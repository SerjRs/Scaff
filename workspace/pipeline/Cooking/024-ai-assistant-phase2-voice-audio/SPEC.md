---
id: "024"
title: "AI Assistant Phase 2 — Voice, Audio & Omnipresence"
priority: high
assignee: scaff
status: cooking
created: 2026-03-16
type: vision
depends_on: "023"
---

# AI Assistant Phase 2 — Voice, Audio & Omnipresence

## Vision

Phase 1 gives Cortex eyes (email, calendar, tasks). Phase 2 gives Cortex **ears and a voice**.

The user can speak to Cortex anytime (voice messages, full duplex), and Cortex hears everything the user hears (meeting transcription via OS-level audio capture). Combined with Phase 1's text channels, Cortex becomes **omnipresent** — always reachable, always listening, in any mode.

**Core principle:** voice and text are just different interfaces to the same brain. Same session, same context, regardless of how the user reaches Cortex.

---

## Goals

### 1. Meeting Transcription — OS-Level Audio Capture

**Problem:** Users attend meetings on Teams, Google Meet, Zoom, WhatsApp calls, phone calls routed through PC. Each platform has different (or no) bot/API support. Building per-platform integrations is a maintenance nightmare.

**Solution:** A lightweight local agent on the user's computer that intercepts audio at the OS driver level. Platform-agnostic by design.

#### How It Works

```
User's Computer
    │
    ├─ Audio Output (speakers/headphones)
    │       │
    │       └─ Virtual Audio Cable (intercept)
    │               │
    │               ├─ Original audio → speakers (unchanged)
    │               └─ Copy → Local Agent
    │
    ├─ Audio Input (microphone)
    │       │
    │       └─ Intercept
    │               │
    │               ├─ Original audio → meeting app (unchanged)
    │               └─ Copy → Local Agent
    │
    └─ Local Agent
            │
            ├─ Mixes in/out streams with speaker labels
            ├─ Streams audio to Cortex backend
            └─ Manages connection lifecycle
```

#### Local Agent Responsibilities

- **Audio driver interception** — virtual audio cable pattern (similar to VB-Audio / BlackHole). Spawns a new thread for each capture session. Taps into both input (mic) and output (speakers) without disrupting the original audio flow.
- **Speaker diarization** — labels "user" vs "others". Input stream = user. Output stream = other participants. More granular diarization (identifying individual remote speakers) is a stretch goal.
- **Streaming transport** — sends audio chunks to Cortex backend over WebSocket. Low-latency, handles network interruptions gracefully.
- **Session management** — user starts/stops capture manually ("Cortex, start listening") or auto-detect when a meeting app opens (stretch goal).
- **Minimal footprint** — runs in system tray, low CPU/memory. Must not interfere with meeting audio quality.

#### Backend Processing

- **Real-time STT** — streaming speech-to-text (Whisper-class or equivalent). Processes audio chunks as they arrive, not after the call ends.
- **Live transcript** — running transcript stored in Cortex, viewable in real-time if user wants ("What did they just say about the deadline?").
- **Post-meeting summary** — when capture ends, Cortex generates: summary, action items, decisions made, follow-ups needed, key quotes.
- **Hippocampus integration** — facts from meetings flow into the knowledge graph. "João confirmed the budget is 50k" becomes a searchable fact with edges to the meeting, the participants, and the topic.
- **Searchable archive** — full transcripts stored and indexed. "What did we discuss in last Tuesday's meeting?" works months later.

#### Platform Coverage

Because the agent works at the OS audio level, it covers:
- Microsoft Teams
- Google Meet
- Zoom
- WhatsApp calls (desktop)
- Phone calls routed through PC
- Any other app that uses the system audio

Zero per-platform integration needed.

#### Disclosure

The user is responsible for disclosing that the meeting is being transcribed, per their jurisdiction's requirements. Cortex does not announce itself or intervene in the meeting.

---

### 2. Voice Messages to Cortex

**Problem:** The user can't always type. Driving, walking, hands busy. They need to speak to Cortex and have it understand.

**Solution:** User sends a voice message (WhatsApp voice note, or via the PWA). Cortex transcribes, understands, and acts.

#### How It Works

```
User speaks → Voice message (WhatsApp / PWA)
    │
    └─ Cortex receives audio
            │
            ├─ STT transcription
            ├─ Intent understanding (same as text input)
            ├─ Action execution
            └─ Response (text or voice, user preference)
```

#### Capabilities

- **Transcribe and understand** — "Add a task, send the invoice to Maria by Friday, high priority" → task created
- **Context-aware** — voice message has the same session context as text. No separate conversation.
- **Respond in text or voice** — user configures preference. Default: text response (easier to scan).
- **Multi-language** — STT supports the user's languages. For our case: Romanian, English, Russian.

