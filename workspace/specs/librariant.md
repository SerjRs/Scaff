# The Librariant — Spec v1

## Overview
An autonomous article ingestion pipeline. User sends bare URLs → Haiku agent fetches, summarizes, indexes → stored in a Library. On command, Scaff walks the Library and generates actionable tasks.

---

## Flow

### 1. Trigger Detection (Scaff / Main Session)
- **Input:** User sends a message containing only a URL (no comment)
- **Detection rule:** Message matches URL pattern AND has no other meaningful text
- **Action:** `sessions_spawn` with task = the URL, routed to Librariant agent

### 2. Router Integration
- Scaff calls `sessions_spawn` with a descriptive task: `"Librariant: fetch, summarize, and index this article: <URL>"`
- **The Router evaluates the task** like any other spawn — scores complexity, picks the model
- The Router should naturally score this as low complexity (fetch + summarize = Haiku territory)
- Label: `librariant-ingest`
- No hardcoded weight — the Router decides

### 3. Librariant Agent (Haiku)
On wake, the agent:

#### a. Fetch
- `web_fetch(url, extractMode="markdown", maxChars=50000)`
- If fetch fails (paywall, 403, JS-heavy): try `web_fetch(url, extractMode="text")` as fallback
- If both fail: store entry with `status: "fetch_failed"`, log the error

#### b. Extract
From the fetched content, produce:

```json
{
  "url": "https://...",
  "title": "Article Title",
  "author": "Author Name (if found)",
  "publishedDate": "2026-02-20 (if found)",
  "source": "blog.example.com",
  "summary": "3-5 sentence summary of the key points",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "category": "one of: architecture | security | ai-agents | infrastructure | programming | devops | product | research | other",
  "relevanceNotes": "Why this might matter for an AI agent system (1-2 sentences)",
  "fetchedAt": "ISO timestamp",
  "status": "indexed"
}
```

#### c. Store
- **SQLite database:** `library/library.sqlite`
- **Table: `articles`**

```sql
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  author TEXT,
  published_date TEXT,
  source TEXT,
  summary TEXT,
  keywords TEXT,           -- JSON array
  category TEXT,
  relevance_notes TEXT,
  raw_content TEXT,        -- first 20KB of fetched markdown (for re-reading)
  fetched_at TEXT NOT NULL,
  status TEXT DEFAULT 'indexed',  -- indexed | fetch_failed | reviewed | actioned
  reviewed_at TEXT,        -- set when Scaff walks the library
  task_generated TEXT,     -- task description if Scaff creates one
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at);
```

#### d. Announce
- On success: announce back with title + category + 1-line summary
- On failure: announce with URL + error reason

---

### 4. Library Walk (Scaff / Main Session)
Triggered by user command like "walk the library" or "review the library".

**Process:**
1. Query all articles with `status = 'indexed'` (unreviewed)
2. For each article:
   - Read `raw_content` + existing `summary` + `keywords`
   - Validate/correct summary and keywords if needed
   - Based on content + current architecture (MEMORY.md, long-term shards):
     - **If actionable:** Generate a task (self-patch, new skill, config change, research follow-up)
     - **If informational:** Mark as reviewed, no task
   - Update `status` → `reviewed`, set `reviewed_at`, optionally set `task_generated`
3. Report findings to user: list of articles reviewed + any tasks generated

**Task categories Scaff can generate:**
- `patch:` — code change to existing system (e.g., "add retry logic to web_fetch based on article X")
- `skill:` — new skill to build (e.g., "build a Playwright visual regression skill")
- `config:` — configuration improvement
- `research:` — needs deeper investigation, spawn a dedicated subagent
- `note:` — interesting but no action needed, just remember it

---

## File Structure

```
library/
├── library.sqlite        # main store
├── README.md             # this spec (condensed)
└── tasks/                # generated task files (optional, for complex ones)
    └── 2026-02-24-retry-logic.md
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Duplicate URL | SQLite UNIQUE constraint → skip, announce "already in library" |
| Paywall / login-required | Store with `status: fetch_failed`, keep URL for manual review |
| Very long article (>50KB) | Truncated by maxChars, note in metadata |
| Non-article link (GitHub repo, tweet, video) | Librariant still extracts what it can; category handles variety |
| Multiple URLs in one message | Split and spawn one Librariant per URL |
| URL with user comment | NOT a bare link — Scaff handles normally, doesn't trigger Librariant |

---

## Config

No special config needed — the Librariant is just a task routed through the standard Router. The Router's evaluator should score "fetch and summarize an article" as low complexity and assign Haiku naturally.

If the Router consistently over-weights these tasks, that's a Router tuning issue — not a Librariant issue.

---

## Future Extensions (v2+)
- **Vector embeddings** on summaries for semantic library search
- **Auto-walk** via cron (e.g., review new articles every evening)
- **Priority scoring** based on keyword overlap with current tasks/backlog
- **Cross-reference** articles that cite each other or cover similar topics
- **Expiry** — archive articles older than 90 days that were never actioned
