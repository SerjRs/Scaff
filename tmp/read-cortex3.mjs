import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

// Get the tool results to see what memory_query returned
const rows = db.prepare(`
  SELECT channel, role, substr(content, 1, 600) as preview, timestamp
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T13:13:00' 
  AND (channel = 'internal' OR (channel = 'whatsapp' AND role = 'assistant' AND content LIKE '%toolCall%'))
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  console.log(`\n--- ${r.timestamp} [${r.channel}/${r.role}] ---`);
  // Extract just the relevant bits
  let content = r.preview;
  if (content.includes('tool_result')) {
    // Parse and show just the facts
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.type === 'tool_result') {
            const inner = JSON.parse(item.content);
            if (inner.facts) {
              console.log(`  Query returned ${inner.facts.length} facts:`);
              for (const f of inner.facts.slice(0, 5)) {
                console.log(`    [${f.distance?.toFixed(1)}] [${f.source}] ${f.text?.slice(0, 100)}`);
              }
            }
          }
        }
      }
    } catch {
      console.log(content.slice(0, 200));
    }
  } else if (content.includes('toolCall')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.type === 'toolCall') {
            console.log(`  → ${item.name}(${JSON.stringify(item.arguments)})`);
          }
        }
      }
    } catch {
      console.log(content.slice(0, 200));
    }
  }
}
