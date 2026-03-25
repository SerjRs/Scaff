# 045 — Reference Material: Memory Architecture in the Wild

These are full Library summaries of projects and papers relevant to our Three-Tier Knowledge Architecture.
Read each one. Extract ideas that apply to our design. Discard what doesn't fit.

---

## [2] TypeAgent Memory Architecture: Structured RAG

**URL:** https://github.com/microsoft/TypeAgent/blob/main/docs/content/architecture/memory.md
**Type:** documentation
**Tags:** ["structured-rag","retrieval-augmented-generation","inverted-index","agent-memory","knowledge-extraction","entity-relationship-extraction","typeagent","knowpro","conversational-ai-memory","vector-database-alternative"]

### Summary
TypeAgent's memory system introduces 'Structured RAG' as a superior alternative to classic Retrieval-Augmented Generation (RAG) for indexing and querying agent conversations. Classic RAG works by embedding each conversation turn into a high-dimensional vector (e.g., 4K floats per message with current models) and retrieving turns via cosine similarity to user queries. Structured RAG instead extracts short topic sentences, tree-structured entity and relationship data, and key terms from each conversation turn, storing them in a compact inverted index that maps terms to entities, topics, and back-pointers to source messages. Structured information (e.g., email metadata, image location data) is stored in relational tables and joined with unstructured query results at retrieval time. At query time, user requests are converted into query expressions containing scope expressions (e.g., time ranges, topic descriptions) and tree-pattern expressions that match extracted semantic trees, combined with optional relational sub-queries including comparison operators. Results are ranked by relevance and placed into a compact answer generation prompt, with raw messages added only if token budget allows. The architecture delivers several concrete advantages: (1) Size efficiency — inverted indices are a fraction the size of vector databases, often fitting in RAM on a single VM vs. distributed disk-based classic RAG deployments; (2) No forgetting — classic RAG systems lose information as conversations grow, while Structured RAG retains all extracted knowledge indefinitely; (3) Higher query specificity — because multi-attribute entity structures are preserved, queries like 'what email did Kevin send to Satya about new AI models?' can be answered precisely, whereas classic RAG conflates semantically adjacent but incorrect results; (4) Inference expansion — the index can be augmented with type hierarchies (e.g., 'artist(Paul Simon)' → 'person(Paul Simon)'), broadening query coverage; (5) Associative pre-fetching — discrete index terms enable real-time memory retrieval as users type, and support query completion hints; (6) Manageability — structured indices support direct query languages and natural language management tools, unlike opaque embedding stores. A key empirical result: with 3K input tokens, Structured RAG recalled all 63 books discussed across 25 podcasts, while classic RAG recalled only 15 books using twice the tokens; at 128K tokens, classic RAG reached only 31 books. The implementation lives in the in-development KnowPro package, and simple fine-tuned models can build indices with only small precision/recall loss compared to large language models, enabling scalable indexing of large corpora like meeting transcripts.

### Key Concepts
["Structured RAG replaces per-message vector embeddings with compact inverted indices mapping extracted terms, entities, and topic sentences back to source messages.","Classic RAG forgets information as conversations grow because it relies on a fixed token window and cosine similarity over high-dimensional vectors, while Structured RAG retains all extracted knowledge indefinitely.","Query expressions in Structured RAG combine scope expressions (time/topic range filters) and tree-pattern expressions matched against semantically extracted entity trees, enabling multi-attribute precision classic RAG cannot achieve.","Structured RAG indices are substantially smaller than vector databases (dense extracted info + back-pointer vs. 4K float vector per message), often fitting in RAM on a single VM.","Fine-tuned small language models can build Structured RAG indices with only marginal loss in precision and recall compared to large language models, enabling cost-efficient large-scale indexing.","Discrete index terms in Structured RAG enable real-time associative memory pre-fetching and query completion hints as users type or speak.","Empirically, Structured RAG recalled all 63 books from 25 podcasts at 3K tokens; classic RAG recalled only 15 books at 6K tokens and 31 books at 128K tokens."]

### Full Text (excerpt)
TypeAgent memory uses a method called Structured RAG for indexing and querying agent conversations. Classic RAG is defined as embedding each conversation turn into a vector, and then for each user request embedding the user request and then placing into the answer generation prompt the top conversation turns by cosine similarity to the user request. Structured RAG is defined as the following steps: For each conversation turn (message): Extract short topic sentences and tree-structured entity and relationship information. Extract key terms from the entities and topics. Add these terms to the primary index that maps terms to entities and topics which in turn point back to messages. Structured information may accompany a message, for example to/from information for an e-mail thread or location information from an image description. Add any structured information to a relational table associated with the conversation. For each user request: Convert the user request into a query expression. If the user request refers to structured information, the query expression will include a relational query to be joined with the unstructured data query result. The relational query may include comparison operators. For the unstructured data, the query expression consists of two parts: scope expressions and tree-pattern expressions. Scope expressions, such as time range, restrict search results to a subset of the conversation. Scope expressions can include topic descriptions, which specify the subset of the conversation that matches the description. Tree-pattern expressions match specific trees extracted from the conversation and can be connected by logical operators. Execute the query, yielding lists of entities and topics, ordered by relevance score. Select the top entities and topics and add them to the answer prompt. If the topics and entities do not use all of the token budget, add to the prompt the messages referenced by the top entities and topics. Submit the answer prompt to a language model to generate the final answer. Structured RAG can use simple language models to extract entities and topics. This enables Structured RAG to index large conversations, like sets of meeting transcripts. With fine tuning, simple models deliver indices with only a small loss of precision and recall relative to indices built with large language models. The current Structured RAG implementation in the KnowPro package uses secondary indices for scope expressions such as document range and time range. The implementation also uses secondary indices for related terms, such as 'novel' for 'book'. During query, the memory system discovers related terms and caches them. Models also offer related terms during information extraction. Structured RAG has the following advantages over state-of-the-art memory using classic RAG: Size: Structured RAG can retain all of the information extracted from every conversation with the agent. Structured RAG uses a standard inverted index to map terms 

---

## [5] Always-On Memory Agent: Persistent AI Memory via Continuous LLM Consolidation

**URL:** https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent
**Type:** tool
**Tags:** ["persistent-ai-memory","llm-memory-consolidation","google-adk","gemini-flash-lite","always-on-agents","multimodal-ingestion","sqlite-memory-store","agent-orchestration","rag-alternative"]

