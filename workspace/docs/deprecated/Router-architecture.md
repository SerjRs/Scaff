## 2. Router

A service inside OpenClaw which takes any execution task, weights it, and spawns an agent corresponding to the task weight. The Router feeds that agent with the task details and a prompt template assembled for the execution. The Router continuously reviews the tasks in its queue; when a task is completed, it returns the result to the issuer.

The Router architecture is built on a queue basis (Redis-backed):
- Any task is enqueued with its status, issuer, and result slot.
- Issuers only enqueue tasks with the corresponding details.
- The Router continuously scans the queue:

| Status | Description |
|--------|-------------|
| 2.1 InQueue | Job just submitted, waiting to be picked up |
| 2.2 Weightening | Evaluator is scoring message complexity (1-10) to determine tier |
| 2.3 Pending | Weight/tier assigned, waiting for a worker to pick it up |
| 2.4 InExecution | A worker is actively running the agent |
| 2.5 Completed | Finished successfully |
| 2.6 Failed | Finished with error |
| 2.7 Canceled | Aborted |

**Flow:** InQueue → Weightening → Pending → InExecution → Completed | Failed | Canceled

The evaluator scores 1-10 and maps to a tier: **Haiku** (1-3), **Sonnet** (4-7), **Opus** (8-10). Each tier has a dedicated prompt template (`src/router/templates/`). The evaluator uses Claude Sonnet to classify complexity; on failure it defaults to weight 5 (Sonnet tier).

**Job types:** `agent_run` (subagent work), `memory_cleanup` (gardener truncation), `long_memory_extraction` (AI fact extraction). Each has a dedicated prompt template registered in `src/router/templates/index.ts`.

**Result delivery:** When a job completes, the notifier stamps `metadata.deliveredAt` on the job and emits a lifecycle event. The gateway's `waitForAgentJob()` listener picks it up and responds to the caller. Delivered jobs are cleaned up after 5 minutes; undelivered after 1 hour.