# Old Case Retrieval Implementation Plan

**Goal:** 用现有账本和搜索投影修复明确关联丢失、受控同义表达和前五条截断。
**Architecture:** 不增搜索表/缓存/依赖，复用按卷宗聚合的实时搜索字段，避免双写和回填。精确任务/成果ID先验权定位；共享小型术语扩展；内部最多30候选、每页最多5条，按实际交付数量推进offset，沿现有工具及预算继续读取。
**Tech Stack:** TypeScript / Bun / SQLite。

1. 先新增失败测试：口语/英文重连、明确任务和成果、前5以外翻页、跨Bot、更新即时可查、空结果。
2. cases.ts共享受控术语扩展；store.ts复用现有查询增加精确关联与候选分页。
3. service.ts及router.ts接入原case_search，保留4次查询/内容预算，明确关系优先、页码或换词不重复查询；保留现有targetTaskId默认关联，不扩大只接收upload的附件协议。
4. 运行相关与Bot功能回归、typecheck和diff检查，独立审查；交付MD说明五点取舍与边界，不报虚构召回率。