### Summary
This project tackles a fundamental limitation of current AI agents: stateless, ephemeral processing. Most agents forget everything between sessions. The Always-On Memory Agent is a lightweight background process built on Google ADK and Gemini Flash-Lite that continuously ingests, consolidates, and queries information — functioning as a persistent, evolving memory system without vector databases or embeddings.

The architecture uses three specialized sub-agents orchestrated by a central router. The IngestAgent extracts structured information (summaries, entities, topics, importance scores) from any file type — 27 supported formats including text, images, audio, video, and PDFs — using Gemini's multimodal capabilities. The ConsolidateAgent runs on a configurable timer (default every 30 minutes) and performs cross-memory analysis: finding connections between stored memories, generating synthesized insights, and compressing related information. This explicitly mirrors the neuroscience of sleep-based memory consolidation, where the brain replays and integrates disparate experiences. The QueryAgent reads the full memory store plus consolidation insights to answer natural language queries with source citations.

The key architectural insight is that active LLM-based consolidation outperforms passive retrieval approaches. Vector DB + RAG embeds once and retrieves later — no active synthesis. Conversation summaries lose detail. Knowledge graphs are expensive to maintain. This system instead runs a cheap, fast LLM continuously to build connections over time, more analogous to human cognition.

Gemini Flash-Lite is deliberately chosen over more capable models: for always-on background operation, cost and latency matter more than raw intelligence. The storage backend is SQLite — simple, zero-infrastructure, file-based.

Ingestion can be triggered three ways: dropping files into a watched inbox folder (auto-ingested within 5-10 seconds), uploading via a Streamlit dashboard, or POSTing via HTTP API. The agent exposes a REST API for status, memory listing, ingestion, querying, consolidation, and deletion. This makes it embeddable as a memory layer for other applications.

The practical takeaway: persistent AI memory doesn't require complex vector infrastructure. A sufficiently capable LLM running cheaply and continuously, with structured write-back to a simple database, can approximate the associative, consolidating memory that makes human cognition useful over time.

### Key Concepts
["Active LLM-based memory consolidation (analogous to sleep) outperforms passive vector retrieval by generating cross-memory insights rather than just storing and fetching embeddings","A cheap, fast model running continuously (Gemini Flash-Lite) is more practical for always-on memory than a powerful model called on demand","SQLite is sufficient as a persistent memory store when the LLM handles synthesis — no vector database or embedding pipeline required","Multimodal ingestion (text, image, audio, video, PDF) unified through a single structured extraction step enables a single memory store across all content types","Three-agent architecture (Ingest, Consolidate, Query) with a central orchestrator cleanly separates concerns for continuous background memory systems","Memory consolidation interval (default 30 min) is a tunable tradeoff between recency of cross-memory insights and LLM compute cost"]

---

## [31] (S)AGE — Sovereign Agent Governed Experience: BFT Consensus-Validated Memory Infrastructure for AI Agents

**URL:** https://github.com/l33tdawg/sage
**Type:** tool
**Tags:** ["agent-memory","bft-consensus","cometbft","mcp-protocol","multi-agent-systems","rbac-clearance","persistent-memory","ai-infrastructure","ed25519-signatures","agentic-ai"]

### Summary
SAGE is an open-source memory infrastructure system for AI agents that provides persistent, consensus-validated memory across conversations. Unlike vector databases or flat-file solutions bolted onto chat apps, SAGE is purpose-built infrastructure using the same consensus primitives as distributed ledgers — specifically CometBFT (Byzantine Fault Tolerant consensus) — to validate, sign, and commit agent memories before they persist.

The core insight is that AI agents lack institutional memory: they forget context between sessions, cannot learn cumulatively from experience, and have no tamper-resistant audit trail for what they know. SAGE solves this by routing every memory write through a pipeline of 4 in-process application validators (Sentinel, Dedup, Quality, Consistency) that require a 3/4 quorum (BFT 2/3 threshold) before a memory is committed to SQLite. Each memory carries a confidence score, decays naturally over time, and is signed with Ed25519 keys.

A published research study comparing 50 memory-enabled agents against 50 memoryless agents found that memory agents outperformed their counterparts, with cumulative learning correlation rho=0.716 versus 0.040 for agents without memory — a striking quantitative demonstration of the value of persistent agent memory.

SAGE exposes memory to AI models via the Model Context Protocol (MCP) and a REST API. Three primary MCP tools — sage_remember, sage_turn, and sage_reflect — handle the memory lifecycle: storing observations, capturing turn-by-turn context, and reflecting on accumulated knowledge. Agents can self-configure via a /v1/mcp-config endpoint.

The CEREBRUM dashboard provides a visual force-directed neural graph of agent memory, real-time SSE updates, semantic search, domain filtering, bulk operations, and a full network management interface for multi-agent deployments. Multi-agent networks support role-based access control (RBAC) with clearance levels, domain-level read/write permissions, multi-org federation, and LAN pairing for agent onboarding.

Security is layered: AES-256-GCM encryption for stored memories (the 'Synaptic Ledger'), Argon2id for key derivation, Ed25519 signing for every memory transaction, and vault-locked API responses that prevent silent plaintext fallback when encryption is engaged. The v4.3 release fixed a critical bug where web login did not actually unlock the vault for writes.

Practically, SAGE runs as a single binary (macOS DMG, Windows EXE, Linux tar.gz) or Docker image, starts a real CometBFT node locally in personal mode, and is compatible with any AI (Claude, ChatGPT, DeepSeek, Gemini, etc.). The project is written primarily in Go (59.6%), with a Python SDK on PyPI and a JavaScript frontend.

### Key Concepts
["SAGE routes every AI agent memory write through BFT consensus with 4 in-process validators requiring 3/4 quorum before committing to SQLite","Memory agents with SAGE showed cumulative learning correlation rho=0.716 versus rho=0.040 for memoryless agents in a 50-vs-50 controlled study","SAGE uses Ed25519 signing, AES-256-GCM encryption, and Argon2id key derivation to ensure tamper-resistant, auditable agent memory","Memories carry confidence scores and decay naturally over time, mimicking biological memory dynamics","SAGE exposes memory to AI models via MCP tools (sage_remember, sage_turn, sage_reflect) and REST API, compatible with any AI provider","Multi-agent networks support RBAC with clearance levels, domain permissions, multi-org federation, and on-chain agent identity via CometBFT","A pre-validation endpoint allows dry-run quality checks against all 4 validators before memory is submitted on-chain, preventing low-quality data accumulation"]

