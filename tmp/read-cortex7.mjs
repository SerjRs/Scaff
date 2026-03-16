import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/Temp User/.openclaw/cortex/bus.sqlite');

const rows = db.prepare(`
  SELECT channel, role, sender_name, substr(content, 1, 800) as preview, timestamp
  FROM cortex_session 
  WHERE timestamp >= '2026-03-16T15:36:00' 
  ORDER BY timestamp ASC
`).all();

for (const r of rows) {
  const name = r.sender_name || r.role;
  let content = r.preview;
  
  if (r.channel === 'internal' && content.includes('"thinkingSignature"')) continue;
  
  if (content.includes('"type":"toolCall"')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const tools = parsed.filter(i => i.type === 'toolCall').map(i => `${i.name}(${JSON.stringify(i.arguments).slice(0, 200)})`);
        const thinking = parsed.find(i => i.type === 'thinking');
        let prefix = '';
        if (thinking?.thinking) prefix = `[THINK: ${thinking.thinking.slice(0, 200)}]\n`;
        if (tools.length > 0) content = `${prefix}[TOOLS] ${tools.join('\n  ')}`;
      }
    } catch {}
  }
  
  if (content.includes('"type":"tool_result"')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const results = parsed.filter(i => i.type === 'tool_result').map(i => (i.content || '').slice(0, 300));
        if (results.length > 0) content = `[RESULTS] ${results.join('\n---\n  ')}`;
      }
    } catch {}
  }

  if (content.includes('"type":"thinking"') && !content.includes('toolCall')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const thinking = parsed.find(i => i.type === 'thinking');
        if (thinking?.thinking) content = `[THINKING] ${thinking.thinking.slice(0, 300)}`;
      }
    } catch {}
  }
  
  console.log(`\n${r.timestamp} [${r.channel}] ${name}`);
  console.log(content.slice(0, 500));
}
