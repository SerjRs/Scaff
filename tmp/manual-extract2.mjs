import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('cortex/bus.sqlite');

// Get session messages by channel
const channels = db.prepare('SELECT DISTINCT channel FROM cortex_session').all();
console.log('Channels:', channels.map(c => c.channel));

// Use gateway to call LLM (same as gardener does)
const GATEWAY = 'http://127.0.0.1:18789';

async function callViaGateway(prompt) {
  // Use the webchat endpoint to send a one-shot completion
  const resp = await fetch(`${GATEWAY}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'agent',
      params: {
        message: prompt,
        sessionKey: 'agent:router-executor:gardener-extract:' + crypto.randomUUID(),
        model: 'claude-haiku-4-5',
        deliver: false,
      },
    }),
  });
  const data = await resp.json();
  return data?.message?.content?.[0]?.text || data?.content || JSON.stringify(data);
}

for (const { channel } of channels) {
  const messages = db.prepare(
    'SELECT role, sender_id, content, timestamp FROM cortex_session WHERE channel = ? ORDER BY timestamp ASC'
  ).all(channel);
  
  console.log(`\n--- Channel: ${channel} (${messages.length} messages) ---`);
  if (messages.length === 0) continue;

  const transcript = messages
    .filter(m => typeof m.content === 'string' && m.content.length > 0 && m.content.length < 2000)
    .slice(-50)
    .map(m => `${m.role === 'assistant' ? 'Cortex' : (m.sender_id || 'User')}: ${m.content.substring(0, 500)}`)
    .join('\n');

  if (transcript.length < 50) {
    console.log('  Transcript too short, skipping');
    continue;
  }

  const prompt = `Extract ONLY facts that are EXPLICITLY stated in this conversation.
Facts are things like user preferences, personal details, project decisions,
technical choices, system configurations, or task outcomes.

RULES:
- ONLY extract what is directly said or clearly demonstrated. Do NOT infer, assume, or fabricate.
- Prefer specific, verifiable facts over vague observations.
- Skip greetings, filler, and routine acknowledgments.
- Each fact should be a standalone statement useful in future conversations.
- If no facts are found, return an empty array [].

Return ONLY a JSON array of strings, one fact per entry.

Conversation:
${transcript}`;

  console.log(`  Sending ${transcript.length} chars...`);
  
  try {
    const response = await callViaGateway(prompt);
    console.log(`  Response (first 300): ${response.substring(0, 300)}`);
    
    let facts;
    try {
      facts = JSON.parse(response);
      if (!Array.isArray(facts)) {
        const match = response.match(/\[[\s\S]*?\]/);
        facts = match ? JSON.parse(match[0]) : [];
      }
    } catch {
      const match = response.match(/\[[\s\S]*?\]/);
      facts = match ? JSON.parse(match[0]) : [];
    }

    console.log(`  Extracted ${facts.length} facts:`);
    let inserted = 0;
    for (const factText of facts) {
      if (typeof factText !== 'string' || factText.trim().length === 0) continue;
      console.log(`    • ${factText}`);
      
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
