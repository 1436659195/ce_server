import type { CodexTurn } from '../../src/cli/bot-runtime/codex'
import type { RuntimeClient } from '../../src/cli/bot-runtime/service'

/** 记忆整理用的假客户端：一轮直接结束、不提交任何判断，所以什么都不写。主人每一轮话之后宿主都会排一次整理，不关心记忆的测试用它顶上。 */
export function silentMemoryClient(): RuntimeClient {
  return { initialize: async () => {}, startThread: async () => 'memory-thread', resumeThread: async id => id,
    startTurn: async threadId => ({ threadId, turnId: 'memory-turn', done: Promise.resolve({ id: 'memory-turn', status: 'completed' } satisfies CodexTurn) }),
    steer: async () => '', interrupt: async () => {}, close: async () => {} }
}
