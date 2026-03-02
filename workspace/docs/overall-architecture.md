<!-- Scaff Architecture Spec — last aligned with code: 2026-02-23 (Groups 1-4) -->

# Overall Architecture

The Scaff architecture is based on OpenClaw v2.0.25 but it adds and modifies the OpenClaw architecture to map its own vision.

## 1. Cortex

The main model which discusses with the User. Cortex primary goals are:

- **Discuss with the User** — keep the User discussion as top priority. Cortex handles user conversation directly via `agentCommand()` (the embedded Pi agent runner). It streams responses in real-time through channels (WhatsApp, Telegram, Discord, etc.).
- **Delegate execution** — background tasks and subagent work are delegated to the Router via `sessions_spawn`. Cortex never burns tokens on tasks that a cheaper tier (Haiku/Sonnet) can handle; research, analysis, and heavy execution are routed to the appropriate tier.
- **Health monitoring** — Cortex oversees its internal status via `src/health/status.ts`. Health checks include: gardener freshness (is `memory_cleanup` running on schedule), hot memory staleness, and context budget (% of context window used). When status is not green, a `[SYSTEM HEALTH]` advisory is injected into the system prompt so Cortex can inform the user. Cortex delegates verification and repair to the Router rather than running checks itself.
- **Run wisely** — minimize token burn by delegating research and execution to the Router, which assigns the cheapest capable tier.
- **Cross-channel:** Cross-channel linking — the Users' channels are linked together so whatever channel the user discusses through, Cortex should be aware of that discussion. This requires a cross-session identity resolver that is not yet built.

## 2. Router
A service inside OpenClaw which takes any execution task, weights it, and spawns an agent corresponding to the task weight. The Router feeds that agent with the task details and a prompt template assembled for the execution. The Router continuously reviews the tasks in its queue; when a task is completed, it returns the result to the issuer.

The Router architecture is built on a queue basis
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

The evaluator scores 1-10 and maps to a tier: **Haiku** (1-3), **Sonnet** (4-7), **Opus** (8-10). Each tier has a dedicated prompt template . The evaluator uses Claude Sonnet to classify complexity; on failure it defaults to weight 5 (Sonnet tier).

**Result delivery:** When a job completes, the notifier stamps on the job and emits a lifecycle event. The gateway's listener picks it up and responds to the caller. Delivered jobs are cleaned up after 5 minutes; undelivered after 1 hour.


## 3. Memory

The memory architecture is built only for Cortex; no other agent stores memory in this architecture. Memory is built on 