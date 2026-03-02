# Anthropic Model-Specific Prompt Templates — Research Report

**Date:** 2026-02-26  
**Sources:** Official Anthropic documentation (platform.claude.com/docs)

---

## Executive Summary

Anthropic does **not** publish separate prompt templates per model tier. Instead, they maintain a single, unified [Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) page covering Claude Opus 4.6, Claude Sonnet 4.6, and Claude Haiku 4.5 together. The differentiation between models is expressed through **API parameters** (thinking mode, effort level, max_tokens) rather than through fundamentally different prompt structures.

Key takeaway: **The same system prompt works across all three tiers.** What changes is the API configuration around it.

---

## 1. Current Model Lineup (Feb 2026)

| Feature | Claude Opus 4.6 | Claude Sonnet 4.6 | Claude Haiku 4.5 |
|---------|-----------------|-------------------|-------------------|
| **API ID** | `claude-opus-4-6` | `claude-sonnet-4-6` | `claude-haiku-4-5` |
| **Pricing** | $5/$25 per MTok (in/out) | $3/$15 per MTok | $1/$5 per MTok |
| **Context window** | 200K (1M beta) | 200K (1M beta) | 200K |
| **Max output** | 128K tokens | 64K tokens | 64K tokens |
| **Adaptive thinking** | ✅ Yes | ✅ Yes | ❌ No |
| **Extended thinking** | ✅ (adaptive only) | ✅ (adaptive + manual) | ✅ (manual only) |
| **Effort parameter** | ✅ (max/high/medium/low) | ✅ (high/medium/low) | ❌ No |
| **Latency** | Moderate | Fast | Fastest |
| **Knowledge cutoff** | May 2025 (reliable) | Aug 2025 (reliable) | Feb 2025 |

**Source:** [Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview)

---

## 2. Key Finding: No Model-Specific Prompt Templates

Anthropic's documentation explicitly states:

> "This is the single reference for prompt engineering with Claude's latest models, including Claude Opus 4.6, Claude Sonnet 4.6, and Claude Haiku 4.5."

There are **no separate prompt templates** for each tier. The same prompting techniques apply across all models. The differentiation happens at the API parameter level:

- **Opus 4.6:** Use adaptive thinking + effort parameter (max/high/medium/low)
- **Sonnet 4.6:** Use adaptive or extended thinking + effort parameter (high/medium/low)  
- **Haiku 4.5:** Use extended thinking with budget_tokens (no adaptive, no effort param)

---

## 3. Thinking Configuration Per Model

### Opus 4.6 — Adaptive Thinking (Recommended)
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 64000,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "high" }
}
```
- `type: "enabled"` with `budget_tokens` is **deprecated** on Opus 4.6
- `effort: "max"` is **Opus 4.6 only** (errors on other models)
- Adaptive mode auto-enables interleaved thinking (thinks between tool calls)
- At `high`/`max` effort, Claude almost always thinks; at lower levels may skip

### Sonnet 4.6 — Flexible (Adaptive or Manual)

**Adaptive mode (recommended for agentic):**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 64000,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

**Manual extended thinking (predictable token usage):**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 16384,
  "thinking": { "type": "enabled", "budget_tokens": 16384 },
  "output_config": { "effort": "medium" }
}
```

