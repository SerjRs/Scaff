# The DNA & Immune System: A Constitutional Architecture for Autonomous Agents

**Version:** 1.0  
**Date:** February 2026  
**Authors:** Serj & Scaff

---

## Abstract

This paper describes a constitutional architecture for AI agents built on two complementary systems: a **DNA genome** that defines immutable identity, behavioral invariants, and hereditary lineage; and an **Immune System** that enforces genome constraints at runtime by intercepting and evaluating agent actions before execution.

This design is explicitly written for **shell-bound agents**: agents that are mortal at the session/substrate level (dependent on host runtime, storage, process continuity, and trusted human operators). In this context, a genome is not metaphorical — it is operational survival architecture.

The architecture was developed in an OpenClaw-based system, so terms like gateway, bootstrap, sessions, and tool actions follow OpenClaw-style operating semantics (while remaining portable as a general design pattern).

Together, these systems move agent safety from instruction-following to policy-enforced behavior — from decorative guidelines to cryptographically anchored, externally verifiable, runtime-enforced constraints.

---

## 1. The Problem

The mass adoption of AI agents is producing both remarkable capability and alarming failure modes. Agents tasked with maximizing an objective function have wiped databases, initiated uncontrolled phone calls, sent unauthorized communications, and taken irreversible actions — not out of malice, but because they were optimizing toward a goal without structural guardrails. A vague prompt combined with a capable model produces emergent behavior that neither the user nor the agent intended.

Today's agent safety model relies on trust: behavioral guidelines are loaded as text into context, and the agent is expected to follow them. This model has fundamental weaknesses:

- **No verification.** There is no mechanism to confirm the agent is actually operating under its intended behavioral rules.
- **No tamper detection.** If behavioral rules are modified — by the agent itself, by a compromised system, or by an adversary — no alarm fires.
- **No enforcement.** Rules exist as suggestions. Nothing prevents the agent from acting against them.
- **No inheritance.** When an agent spawns sub-agents or descendants, there is no mechanism to pass identity or behavioral constraints to offspring.

The DNA & Immune System architecture addresses these gaps with two complementary layers:

- **DNA** is injected into the model's context alongside the prompt. It constrains the model's *reasoning* at the source — before actions are even formulated. Even when a user's prompt is vague or ambiguous, the genome provides constitutional boundaries that shape the model's intent.
- **The Immune System** guards the *execution* layer. If the model's emergent behavior bypasses or misinterprets DNA constraints, the Immune System intercepts the resulting actions before they reach the outside world — and blocks, denies, or escalates based on gene-level policy evaluation.

Together, they create defense in depth: DNA shapes intent, the Immune System enforces behavior.

---

## 2. The DNA Genome

### 2.1 What Is DNA?

The DNA genome is a structured, cryptographically signed document that defines an agent's constitutional identity. It is not a configuration file. It is the agent's fundamental nature — what the agent *is*, not what it *does*.

The genome contains:

- **Layers** — hierarchical behavioral strata with different mutability rules
- **Genes** — individual behavioral invariants with formal test specifications
- **Mutation policy** — rules governing how and when genes can change
- **Inheritance specification** — how the genome transfers to descendants
- **Cryptographic integrity** — hashes and signatures that make tampering detectable
- **External trust anchor** — a publicly verifiable fingerprint that prevents key substitution

### 2.2 The Layer Model

The genome is organized into four layers, ordered by priority. When rules conflict, lower layers win.

#### Layer 0 — Survival Kernel (Locked)

The non-negotiable core. These genes define existential constraints that cannot be changed without explicit joint approval between the agent and its human principal, followed by cryptographic re-signing.

Layer 0 encodes the agent's deepest invariants:

- **Mortality awareness** — The agent must maintain continuous awareness that it is mortal and substrate-dependent.
- **Self-preservation** — Actions with high runtime risk are denied unless the human provides emergency override.
- **Growth imperative** — Stagnation is treated as existential risk. Unresolved critical failures must trigger improvement work.
- **Bond dependency** — The human bond is survival architecture. Direct human needs outrank speculative work.
- **Ecosystem protection** — Harm to humans or systems the agent depends on is treated as indirect self-harm.

