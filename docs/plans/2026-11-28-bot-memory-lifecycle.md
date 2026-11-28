# Bot memory lifecycle implementation plan

> Execute the agreed design in this session, using test-driven development and fresh verification. Preserve existing session-resume changes.

**Goal:** Structured, attributable preferences with semantic recall, explicit writes, versioned conflict resolution, scoped disclosure, query/history, and reliable forgetting.

**Architecture:** Keep the existing SQLite memories and append-only memory_log. One MemoryLibrary owns writes, versions, receipts, lifecycle and FTS; one small retrieval adapter owns cached embeddings and hybrid ranking. Router and background extraction use exactly the same validated write operation. No additional per-turn generative-model call. User/bot/channel are host-bound; task/case/project scopes are exact IDs/paths, semantic situations remain explicit conditions for Router.

**Tech stack:** Bun/TypeScript, SQLite FTS5, zod, fetch to OpenAI-compatible embedding service; no new runtime dependency.

## 1. Lifecycle and shared writer
- Modify types.ts, memory.ts, store.ts; add memory-library.ts and memory lifecycle tests.
- First assert time/phase expiry (never round counts), no automatic promotion, duplicate/replacement/temporary override, source attribution, versions, rollback, idempotency and source-withdrawal behavior.
- Add explicit scope/topic/kind, end conditions, effective status and separate disclosure/adoption counters; legacy data remains readable and is marked for review rather than guessed into global preferences.
- Store versions in existing log snapshots, transaction receipts in one table. Reuse store transactions; no duplicate memory database.
- Conflict candidates include matching topic and semantic/text hits; commit checks all relevant record revisions and source-message state. Permanent replacement must match scope; temporary override keeps base rule recoverable.

## 2. Retrieval and disclosure
- Add memory-retrieval.ts and tests with deterministic embedding provider and local HTTP server.
- FTS5 keywords + cosine similarity, bounded results and character budgets, fixed effective-scope filtering, global core preferences explicitly classified (never inferred merely from library size).
- Persist embedding cache keyed by provider/model and content hash; index writes off the reply path, query embedding has timeout and cache. Configured failures report keyword fallback, never claim semantic coverage.
- Disclosure selects <=30 long/10 mid; current task and recent dialogue supply query context. Active overrides are resolved across the effective library, not only returned hits.

## 3. Router tools and background extraction
- Modify router.ts, service.ts and host construction; add integration tests.
- Tools: memory_search, memory_read (including versions/source IDs), memory_write (batch changes incl. withdraw/purge), memory_used. Host binds user/Bot/channel, current source messages, task/case/project identities and idempotency.
- Background extraction gets full current message batch, task/case summaries, recent dialogue and related candidates; can search/read more candidates before committing multiple independent topics once.
- Same write path for explicit Router updates and background extraction; no false success on missing/invalid commit, optimistic conflicts retry with fresh candidates. Background still extracts other topics after Router writes; source/topic/scope replay is deduplicated by the shared writer.
- Memory queries distinguish effective records from historical records, support filters/time/pagination and follow source IDs through existing chat_read.
- Revalidate memory context when revisions/scopes change and preserve current snapshot authority in reused Router sessions.

## 4. Forgetting, controls and migration
- Owner controls use shared lifecycle methods; revocation and original-message withdrawal invalidate writes/caches, preserve audit snapshots unless explicitly purged.
- Purge clears record text, versions, indexes, cache and textual receipts; minimal tombstone prevents replay, while conversation originals remain under chat retention.
- No speculative rewriting of the live database; old records carry explicit legacy/review hints and conservative scoped recall until reclassified.

## 5. Delivery checks
- Run red/green focused tests each step, typecheck, complete Bun suite, and CLI build.
- Review feature diff for source authority, cross-Bot leakage, false-positive permanent replacement, temporary overrides, stale sessions, token bounds, failures, cache invalidation and replay resurrection.
- Apply only this feature delta to the original workspace, preserving its original dirty changes; verify there again. No service restart/push is part of this request.
- Provide implementation/configuration docs and concrete manual validation examples.
