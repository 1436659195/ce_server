# E2E 加密规格(App 与 ce 共用)

> 两边都用 **tweetnacl**(纯 JS nacl 实现,无 WASM;Bun / Capacitor WebView 都稳),按本规格实现 → 互通由同一套原语保证,**无跨语言互通问题**。
> 原语:X25519(nacl.box)+ XSalsa20-Poly1305(nacl.secretbox),与 libsodium 的 crypto_box/crypto_secretbox 同源、密文兼容。
> 这是 App(`src/utils/e2e.ts`,Phase 4)与 ce(`src/shared/crypto.ts`)共同遵守的契约;改这里要两边同步。

## 1. 密钥(pairing 时一次性建立,后续复用)

1. 各自生成 X25519 密钥对:`nacl.box.keyPair()` → `{ publicKey, secretKey }`(本仓库统一叫 `privateKey`)。
2. **ce 的 publicKey 进二维码**;手机扫码后,在 pairing 握手里把自己的 publicKey 发给 ce(用配对码防抢占,Phase 2/3 实现)。
3. 配对完成后:每方持有「自己的 privateKey + 对方的 publicKey」。

## 2. 共享对称密钥

- `sharedKey = nacl.box.before(peerPublicKey, myPrivateKey)` → 32 字节。
- X25519 的对称性:两边算出的 `sharedKey` **相同**。之后**两个方向用同一个 sharedKey**(对称密钥,无方向歧义)。

## 3. 每条 Frame.payload 加解密(nacl.secretbox,XSalsa20-Poly1305)

**加密:**
```
nonce = nacl.randomBytes(24)                 // 24 字节随机 nonce,每条都新随机
ct    = nacl.secretbox(payload, nonce, sharedKey)
线路字节 = nonce(24) || ct
```

**解密:**
```
nonce = bytes[0:24]
ct    = bytes[24:]
payload = nacl.secretbox.open(ct, nonce, sharedKey)   // 失败返回 null → 当作篡改/密钥不匹配,丢弃
```

## 4. 红线

- **nonce 每条必须随机新生成,绝不复用**(同 key + nonce 复用 = 可破解)。
- 一律用 tweetnacl 成熟原语,**不自造密码学**。
- `sharedKey` 绑定 pairing 一次建立,持久化在手机(下次自动重连不重扫)。
- 中继**零信任**:它只转发密文,从不持 `sharedKey`、无法解密。

## 5. RPC 操作契约(手机 ↔ ce,密文帧内)

手机发 `RPCReq { op, ... }`,ce 回 `RPCResp { ok, data?, error? }`。除 `listTerminals`/`deleteTerminal`/`detachTerminal` 为特例外,其余 `op`(`listDir`/`readFile`/`createDir`/`readFileRange`/`createTerminal`/`deleteFile`/`renameFile`/`saveFile`)由 `bridge.ts` 的 `handleRpc` 分派到本地 Jupyter REST。

文件写操作(直连与中继对称,见 `useFiles.ts` ↔ `bridge.ts`):

- **`deleteFile`**(`{ path }`):`DELETE /api/contents/{path}`(目录递归删)。
- **`renameFile`**(`{ path, newPath }`):`PATCH /api/contents/{path}` body `{path: newPath}`。`newPath` 是去前导 `/` 的逻辑路径(JSON 值,**不** URL-encode;URL 段才走 `encodePath`)。仅同目录改名。
- **`saveFile`**(`{ path, content, format }`):`PUT /api/contents/{path}` body `{type:'file', format:'text'|'base64', content}`。整文件覆盖(无分段语义):新建空文件(`content:''`)/ 编辑保存(text)/ 上传(base64)共用。

- **`listTerminals`**(特例,`main.ts` 处理 —— 需访问 ce 的 `terms` map 算 `managed`):返回 `{ ok: true, data: { terminals: RemoteTerminalInfo[] } }`,其中
  - `RemoteTerminalInfo = { name: string; lastActivityAt: number | null; managed: boolean; occupiedBy: string | null }`
  - ce 转发本地 `GET /api/terminals`,用 `toRemoteTerminals(all, managedSet)`(`bridge.ts`)映射:`name` = 终端名(= terminado session name = 隧道 TermOutput 的 sid);`lastActivityAt` = 解析 `last_activity` 的 ms 时间戳(无则 null);`managed` = 该终端是否在 ce `terms` map 里(= ce 经手过、有 terminado WS);`occupiedBy` = 当前占用者显示名(按 `terminalOwner` map 查 phone 显示名;空闲=`null`)。
  - 手机:**杀 app 重开自动恢复只挑 `managed=true`**(零回归);**「+」面板显示全部**,并据 `occupiedBy` 灰显别人正在用的(自己占用的仍可切)。
