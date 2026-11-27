import { expect, test } from 'bun:test'
import { validateRouterReply } from '../src/cli/bot-runtime/reply-policy'

test('普通聊天保持100字纯文本，拆泡不能扩额度', () => {
  expect(validateRouterReply(['收到。'])).toBe('plain')
  expect(() => validateRouterReply(['字'.repeat(60), '字'.repeat(41)])).toThrow(/100/)
  expect(() => validateRouterReply(['**收到**'])).toThrow(/纯文本/)
})

test('真实Worker文字结果允许500字及Markdown', () => {
  expect(validateRouterReply(['**结论**\n\n' + '字'.repeat(450)], { worker: true })).toBe('markdown')
  expect(() => validateRouterReply(['字'.repeat(501)], { worker: true })).toThrow(/500/)
  expect(() => validateRouterReply(['字'.repeat(150)])).toThrow(/100/)
})

test('附件交付仍为100字纯文本，按实际附件而非模型自报决定', () => {
  expect(validateRouterReply(['请查看附件。'], { worker: true, files: true })).toBe('plain')
  expect(() => validateRouterReply(['**请查看附件**'], { worker: true, files: true })).toThrow(/纯文本/)
  expect(() => validateRouterReply(['字'.repeat(101)], { worker: true, files: true })).toThrow(/100/)
})

test('Markdown链接按可见文字计数，并限制原文大小', () => {
  expect(validateRouterReply(['[说明](https://example.com/' + 'a'.repeat(600) + ')'], { worker: true })).toBe('markdown')
  expect(() => validateRouterReply(['x'.repeat(9000)], { worker: true })).toThrow()
})

test('中文、组合字形和emoji按可见字符计算，气泡数量仍有限制', () => {
  expect(validateRouterReply(['👨‍👩‍👧‍👦'.repeat(100)])).toBe('plain')
  expect(validateRouterReply(['e\u0301'.repeat(100)])).toBe('plain')
  expect(() => validateRouterReply(['👨‍👩‍👧‍👦'.repeat(101)])).toThrow(/100/)
  expect(() => validateRouterReply(['一', '二', '三', '四'], { worker: true })).toThrow(/3/)
  expect(() => validateRouterReply(['  '])).toThrow(/不能为空/)
})

test('纯文本拒绝常见Markdown，但保留普通路径与比较符号', () => {
  for (const text of ['# 标题', '- 条目', '1. 条目', '> 引用', '`code`', '*强调*', '[链接](https://example.com)', '标题\n---']) {
    expect(() => validateRouterReply([text])).toThrow(/纯文本/)
  }
  expect(validateRouterReply(['路径 /tmp/a_b.md，CPU > 80% 时提醒。'])).toBe('plain')
})

test('Worker代码内容保留字面量，不用链接语法压低正文计数', () => {
  expect(() => validateRouterReply(['```text\n[说明](https://example.com/' + 'a'.repeat(600) + ')\n```'], { worker: true })).toThrow(/500/)
  expect(() => validateRouterReply(['`[说明](https://example.com/' + 'a'.repeat(600) + ')`'], { worker: true })).toThrow(/500/)
  expect(() => validateRouterReply(['**' + '字'.repeat(260) + '**', '字'.repeat(241)], { worker: true })).toThrow(/500/)
})
