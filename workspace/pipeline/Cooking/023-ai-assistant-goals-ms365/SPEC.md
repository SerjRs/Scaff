---
id: "023"
title: "AI Assistant Goals — MS365 Integration & Core Capabilities"
priority: high
assignee: scaff
status: cooking
created: 2026-03-16
type: vision
---

# AI Assistant Goals — MS365 Integration & Core Capabilities

## Vision

Cortex is a **personal chief of staff** — a persistent, context-aware assistant that any professional can use regardless of technical ability. It communicates through familiar channels (WhatsApp, Teams), learns from the user's domain knowledge, and operates inside the corporate perimeter.

The key insight: **the channel IS the UI**. Non-tech users don't want dashboards. They text their assistant and get answers.

---

## Why MS365 Integration First

Every capability Cortex offers depends on **knowing the user's world**. Without data, a daily briefing is empty. The question is: where does the data come from?

### The Problem with API Connectors
- OAuth per user — IT friction, user confusion
- Every org uses a different tool stack
- Maintenance burden: 15 connectors for 15 tools
- Data leaves the user's control flow

### The MS365 Solution
Give the AI its own corporate account (email, calendar, tasks) managed by IT. Use Exchange transport rules to BCC the user's email flow to the AI inbox.

**This gives Cortex everything passively:**

| Source | How it flows | What Cortex gets |
|---|---|---|
| Email (inbound + outbound) | BCC transport rule → AI mailbox | Full communication history |
| Calendar | Delegate access or invite forwarding | User's schedule, meeting participants |
| Tasks | Shared lists via Planner/To Do | User's task backlog |
| Contacts | Global Address List (GAL) | Org directory, who is who |

### Why This Works for Enterprise

- **Zero user effort** — BCC rule is set once at admin level. User changes nothing.
- **Stays inside corporate perimeter** — data never leaves MS365 tenant.
- **Compliance-friendly** — IT controls, audits, and can revoke access instantly.
- **Department-agnostic** — same setup for sales, accounting, HR, marketing.
- **Revocable** — disable the transport rule and the AI goes dark.

### Architecture

```
User's MS365 mailbox
    │
    ├─ BCC transport rule ──→ AI's MS365 mailbox
    │                              │
    │                              ├─ Email Reader   (Graph API)
    │                              ├─ Calendar Reader (Graph API)
    │                              └─ Task Manager   (Graph API)
    │
    └─ WhatsApp / Teams ────→ Cortex (conversation channel)
                                   │
                                   └─ Internal Knowledge Store
                                        ├─ Emails (indexed, triaged)
                                        ├─ Calendar events
                                        ├─ Tasks + deadlines
                                        ├─ Hippocampus (knowledge graph)
                                        └─ Library (user-trained knowledge)
```

---

## Core Goals

### 1. Daily Briefing

Every morning, Cortex pushes a digest to the user's channel — unprompted.

**Contents:**
- Today's calendar: meetings, times, participants, locations
- Overdue tasks and approaching deadlines
- Overnight email summary: what came in, what's urgent, what needs a reply
- Follow-ups due today ("You said you'd send the proposal to Maria by today")
- Anything Cortex proactively noticed (e.g., conflicting meetings, a deadline moved)

**Why it matters:** Replaces the user opening 5 apps every morning. One message, full picture.

### 2. Reminders & Nudges

Cortex tracks commitments and deadlines across all data sources and nudges the user at the right time.

**Types:**
- **Time-based** — "Remind me at 9am to call the bank" → fires at 9am
- **Deadline-based** — task due Friday → Cortex nudges Thursday if not marked done
- **Follow-up-based** — email sent 3 days ago with no reply → "Still waiting on João's response about the budget"
- **Meeting prep** — 15 min before a meeting, Cortex sends context: who's attending, last emails with them, relevant notes
- **Recurring** — "Every Monday, remind me to submit the weekly report"

**Why it matters:** Things stop falling through the cracks. Cortex is the user's external memory.

### 3. Email Triage & Summarization

Cortex reads incoming email (via BCC) and categorizes it:

- **Priority classification** — urgent / needs reply / FYI / spam
- **Summary extraction** — one-line summary per email, action items highlighted
- **Thread context** — "This is the 4th message in the invoice dispute with Vendor X"
- **Draft replies** — user says "reply to Maria's email, confirm the meeting" → Cortex drafts, user approves

**Why it matters:** Email is 2+ hours/day for most professionals. Even a 30% reduction is massive.

### 4. Task Management

Cortex maintains the user's task list through natural conversation:

- "Add task: review Q1 financials, due Wednesday, high priority"
- "What are my open tasks?"
- "Mark the proposal task as done"
- "What's overdue?"

Tasks are stored internally and optionally synced to MS365 Planner/To Do. Cortex tracks status, deadlines, and priorities — and nags when things slip.

### 5. Research & Knowledge Work

User asks Cortex to investigate a topic:

- "Research EU compliance changes for Q2"
- Cortex searches, reads, summarizes, stores findings in the Library
- User can drill deeper: "Tell me more about Article 5"
- Results persist — Cortex learns the domain over time

### Contact & Relationship Memory → Hippocampus

This is **not a separate system** — it's a natural extension of the existing Hippocampus knowledge graph.

MS365 becomes a new **fact source** feeding the same graph:

```
MS365 GAL ────────────→ Hippocampus (structured facts: name, title, department)
Email threads ────────→ Hippocampus (relationship edges: discussed X with Y on date)
Calendar events ──────→ Hippocampus (interaction history: met 3 times this month)
Conversations ────────→ Hippocampus (already works today)
```

When the user asks "who is João?" — Hippocampus answers from all sources. No separate contact module needed.

---

## What Cortex Does NOT Do (Boundaries)

- **Does not send emails autonomously** — drafts only, user approves
- **Does not make decisions** — surfaces information, user decides
- **Does not access data outside its granted scope** — only what IT provisions
- **Does not store data outside the corporate perimeter** (when deployed on-prem / private cloud)

---

## Phasing

| Phase | Scope |
|---|---|
| **Phase 1** | Internal task/calendar/reminder system via conversation. No external integrations. Cortex is the source of truth. |
| **Phase 2** | MS365 integration: email ingestion (BCC), calendar sync, GAL → Hippocampus. Daily briefing goes live. |
| **Phase 3** | Meeting transcription (real-time audio → text → summary → action items). Advanced email workflows (draft & send with approval). |
| **Phase 4** | Multi-department specialization. Department-specific skills, SOPs, templates. |

---

## Open Questions

- Retention policy for ingested emails — how long, how much to process deeply vs. skim?
- On-prem vs. cloud deployment model for enterprise customers?
- Per-user Cortex instance or shared instance with user isolation?
- How to handle confidential/sensitive emails in the BCC flow? (HR, legal)