- **`deleteTerminal`**(`{ name }`,特例):关 ce 端 terminado WS + 本地 `DELETE /api/terminals/{name}`(硬删:杀服务器终端进程)。
- **`detachTerminal`**(`{ name }`,特例):只关 ce 端 terminado WS + 从 ce `terms` map 移除,**不** Jupyter DELETE(软移除:服务器终端保留)。→ 该终端 `managed` 变 false(杀 app 重开不自动恢复),但 `GET /api/terminals` 仍返回 →「+」面板可见、可重新接管。

## 6. Control 帧的密文 op(ce→手机,定向加密 + targetPhoneId 路由)

除手机→ce 的握手(明文 phonePub)/resize(密文)外,ce→手机 也用 `FrameType.Control` 发密文控制通知:

- **`attachDenied`**(`{ op:'attachDenied', name, occupiedBy }`):race 反馈。两手机近乎同时接管同一空闲终端,ce `tryAcquire` 按先到先得裁决,落败方(loser)此前已在本地建会话(接管面板点的)→ ce 给 loser 发此通知(用 loser 的 sharedKey 加密 + `targetPhoneId=loser` 路由)。loser 收到后**本地回滚该 session(软移除,`localOnly=true`:不再对 ce 发 `detachTerminal`,否则会误杀 winner 刚抢到的终端/占用)** + 弹 toast(`「name」刚被 occupiedBy 占用了`)。`occupiedBy` = winner 的显示名。

## 7. AI 管家(ce 托管,Agent SDK 工具化版)

管家大脑 = **ce 里的一个 cc**,经 `@anthropic-ai/claude-agent-sdk` 的 `query()` 长驻跑(`prompt` = 永不结束的异步队列 → cc 多轮常驻)。终端操作是 cc 的**自定义工具**(`createSdkMcpServer` 里 `list_terminals`/`read_terminal`/`send_terminal`),handler 跑在 ce 进程内、直接读 ce 终端缓冲 / 写 terminado stdin。**管家是中继专属**(直连无 ce,无管家),且**工具无关**——终端里跑 cc/codex/opencode/服务/裸 shell 都用同一套工具管。

- **skill** 由手机在 `butlerStart` RPC 里传(`req.skill`),ce 作为 mcpServer `instructions` 注入;ce 不另存。
- **隔离**:`cwd='/tmp/ce-butler-cwd'`(空)→ cc 不加载任何项目 CLAUDE.md;`pathToClaudeCodeExecutable=resolveClaudeBin()` 复用系统 claude(连带 auth,绕开编译期 extractFromBunfs)。
- **读类工具**(`list_terminals`/`read_terminal`/`Read`/`Grep`/`Glob`)进 `allowedTools` 自动放行;**写类**(`send_terminal`)走 `canUseTool` 问手机审批。

### 7.1 RPC(复用 RPCReq/Resp)

- **`butlerStart`**(`{ op:'butlerStart', skill }`):ce 起(或复用,见 7.3)cc、登记 `owner=srcPhoneId`、回 `{ ok:true, data:{ sid } }`(`sid` 形如 `butler-<hex>`)。**合成 `system/init` 排在 RPCResp 之【后】发**(复用路径 cc 已 boot、不再吐 init,须补一条;排在 RPCResp 后是为让手机先 resolve `tunnel.rpc`→注册 `onButlerOutput` 订阅→再收 init——否则 init 到达时订阅还没注册、被丢弃 → 复用路径 40s 超时)。
- **`butlerStop`**(`{ op:'butlerStop', sid }`):ce 收尾该 cc、清 map、回 `{ ok:true }`。

### 7.2 流帧(FrameType 沿用 `ButlerStdin=5`/`ButlerOutput=6`,不新增)

- **`ButlerStdin`**(手机→ce,`sid`=butlerSid,payload 密文)。两种 JSON 载荷:
  - 用户发言:`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`(SDKUserMessage)→ ce `writeStdin` 入对话队列。
  - 审批响应:`{"type":"butler_approval_response","reqId":"…","allow":true|false}` → ce `resolveApproval` 解 `canUseTool` 的 pending。
