export interface RouterReplySource { worker?: boolean; files?: boolean }
export type RouterReplyFormat = 'plain' | 'markdown'

const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' })
const RAW_REPLY_LIMIT = 8000

/** Keep the plain bubble free of Markdown constructs, while allowing ordinary punctuation. */
function hasMarkdown(text: string): boolean {
  return /(^|\n) {0,3}(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|(?:[-*_]\s*){3,}$)/m.test(text)
    || /!?\[[^\]\n]*\]\([^\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]/.test(text)
    || /(^|\n) {0,3}\[[^\]\n]+\]:\s*\S/.test(text)
    || /(`+)[^`\n]+\1|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~/.test(text)
    || /(^|[\s(])\*[^*\n]+\*(?=$|[\s).,，。！!？?])|(^|[\s(])_[^_\n]+_(?=$|[\s).,，。！!？?])/.test(text)
    || /<(?:https?:\/\/|[\w.+-]+@)[^>]+>|<\/?[a-z][^>]*>/i.test(text)
    || /(^|\n)[^\n]+\n {0,3}(?:={3,}|-{3,})\s*(?:\n|$)|(^|\n)\s*\|?\s*:?-{3,}:?\s*\|/.test(text)
}

/** Conservative visible-text count for the supported Markdown outlet.
 * Only remove well-formed formatting; malformed syntax remains in the count.
 * Code contents stay literal, including apparent links or emphasis.
 */
function markdownVisibleText(text: string): string {
  const literal: string[] = []
  const hold = (value: string) => `\u0000${literal.push(value) - 1}\u0000`
  let visible = text
    .replace(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}\2\s*(?=\n|$)/g, (_all, line: string, _fence: string, content: string) => line + hold(content))
    .replace(/(`+)([^`\n]+)\1/g, (_all, _ticks: string, content: string) => hold(content))
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, (_all, escaped: string) => hold(escaped))
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/(^|\n) {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~/g, (_all, a: string, b: string, c: string) => a ?? b ?? c)
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)|(^|\s)_([^_\n]+)_(?=\s|$)/g, (_all, a: string, b: string, c: string, d: string) => (a ?? c) + (b ?? d))
  visible = visible.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => literal[Number(index)])
  return visible
}

/** Source flags come from the bound host result, never from model assertions. */
export function validateRouterReply(bubbles: string[], source: RouterReplySource = {}): RouterReplyFormat {
  if (!Array.isArray(bubbles) || bubbles.length > 3) throw new Error('每轮最多3个气泡')
  if (bubbles.some(text => typeof text !== 'string' || !text.trim())) throw new Error('回复不能为空')
  const text = bubbles.map(value => value.trim()).join('')
  if (text.length > RAW_REPLY_LIMIT) throw new Error('回复原文过长，请改为成果附件')
  const format = source.worker && !source.files ? 'markdown' : 'plain'
  if (format === 'plain' && hasMarkdown(text)) throw new Error('本轮只允许纯文本气泡，不能使用Markdown格式')
  const limit = format === 'markdown' ? 500 : 100
  const visible = format === 'markdown' ? bubbles.map(markdownVisibleText).join('') : text
  if ([...segments.segment(visible)].length > limit) throw new Error(`整轮回复最多 ${limit} 个可见字符，不能拆泡规避；长内容放成果文件`)
  return format
}
