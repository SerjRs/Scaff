import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT channel, role, sender_name, substr(content, 1, 600) as preview, timestamp
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T15:39:00' 
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  const name = r.sender_name || r.role;
  let content = r.preview;
  
  // Skip internal thinking noise
  if (r.channel === 'internal' && content.includes('"thinkingSignature"')) continue;
  
  // Simplify tool calls
  if (content.includes('"type":"toolCall"')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const tools = parsed.filter(i => i.type === 'toolCall').map(i => `${i.name}(${JSON.stringify(i.arguments).slice(0, 120)})`);
        const thinking = parsed.find(i => i.type === 'thinking');
        let prefix = '';
        if (thinking?.thinking) prefix = `[THINK: ${thinking.thinking.slice(0, 150)}]\n`;
        if (tools.length > 0) content = `${prefix}[TOOLS] ${tools.join('\n  ')}`;
      }
    } catch {}
  }
  
  // Simplify tool results
  if (content.includes('"type":"tool_result"')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const results = parsed.filter(i => i.type === 'tool_result').map(i => (i.content || '').slice(0, 200));
        if (results.length > 0) content = `[RESULTS] ${results.join('\n  ')}`;
      }
    } catch {}
  }

  // Simplify thinking-only messages
  if (content.includes('"type":"thinking"') && !content.includes('toolCall')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const thinking = parsed.find(i => i.type === 'thinking');
        if (thinking?.thinking) content = `[THINKING] ${thinking.thinking.slice(0, 200)}`;
      }
    } catch {}
  }
  
  console.log(`\n${r.timestamp} [${r.channel}] ${name}`);
  console.log(content.slice(0, 400));
}