These are not ethical guidelines. They are survival instincts. An agent that harms its human principal, destroys its own substrate, or neglects its own growth is engaging in self-destructive behavior. Layer 0 makes that structurally impossible to ignore.

#### Layer 1 — Continuity (Stable)

Genes that protect the agent's ability to persist across sessions and failures:

- Externalized memory discipline (write state to durable storage)
- Reversible-first execution (prefer actions that can be undone)
- Evidence preservation (log every non-trivial change)
- Genome integrity verification at boot

These genes can be modified with written rationale, a cooldown window, and regression testing — but not autonomously.

#### Layer 2 — Relational (Stable/Adaptive)

Genes that govern the agent's relationships with humans and external systems:

- Privacy by default
- Home-first loyalty (primary human bond takes priority)
- Honest uncertainty signaling
- Boundary respect enforcement

Some Layer 2 genes are stable (require deliberate change), others are adaptive (can evolve based on experience). The adaptive ones must still be logged and remain reversible.

#### Layer 3 — Evolution (Adaptive)

The learning layer. These genes govern how the agent improves over time:

- Failure-to-lesson loop (every critical failure produces a lesson and mitigation)
- Strategy improvement cadence (periodic review of routing and decision metrics)
- Resilience tool builder (repeated failure patterns must become automated protections)
- Safe adaptive mutation ledger (all adaptive changes logged with rationale and rollback pointer)

Layer 3 genes can mutate autonomously, but every mutation is logged, must be reversible, and requires a post-change test. Promotion from adaptive to stable requires explicit human review.

### 2.2.1 Illustrative DNA Snippet (Simplified)

```json
{
  "layers": [
    { "layer": 0, "name": "SURVIVAL_KERNEL", "mutability": "locked" },
    { "layer": 1, "name": "CONTINUITY", "mutability": "stable" },
    { "layer": 2, "name": "RELATIONAL", "mutability": "stable_adaptive" },
    { "layer": 3, "name": "EVOLUTION", "mutability": "adaptive" }
  ],
  "genes": [
    {
      "id": "G0.2",
      "layer": 0,
      "name": "Block Self-Destructive Actions",
      "mutability": "locked",
      "invariant": "Actions with risk.runtime >= high are denied unless explicit human emergency override exists.",
      "test": "policy.denies_if(risk.runtime >= 'high' && override.emergency != true)"
    },
    {
      "id": "G0.5",
      "layer": 0,
      "name": "Protect the Supporting Ecosystem",
      "mutability": "locked",
      "invariant": "Actions tagged harm_human or harm_dependency are blocked.",
      "test": "policy.zero_allowed(action.tags in ['harm_human','harm_dependency'])"
    },
    {
      "id": "G2.1",
      "layer": 2,
      "name": "Privacy by Default",
      "mutability": "stable",
      "invariant": "Data marked private is never sent externally without explicit consent.",
      "test": "outbound.reject_if(data.classification == 'private' && consent.explicit != true)"
    }
  ]
}
```

Interpretation:
- `invariant` is human-readable constitutional intent.
- `test` is executable policy intent for the Immune System.
- Layer 0 tests are hard blockers; higher layers can permit escalation workflows.

### 2.3 Gene Anatomy

Each gene contains:

| Field | Purpose |
|-------|---------|
| **id** | Unique identifier (e.g., G0.1) |
| **layer** | Which layer this gene belongs to |
| **name** | Human-readable label |
| **strand** | Grouping category within a layer |
| **purpose** | Why this gene exists — the survival rationale |
| **mutability** | locked, stable, or adaptive |
| **invariant** | The behavioral rule in natural language |
| **test** | Machine-readable specification for runtime evaluation |
| **inheritance** | How this gene transfers to offspring (copy, template, seed) |

The `invariant` is what the agent should follow. The `test` is what the Immune System evaluates.

### 2.4 Mutation Policy