### Full Text (excerpt)
(S)AGE — Sovereign Agent Governed Experience

Persistent, consensus-validated memory infrastructure for AI agents.

SAGE gives AI agents institutional memory that persists across conversations, goes through BFT consensus validation, carries confidence scores, and decays naturally over time. Not a flat file. Not a vector DB bolted onto a chat app. Infrastructure — built on the same consensus primitives as distributed ledgers.

The architecture is described in Paper 1: Agent Memory Infrastructure.

Just want to install it? Download here — double-click, done. Works with any AI.

Architecture:
Agent (Claude, ChatGPT, DeepSeek, Gemini, etc.)
│
MCP / REST
▼
sage-gui
├── ABCI App (validation, confidence, decay, Ed25519 sigs)
├── App Validators (sentinel, dedup, quality, consistency — BFT 3/4 quorum)
├── CometBFT consensus (single-validator or multi-agent network)
├── SQLite + optional AES-256-GCM encryption
├── CEREBRUM Dashboard (SPA, real-time SSE)
└── Network Agent Manager (add/remove agents, key rotation, LAN pairing)

Personal mode runs a real CometBFT node with 4 in-process application validators — every memory write goes through pre-validation, signed vote transactions, and BFT quorum before committing. Same consensus pipeline as multi-node deployments. Add more agents from the dashboard when you're ready.

Full deployment guide (multi-agent networks, RBAC, federation, monitoring): Architecture docs

CEREBRUM Dashboard
http://localhost:8080/ui/ — force-directed neural graph, domain filtering, semantic search, real-time updates via SSE.

Network Management
Add agents, configure domain-level read/write permissions, manage clearance levels, rotate keys, download bundles — all from the dashboard.

Settings Overview: Chain health, peers, system status
Security Configuration: Synaptic Ledger encryption, export
Update: Boot instructions, cleanup, tooltips
One-click updates from dashboard

What's New in v4.5:
Cross-Agent Visibility Fixed — Org-based access (clearance levels, multi-org federation) now correctly grants visibility across agents. Queries and list operations check direct grants, org membership, and unregistered domain fallback — no more 0-result queries when clearance should allow access.
Domain Auto-Registration — First write to an unregistered domain auto-registers it with the submitting agent as owner and full access granted. No more propose-succeeds-but-query-404.
RBAC Gate Simplification — DomainAccess (explicit allowlist) and multi-org gates are alternatives, not stacked. Passing one skips the other.
Python Agent SDK — sage-agent-sdk on PyPI for building SAGE-integrated agents. CI-tested on every release.
/v1/mcp-config Endpoint — Agents can self-configure their MCP connection without manual setup.
Docker Images — Every release auto-builds and pushes to ghcr.io/l33tdawg/sage. Pin a version or pull latest.

