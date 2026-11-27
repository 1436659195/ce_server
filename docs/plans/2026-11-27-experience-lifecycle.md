# Bot Experience Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the approved experience writing, contextual retrieval, explicit adoption accounting, and versioned update workflow without treating ordinary delivery reports as reusable lessons.

**Architecture:** A SQLite-backed experience library stores structured lessons, immutable versions, validated material references and idempotent usage events. Router writes/searches/reads/selects lessons; Worker proposes lessons and reports actual adoption through its existing delivery channel; only accepted results can create automatic lessons and validate adoption. Existing Router performs semantic selection over a bounded catalog; SQLite FTS5 with Chinese word/bigram and normalized English tokens recalls larger catalogs.

**Tech Stack:** Bun, TypeScript, SQLite/FTS5, existing zod schemas and Router/Worker adapters. No extra model service or vector database.

## Accepted behavior

- Two writing entrances: Worker may include one focused reusable lesson proposal with a delivery; explicit user requests can be fulfilled by Router directly or by asking Worker. Both use the same saving service and receive persisted ID/version receipts. An ordinary completion report never creates a lesson.
- Lesson content includes title, applicability/structured project-service-OS-version scope, pitfalls, recommended steps, verification procedure, optional detail and immutable artifact references. Topic updates target an existing ID/version; exact duplicate topics return an existing record rather than silently multiplying entries. No fuzzy automatic destructive merging.
- Search considers current request plus explicit long-term rules and actual task goals. Known incompatible scope is excluded, unknown scope is retained with a caution. Small catalogs (<=20 applicable lessons) expose all candidates for Router semantic selection; larger ones use weighted FTS5/BM25, paginated and <=20 per page. Title/applicability rank above detail. Usage impressions never reserve positions. Router selects at most 3 per dispatch and may refine searches/read details.
- Dispatch references stable lesson ID/version plus task-specific execution guidance; Worker can read selected versions and their linked files. In-flight references remain pinned when a newer version is published.
- Display, read, adoption, success are separate. Worker must report adopted/adapted/skipped/failed, concrete applied steps and result; source must be a selected lesson version. One task/lesson adoption maximum even through corrections; success requires Router approval and actual delivery checks. Failures and skipped records remain auditable.
- Each update requires expectedVersion, change explanation and real source evidence; retain all old snapshots. Retire/review/restore are versioned and owner/Router authorized; unverified suggestions remain unverified. Automatic writes are staged until accepted Worker results; a superseded/revised result cannot publish lessons.
- Migrate legacy uses into legacy exposure count, never adoption. Preserve all original reports/history; categorize old task reports separately. Explicit retrospective/manual entries can become structured lessons using their preserved contents, not just their opening delivery sentence. No broad fingerprint retirement for compatible textual knowledge.
- No APK/API protocol break: preserve legacy display fields for older clients. Tools validate same-Bot sources/materials and never accept filesystem paths as artifact grants.

## Task 1 — Library kernel and migration

Files: `src/cli/bot-runtime/types.ts`, `experience.ts`, new `experience-library.ts`, `store.ts`; tests `test/bot-experience-library.test.ts` and targeted store/experience tests.

1. Add failing tests for structured create/update/history/conflict/idempotency; cross-Bot evidence/material rejection; source-based verification; old exposure migration; topical report separation; Chinese/English search/scope filtering/pagination; no popularity slots; task adoption dedupe/version pinning.
2. Run `bun test test/bot-experience-library.test.ts` and inspect RED.
3. Implement public `store.experienceLibrary` repository sharing the store transaction/DB; keep old view accessors compatible, remove old visibility-as-adoption semantics.
4. Run focused tests/typecheck. Commit kernel only after passing applicable tests. Spec review then quality review before accepting kernel.

## Task 2 — Router/Worker integration

Files: `router.ts`, `service.ts`, tests `test/bot-experience.test.ts`, new `test/bot-experience-flow.test.ts`, fixtures as needed.

1. Write failing integration tests: no auto lesson from plain report; Worker proposal only publishes after Router approval; explicit Router save receipt and bound source; contextual search/read; same-Bot and disclosed-version enforcement; selected snapshots reach Worker; adoption/success do not increment on chat/read; stale/rejected results do not mutate knowledge; old version/material reading after updates.
2. Run focused tests for RED; implement minimal tool schemas/handlers/prompts/context and versioned dispatch plumbing.
3. Add `experience_search`, extend `experience_read` to version/history/material reads, `experience_save` and versioned status tool; add dispatch `experienceRefs`, `work_finish.lesson`/`experienceUsage`, and `work_read_experience`.
4. Keep normal tool permissions, source binding, task revisions, cancellation, immutable exports, and Router summary-only validation intact.
5. Run focused tests/typecheck; spec review then quality review. Fix all important findings.

## Task 3 — Documentation, regression and delivery

Files: `docs/ops.md`, new `docs/experience-lifecycle.md`, plan progress.

1. Document exact algorithms, model-vs-host responsibilities, counters, source and artifact binding, migration and limits; manual validation examples use synthetic Bots only.
2. Run `bun run typecheck`, `bun test`, `git diff --check`; final independent review and fix important issues.
3. Commit only feature files in isolated branch, preserving the original workspace's unrelated uncommitted session-resume changes. Integrate into bot-runtime only when it can be done without overwriting those changes; no real Bot messages or remote deployments for tests.

## Implementation and verification record

- Kernel and integration are implemented, with specification and independent quality review completed. Review findings covered stale-version failure handling, distinct topic identity, blank verification evidence, conservative version ranges and exact-version scope filtering; all were resolved with regression tests.
- Full integration regression before the final exact-version correction: 874 passed, 2 skipped, 0 failed across 82 files; typecheck passed. After that correction, the 37 affected library/flow tests passed independently; final delivery also runs regression on the integrated workspace.
- A private SQLite backup of the local maintenance Bot was migrated without running agents: all six records remained (one retrospective lesson and five reports), legacy counters and attachment references remained, adoption started at zero, reopen was idempotent and SQLite quick_check returned ok. The verification did not modify the live database or send real chat messages.
- Original workspace changes were isolated from feature development and backed up before integration. The optional real-model operations scenario was not executed; its obsolete assumption that every completed task must create experience was updated.