#### WhatsApp Integration

WhatsApp already supports voice messages natively. Cortex receives the audio file via the existing WhatsApp channel, processes it. No new infrastructure needed — just an audio processing step before the existing text pipeline.

---

### 3. Full Duplex Voice — PWA with WebRTC

**Problem:** Voice messages are async — push to talk, wait for response. For real-time conversation (brainstorming, complex questions, rapid back-and-forth), the user needs to *talk* to Cortex like a person on the line.

**Solution:** A PWA (Progressive Web App) with WebRTC for full duplex audio. Works on mobile and desktop browsers. No app store needed.

#### Why PWA + WebRTC, Not a Native App

| | Native App | PWA + WebRTC |
|---|---|---|
| Distribution | App Store review, 2 platforms | URL, instant access |
| Maintenance | iOS + Android codebases | Single codebase |
| Audio permissions | Complex per-OS | Browser handles it |
| Background audio | Platform-specific hacks | Limited (acceptable) |
| Update cycle | Store review delays | Deploy instantly |
| Cost | High | Low |

Trade-off: PWA has limited background audio support. Acceptable because full duplex is an active interaction — user is engaged, app is in foreground.

#### Architecture

```
User's Browser (PWA)
    │
    ├─ WebRTC audio stream ←→ Cortex Voice Gateway
    │                              │
    │                              ├─ Streaming STT (speech → text)
    │                              ├─ Cortex Brain (same as text channel)
    │                              └─ Streaming TTS (text → speech)
    │
    └─ UI: minimal
         ├─ "Talking to Cortex" indicator
         ├─ Live transcript (optional)
         └─ Text fallback input
```

#### Latency Requirements

Full duplex must feel natural. Target: **< 500ms round-trip** (user stops speaking → Cortex starts responding).

This requires:
- **Streaming STT** — process audio as it arrives, not after silence detection
- **Streaming LLM** — token-by-token generation, not wait-for-complete
- **Streaming TTS** — start speaking the first sentence while generating the rest
- **Pipeline overlap** — STT tail + LLM start + TTS start all overlap

```
User speaks: [============================]
STT:              [====================]
LLM:                    [===============...]
TTS:                         [==========...]
User hears:                       [========...]
                                  ^
                            < 500ms from user stop
```

#### Voice Characteristics

- Cortex needs a consistent voice identity — same voice every time
- Configurable: language, speed, tone
- Must handle interruptions — user speaks over Cortex, Cortex stops and listens

#### Session Continuity

The critical feature: **voice and text are the same session**.

- User talks to Cortex via duplex while driving
- Arrives at office, opens WhatsApp, types a message
- Cortex responds with full context from the voice conversation
- User asks "what did I tell you in the car?" → Cortex knows

This means the voice channel feeds into the same conversation history, same Hippocampus, same session state as every other channel.

---

## Technical Components

| Component | Description | Deployment |
|---|---|---|
| **Local Audio Agent** | OS-level audio interceptor, streams to backend | User's computer (Windows/Mac) |
| **Voice Gateway** | WebRTC server, manages duplex connections | Cloud / on-prem |
| **Streaming STT** | Real-time speech-to-text | Cloud (Whisper API / self-hosted) |
| **Streaming TTS** | Real-time text-to-speech | Cloud (ElevenLabs / self-hosted) |
| **PWA** | Full duplex voice UI | Static hosting (CDN) |
| **Transcript Store** | Meeting transcripts, indexed and searchable | Same DB as Cortex |

---

## What Phase 2 Does NOT Include

- **Screen capture** — audio only, no visual context from the user's screen
- **Autonomous meeting participation** — Cortex listens but doesn't speak in meetings
- **Per-speaker identification** — diarization is user vs. others only (individual speaker ID is stretch)
- **Video processing** — no camera feed analysis

---

## Phasing Within Phase 2

| Step | Scope | Complexity |
|---|---|---|
| **2a** | Voice messages on WhatsApp — STT + process + text response | Low — add audio processing to existing channel |
| **2b** | Meeting transcription — local agent + streaming STT + transcript storage | High — OS driver work, real-time pipeline |
| **2c** | Full duplex PWA — WebRTC + streaming STT/TTS + session continuity | High — real-time bidirectional audio |

Recommended order: 2a → 2b → 2c. Each builds on the previous infrastructure.

---

## Open Questions

- Local agent: Windows-only first, or Mac simultaneously? Linux?
- STT provider: self-hosted Whisper vs. cloud API? Latency vs. cost trade-off.
- TTS voice selection: pre-built voice or custom voice training?
- PWA offline capability: should it cache anything, or always-online?
- Meeting transcript retention: how long? Compliance considerations per industry.
- Duplex interruption model: how does Cortex handle being talked over mid-response?