- **`ButlerOutput`**(ce→手机,`sid`=butlerSid,`targetPhoneId`=owner,payload 密文 = JSON + `\n`):cc 吐的每个 SDKMessage 原样转发——`system/init`(就绪)、`assistant`(内容块:text 人话 / tool_use 工具调用)、`user`(含 tool_result)、`result`(一轮完)。手机直接渲染(白盒:工具调用是结构化事件,不再解析文本信封)。
- **额外 system 事件**(ce 造):
  - `{"type":"system","subtype":"butler_approval","reqId","tool","input"}`:写工具被 `canUseTool` 拦下 → 手机弹审批卡。
  - `{"type":"system","subtype":"butler_approval_resolved","reqId","resolved":"denied"}`:ce 单方面结掉审批(15s 超时拒 / 管家退出)→ 手机把对应审批卡同步置「已拒绝」,免僵尸卡(显式 approve/deny 由手机发起、本地卡已先标好,不发此事件)。
  - `{"type":"system","subtype":"butler_exit","code":N}`:cc 进程退 → 手机转 `dead`。
  - `{"type":"system","subtype":"butler_nocc","code":-2|127}`:spawn claude 失败(未装/native 缺)→ 手机转 `nocc` + 安装提示。

### 7.3 生命周期(管家是 ce 侧长驻进程,同终端,扛过手机瞬时断连)

- **phoneLeft / 中继断**:**不杀管家**(只清 E2E 通道 + 终端占用)。手机瞬时断连(后台/切应用致 WS 冻结重连)极常见,管家留活,手机重连后重新握手派生 phoneKeys、按 `owner=phoneId` 续接同一 cc(保留对话历史)。**孤儿回收**:phoneLeft 同时挂 6h 计时(`markPhoneLeft`),6h 内手机重连(握手 `markPhoneBack`)取消;到期未归则 `stopAllForPhone` 回收——免「移除服务器后不再回来」致 cc 常驻泄漏。
- **复用**:`butlerStart` 先 `sidForPhone(srcPhone)` 查同 owner 活管家 → 命中则返回其 sid(接回带历史上下文的 cc),不二次 spawn。
- **真死**:cc 进程退 / ce 整体重启 → 管家没了(进程死)→ 手机端超时或 `butler_exit` → 重开 respawn。
- **多手机**:管家 `owner`=发起 `butlerStart` 的 phoneId;`ButlerOutput` 只定向该 phone(同终端占用语义);一机一管家。

## 8. AgentEvent 帧(ce→手机,agent 结构化事件;CC 审查楔子用)

`FrameType.AgentEvent = 7`(**新增,加在 enum 末尾**,不破坏 0-6)。ce→手机,载荷密文 = agent 事件 JSON。
**ce 当哑管道**:hub 只转发、不解析事件语义(CC hooks 格式等 agent 专属知识在 ce CLI 的 hooks 层 + 手机插件,不在中继)。

- 用途:CC 跑在被控机终端里,hooks(PreToolUse / PostToolUse)捕获结构化事件 → ce CLI 包成 AgentEvent 帧发中继 → hub 透传 → 手机 CC 审查插件渲染(审批卡 / diff)。
- 路由:同 TermOutput —— cli→phone,按 `targetPhoneId` 定向或广播;hub 零信任只转发密文。
- 载荷(JSON,密文):`{ kind:'PreToolUse'|'PostToolUse'|'Result'|..., tool?, input?, ... }`(具体 schema 由 ce CLI hooks 层 + 手机插件约定,中继不关心)。
- **此帧编号必须与手机端 `ce-platform/src/core/connection/relay/frame.ts` 同步**:0-6 一致,AgentEvent=7(改 enum 数字 = 破坏互通)。

## 9. 通用审批派发(blocking approval round-trip,**非 CC 专属**)

被控机上某 agent(如终端里跑的 CC)要做写操作、需人工放行 → **blocking 审批**。ce 当通用哑管道:
`ApprovalDispatcher`(`src/cli/approval.ts`)只管 reqId 配对 + 超时 + 取消,**不知「CC / PreToolUse / diff」**。agent 专属
知识住 `cc-hooks.ts` + 手机插件。审批请求/响应仍是 E2E 加密帧内 JSON,中继只转密文。

**复用现成帧,零新帧类型**(对齐 §8 + §5 RPC):

1. **ce→手机 审批请求** = `AgentEvent` 帧(=7),载荷密文 JSON:`{ kind:'PreToolUse', reqId, terminalId?, tool, input }`。
   - PreToolUse 本就是 agent 事件 —— 审批请求即「带 reqId 的 PreToolUse 事件」。手机插件据 `tool`+`input` 渲染审批卡
     (如 Write → 读旧文件算 diff;Bash → 显示命令)。`reqId` 是 ce 生成、用于回程配对。
