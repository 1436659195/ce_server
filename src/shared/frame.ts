/**
 * 隧道帧协议 —— 手机 / 中继 / ce 三方共享的消息结构。
 *
 * 设计:payload 在传输前由 crypto 包加解密(这里只管明文结构)。
 * 隧道里跑两类加密帧:
 *   - 终端流(TermStdin/TermOutput):每个 Jupyter 终端 sid 一条,载荷是 terminado JSON 字节
 *   - RPC(RPCReq/RPCResp):列目录/建终端/读文件等,载荷是请求/响应 JSON 字节
 *   - Control:控制帧(配对确认、resize、ping 等)
 *
 * 编码:JSON 文本(YAGNI;终端高频小包若性能不够,再换 length-prefix 二进制,届时同步改本文件 + 测试)。
 * Uint8Array payload 经 base64 进 JSON(JSON 不支持裸字节)。
 */

export enum FrameType {
  TermStdin, // 手机→ce:终端输入(terminado ["stdin",..])
  TermOutput, // ce→手机:终端输出(stdout/stderr)
  RPCReq, // 手机→ce:RPC 请求(列目录/建终端/读文件)
  RPCResp, // ce→手机:RPC 响应
  Control, // 控制帧(配对确认、resize、ping)
}

export interface Frame {
  type: FrameType
  sid?: string // 终端会话ID(终端流用)
  reqId?: string // RPC 请求ID(RPC 用)
  payload: Uint8Array // 终端:terminado JSON 字节;RPC:请求/响应 JSON 字节;均已加密
  // 多人共连路由元数据(非 E2E 负载,payload 仍加密不变):
  targetPhoneId?: string // cli→phone 定向:ce 指明此帧发给哪台手机
  sourcePhoneId?: string // phone→cli 来源:hub 注入,标明此帧来自哪台手机
}

// 传输用 JSON 形态(payload 转 base64;sid/reqId/targetPhoneId/sourcePhoneId 为空时省略)
interface WireFrame {
  type: FrameType
  sid?: string
  reqId?: string
  payload: string // base64
  targetPhoneId?: string
  sourcePhoneId?: string
}

export const encodeFrame = (f: Frame): Uint8Array => {
  const wire: WireFrame = {
    type: f.type,
    payload: Buffer.from(f.payload).toString('base64'),
  }
  if (f.sid !== undefined) wire.sid = f.sid
  if (f.reqId !== undefined) wire.reqId = f.reqId
  if (f.targetPhoneId !== undefined) wire.targetPhoneId = f.targetPhoneId
  if (f.sourcePhoneId !== undefined) wire.sourcePhoneId = f.sourcePhoneId
  return new TextEncoder().encode(JSON.stringify(wire))
}

export const decodeFrame = (b: Uint8Array): Frame => {
  const o = JSON.parse(new TextDecoder().decode(b)) as WireFrame
  return {
    type: o.type,
    sid: o.sid,
    reqId: o.reqId,
    payload: new Uint8Array(Buffer.from(o.payload, 'base64')),
    targetPhoneId: o.targetPhoneId,
    sourcePhoneId: o.sourcePhoneId,
  }
}
