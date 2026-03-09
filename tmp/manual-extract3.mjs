import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const db = new DatabaseSync('cortex/bus.sqlite');

// Get auth from profiles  
const authPath = path.join(process.env.USERPROFILE, '.openclaw/agents/main/agent/auth-profiles.json');
const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));

let apiKey = null;
const profiles = auth.profiles || {};
for (const [id, profile] of Object.entries(profiles)) {
  if (profile.token) { apiKey = profile.token; break; }
}

if (!apiKey) {
  console.error('No API key found');
  process.exit(1);
}

// The token might be for a proxy. Let's check what base URL the gateway uses
const cfgPath = path.join(process.env.USERPROFILE, '.openclaw/openclaw.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
const anthropicProvider = cfg.providers?.find?.(p => p.id === 'anthropic') || cfg.providers?.anthropic;
const baseUrl = anthropicProvider?.baseUrl || 'https://api.anthropic.com';
console.log('Provider baseUrl:', baseUrl);

// Check what model IDs work — read from router tiers
const haikuModel = cfg.router?.tiers?.haiku?.model || 'anthropic/claude-haiku-4-5';
console.log('Haiku model from config:', haikuModel);

// Try the API with proper model ID resolution
// The gateway handles model resolution - the raw model might need the provider prefix stripped
const modelId = haikuModel.replace('anthropic/', '');
console.log('Trying model:', modelId);

async function callLLM(prompt) {
  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${resp.status}: ${text.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '[]';
}

// Test with a simple call first
console.log('Testing LLM call...');
try {
  const test = await callLLM('Return exactly: ["test"]');
  console.log('Test response:', test);
} catch (e) {
  console.error('Test failed:', e.message);
  
  // Try listing available models
  console.log('\nTrying to list models...');
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log('Available models:', data.data?.map(m => m.id).slice(0, 10));
    } else {
      console.log('Models endpoint:', resp.status, await resp.text().then(t => t.substring(0, 200)));
    }
  } catch(e2) { console.log('Models error:', e2.message); }
  
  process.exit(1);
}

// Now extract from each channel
for (const { channel } of db.prepare('SELECT DISTINCT channel FROM cortex_session').all()) {
  const messages = db.prepare(
    'SELECT role, sender_id, content FROM cortex_session WHERE channel = ? ORDER BY timestamp ASC'
  ).all(channel);
  
  console.log(`\n--- ${channel} (${messages.length} msgs) ---`);
  const transcript = messages
    .filter(m => typeof m.content === 'string' && m.content.length > 0 && m.content.length < 2000)
    .slice(-50)
    .map(m => `${m.role === 'assistant' ? 'Cortex' : (m.sender_id || 'User')}: ${m.content.substring(0, 400)}`)
    .join('\n');

  if (transcript.length < 50) { console.log('  Too short'); continue; }

  const prompt = `Extract ONLY facts that are EXPLICITLY stated in this conversation.
Facts are things like user preferences, personal details, project decisions,
technical choices, system configurations, or task outcomes.

RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer, assume, or fabricate.
- Prefer specific, verifiable facts over vague observations.
- Skip greetings, filler, and routine acknowledgments.
- If no facts are found, return an empty array [].

Return ONLY a JSON array of strings, one fact per entry.

Conversation:
${transcript}`;

  try {
    const response = await callLLM(prompt);
    let facts;
    try { facts = JSON.parse(response); } catch { 
      const m = response.match(/\[[\s\S]*?\]/); facts = m ? JSON.parse(m[0]) : []; 
    }
    if (!Array.isArray(facts)) facts = [];

    let inserted = 0;
    for (const ft of facts) {
      if (typeof ft !== 'string' || !ft.trim()) continue;
      const ex = db.prepare('SELECT id FROM cortex_hot_memory WHERE fact_text = ?').get(ft.trim());
      if (!ex) {
        db.prepare('INSERT INTO cortex_hot_memory (id, fact_text, created_at, last_accessed_at, hit_count) VALUES (?, ?, ?, ?, 0)')
          .run(crypto.randomUUID(), ft.trim(), new Date().toISOString(), new Date().toISOString());
        inserted++;
      }
    }
    console.log(`  ${facts.length} facts extracted, ${inserted} inserted`);
    for (const ft of facts) console.log(`    • ${ft}`);
  } catch (e) { console.log(`  Error: ${e.message}`); }
}

const total = db.prepare('SELECT COUNT(*) as c FROM cortex_hot_memory').get();
console.log(`\n=== Total: ${total.c} facts ===`);
db.close();
