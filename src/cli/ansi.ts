/** 剥 ANSI 转义(CSI 序列 + OSC 序列)。ce 侧复制自手机 src/butler/protocol.ts——
 *  ce 与手机是两套依赖、各自 tsconfig,不共享,故各留一份同名纯函数。 */
export const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07?/g, '')