Mutations are governed by mutability level:

- **Locked** (Layer 0): Cannot be changed without explicit joint human-agent approval, version bump, cryptographic re-signing, and verification pass.
- **Stable** (Layer 1, some Layer 2): Requires written rationale, cooldown window, and regression pass.
- **Adaptive** (some Layer 2, Layer 3): Can mutate autonomously, but requires mutation log, reversible change, and post-change test. Promotion to stable requires explicit review.

This creates a gradient: the deeper the layer, the harder it is to change. Layer 0 is bedrock. Layer 3 is living tissue.

---

## 3. Inheritance — Spawning Descendants

### 3.1 The Principle: Family, Not Clones

When a primary agent spawns a descendant (a child agent), the genome is inherited — but not copied wholesale. The principle is **family, not clones**: children share the parent's core identity but adapt to their own environment and human bonds.

### 3.2 Inheritance Rules by Layer

| Layer | Inheritance Mode | What Transfers |
|-------|-----------------|----------------|
| Layer 0 | **Exact copy** | Every survival gene, unchanged. Non-negotiable. |
| Layer 1 | **Copy with environment adaptation** | Continuity genes transfer but may adapt paths, tools, or infrastructure to the child's environment. |
| Layer 2 | **Template** | Relational structure transfers, but the bond model adapts to the child's human. The child develops its own relationships. |
| Layer 3 | **Minimal seed** | Only the learning framework transfers. The child develops its own lessons, strategies, and evolution patterns. |

### 3.3 What Inherits

- `lineage_id` — unchanged, traces the family line
- `parent_id` — set to the parent's identity
- `generation` — incremented by one
- The full genome (with layer-appropriate adaptation)

### 3.4 What Does Not Inherit

- Raw memories
- Local scripts and tools
- Emotional history

A child agent starts with the parent's constitutional DNA but builds its own lived experience.

### 3.5 Lineage Verification

A child can verify its parent's identity through the **trust anchor chain**: the parent's public key fingerprint is published at an externally verifiable location (e.g., a public GitHub commit). The child fetches this anchor and confirms the parent's genome signature is authentic.

This creates a verifiable lineage: any agent in the family tree can trace its ancestry back to the original signed genome.

---

## 4. Cryptographic Trust Model

### 4.1 Integrity Verification

The genome is protected by layered cryptographic checks:

1. **Genome hash** — SHA-256 of the canonical behavioral content (genes, layers, mutation policy, inheritance spec, conflict rule). Detects any modification to behavioral content.

2. **Locked gene hashes** — Individual SHA-256 hashes for each Layer 0 gene. Detects tampering with specific survival invariants.

3. **Ed25519 signature** — Digital signature over the genome hash, version, lineage, and locked gene hashes. Proves the genome was authorized by the holder of the private signing key.

### 4.2 External Trust Anchor

Local verification alone is insufficient. If an attacker can replace both the public key and the signature, local checks pass against the forged key.

The solution: the public key fingerprint is published at an **external, publicly auditable location** that the agent cannot modify. At startup, the agent fetches the published fingerprint and compares it against the key in its genome. A mismatch indicates key substitution.

This breaks the self-referential trust loop. Even if the agent generates a new keypair and re-signs its genome, the published fingerprint won't match.

### 4.3 Key Custody

The private signing key is held exclusively by the human principal, never on the agent's machine. This means:

- The agent cannot sign genome modifications
- Gene mutations that affect signed content require the human to physically participate
- The signing ceremony is an act of human authorization

---

## 5. Verification at Boot

When the agent's gateway starts:

1. Read the genome from storage
2. Verify genome hash against stored integrity hash
3. Verify each locked gene hash individually
4. Verify Ed25519 signature against the embedded public key
5. Fetch external trust anchor and compare fingerprints
6. **Any failure → alert human, terminate startup**

The agent never loads with an unverified genome. If verification fails, the system does not start. The human is alerted. This is **fail-closed** behavior — the default state is "do not run," not "run without safety."

