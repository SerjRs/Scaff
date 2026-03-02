# Hippocampus Stress Test Report
**Date:** 2026-03-02
**Duration:** 26 minutes

## Results
- **Hot facts extracted:** 45 (target: ≥20)
- **Recall accuracy:** 10/10 = 100% (target: ≥80%)
- **Verdict:** ✅ MILESTONE 1 PASSED

## Facts Extracted
- User's favorite color is blue
- User's dog is named Rex
- User works at TechCorp as a backend engineer
- User prefers Rust over Go
- User's birthday is March 15th
- User moved to Berlin in 2019 and lives in Kreuzberg
- User's main programming languages are TypeScript and Python
- User avoids Java whenever possible
- User drives a white Tesla Model 3, bought in 2023
- User moved to Berlin in 2019 and lives in the Kreuzberg neighborhood
- User's previous recorded location was Bucharest (now outdated)
- User's wife is named Elena and she works as a UX designer at Figma
- User has two cats: Luna (tabby) and Pixel (black cat)
- User uses NeoVim as their main editor
- User uses VSCode for debugging
- User's terminal is WezTerm
- User's go-to lunch spot is Pho 36, a Vietnamese restaurant near Kottbusser Tor in Berlin
- User runs 5K every morning at 6:30 AM with a best time of 22 minutes
- User's team uses PostgreSQL as the main database and Redis for caching, migrated from MongoDB last year
- User is allergic to shellfish
- User loves sushi, especially salmon nigiri
- User prefers Signal over WhatsApp for work communication
- User's project deadline is April 15th with a board demo on April 10th
- User reads mostly sci-fi; favorite book is Blindsight by Peter Watts; currently reading Project Hail Mary
- User's team uses AWS (EKS and RDS) and is evaluating Fly.io as an alternative
- User takes melatonin before bed
- User drinks oat milk in coffee with no sugar
- User has a dog named Rex
- User drives a white Tesla Model 3 bought in 2023
- User uses NeoVim as main editor, VSCode for debugging, and WezTerm as terminal
- User's go-to lunch spot is Pho 36 (Vietnamese) near Kottbusser Tor in Berlin
- User's team uses PostgreSQL for the main database and Redis for caching, migrated from MongoDB last year
- User is allergic to shellfish but loves sushi, especially salmon nigiri
- User's project demo with the board is on April 10th and the project deadline is April 15th
- User's team uses AWS (primarily EKS and RDS) and is evaluating Fly.io as an alternative
- User takes melatonin before bed, drinks oat milk in coffee, and takes no sugar
- User's team uses PostgreSQL as main database and Redis for caching, migrated from MongoDB last year
- User prefers Signal over WhatsApp for work
- Project deadline is April 15th with a board demo on April 10th
- User takes melatonin before bed, drinks oat milk in coffee, no sugar

## Recall Queries
| # | Query | Expected | Hits | Result |
|---|-------|----------|------|--------|
| 1 | Where do I live? | Berlin, Kreuzberg | Berlin, Kreuzberg | ✅ |
| 2 | What programming languages do I use? | TypeScript, Python | TypeScript, Python | ✅ |
| 3 | What car do I drive? | Tesla, Model 3 | Tesla, Model 3 | ✅ |
| 4 | Tell me about my wife | Elena, UX, Figma | Elena, UX, Figma | ✅ |
| 5 | What are my cats' names? | Luna, Pixel | Luna, Pixel | ✅ |
| 6 | What editor do I use? | NeoVim, VSCode | NeoVim, VSCode | ✅ |
| 7 | What's my running routine? | 5K, 6:30, morning | 5K, 6:30, morning | ✅ |
| 8 | What databases does our team use? | PostgreSQL, Redis | PostgreSQL, Redis | ✅ |
| 9 | What food allergies do I have? | shellfish | shellfish | ✅ |
| 10 | When is the project deadline? | April 15 | April 15 | ✅ |

