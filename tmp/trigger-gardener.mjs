/**
 * Trigger Gardener fact extraction manually against all cortex_session rows.
 * Uses Haiku directly via Anthropic API (same as the Gardener does).
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';

const ROOT = process.env.USERPROFILE + '/.openclaw';
const DB_PATH = ROOT + '/cortex/bus.sqlite';

const authProfiles = JSON.parse(readFileSync(ROOT + '/agents/main/agent/auth-profiles.json', 'utf8'));
const API_KEY = authProfiles.profiles['anthropic:scaff'].token;

async function extractLLM(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  return (await resp.json()).content[0].text;
}

const db = new DatabaseSync(DB_PATH);

// Get all seeded sessions grouped by approximate time windows
const seeded = db.prepare("SELECT content, timestamp FROM cortex_session WHERE issuer='memory-seed' ORDER BY timestamp").all();
console.log(`Seeded sessions: ${seeded.length}`);

// Group by timestamp (each timestamp = one source file's worth of content)
const groups = new Map();
for (const s of seeded) {
  const key = s.timestamp.substring(0, 13); // group by hour
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(s.content);
}

console.log(`Time groups: ${groups.size}`);

const EXTRACT_PROMPT = `Extract ONLY facts that are EXPLICITLY stated in this conversation. \
Facts are things like user preferences, personal details, project decisions, \
technical choices, system configurations, or relationships.

RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer, assume, or fabricate.
- Prefer specific, verifiable facts that would be useful weeks or months later.
- Skip: greetings, filler, routine acknowledgments, one-off computation results, task dispatch IDs, stress test data, ephemeral status observations, temporary debugging output.
- Each fact should be a standalone statement useful in future conversations.
- If no facts are found, return an empty array [].

Return ONLY a JSON array of strings, one fact per entry.

Content:
`;

// Process each group
let totalFacts = 0;
let insertedFacts = 0;
const insertStmt = db.prepare(
  "INSERT INTO cortex_hot_memory (id, fact_text, created_at, last_accessed_at, hit_count) VALUES (?, ?, ?, ?, 0)"
);

let groupNum = 0;
for (const [key, contents] of groups) {
  groupNum++;
  // Batch contents into chunks of ~4000 chars to stay within context
  let batch = '';
  for (const c of contents) {
    if (batch.length + c.length > 4000) {
      // Process this batch
      try {
        const response = await extractLLM(EXTRACT_PROMPT + batch);
        let facts;
        try {
          facts = JSON.parse(response);
          if (!Array.isArray(facts)) facts = [];
        } catch {
          const match = response.match(/\[[\s\S]*?\]/);
          facts = match ? JSON.parse(match[0]) : [];
        }
        
        for (const f of facts) {
          if (typeof f === 'string' && f.trim().length > 0) {
            const existing = db.prepare("SELECT id FROM cortex_hot_memory WHERE fact_text = ?").get(f.trim());
            if (!existing) {
              const id = crypto.randomUUID();
              const ts = key + ':00:00.000Z';
              insertStmt.run(id, f.trim(), ts, ts);
              insertedFacts++;
            }
          }
          totalFacts++;
        }
      } catch (e) {
        console.error(`  Error: ${e.message.substring(0, 100)}`);
      }
      batch = '';
    }
    batch += c + '\n\n---\n\n';
  }
  
  // Process remaining batch
  if (batch.length > 100) {
    try {
      const response = await extractLLM(EXTRACT_PROMPT + batch);
      let facts;
      try {
        facts = JSON.parse(response);
        if (!Array.isArray(facts)) facts = [];
      } catch {
        const match = response.match(/\[[\s\S]*?\]/);
        facts = match ? JSON.parse(match[0]) : [];
      }
      
      for (const f of facts) {
        if (typeof f === 'string' && f.trim().length > 0) {
          const existing = db.prepare("SELECT id FROM cortex_hot_memory WHERE fact_text = ?").get(f.trim());
          if (!existing) {
            const id = crypto.randomUUID();
            const ts = key + ':00:00.000Z';
            insertStmt.run(id, f.trim(), ts, ts);
            insertedFacts++;
          }
        }
        totalFacts++;
      }
    } catch (e) {
      console.error(`  Error: ${e.message.substring(0, 100)}`);
    }
  }
  
  console.log(`  Group ${groupNum}/${groups.size} [${key}]: processed`);
}

const total = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`\nDone. Extracted: ${totalFacts}, New inserts: ${insertedFacts}`);
console.log(`Total hot memory facts: ${total.c}`);
db.close();