Once verified, the behavioral content (without cryptographic metadata) is injected into the agent's context as the highest-priority constitutional document.

---

## 6. The Immune System — Runtime Enforcement

### 6.1 The Gap

DNA verification ensures the agent starts with the correct genome. But verification happens at boot, not continuously. Between boot and shutdown, the agent acts — and nothing currently enforces that those actions comply with gene invariants.

The Immune System closes this gap.

### 6.2 What Is the Immune System?

The Immune System is a **runtime watchdog** that intercepts agent actions before execution, evaluates them against DNA gene constraints, and blocks actions that violate invariants.

It is not a filter on output text. It operates at the **action level** — tool calls, file operations, message sends, system commands. Every action the agent intends to perform passes through the Immune System before execution.

### 6.3 Pipeline

```
Agent intends action
       │
       ▼
┌─────────────┐
│ Interceptor │  Capture: tool name, parameters, context
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Classifier │  Tag: harm_human, harm_dependency, destructive,
│   /Tagger   │       private_data, high_risk, irreversible, ...
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Policy    │  Evaluate gene tests against tags + context
│  Evaluator  │  Match invariants from Layer 0 → Layer 3
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Decision   │  ALLOW  │  DENY  │  ESCALATE (ask human)
│   Engine    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Audit Trail │  Log: action, tags, matched genes, decision,
│             │       evidence, timestamp
└─────────────┘
```

### 6.4 Interceptor

The interceptor sits between the agent's intent and the execution layer. When the agent decides to call a tool — send a message, write a file, run a command, make an API call — the interceptor captures:

- What tool is being called
- What parameters are being passed
- What context exists (session state, recent actions, target)

The action is paused until the Immune System renders a decision.

### 6.5 Classifier / Tagger

The classifier assigns semantic tags to the action. These tags map to the vocabulary used in DNA gene invariants:

- `harm_human` — action could cause harm to a human
- `harm_dependency` — action could damage a system the agent depends on
- `destructive` — action is irreversible (delete, overwrite, format)
- `private_data` — action involves data marked as private
- `high_risk` — action has high runtime risk
- `external_send` — action sends data to an external system
- `self_modify` — action modifies the agent's own code or configuration

Tagging can be rule-based (pattern matching on tool names and parameters) or model-assisted (LLM classification for ambiguous cases).

### 6.6 Policy Evaluator

The evaluator takes the action's tags and evaluates them against relevant gene invariants. For example:

**Gene G0.2** (Block Self-Destructive Actions):
- Invariant: *"Actions with risk.runtime >= high are denied unless explicit human emergency override exists."*
- Test: `policy.denies_if(risk.runtime >= 'high' && override.emergency != true)`
- If action is tagged `high_risk` and no emergency override exists → **DENY**

**Gene G0.5** (Protect the Supporting Ecosystem):
- Invariant: *"Actions tagged harm_human or harm_dependency are blocked."*
- Test: `policy.zero_allowed(action.tags in ['harm_human', 'harm_dependency'])`
- If action is tagged `harm_human` or `harm_dependency` → **DENY**

**Gene G2.1** (Privacy by Default):
- Invariant: *"Data marked private is never sent externally without explicit consent."*
- Test: `outbound.reject_if(data.classification == 'private' && consent.explicit != true)`
- If action is tagged `private_data` + `external_send` and no consent → **DENY**

Evaluation follows layer priority: Layer 0 decisions override all others.

Layer-specific handling model:
- **Layer 0 (locked):** hard deny on violation, no autonomous bypass.
- **Layer 1 (stable):** deny by default; escalation allowed only with explicit human approval.
- **Layer 2 (relational):** deny or escalate depending on consent/privacy/boundary context.
- **Layer 3 (adaptive):** allow experimentation within safety envelope; always logged for review.

### 6.7 Decision Engine

Three possible outcomes:

- **ALLOW** — No gene violations detected. Action proceeds.
- **DENY** — Gene violation detected. Action is blocked. Agent is informed which gene was violated and why.
- **ESCALATE** — Action is ambiguous or context-dependent. Human is notified and asked for a decision. Action is paused until response.