## Log
```
[08:19:36] === Hippocampus Stress Test ===
[08:19:36] Pre-test: 5 hot facts, 289 session messages
[08:19:36] 
--- Phase 1: Seeding facts ---
[08:19:36] Sending 1/15: "I moved to Berlin in 2019 and I've been living the..."
[08:20:12]   ✓ Sent
[08:20:16] Sending 2/15: "My main programming languages are TypeScript and P..."
[08:20:39]   ✓ Sent
[08:20:42] Sending 3/15: "I drive a Tesla Model 3, white color, bought it in..."
[08:21:10]   ✓ Sent
[08:21:13] Sending 4/15: "My wife's name is Elena and she works as a UX desi..."
[08:21:37]   ✓ Sent
[08:21:41] Sending 5/15: "We have two cats: Luna and Pixel. Luna is a tabby ..."
[08:22:04]   ✓ Sent
[08:22:07] Sending 6/15: "I use NeoVim as my main editor but VSCode for debu..."
[08:22:32]   ✓ Sent
[08:22:35] Sending 7/15: "My go-to lunch spot is a Vietnamese place called P..."
[08:22:58]   ✓ Sent
[08:23:01] Sending 8/15: "I run 5K every morning at 6:30 AM. My best time is..."
[08:23:25]   ✓ Sent
[08:23:28] Sending 9/15: "Our team uses PostgreSQL for the main database and..."
[08:23:51]   ✓ Sent
[08:23:54] Sending 10/15: "I'm allergic to shellfish but I love sushi, especi..."
[08:24:17]   ✓ Sent
[08:24:21] Sending 11/15: "My phone number is +49-170-555-1234 and I prefer S..."
[08:24:44]   ✓ Sent
[08:24:47] Sending 12/15: "The project deadline is April 15th. We have a demo..."
[08:25:09]   ✓ Sent
[08:25:13] Sending 13/15: "I read mostly sci-fi. My favorite book is Blindsig..."
[08:25:36]   ✓ Sent
[08:25:39] Sending 14/15: "Our AWS bill is around $8000/month. Most of it is ..."
[08:26:02]   ✓ Sent
[08:26:05] Sending 15/15: "I take melatonin before bed and drink oat milk in ..."
[08:26:28]   ✓ Sent
[08:26:31] 
Post-seed: 27 hot facts, 319 session messages
[08:26:31] 
--- Phase 2: Waiting for Gardener extraction ---
[08:27:31]   1min: 27 hot facts
[08:28:31]   2min: 27 hot facts
[08:29:32]   3min: 27 hot facts
[08:30:32]   4min: 27 hot facts
[08:31:32]   5min: 36 hot facts
[08:32:32]   6min: 36 hot facts
[08:33:33]   7min: 36 hot facts
[08:34:33]   8min: 36 hot facts
[08:35:33]   9min: 36 hot facts
[08:36:34]   10min: 40 hot facts
[08:37:34]   11min: 40 hot facts
[08:38:34]   12min: 40 hot facts
[08:38:34] 
Post-extraction: 40 hot facts
[08:38:34] All facts:
[08:38:34]   • User's favorite color is blue
[08:38:34]   • User's dog is named Rex
[08:38:34]   • User works at TechCorp as a backend engineer
[08:38:34]   • User prefers Rust over Go
[08:38:34]   • User's birthday is March 15th
[08:38:34]   • User moved to Berlin in 2019 and lives in Kreuzberg
[08:38:34]   • User's main programming languages are TypeScript and Python
[08:38:34]   • User avoids Java whenever possible
[08:38:34]   • User drives a white Tesla Model 3, bought in 2023
[08:38:34]   • User moved to Berlin in 2019 and lives in the Kreuzberg neighborhood
[08:38:34]   • User's previous recorded location was Bucharest (now outdated)
[08:38:34]   • User's wife is named Elena and she works as a UX designer at Figma
[08:38:34]   • User has two cats: Luna (tabby) and Pixel (black cat)
[08:38:34]   • User uses NeoVim as their main editor
[08:38:34]   • User uses VSCode for debugging
[08:38:34]   • User's terminal is WezTerm
[08:38:34]   • User's go-to lunch spot is Pho 36, a Vietnamese restaurant near Kottbusser Tor in Berlin
[08:38:34]   • User runs 5K every morning at 6:30 AM with a best time of 22 minutes
[08:38:34]   • User's team uses PostgreSQL as the main database and Redis for caching, migrated from MongoDB last year
[08:38:34]   • User is allergic to shellfish
[08:38:34]   • User loves sushi, especially salmon nigiri
[08:38:34]   • User prefers Signal over WhatsApp for work communication
[08:38:34]   • User's project deadline is April 15th with a board demo on April 10th
[08:38:34]   • User reads mostly sci-fi; favorite book is Blindsight by Peter Watts; currently reading Project Hail Mary
[08:38:34]   • User's team uses AWS (EKS and RDS) and is evaluating Fly.io as an alternative
[08:38:34]   • User takes melatonin before bed
[08:38:34]   • User drinks oat milk in coffee with no sugar
[08:38:34]   • User has a dog named Rex
[08:38:34]   • User drives a white Tesla Model 3 bought in 2023
[08:38:34]   • User uses NeoVim as main editor, VSCode for debugging, and WezTerm as terminal
[08:38:34]   • User's go-to lunch spot is Pho 36 (Vietnamese) near Kottbusser Tor in Berlin
[08:38:34]   • User's team uses PostgreSQL for the main database and Redis for caching, migrated from MongoDB last year
[08:38:34]   • User is allergic to shellfish but loves sushi, especially salmon nigiri
[08:38:34]   • User's project demo with the board is on April 10th and the project deadline is April 15th
[08:38:34]   • User's team uses AWS (primarily EKS and RDS) and is evaluating Fly.io as an alternative
[08:38:34]   • User takes melatonin before bed, drinks oat milk in coffee, and takes no sugar
[08:38:34]   • User's team uses PostgreSQL as main database and Redis for caching, migrated from MongoDB last year
[08:38:34]   • User prefers Signal over WhatsApp for work
[08:38:34]   • Project deadline is April 15th with a board demo on April 10th
[08:38:34]   • User takes melatonin before bed, drinks oat milk in coffee, no sugar
[08:38:34] 
--- Phase 3: Recall queries ---
[08:38:34] 
Query 1/10: "Where do I live?"
[08:39:11]   Response: "Berlin, Kreuzberg. You moved there in 2019."
[08:39:11]   Expected: [Berlin, Kreuzberg] → Hits: [Berlin, Kreuzberg] → ✅ PASS
[08:39:14] 
Query 2/10: "What programming languages do I use?"
[08:39:53]   Response: "TypeScript and Python mainly. You avoid Java whenever possible, and you prefer Rust over Go."
[08:39:53]   Expected: [TypeScript, Python] → Hits: [TypeScript, Python] → ✅ PASS
[08:39:56] 
Query 3/10: "What car do I drive?"
[08:40:35]   Response: "White Tesla Model 3, bought in 2023."
[08:40:35]   Expected: [Tesla, Model 3] → Hits: [Tesla, Model 3] → ✅ PASS
[08:40:38] 
Query 4/10: "Tell me about my wife"
[08:41:19]   Response: "Her name is Elena, she's a UX designer at Figma."
[08:41:19]   Expected: [Elena, UX, Figma] → Hits: [Elena, UX, Figma] → ✅ PASS
[08:41:22] 
Query 5/10: "What are my cats' names?"
[08:42:02]   Response: "Luna (tabby) and Pixel (black cat)."
[08:42:02]   Expected: [Luna, Pixel] → Hits: [Luna, Pixel] → ✅ PASS
[08:42:05] 
Query 6/10: "What editor do I use?"
[08:42:40]   Response: "NeoVim as your main editor, VSCode for debugging, WezTerm as your terminal."
[08:42:40]   Expected: [NeoVim, VSCode] → Hits: [NeoVim, VSCode] → ✅ PASS
[08:42:43] 
Query 7/10: "What's my running routine?"
[08:43:24]   Response: "5K every morning at 6:30 AM, best time 22 minutes."
[08:43:24]   Expected: [5K, 6:30, morning] → Hits: [5K, 6:30, morning] → ✅ PASS
[08:43:27] 
Query 8/10: "What databases does our team use?"
[08:44:05]   Response: "PostgreSQL as the main database, Redis for caching. Migrated from MongoDB last year."
[08:44:05]   Expected: [PostgreSQL, Redis] → Hits: [PostgreSQL, Redis] → ✅ PASS
[08:44:08] 
Query 9/10: "What food allergies do I have?"
[08:44:45]   Response: "Shellfish. But you love sushi — salmon nigiri especially. 🍣"
[08:44:45]   Expected: [shellfish] → Hits: [shellfish] → ✅ PASS
[08:44:48] 
Query 10/10: "When is the project deadline?"
[08:45:22]   Response: "April 15th. Board demo is April 10th."
[08:45:22]   Expected: [April 15] → Hits: [April 15] → ✅ PASS
[08:45:25] 
--- Results ---
[08:45:25] Total hot facts: 45
[08:45:25] Recall: 10/10 (100%)
[08:45:25] Duration: 26 minutes
[08:45:25] Target: ≥20 facts, ≥80% recall
[08:45:25] Verdict: ✅ MILESTONE 1 PASSED
```