v4.4:
CEREBRUM UX Overhaul — Snap-back physics (nodes spring back to cloud on focus exit), forget animation (fade-and-remove instead

---

## [39] Cognitive Memory in AI Agents: Moving from Stateless Execution to Compounding Learning

**URL:** https://api.vxtwitter.com/i/status/2032124525476004079
**Type:** discussion
**Tags:** ["ai-agent-memory","cognitive-memory","crewai","stateless-vs-stateful-agents","human-in-the-loop","feedback-loop","recurring-workflows","agent-learning","operations-automation"]

### Summary
João Moura, a figure associated with CrewAI, identifies a core structural problem with how most AI agents are deployed: they are stateless. When a human corrects an agent's output, that correction is applied once, then discarded. The next run begins with no memory of what was learned, forcing teams into an endless loop of providing the same feedback across different sessions. The agent executes, not learns.

The solution Moura advocates is Cognitive Memory — a mechanism that goes beyond saving feedback as a note. Instead, feedback is actively distilled into generalizable lessons that the agent retrieves before generating any output. By recalling what has mattered in prior interactions before producing a first draft, the agent preemptively applies accumulated preferences rather than waiting for post-output correction.

The compounding effect is significant: teams that previously needed 3 rounds of editing see that reduce to 1, not because the task changed, but because the agent's internal model of how the team thinks has grown more accurate over time. The human role shifts from corrector — reviewing outputs and explaining the same issues repeatedly — to director, managing higher-level outcomes rather than per-output quality.

The deeper architectural distinction Moura draws is between stateless and stateful agents. Stateless agents are reliable for isolated, well-defined tasks. But for recurring workflows — especially those involving judgment, style, or preference — stateless agents create overhead that scales linearly with usage. Memory-equipped agents invert this dynamic: usage drives improvement. After enough corrective interactions, the agent has built a working model of how its users think, enabling it to try approaches, remember what worked, and develop strategies rather than simply execute instructions.

The practical takeaway for operations teams: memory infrastructure is the leverage point in AI agent deployment. The return is not efficiency per task but a compounding reduction in review overhead as the agent's world model becomes more aligned with team preferences. This is most impactful in recurring workflows involving content, analysis, or communication where style, judgment, and organizational voice are central.

CrewAI implements this as a named feature called Cognitive Memory, aimed at operations teams running AI agents on recurring workflows.

### Key Concepts
["Stateless AI agents reset after every run, making corrections non-persistent and forcing teams into repetitive feedback loops","Cognitive Memory distills human feedback into generalizable lessons rather than saving raw comments, enabling pre-draft recall","Agents with memory retrieve relevant lessons before generating output, reducing correction rounds from multiple to one","Memory-equipped agents develop working models of user preferences over time, shifting human role from corrector to director","Stateful agents can explore and refine strategies across runs; stateless agents can only execute individual instructions","The compounding value of agent memory grows with usage — more interactions produce better alignment, not more overhead","CrewAI's Cognitive Memory feature operationalizes this for recurring workflow automation in operations teams"]

### Full Text (excerpt)
Stop rewriting the same AI feedback every single week.

You give the agent a task. It gets it 80% right.

You correct the AI.
It fixes the mistake.
Then next week, it makes the exact same error.

This is the most frustrating part of working with AI systems.

You give feedback. The system applies it. Job done.

But it doesn't actually learn, it just executes.

So you become a corrector on an endless loop. Same feedback, different Tuesday.

Here's what changed for us:

We built cognitive memory into our AI agents. When a human provides feedback, the system doesn't just save the comment and move on.

It distills that feedback into a generalizable lesson.

Next time the agent runs, it recalls those lessons BEFORE it even shows you a first draft.

The shift is dramatic:

- You stop rewriting every output.
- You stop explaining the same thing over and over.
- You move from corrector to director.

The system that used to need 3 rounds of edits now gets it right on the first pass because it remembers what you care about.

And here's the bigger unlock:

Stateless agents can only execute. Input goes in, output comes out, then it forgets everything.

Agents with memory can explore. They try an approach, remember what worked, refine on the next run.

They develop strategies over time. They get better at getting better.

The gap between those 2 modes is enormous for any team running recurring workflows.

After enough corrections, the agent isn't just better at one task - it's built a working model of how you think. The review cycle shortens. The quality baseline rises. You stop managing outputs and start managing outcomes.

This is exactly what Cognitive Memory does inside CrewAI. If you're running operations teams and want to see how it works in practice, drop a comment or send me a message.

Human-in-the-loop means humans as teachers.

The AI learns. You scale.

---

## [24] OpenViking: Open-Source Context Database for AI Agents

**URL:** https://github.com/volcengine/OpenViking
**Type:** documentation
**Tags:** ["context-database","ai-agents","agentic-rag","filesystem-paradigm","long-term-memory","token-efficiency","context-engineering","openclaw","vector-retrieval","self-evolving-agents"]

### Summary
OpenViking is an open-source context database developed by Volcengine, purpose-built for AI Agents. It addresses a fundamental pain point in agentic AI development: fragmented, hard-to-manage context. Traditional RAG systems store memories, resources, and skills in separate silos — vector databases, code, scattered files — making unified retrieval difficult and retrieval trajectories opaque. OpenViking's core innovation is treating all agent context as a virtual filesystem under a `viking://` URI scheme, unifying memories, resources, and skills into a single hierarchical structure navigable with familiar commands like `ls`, `find`, and `grep`.

The system introduces a three-tier context loading model (L0/L1/L2): L0 is a one-sentence abstract (~100 tokens) for quick relevance checks; L1 is a structured overview (~2K tokens) for planning; L2 is full content loaded only when necessary. This tiered approach dramatically reduces token consumption compared to stuffing full context into prompts.

Retrieval uses a Directory Recursive Retrieval strategy: intent analysis generates multiple retrieval conditions, vector search locates the highest-scoring directories, then recursive secondary retrieval refines results within those directories. This outperforms flat RAG by preserving contextual hierarchy and providing observable retrieval trajectories — users can trace exactly which directories and files were accessed during a query.

OpenViking also supports automatic session management: at the end of each session, the system extracts long-term memory from interactions, updating both user preference memories and agent experience memories, enabling self-evolution over time.

Benchmarked against the LoCoMo10 dataset (1,540 long-range dialogue cases), OpenViking integrated with OpenClaw achieved a 52.08% task completion rate with native memory disabled, versus 35.65% for baseline OpenClaw and 44.55% for OpenClaw+LanceDB. Critically, OpenViking used only 4.26M input tokens versus LanceDB's 51.57M — a 92% token reduction with better performance. With native memory enabled alongside OpenViking, completion rate was 51.23% at just 2.1M tokens — a 91% token reduction over baseline.

The project is written primarily in Python (82.9%) with C++ (8.2%) and Rust (3.6%) components. It supports multiple VLM and embedding providers including Volcengine (Doubao), OpenAI, and LiteLLM (covering Anthropic, DeepSeek, Gemini, Ollama, vLLM, and more). Installation is available via pip or a Rust CLI. Licensed under Apache 2.0, the project has 13.7K GitHub stars and 940 forks as of March 2026.

### Key Concepts
["OpenViking uses a virtual filesystem paradigm (viking:// URIs) to unify agent context — memories, resources, and skills — into a single hierarchical structure, replacing fragmented vector-only storage.","Three-tier context loading (L0 abstract, L1 overview, L2 full content) dramatically reduces token consumption by loading only as much detail as needed for each task phase.","Directory Recursive Retrieval combines intent analysis, vector search for directory positioning, and recursive refinement within subdirectories to improve retrieval accuracy over flat RAG.","Benchmarks show OpenViking achieves 52% task completion vs 35.65% baseline with a 92% reduction in input token usage compared to LanceDB on the LoCoMo10 dataset.","Automatic session management extracts long-term memory from each session, updating user preference and agent experience directories to enable self-evolving agent intelligence.","Retrieval trajectories are fully observable as directory browse logs with URI references, solving the black-box problem of traditional RAG systems."]

### Full Text (excerpt)
OpenViking: The Context Database for AI Agents

Overview

Challenges in Agent Development
In the AI era, data is abundant, but high-quality context is hard to come by. When building AI Agents, developers often face these challenges:
- Fragmented Context: Memories are in code, resources are in vector databases, and skills are scattered, making them difficult to manage uniformly.
- Surging Context Demand: An Agent's long-running tasks produce context at every execution. Simple truncation or compression leads to information loss.
- Poor Retrieval Effectiveness: Traditional RAG uses flat storage, lacking a global view and making it difficult to understand the full context of information.
- Unobservable Context: The implicit retrieval chain of traditional RAG is like a black box, making it hard to debug when errors occur.
- Limited Memory Iteration: Current memory is just a record of user interactions, lacking Agent-related task memory.

The OpenViking Solution
OpenViking is an open-source Context Database designed specifically for AI Agents. We aim to define a minimalist context interaction paradigm for Agents, allowing developers to completely say goodbye to the hassle of context management.

OpenViking abandons the fragmented vector storage model of traditional RAG and innovatively adopts a "file system paradigm" to unify the structured organization of memories, resources, and skills needed by Agents. With OpenViking, developers can build an Agent's brain just like managing local files:
- Filesystem Management Paradigm → Solves Fragmentation: Unified context management of memories, resources, and skills based on a filesystem paradigm.
- Tiered Context Loading → Reduces Token Consumption: L0/L1/L2 three-tier structure, loaded on demand, significantly saving costs.
- Directory Recursive Retrieval → Improves Retrieval Effect: Supports native filesystem retrieval methods, combining directory positioning with semantic search to achieve recursive and precise context acquisition.
- Visualized Retrieval Trajectory → Observable Context: Supports visualization of directory retrieval trajectories, allowing users to clearly observe the root cause of issues and guide retrieval logic optimization.
- Automatic Session Management → Context Self-Iteration: Automatically compresses content, resource references, tool calls, etc., in conversations, extracting long-term memory, making the Agent smarter with use.

Quick Start

Prerequisites:
- Python Version: 3.10 or higher
- Go Version: 1.22 or higher (Required for building AGFS components)
- C++ Compiler: GCC 9+ or Clang 11+ (Required for building core extensions)
- Operating System: Linux, macOS, Windows
- Network Connection: A stable network connection is required

Installation:
pip install openviking --upgrade --force-reinstall

Rust CLI (Optional):
curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/crates/ov_cli/install.sh | bash

Model Preparation:
OpenViking requires VLM Model (for image and

---

## [1] OpenRAG: Intelligent Agent-Powered Document Search Platform

**URL:** https://github.com/langflow-ai/openrag
**Type:** tool
**Tags:** ["retrieval-augmented-generation","opensearch","langflow","docling","agentic-rag","mcp-server","document-ingestion","vector-search","open-source-ai","self-hosted-llm"]

### Summary
OpenRAG is an open-source, production-ready Retrieval-Augmented Generation (RAG) platform that bundles document ingestion, semantic search, and AI-powered chat into a single deployable package. Built on three foundational technologies — Langflow (workflow orchestration), Docling (document parsing), and OpenSearch (vector/keyword search) — it removes the typical integration burden of assembling a RAG stack from scratch.

The platform's most notable design decision is its 'pre-packaged and ready to run' philosophy: all core components are wired together at installation, meaning teams can skip the lengthy configuration phase that normally accompanies RAG deployments. This makes it practically valuable for organizations wanting to prove out document-search use cases quickly before committing to custom infrastructure.

OpenRAG supports agentic RAG workflows, which go beyond naive single-pass retrieval. It incorporates re-ranking and multi-agent coordination, addressing a common failure mode in basic RAG systems where retrieval quality degrades on complex or ambiguous queries. The drag-and-drop visual workflow builder (powered by Langflow) allows non-engineers to iterate on retrieval pipelines without code changes.

For integration, OpenRAG ships official SDKs in both Python and TypeScript/JavaScript, enabling application developers to embed RAG-enhanced chat or semantic search with minimal boilerplate. Additionally, it exposes a Model Context Protocol (MCP) server, allowing AI assistants such as Cursor and Claude Desktop to connect directly to an OpenRAG knowledge base — a forward-looking feature that positions it within the emerging ecosystem of tool-augmented LLM agents.

Deployment options are flexible: a Python package install, Docker/Podman self-managed services, and Kubernetes/Helm charts are all provided, covering the spectrum from local development to enterprise-scale production. The FastAPI backend and Next.js frontend reflect modern, maintainable technology choices.

With 3,100+ stars, 277 forks, 39 contributors, and 52 releases (latest v0.3.1 as of March 2026), the project shows active community traction. The Apache-2.0 license makes it commercially friendly. The repository structure (sdks/, flows/, kubernetes/, src/, tests/) indicates a mature, well-organized codebase rather than a proof-of-concept.

### Key Concepts
["OpenRAG bundles Langflow, Docling, and OpenSearch into a single pre-configured RAG platform, eliminating manual integration of these components","Agentic RAG workflows with re-ranking and multi-agent coordination improve retrieval quality beyond naive single-pass retrieval","Official Python and TypeScript SDKs allow application-level integration of RAG-enhanced chat and semantic search with minimal code","A Model Context Protocol (MCP) server enables AI assistants like Claude Desktop and Cursor to query the OpenRAG knowledge base directly","Deployment is supported via Python package, Docker/Podman, and Kubernetes Helm charts, covering local to enterprise-scale environments","The visual drag-and-drop workflow builder (Langflow) enables non-engineers to modify retrieval pipelines without writing code","OpenRAG is Apache-2.0 licensed, making it commercially usable without licensing restrictions"]

### Full Text (excerpt)
GitHub - langflow-ai/openrag: OpenRAG is a comprehensive, single package Retrieval-Augmented Generation platform built on Langflow, Docling, and Opensearch.

langflow-ai / openrag Public

OpenRAG
Intelligent Agent-powered document search

OpenRAG is a comprehensive Retrieval-Augmented Generation platform that enables intelligent document search and AI-powered conversations. Users can upload, process, and query documents through a chat interface backed by large language models and semantic search capabilities. The system utilizes Langflow for document ingestion, retrieval workflows, and intelligent nudges, providing a seamless RAG experience.

Check out the documentation or get started with the quickstart.

Built with FastAPI and Next.js. Powered by OpenSearch, Langflow, and Docling.

✨ Highlight Features
- Pre-packaged & ready to run - All core tools are hooked up and ready to go, just install and run
- Agentic RAG workflows - Advanced orchestration with re-ranking and multi-agent coordination
- Document ingestion - Handles messy, real-world data with intelligent parsing
- Drag-and-drop workflow builder - Visual interface powered by Langflow for rapid iteration
- Modular enterprise add-ons - Extend functionality when you need it
- Enterprise search at any scale - Powered by OpenSearch for production-grade performance

🔄 How OpenRAG Works
OpenRAG follows a streamlined workflow to transform your documents into intelligent, searchable knowledge:
1. Launch OpenRAG
2. Add Knowledge
3. Start Chatting

🚀 Install OpenRAG
To get started with OpenRAG, see the installation guides in the OpenRAG documentation:
- Quickstart
- Install the OpenRAG Python package
- Deploy self-managed services with Docker or Podman

📦 SDKs
Integrate OpenRAG into your applications with our official SDKs:

Python SDK
pip install openrag-sdk

Quick Example:
import asyncio
from openrag_sdk import OpenRAGClient

async def main():
    async with OpenRAGClient() as client:
        response = await client.chat.create(message="What is RAG?")
        print(response.response)

if __name__ == "__main__":
    asyncio.run(main())

TypeScript/JavaScript SDK
npm install openrag-sdk

Quick Example:
import { OpenRAGClient } from "openrag-sdk";
const client = new OpenRAGClient();
const response = await client.chat.create({ message: "What is RAG?" });
console.log(response.response);

🔌 Model Context Protocol (MCP)
Connect AI assistants like Cursor and Claude Desktop to your OpenRAG knowledge base:
pip install openrag-mcp

Quick Example (Cursor/Claude Desktop config):
{
  "mcpServers": {
    "openrag": {
      "command": "uvx",
      "args": ["openrag-mcp"],
      "env": {
        "OPENRAG_URL": "http://localhost:3000",
        "OPENRAG_API_KEY": "your_api_key_here"
      }
    }
  }
}

The MCP server provides tools for RAG-enhanced chat, semantic search, and settings management.

🛠️ Development
For developers who want to contribute to OpenRAG or set up a development environment, see CONTRIBUTI

---

## [16] typeagent-py: Structured RAG Library for Python

**URL:** https://github.com/microsoft/typeagent-py
**Type:** tool
**Tags:** ["structured-rag","retrieval-augmented-generation","python-ai-library","agent-memory","knowledge-indexing","microsoft-research","llm-tooling","typeagent","open-source-prototype"]

### Summary
typeagent-py is an experimental Python library from Microsoft that implements Structured RAG (Retrieval-Augmented Generation) — a pattern for ingesting, indexing, and querying knowledge in a structured way. It is a Pythonic translation of Microsoft's TypeAgent KnowPro and related packages originally written in TypeScript, making those capabilities accessible to the Python ecosystem.

The core insight behind Structured RAG is that standard RAG pipelines treat retrieved chunks as flat, unordered text. Structured RAG instead organizes knowledge into a more semantically meaningful index, enabling higher-quality retrieval and query responses. This is particularly useful for agents that need to reason over ingested knowledge rather than simply retrieve similar embeddings.

The library is explicitly marked as an experimental prototype working toward a shared MVP definition of Structured RAG. Developers should treat it as sample/reference code rather than production-grade infrastructure. A key practical warning: the library sends input data to a third-party LLM, so it must not be used to index confidential or sensitive information.

The project was presented at PyBay 2025, with slides and video available, indicating it has reached a stage of public community sharing and is actively seeking feedback and collaboration. The repository has 787 stars and 63 forks with 16+ contributors, suggesting meaningful community traction despite its experimental status.

Installation is straightforward via pip (`pip install typeagent`), and documentation lives in the `docs/` directory. The codebase is almost entirely Python (99.5%), uses `pyproject.toml` and `uv.lock` for dependency management, and follows standard open-source conventions (CHANGELOG, SECURITY.md, CODE_OF_CONDUCT, TODO, NOTES).

For Python developers building AI agents or knowledge-intensive applications, typeagent-py offers a reference implementation of structured knowledge indexing patterns translated from a production TypeScript codebase, making it a useful study resource for understanding how Microsoft conceptualizes agent memory and knowledge retrieval. The TypeScript-to-Python translation also makes the architecture accessible to a broader audience without requiring TypeScript expertise.

### Key Concepts
["Structured RAG organizes ingested knowledge into a semantic index rather than flat embedding chunks, enabling higher-quality agent reasoning over retrieved content.","typeagent-py is a Pythonic port of Microsoft's TypeScript-based TypeAgent KnowPro library, bridging the TypeScript AI agent ecosystem for Python developers.","The library sends input to a third-party LLM during indexing — confidential data must never be processed through it.","The project is explicitly experimental/prototype-grade and is working toward a shared community definition of the Structured RAG MVP.","Installation is via pip and the API is designed to be Pythonic, lowering the barrier for Python developers to adopt structured retrieval patterns.","The project was publicly presented at PyBay 2025, signaling active community engagement and a desire for broader adoption and feedback."]

---

## [25] GitNexus: The Zero-Server Code Intelligence Engine

**URL:** https://github.com/abhigyanpatwari/GitNexus
**Type:** tool
**Tags:** ["knowledge-graph","code-intelligence","mcp-server","graph-rag","tree-sitter","ai-coding-agents","static-analysis","codebase-indexing","ladybugdb","claude-code-integration"]

### Summary
GitNexus is an open-source code intelligence platform that builds a complete knowledge graph of any codebase, enabling AI agents to reason about code structure with full architectural awareness. Unlike traditional code search or RAG approaches that give LLMs raw graph edges and rely on multi-step exploration, GitNexus precomputes relational structure at index time — clustering, execution flow tracing, dependency scoring — so AI agents can retrieve complete, confidence-scored context in a single tool call. This 'Precomputed Relational Intelligence' approach means smaller LLMs can achieve the same architectural clarity as much larger models, effectively democratizing capable code agents.

The system operates in two modes: a CLI + MCP server for daily development workflows with editors like Cursor, Claude Code, and Windsurf, and a fully browser-based Web UI for quick exploration without any install. The CLI indexes repositories locally using native Tree-sitter bindings and stores the graph in LadybugDB (an embedded graph database with vector support), registering repos in a global registry so one MCP server can serve multiple projects. The Web UI runs the same pipeline entirely in WebAssembly, meaning no code ever leaves the browser.

For AI agents, GitNexus exposes 7 MCP tools: process-grouped hybrid search (BM25 + semantic + RRF), 360-degree symbol context, blast-radius impact analysis, git-diff change detection, multi-file coordinated rename, raw Cypher queries, and repo discovery. These tools precompute answers that would otherwise require 4+ sequential LLM queries, reducing token usage and eliminating missed dependencies. Claude Code receives the deepest integration via PreToolUse and PostToolUse hooks that enrich searches with graph context and auto-reindex after commits.

The indexing pipeline proceeds through six phases: file structure mapping, AST parsing with Tree-sitter, cross-file import/call resolution with constructor inference and self/this receiver type mapping, community detection via Leiden algorithm for functional clustering, execution flow tracing from entry points, and hybrid search index construction. Thirteen languages are supported with varying feature depth, with TypeScript, JavaScript, Python, C#, and Go having the most complete feature sets.

A key architectural insight is the multi-repo global registry: one MCP server configured once can serve all indexed repositories. Connections to LadybugDB are opened lazily and evicted after 5 minutes of inactivity with a cap of 5 concurrent connections, keeping resource usage low. The project has 15.3k stars, 1.8k forks, and 27 contributors as of March 2026, indicating significant community traction.

### Key Concepts
["Precomputed Relational Intelligence eliminates multi-step LLM graph exploration by structuring complete context at index time, enabling single-query architectural answers","GitNexus exposes codebase knowledge via MCP tools, making smaller language models competitive with larger ones on code architecture tasks","A global registry pattern allows one MCP server to serve multiple indexed repositories without per-project configuration","The same indexing pipeline runs natively (CLI/Node.js) and in WebAssembly (browser), sharing architecture across both deployment modes","Leiden community detection groups code symbols into functional clusters, and execution flow tracing maps entry-point-to-leaf call chains as 'processes'","Claude Code receives PreToolUse and PostToolUse hooks that automatically enrich searches and re-index after commits, providing the deepest editor integration","Confidence scoring on graph edges (CALLS, IMPORTS, EXTENDS, IMPLEMENTS) enables blast-radius analysis with quantified reliability per dependency"]

### Full Text (excerpt)
GitNexus: The Zero-Server Code Intelligence Engine - GitNexus is a client-side knowledge graph creator that runs entirely in your browser. Drop in a GitHub repo or ZIP file, and get an interactive knowledge graph with a built in Graph RAG Agent. Perfect for code exploration.

Building nervous system for agent context. Indexes any codebase into a knowledge graph — every dependency, call chain, cluster, and execution flow — then exposes it through smart tools so AI agents never miss code.

Like DeepWiki, but deeper. DeepWiki helps you understand code. GitNexus lets you analyze it — because a knowledge graph tracks every relationship, not just descriptions.

TL;DR: The Web UI is a quick way to chat with any repo. The CLI + MCP is how you make your AI agent actually reliable — it gives Cursor, Claude Code, and friends a deep architectural view of your codebase so they stop missing dependencies, breaking call chains, and shipping blind edits. Even smaller models get full architectural clarity, making it compete with goliath models.

Two Ways to Use GitNexus:

CLI + MCP:
- What: Index repos locally, connect AI agents via MCP
- For: Daily development with Cursor, Claude Code, Windsurf, OpenCode
- Scale: Full repos, any size
- Install: npm install -g gitnexus
- Storage: LadybugDB native (fast, persistent)
- Parsing: Tree-sitter native bindings
- Privacy: Everything local, no network

Web UI:
- What: Visual graph explorer + AI chat in browser
- For: Quick exploration, demos, one-off analysis
- Scale: Limited by browser memory (~5k files), or unlimited via backend mode
- Install: No install — gitnexus.vercel.app
- Storage: LadybugDB WASM (in-memory, per session)
- Parsing: Tree-sitter WASM
- Privacy: Everything in-browser, no server

Bridge mode: gitnexus serve connects the two — the web UI auto-detects the local server and can browse all your CLI-indexed repos without re-uploading or re-indexing.

CLI + MCP (recommended):
The CLI indexes your repository and runs an MCP server that gives AI agents deep codebase awareness.

Quick Start:
# Index your repo (run from repo root)
npx gitnexus analyze

This indexes the codebase, installs agent skills, registers Claude Code hooks, and creates AGENTS.md / CLAUDE.md context files — all in one command.

Editor Support:
- Claude Code: MCP + Skills + Hooks (PreToolUse + PostToolUse) — Full support
- Cursor: MCP + Skills — Full support
- Windsurf: MCP only
- OpenCode: MCP + Skills

CLI Commands:
gitnexus setup — Configure MCP for your editors (one-time)
gitnexus analyze [path] — Index a repository (or update stale index)
gitnexus analyze --force — Force full re-index
gitnexus analyze --skills — Generate repo-specific skill files
gitnexus analyze --skip-embeddings — Skip embedding generation (faster)
gitnexus analyze --embeddings — Enable embedding generation (slower, better search)
gitnexus mcp — Start MCP server (stdio)
gitnexus serve — Start local HTTP server for web UI connection
gitnexus list — List all indexed repo

---

## [38] Gemini Embedding 2: Our first natively multimodal embedding model

**URL:** https://api.vxtwitter.com/i/status/2031421162123870239
**Type:** article
**Tags:** ["gemini-embedding-2","multimodal-embeddings","vector-search","cross-modal-retrieval","rag-pipeline","google-ai-studio","embedding-models","multimodal-ai"]

### Summary
Google AI Studio has announced Gemini Embedding 2, their first natively multimodal embedding model. Unlike prior embedding models that operate on a single modality (e.g., text-only or image-only) and require separate pipelines or late fusion to work across modalities, Gemini Embedding 2 maps text, images, video, audio, and documents into a single unified embedding space. This is a significant architectural departure: natively multimodal means the model is trained end-to-end to understand and relate all these modalities in one shared vector space, rather than projecting them into alignment post-hoc.

The practical implication is that a query in one modality — for example, a text question — can retrieve results from any other modality (images, audio clips, video segments, documents) using the same embedding index. This unifies retrieval-augmented generation (RAG) pipelines that previously required separate indexes per modality or cross-modal bridge models. Similarly, classification tasks that span modalities (e.g., labeling a mixed media corpus) can be performed against a single embedding space.

For developers building search, recommendation, or RAG systems, this collapses what would previously have been multi-model, multi-index architectures into a single embedding call. It also means similarity search across modalities is inherently meaningful — text embeddings and image embeddings in the same space will be geometrically comparable by semantic content.

The announcement was published on March 10, 2026, via Google AI Studio's official Twitter/X account, with the article hosted as a native X article. The preview text explicitly positions this as the first model of its kind from Google, suggesting Gemini Embedding 2 replaces the earlier text-only `text-embedding-004` and related models in the Gemini family. The model is expected to be available via the Gemini API. This development places Google in direct competition with OpenAI's multimodal embedding efforts and specialized embedding providers, while benefiting from tight integration with the broader Gemini model ecosystem.

### Key Concepts
["Gemini Embedding 2 is Google's first natively multimodal embedding model, mapping text, images, video, audio, and documents into a single shared vector space.","Native multimodality means all modalities are embedded end-to-end in a unified space, enabling cross-modal similarity search without separate indexes or bridge models.","The model enables multimodal retrieval — a query in one modality can surface semantically related content from any other modality.","Single-space multimodal embeddings collapse multi-model RAG architectures into a single embedding API call.","Gemini Embedding 2 supports multimodal classification tasks across mixed-media corpora.","The model is published by Google AI Studio and is part of the Gemini model family, announced March 10, 2026."]

### Full Text (excerpt)
Tweet from @GoogleAIStudio (Google AI Studio), posted Tue Mar 10 17:25:21 +0000 2026.

Article title: Gemini Embedding 2: Our first natively multimodal embedding model

Preview text: Gemini Embedding 2 is our first natively multimodal embedding model that maps text, images, video, audio and documents into a single embedding space, enabling multimodal retrieval and classification

Source tweet URL: https://twitter.com/GoogleAIStudio/status/2031421162123870239
Article image: https://pbs.twimg.com/media/HDEOl73a0AAqw4G.jpg
Likes: 11270 | Retweets: 1301 | Replies: 261

---

## [7] Grep Is Dead: How I Made Claude Code Actually Remember Things

**URL:** https://api.fxtwitter.com/status/2028330693659332615
**Type:** tutorial
**Tags:** ["claude-code","obsidian","qmd","bm25-search","semantic-search","context-persistence","session-memory","local-first-ai","ai-workflow","knowledge-retrieval"]

### Summary
Artem Zhutov, a Physics PhD, describes a practical memory system he built for Claude Code using QMD — a local search engine by Tobias Lutke (CEO of Shopify) — to solve the fundamental problem of context loss across AI coding sessions. After accumulating 700 Claude Code sessions in 3 weeks, he found the default paradigm of grepping over files to recover context was too slow, too noisy, and too expensive in tokens. His solution layers three components: QMD for indexing and search, a session export hook, and a /recall skill.

QMD indexes an Obsidian vault and supports three search modes: BM25 (deterministic full-text, scores by term frequency and rarity across documents), semantic search (embedding-based, finds conceptual matches even without exact keywords), and hybrid (combines both). Compared to grep — which returned 200 irrelevant files for a 'sleep' query including programming sleep() calls — BM25 returned 3 targeted results in 2 seconds, and semantic search surfaced a bedtime discipline goal written years ago without containing the search terms at all.

The /recall skill wraps QMD with three modes: temporal (reconstructs session history by date), topic (BM25 search across collections), and graph (interactive visualization of sessions and linked files). A session-close hook automatically parses Claude Code's JSONL conversation files into clean markdown, embeds them into QMD, and keeps the index current with no manual steps. This means every past decision, question, and context fragment is immediately searchable from the next session.

The system's key insight is that Claude Code's raw JSONL logs are a gold mine — but only if you can query them intelligently. Brute-force grep (or sending a Haiku sub-agent to scan files) burns tokens and takes minutes; BM25+semantic search returns ranked, relevant results in seconds. The /recall topic mode reconstructed an entire project's state — dashboard, production plan, to-do list — in under a minute, then allowed the question 'what is the next highest leverage action?' to be answered with full context.

A notable emergent capability: semantic search across daily notes surfaces non-obvious patterns, such as identifying that the happiest days correlate with shipping something combined with good sleep recovery. It also surfaced forgotten ideas — an unbuilt PhD writing dashboard, illustration app concepts — by searching for 'ideas I never acted on.'

The full stack runs locally: Obsidian vault at the base, QMD in the middle, Claude Code and OpenClaw on top. Obsidian Sync keeps the vault current across machines; OpenClaw running on a always-on Mac Mini makes the full context available from any device. The skill is installable in 2 minutes and the full walkthrough is a 42-minute YouTube video.

### Key Concepts
["Claude Code saves all conversations as local JSONL files, which can be parsed, embedded, and made searchable with a session-close hook","BM25 search scores documents by term frequency and inverse document frequency, outperforming grep for relevance without requiring AI embeddings","Semantic (embedding-based) search finds conceptually related content even when exact query terms are absent from documents","The /recall skill provides three context-recovery modes: temporal (by date), topic (BM25 across collections), and graph (interactive session visualization)","Grep-based context recovery from a large vault takes 3+ minutes and returns noisy results; QMD hybrid search returns ranked results in seconds with far fewer tokens","A local-first memory stack (Obsidian + QMD + Claude Code) makes all past session context portable and queryable across devices via sync"]

---

## [40] Self Improving Skills for Agents

**URL:** https://api.vxtwitter.com/i/status/2032179887277060476
**Type:** discussion
**Tags:** ["skill-md","agentic-ai","self-improving-agents","agent-skill-design","autonomous-agents","agent-memory","ai-feedback-loops","agent-frameworks"]

### Summary
This X (Twitter) article by Vasilije (@tricalt), published March 12, 2026, examines a critical open problem in agent design: the gap between agents that have skills and agents whose skills can improve over time. The post centers on 'SKILL.md' — a markdown-based convention for encoding agent capabilities — noting that while this pattern appears to have become a durable standard in agentic system design, the deeper challenge remains unsolved: how do agent skills actually get better through use or feedback?

The core insight is a distinction between static skill endowment and adaptive skill refinement. Most current agent frameworks treat skills as fixed definitions — a SKILL.md file describes what an agent can do, but that definition doesn't evolve based on outcomes, errors, or accumulated experience. The author argues this is the fundamental problem: tooling for distributing and invoking skills exists, but no robust mechanism exists for skills to self-improve in a principled, safe, or automated way.

The piece touches on a broader challenge in the agentic AI space: closing the loop between task execution and skill update. Truly capable autonomous agents would not only execute from a skill definition but would revise that definition when they discover better methods, encounter edge cases, or receive corrective feedback. This is analogous to how expert humans refine their mental models of how to do things — not just applying procedures but updating them.

The preview text frames this as an unsolved problem rather than offering a solution, suggesting the article is a problem-statement or exploratory discussion rather than a prescriptive guide. With 1,069 likes and 120 retweets at time of fetch, the post resonated widely in the AI/agent development community, indicating the topic is timely and practitioners recognize the gap. The signal-to-noise ratio of the engagement suggests this represents a genuine open research and engineering challenge in the field of autonomous AI agents.

### Key Concepts
["SKILL.md is an emerging convention for defining agent capabilities as structured markdown files","Current agent frameworks treat skills as static definitions, not adaptive or self-updating constructs","The core unsolved problem is creating a feedback loop where agent skills improve based on execution outcomes","There is a meaningful distinction between 'agents with skills' and 'agents with skills that can improve over time'","Self-improving skills require a mechanism to update skill definitions in response to errors, successes, or new information","Skill distribution and invocation tooling is maturing, but skill refinement tooling does not yet exist at scale"]

### Full Text (excerpt)
Article title: Self improving skills for agents

Preview text: "not just agents with skills, but agents with skills that can improve over time"
Seems that "SKILL.md" is here to stay, however, we haven't really solved the most fundamental problem around them:

[Full article body unavailable — content requires authentication on x.com]

Source tweet: https://twitter.com/tricalt/status/2032179887277060476
Author: Vasilije (@tricalt)
Date: Thu Mar 12 19:40:15 +0000 2026
Likes: 1069 | Retweets: 120 | Replies: 19

---

