import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT channel, role, sender_name, substr(content, 1, 600) as preview, timestamp
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T14:39:00' 
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  const name = r.sender_name || r.role;
  let content = r.preview;
  
  // Simplify thinking blocks
  if (content.includes('"type":"thinking"')) {
    // Extract just the thinking text
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.type === 'thinking' && item.thinking) {
            content = `[THINKING] ${item.thinking.slice(0, 200)}`;
          } else if (item.type === 'toolCall') {
            content = `[TOOL] ${item.name}(${JSON.stringify(item.arguments).slice(0, 150)})`;
          } else if (item.type === 'tool_result') {
            const inner = item.content?.slice(0, 200) || '';
            content = `[RESULT] ${inner}`;
          }
        }
      }
    } catch {}
  }
  
  // Simplify tool calls
  if (content.includes('"type":"toolCall"')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const tools = parsed.filter(i => i.type === 'toolCall').map(i => `${i.name}(${JSON.stringify(i.arguments).slice(0, 100)})`);
        if (tools.length > 0) content = `[TOOLS] ${tools.join(' | ')}`;
      }
    } catch {}
  }
  
  // Simplify tool results
  if (content.includes('"type":"tool_result"')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const results = parsed.filter(i => i.type === 'tool_result').map(i => (i.content || '').slice(0, 150));
        if (results.length > 0) content = `[RESULTS] ${results.join(' | ')}`;
      }
    } catch {}
  }
  
  console.log(`\n${r.timestamp} [${r.channel}] ${name}`);
  console.log(content.slice(0, 300));
}
