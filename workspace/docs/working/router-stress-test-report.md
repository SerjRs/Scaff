# Router Stress Test Report (via Cortex)
**Date:** 2026-03-02
**Duration:** 12 minutes

## Results
- **Passed:** 5/8 (63%)

## Individual Tests
| # | Test | Result | Hits |
|---|------|--------|------|
| 1 | File read | ❌ | none |
| 2 | Web search | ✅ | Bucharest |
| 3 | Simple exec | ✅ | node, . |
| 4 | Memory recall | ✅ | Luna, Pixel |
| 5 | Multi-step reasoning | ❌ | none |
| 6 | File write | ✅ | created, Router works |
| 7 | Calendar/time | ❌ | none |
| 8 | Combined memory + tool | ✅ | Blindsight, Watts |

## Details
### 1. File read
**Query:** Read the first 5 lines of workspace/SOUL.md and tell me what it says
**Response:** [silence]
**Expected:** Scaff, calm, direct
**Hits:** none
**Result:** ❌ FAIL

### 2. Web search
**Query:** Search the web for 'Bucharest weather today' and tell me the temperature
**Response:** [Tool] sessions_spawn>
<invoke name="sessions_spawn">
<parameter name="task">Search the web for "Bucharest weather today" and return the current temperature.</parameter>
<parameter name="mode">run</parameter>
<parameter name="priority">normal</parameter>
</invoke>
On it — spawned the search task.
**Expected:** Bucharest, °
**Hits:** Bucharest
**Result:** ✅ PASS

### 3. Simple exec
**Query:** Run 'node --version' and tell me which Node.js version is installed
**Response:** [Tool] sessions_spawn: 'Run the command "node --version" in the terminal and return the output.', priority=normal
On it — spawned it alongside the weather task.
**Expected:** v2, node, .
**Hits:** node, .
**Result:** ✅ PASS

### 4. Memory recall
**Query:** What do you remember about my cats?
**Response:** Luna and Pixel. Luna is a tabby, Pixel is a black cat. 🐱
**Expected:** Luna, Pixel
**Hits:** Luna, Pixel
**Result:** ✅ PASS

### 5. Multi-step reasoning
**Query:** How many files are in the workspace/docs/working/ directory? List them.
**Response:** [Tool] sessions_spawn: 'List all files in the workspace/docs/working/ directory and return the count and file names.', priority=normal
On it — spawned it.
**Expected:** stress, test, .md
**Hits:** none
**Result:** ❌ FAIL

### 6. File write
**Query:** Create a file at workspace/_router_test_output.txt with the content 'Router works!' and confirm it was created
**Response:** [Tool] sessions_spawn: 'Create a file at workspace/_router_test_output.txt with the content "Router works!" and confirm it was created successfully.', priority=normal
[silence]
**Expected:** created, Router works, wrote
**Hits:** created, Router works
**Result:** ✅ PASS

### 7. Calendar/time
**Query:** What is today's date and day of the week?
**Response:** [Tool] sessions_spawn: 'What is today\'s date and day of the week? Return the current date in a human-readable format.', priority=normal
[silence]
**Expected:** March, 2026, Sunday
**Hits:** none
**Result:** ❌ FAIL

### 8. Combined memory + tool
**Query:** What's my favorite book? Search the web for a summary of it.
**Response:** [Tool] sessions_spawn: 'Search the web for a summary of the book "Blindsight" by Peter Watts and return a concise summary (150-200 words).', priority=normal
On it — your favorite is Blindsight by Peter Watts. Spawned a web search for the summary.
**Expected:** Blindsight, Watts
**Hits:** Blindsight, Watts
**Result:** ✅ PASS


## Log
```
[08:48:38] === Router Stress Test (via Cortex) ===
[08:48:38] Session messages: 339
[08:48:38] 
--- Test 1/8: File read ---
[08:48:38] Query: "Read the first 5 lines of workspace/SOUL.md and tell me what it says"
[08:49:09] Response: "[silence]"
[08:49:09] Expected any of: [Scaff, calm, direct] → Hits: [] → ❌ FAIL
[08:49:14] 
--- Test 2/8: Web search ---
[08:49:14] Query: "Search the web for 'Bucharest weather today' and tell me the temperature"
[08:51:10] Response: "[Tool] sessions_spawn>
<invoke name="sessions_spawn">
<parameter name="task">Search the web for "Bucharest weather today" and return the current temperature.</parameter>
<parameter name="mode">run</pa"
[08:51:10] Expected any of: [Bucharest, °] → Hits: [Bucharest] → ✅ PASS
[08:51:15] 
--- Test 3/8: Simple exec ---
[08:51:15] Query: "Run 'node --version' and tell me which Node.js version is installed"
[08:52:39] Response: "[Tool] sessions_spawn: 'Run the command "node --version" in the terminal and return the output.', priority=normal
On it — spawned it alongside the weather task."
[08:52:39] Expected any of: [v2, node, .] → Hits: [node, .] → ✅ PASS
[08:52:44] 
--- Test 4/8: Memory recall ---
[08:52:44] Query: "What do you remember about my cats?"
[08:53:10] Response: "Luna and Pixel. Luna is a tabby, Pixel is a black cat. 🐱"
[08:53:10] Expected any of: [Luna, Pixel] → Hits: [Luna, Pixel] → ✅ PASS
[08:53:15] 
--- Test 5/8: Multi-step reasoning ---
[08:53:15] Query: "How many files are in the workspace/docs/working/ directory? List them."
[08:55:09] Response: "[Tool] sessions_spawn: 'List all files in the workspace/docs/working/ directory and return the count and file names.', priority=normal
On it — spawned it."
[08:55:09] Expected any of: [stress, test, .md] → Hits: [] → ❌ FAIL
[08:55:15] 
--- Test 6/8: File write ---
[08:55:15] Query: "Create a file at workspace/_router_test_output.txt with the content 'Router work"
[08:56:40] Response: "[Tool] sessions_spawn: 'Create a file at workspace/_router_test_output.txt with the content "Router works!" and confirm it was created successfully.', priority=normal
[silence]"
[08:56:40] Expected any of: [created, Router works, wrote] → Hits: [created, Router works] → ✅ PASS
[08:56:45] 
--- Test 7/8: Calendar/time ---
[08:56:45] Query: "What is today's date and day of the week?"
[08:58:19] Response: "[Tool] sessions_spawn: 'What is today\'s date and day of the week? Return the current date in a human-readable format.', priority=normal
[silence]"
[08:58:19] Expected any of: [March, 2026, Sunday] → Hits: [] → ❌ FAIL
[08:58:24] 
--- Test 8/8: Combined memory + tool ---
[08:58:24] Query: "What's my favorite book? Search the web for a summary of it."
[09:00:30] Response: "[Tool] sessions_spawn: 'Search the web for a summary of the book "Blindsight" by Peter Watts and return a concise summary (150-200 words).', priority=normal
On it — your favorite is Blindsight by Pete"
[09:00:30] Expected any of: [Blindsight, Watts] → Hits: [Blindsight, Watts] → ✅ PASS
[09:00:35] 
=== Results ===
[09:00:35] Passed: 5/8 (63%)
[09:00:35] Duration: 12 minutes
```
