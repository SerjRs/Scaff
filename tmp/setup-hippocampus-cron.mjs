// Set up a cron to refresh hippocampus context every 2 hours
const resp = await fetch('http://127.0.0.1:18789/api/cron', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'add',
    name: 'hippocampus-refresh',
    schedule: { everyMs: 2 * 60 * 60 * 1000 }, // 2 hours
    sessionTarget: 'main',
    payload: { 
      kind: 'system-event', 
      text: 'HIPPOCAMPUS_REFRESH: Run `node scripts/refresh-hippocampus-context.mjs` to update MEMORY.md with latest Hippocampus facts.'
    }
  })
});
console.log('Status:', resp.status, await resp.text());