2. **手机→ce 审批响应** = `RPCReq` 帧(=2),载荷密文 JSON:`{ op:'resolveApproval', reqId, decision:'allow'|'deny' }`。
   - ce 内联处理(同 `listTerminals`/`butlerStart`,需 dispatcher 上下文、非 JupyterClient):`approvals.resolve(reqId, decision)`。
   - ce 回 `RPCResp { ok:true, data:{ resolved:boolean } }`。`resolved:false` = 未命中(幂等:超时后迟到 / 别的手机先解过)→ 不报错。
3. **ce→手机 resolved 通知** = `AgentEvent` 帧,载荷:`{ kind:'approval_resolved', reqId, resolved:'approved'|'denied' }`。
   - ce 在**任何**结掉 pending 时发(手机人审 resolve / 超时 / cancelAll)。用途:多手机共连时,**没决策的那台手机**
     仍挂着的审批卡要同步清掉(发起方本地卡已先标、收到是幂等 no-op)。

**超时 / 取消**(防 hook 永久挂起):
- dispatcher 默认 55s 未答 → 自动 deny + 发 `approval_resolved{denied}`。55s < CC PreToolUse hook 默认 60s 超时:ce 先于 CC 结掉,
  手机卡不僵尸、hook 不被 CC 强杀成 block。
- **中继断**(`ws.on('close')`):`approvals.cancelAll('deny')` —— 手机此刻不可达,全拒让 agent 早结(不干等 55s)。重连后新审批重来。

**`trustWindowSec`(信任窗口)**:手机可能带「允许 N 秒内同类免再问」→ 这是**手机插件侧**缓存语义,ce 不持状态、不解析。
回程 RPC 里可有 `trustWindowSec?` 字段,ce 透传忽略(未来若要 ce 端缓存再加,目前 YAGNI)。

## 10. CC hooks 层(CC 专属知识住 ce CLI 这层;CLI 编排,非中继)

CC(Claude Code)跑在被控机**终端里**(非 ce 托管进程 —— 区别于管家 butler 的 Agent SDK)。ce 在用户启动 `claude` **前**把
hooks 配置写到 `~/.ce/cc-settings.json`,指向 ce 的本地 hook 接收端点。CC 触发 hook → `curl` 把事件 JSON POST 给 ce →
ce 按 §9 / §8 处理。**ce 不 spawn claude**:CC 由用户在终端起(可被电脑开 Jupyter Lab 接管、同终端同 CC)。

- **hooks 配置生成**(`generateHooksConfig`,`src/cli/cc-hooks.ts`):写 `.claude/settings.json` 形态 ——
  `PreToolUse`(matcher = `Write|Edit|MultiEdit|NotebookEdit|Bash`,写/执行类需审批;读类 Read/Grep/Glob 不拦截,对齐管家 READ_TOOLS)
  + `PostToolUse`(matcher = `''`,全转发)。hook 命令 = `curl -s --data-binary @- -X POST http://127.0.0.1:<port>/hook`
  (读 stdin = CC hook 事件 JSON;stdout = ce 响应体 → PreToolUse 时即 permissionDecision,CC 据此 allow/deny)。
- **hook 接收器**(`main.ts` 用 `Bun.serve`,只听 `127.0.0.1`、`port:0` 让 OS 分配空闲端口):
  - `PreToolUse` → `handleHookBody` 调 `approvals.request()`(§9,阻塞 55s 等手机)→ 回 CC 期望的
    `{ hookSpecificOutput:{ hookEventName:'PreToolUse', permissionDecision:'allow'|'deny', permissionDecisionReason? } }`。
  - 其余(PostToolUse 等)→ 包成 AgentEvent(§8)即发广播 → 回 `{}`(CC 放行)。
  - 非法 body → 回 `{}`(绝不卡 CC)。
- **CC hook stdin schema**(`parseHookEvent`):`{ hook_event_name, tool_name?, tool_input?, session_id?, cwd? }` → 归一化
  `{ hook, tool?, input?, sessionId?, cwd? }`。`hook_event_name` 缺失 → null(放行)。
- **边界**:本层知「CC 的 hook stdin 字段、CC 期望的 permissionDecision 响应体」。换 codex/opencode 只换本文件的
  解析/响应格式,`ApprovalDispatcher`(§9)+ AgentEvent(§8)+ 中继零透传不动 —— 这正是「ce 当哑管道、agent 知识住边缘」。
- **手机端对齐**:`PreToolUse` 的 `tool`+`input` 走 §8 AgentEvent 给手机插件渲染(M27 CC 审查插件);审批回程走 §9 `resolveApproval`。
  手机端 frame.ts 只需认 AgentEvent=7(已在 §8 对齐),**无新帧**。