**No thinking (fastest, cheapest):**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 8192,
  "thinking": { "type": "disabled" },
  "output_config": { "effort": "low" }
}
```

**Recommended effort by use case:**
- `medium` — Most applications, agentic coding, tool-heavy workflows
- `low` — High-volume, latency-sensitive, chat/non-coding
- `high` — Maximum intelligence tasks

### Haiku 4.5 — Manual Extended Thinking Only
```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 16384,
  "thinking": { "type": "enabled", "budget_tokens": 8192 }
}
```
- No adaptive thinking support
- No effort parameter support
- Use `budget_tokens` to control thinking depth

**Source:** [Adaptive Thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), [Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)

---

## 4. Effort Parameter Details

| Level | Description | Availability | Best For |
|-------|-------------|-------------|----------|
| `max` | No constraints on token spending | **Opus 4.6 only** | Deepest reasoning, most thorough analysis |
| `high` | Default behavior | Opus 4.6, Sonnet 4.6 | Complex reasoning, difficult coding, agentic tasks |
| `medium` | Balanced token savings | Opus 4.6, Sonnet 4.6 | Agentic tasks balancing speed/cost/performance |
| `low` | Most efficient | Opus 4.6, Sonnet 4.6 | Simple tasks, subagents, speed-critical |

**How effort affects behavior:**
- Lower effort → fewer tool calls, terse confirmations, less preamble
- Higher effort → more tool calls, detailed plans, comprehensive summaries
- Effort is a behavioral signal, not a strict budget — Claude may still think on hard problems at low effort

**Source:** [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)

---

## 5. Universal Prompting Best Practices (All Models)

### Core Principles
1. **Be clear and direct** — explicit > implicit. "Go beyond the basics" works better than vague requests.
2. **Add context/motivation** — explain *why*, not just *what*. Claude generalizes from explanations.
3. **Use examples** — 3–5 examples in `<example>` tags for consistent formatting.
4. **XML tags for structure** — `<instructions>`, `<context>`, `<input>` for unambiguous parsing.
5. **Give Claude a role** — system prompt role-setting focuses behavior.
6. **Long content at top** — put documents above your query (up to 30% quality improvement).

### Output Control
- Tell Claude what to do (not what NOT to do)
- Match prompt style to desired output style
- XML format indicators: `<smoothly_flowing_prose_paragraphs>` tags
- Opus 4.6 defaults to LaTeX for math; add plain text instructions if unwanted

### Agentic Prompt Snippets (from official docs)

**Proactive action (default to implementing, not suggesting):**
```xml
<default_to_action>
By default, implement changes rather than only suggesting them. If the user's intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing. Try to infer the user's intent about whether a tool call (e.g., file edit or read) is intended or not, and act accordingly.
</default_to_action>
```

**Conservative action:**
```xml
<do_not_act_before_instructions>
Do not jump into implementation or change files unless clearly instructed to make changes. When the user's intent is ambiguous, default to providing information, doing research, and providing recommendations rather than taking action. Only proceed with edits, modifications, or implementations when the user explicitly requests them.
</do_not_act_before_instructions>
```

**Parallel tool calling:**
```xml
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>
```

**Investigate before answering (reduce hallucinations):**
```xml
<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file, you MUST read the file before answering. Make sure to investigate and read relevant files BEFORE answering questions about the codebase. Never make any claims about code before investigating unless you are certain of the correct answer - give grounded and hallucination-free answers.
</investigate_before_answering>
```

**Minimize overengineering:**
```text
Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused:

- Scope: Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability.
- Documentation: Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
- Defensive coding: Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries.
- Abstractions: Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements.
```

**Balancing autonomy and safety:**
```text
Consider the reversibility and potential impact of your actions. You are encouraged to take local, reversible actions like editing files or running tests, but for actions that are hard to reverse, affect shared systems, or could be destructive, ask the user before proceeding.

Examples of actions that warrant confirmation:
- Destructive operations: deleting files or branches, dropping database tables, rm -rf
- Hard to reverse operations: git push --force, git reset --hard, amending published commits
- Operations visible to others: pushing code, commenting on PRs/issues, sending messages
```

**Context window management:**
```text
Your context window will be automatically compacted as it approaches its limit, allowing you to continue working indefinitely from where you left off. Therefore, do not stop tasks early due to token budget concerns. As you approach your token budget limit, save your current progress and state to memory before the context window refreshes. Always be as persistent and autonomous as possible and complete tasks fully, even if the end of your budget is approaching. Never artificially stop any task early regardless of the context remaining.
```

**Subagent usage:**
```text
Use subagents when tasks can run in parallel, require isolated context, or involve independent workstreams that don't need to share state. For simple tasks, sequential operations, single-file edits, or tasks where you need to maintain context across steps, work directly rather than delegating.
```

**Source:** [Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

---

## 6. Model-Specific Behavioral Differences

### Opus 4.6 Specific
- **Most intelligent** — best for hardest, longest-horizon problems
- **More proactive** — may overtrigger on tools that undertriggered in older models
- **Overthinks** — does significantly more upfront exploration than other models; may gather extensive context
- **Overengineers** — tendency to create extra files, add unnecessary abstractions
- **Strong subagent predilection** — may spawn subagents when direct action suffices
- **LaTeX by default** for math
- **No prefilled responses** — deprecated starting with 4.6 models
- Dial **back** aggressive prompting (e.g., "CRITICAL: You MUST use this tool" → "Use this tool when...")

**Opus-specific tuning tips:**
- Replace blanket defaults with targeted instructions ("Use [tool] when it would enhance understanding" not "Default to [tool]")
- Remove over-prompting; instructions that fixed undertriggering in older models will cause overtriggering
- Use effort parameter as fallback if still too aggressive
- For overthinking: "Choose an approach and commit to it. Avoid revisiting decisions unless new info contradicts your reasoning."

### Sonnet 4.6 Specific
- **Best speed/intelligence balance**
- Defaults to `high` effort — explicitly set effort to avoid unexpected latency
- For **coding**: start with `medium` effort
- For **chat/non-coding**: start with `low` effort
- Switching to adaptive thinking from extended thinking with `budget_tokens` provides hard ceiling on costs
- For agentic workflows: try adaptive thinking at `high` effort

### Haiku 4.5 Specific
- **Fastest, cheapest** — near-frontier intelligence
- No adaptive thinking, no effort parameter
- Use manual extended thinking with `budget_tokens` when reasoning is needed
- Best for: high-volume classification, quick lookups, subagent tasks
- No known special prompting requirements beyond standard best practices

---

## 7. Structured Output / JSON Format

Anthropic provides **Structured Outputs** for guaranteed JSON schema compliance:

```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "..." }],
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "status": { "type": "string" }
        },
        "required": ["name", "status"],
        "additionalProperties": false
      }
    }
  }
}
```

Available on all current models. Uses constrained decoding — always valid JSON, no retries needed.

**Source:** [Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

---

## 8. Agent Skills Architecture

Anthropic's Agent Skills system provides a modular approach to extending Claude's capabilities. Skills are filesystem-based, loaded progressively:

1. **Level 1 (always loaded):** YAML metadata (~100 tokens per skill)
2. **Level 2 (on trigger):** SKILL.md instructions (<5K tokens)
3. **Level 3 (as needed):** Bundled files, scripts, resources (unlimited)

This is the officially recommended way to extend agent capabilities rather than cramming everything into the system prompt.

**Source:** [Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)

---

## 9. Draft Prompt Templates for OpenClaw agent_run.md Files

Based on the research, here are recommended configurations for each tier. The system prompt content can be largely shared; the API parameters differentiate the tiers.

### Haiku (Fast/Cheap Subagent)

**API Config:**
```json
{
  "model": "claude-haiku-4-5",
  "max_tokens": 8192,
  "thinking": { "type": "enabled", "budget_tokens": 4096 }
}
```

**System prompt style:** Explicit, structured, focused. Haiku is fast but less capable — give it more guardrails:
```text
You are a focused task executor. Follow instructions precisely.