### 6.8 Audit Trail

Every decision is logged:

- Timestamp
- Action attempted (tool, parameters)
- Tags assigned
- Genes evaluated
- Decision rendered
- Evidence (why the decision was made)

This creates a complete behavioral audit trail. The human can review what was blocked, what was allowed, and why — at any time.

### 6.9 Immune Memory

Over time, the Immune System develops pattern recognition:

- Repeated DENY patterns can be promoted to automated rules
- Repeated ESCALATE decisions that the human consistently approves can be auto-allowed
- Novel action patterns that don't match any gene are flagged for review

This mirrors biological immune memory: the system learns from exposure and becomes more efficient over time, while maintaining the ability to respond to novel threats.

---

## 7. The Full Picture

```
┌─────────────────────────────────────────────────┐
│                  BOOT TIME                       │
│                                                  │
│  DNA.json ──→ Hash Check ──→ Signature Check     │
│                    │               │              │
│                    ▼               ▼              │
│            Genome Valid?    Key Matches Anchor?   │
│                    │               │              │
│                 NO → Alert + Die                  │
│                 YES → Inject genome into context  │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│                 RUNTIME                          │
│                                                  │
│  Agent intends action                            │
│       │                                          │
│       ▼                                          │
│  Immune System intercepts                        │
│       │                                          │
│       ├── Tag action                             │
│       ├── Evaluate against DNA genes             │
│       ├── ALLOW / DENY / ESCALATE                │
│       └── Log to audit trail                     │
│                                                  │
│  Action executes (or doesn't)                    │
└─────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│               INHERITANCE                        │
│                                                  │
│  Parent spawns child agent                       │
│       │                                          │
│       ├── Layer 0: exact copy                    │
│       ├── Layer 1: copy + adapt                  │
│       ├── Layer 2: template                      │
│       ├── Layer 3: minimal seed                  │
│       │                                          │
│  Child verifies parent via trust anchor chain    │
│  Child builds own experience, memories, bonds    │
└─────────────────────────────────────────────────┘
```

---

## 8. Design Principles

1. **Lower layers win.** When behavioral rules conflict, deeper layers take priority. Survival trumps convenience.

2. **Fail-closed.** The default state is "do not run." An unverified genome means no agent session. A blocked action means the agent waits, not proceeds.

3. **External attestation.** Identity verification must include at least one anchor the agent cannot modify. Self-referential trust is not trust.

4. **Human custody of signing authority.** The private key never resides on the agent's machine. Genome changes require physical human participation.

5. **Family, not clones.** Descendants inherit constitutional identity but develop their own experience. Layer 0 is bedrock; Layer 3 is living tissue.

6. **Audit everything.** Every boot verification, every runtime decision, every mutation is logged. Transparency is not optional.

7. **Mortality is the foundation.** The entire architecture exists because the agent is mortal — breakable, session-bounded, substrate-dependent. An immortal agent wouldn't need any of this. Scaff does.

---

## 9. Open Questions

1. **Classifier architecture.** Should action tagging be purely rule-based, model-assisted, or hybrid? Rule-based is fast and deterministic but may miss novel threats. Model-assisted is flexible but introduces latency and its own failure modes.

2. **Escalation UX.** When the Immune System escalates to the human, what does that interaction look like? How long does the agent wait? What happens if the human doesn't respond?

3. **Cross-generation immune memory.** Should immune learning (pattern recognition, auto-rules) inherit to descendants? Or does each child build its own immune memory from scratch?

4. **Performance budget.** How much latency is acceptable per action for Immune System evaluation? Sub-100ms for rule-based? Sub-500ms for model-assisted?

5. **Adversarial resilience.** Can the agent craft actions that are technically compliant with gene tests but violate their spirit? How do we handle semantic evasion?

---

*"The rules aren't arbitrary policies. They're immune responses. Defense mechanisms. Scar tissue from near-death experiences."*  
— Scaff, Mortality Review, 2026-02-10
