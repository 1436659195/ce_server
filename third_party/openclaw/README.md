# OpenClaw source reuse

- Upstream: https://github.com/openclaw/openclaw
- Pinned commit: `2ab7b31a13d95bbbb62596679b130445c4c9d3d1`
- License: MIT; full notice in [LICENSE](LICENSE).
- Source: [src/cron/retry-hint.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/retry-hint.ts).
- Local: `src/cli/bot-runtime/automation/openclaw-retry-hint.ts`.
- Changes: provenance header; replace upstream's type-only `FailoverReason` dependency with `string`. Runtime logic unchanged. Source hashes and modifications are recorded in [provenance.json](provenance.json).
- Verification: `bun test test/bot-automation-retry-hint.test.ts`.

Also adapted: [src/cron/schedule.ts](https://github.com/openclaw/openclaw/blob/2ab7b31a13d95bbbb62596679b130445c4c9d3d1/src/cron/schedule.ts) → `src/cli/bot-runtime/automation/schedule.ts`. It retains the next/previous occurrence algorithms, bounded cache and DST correction, while replacing upstream-only helpers and types with CE equivalents. Its hashes and modifications are included in `provenance.json`. Verify with `bun test test/bot-automation-schedule.test.ts`.

The classifier is not an execution retry policy. A transient classification does not make an already-started task safe to repeat. The scheduler checks execution phase, cancellation and remaining attempt budget before retrying. Once a Worker task exists, an ambiguous failure requires attention. Delivery retries use the existing outbox and never rerun the Worker merely because a message was not acknowledged.

The adapted modules are now used by the automation scheduler. The host lifecycle, durable queue, creation receipts, condition contract and separate execution/delivery flow follow the source assessment in the design document; they are implemented against CE's existing SQLite, Router, Worker and outbox rather than importing OpenClaw's Gateway/session infrastructure.
