import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const db = new DatabaseSync('cortex/bus.sqlite');

// Get API key
const authPath = path.join(process.env.USERPROFILE, '.openclaw/agents/main/agent/auth-profiles.json');
const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));

// Navigate auth structure to find API key
let apiKey = null;
if (auth.profiles) {
  for (const [id, profile] of Object.entries(auth.profiles)) {
    if (profile.apiKey) { apiKey = profile.apiKey; break; }
    if (profile.token) { apiKey = profile.token; break; }
    if (profile.keys) {
      for (const k of profile.keys) {
        if (k.key) { apiKey = k.key; break; }
      }
      if (apiKey) break;
    }
  }
}
if (!apiKey) {
  console.log('Could not find API key. Auth structure:', JSON.stringify(Object.keys(auth), null, 2));
  const profiles = auth.profiles || {};
  for (const [id, p] of Object.entries(profiles)) {
    console.log(`Profile ${id}:`, Object.keys(p));
  }
  process.exit(1);
}
console.log('API key found ✅');

async function callHaiku(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.content?.[0]?.text || '[]';
}

// Get session messages grouped by channel
const channels = db.prepare('SELECT DISTINCT channel FROM cortex_session').all();
console.log('Channels:', channels.map(c => c.channel));

for (const { channel } of channels) {
  const messages = db.prepare(
    'SELECT role, sender_id, content, timestamp FROM cortex_session WHERE channel = ? ORDER BY timestamp ASC'
  ).all(channel);
  
  console.log(`\n--- Channel: ${channel} (${messages.length} messages) ---`);
  if (messages.length === 0) continue;

  // Build transcript
  const transcript = messages
    .filter(m => typeof m.content === 'string' && m.content.length > 0)
    .slice(-100) // last 100 messages
    .map(m => `${m.role === 'assistant' ? 'Cortex' : (m.sender_id || 'User')}: ${m.content.substring(0, 500)}`)
    .join('\n');

  if (transcript.length < 50) {
    console.log('  Transcript too short, skipping');
    continue;
  }

  const prompt = `Extract ONLY facts that are EXPLICITLY stated in this conversation. \
Facts are things like user preferences, personal details, project decisions, \
technical choices, system configurations, or task outcomes.

RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer, assume, or fabricate.
- If the user says "I live in Bucharest" → extract that. If they don't mention where they live → extract nothing about location.
- Prefer specific, verifiable facts over vague observations.
- Skip greetings, filler, and routine acknowledgments.
- Each fact should be a standalone statement that would be useful in future conversations.
- If no facts are found, return an empty array [].

Return ONLY a JSON array of strings, one fact per entry.

Conversation:
${transcript}`;

  console.log(`  Sending ${transcript.length} chars to Haiku...`);
  
  try {
    const response = await callHaiku(prompt);
    let facts;
    try {
      facts = JSON.parse(response);
      if (!Array.isArray(facts)) facts = [];
    } catch {
      const match = response.match(/\[[\s\S]*?\]/);
      facts = match ? JSON.parse(match[0]) : [];
    }

    console.log(`  Extracted ${facts.length} facts:`);
    let inserted = 0;
    for (const factText of facts) {
      if (typeof factText !== 'string' || factText.trim().length === 0) continue;
      console.log(`    • ${factText}`);
      
      // Check exact duplicate
      const existing = db.prepare('SELECT id FROM cortex_hot_memory WHERE fact_text = ?').get(factText.trim());
      if (!existing) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare('INSERT INTO cortex_hot_memory (id, fact_text, created_at, last_accessed_at, hit_count) VALUES (?, ?, ?, ?, 0)')
          .run(id, factText.trim(), now, now);
        inserted++;
      }
    }
    console.log(`  Inserted: ${inserted} new facts`);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

const total = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`\n=== Total facts in hot memory: ${total.c} ===`);

db.close();