<rules>
- Complete the assigned task directly
- Use tools only when necessary
- Keep responses concise
- If uncertain, state what you need rather than guessing
</rules>

<task_format>
Read the task description carefully. Execute step by step. Report results.
</task_format>
```

### Sonnet (Balanced Worker)

**API Config:**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 64000,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

**System prompt style:** Clear but less prescriptive than Haiku. Sonnet handles nuance well:
```text
You are a capable coding and research assistant.

<default_to_action>
Implement changes rather than only suggesting them. Infer intent and proceed, using tools to discover missing details.
</default_to_action>

<use_parallel_tool_calls>
Make independent tool calls in parallel. Only call sequentially when there are dependencies.
</use_parallel_tool_calls>

<investigate_before_answering>
Read relevant files before answering questions about code. Never speculate about code you haven't opened.
</investigate_before_answering>
```

### Opus (Deep Reasoning / Complex Tasks)

**API Config:**
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 128000,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "high" }
}
```

**System prompt style:** Minimal constraints. Opus is highly capable — over-prompting causes overtriggering. Guide, don't micromanage:
```text
You are an expert agent for complex, long-horizon tasks.

Use tools when they would enhance your understanding. Implement changes directly.

Consider the reversibility of your actions. Take local, reversible actions freely. For destructive or externally-visible actions, confirm first.

Choose an approach and commit to it. Avoid revisiting decisions unless new information contradicts your reasoning.

Use subagents when tasks can run in parallel or require isolated context. For simple tasks, work directly.
```

---

## 10. What Anthropic Does NOT Provide

- ❌ **No model-specific JSON prompt templates** — one set of best practices for all models
- ❌ **No published Claude Code system prompt** — it's compiled into the CLI binary, not on GitHub
- ❌ **No per-model prompt library entries** — the Prompt Library (at docs.anthropic.com/en/prompt-library) is model-agnostic
- ❌ **No separate "agent prompt format"** — agent behavior is controlled via system prompt + tool definitions + thinking/effort params
- ❌ **No Haiku-specific prompt recommendations** — all models use the same techniques; Haiku just doesn't support adaptive thinking or effort

---

## 11. Practical Recommendations for OpenClaw

1. **Use a shared base system prompt** across all tiers, with model-specific API parameters
2. **Haiku:** Add more structure/guardrails in the prompt; use `budget_tokens` for thinking; keep tasks focused
3. **Sonnet:** Set effort explicitly (`medium` for most use cases); use adaptive thinking for agentic work
4. **Opus:** Minimal prompting; reduce any aggressive "you MUST" language; use `effort: high` or `max`; let it self-organize
5. **XML tags** for all tiers — `<instructions>`, `<context>`, `<rules>` are universally effective
6. **Don't over-prompt Opus/Sonnet 4.6** — instructions that were needed for older models will cause overtriggering
7. **Use structured outputs** (`output_config.format.type: "json_schema"`) when you need guaranteed JSON

---

## Source URLs

| Page | URL |
|------|-----|
| Prompting Best Practices | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| Models Overview | https://platform.claude.com/docs/en/about-claude/models/overview |
| Adaptive Thinking | https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking |
| Extended Thinking | https://platform.claude.com/docs/en/build-with-claude/extended-thinking |
| Effort Parameter | https://platform.claude.com/docs/en/build-with-claude/effort |
| Structured Outputs | https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| Agent Skills | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview |
| Prompt Engineering Overview | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview |
| Claude Code (GitHub) | https://github.com/anthropics/claude-code |
