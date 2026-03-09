import { readFileSync } from 'fs';

// Check both days
for (const day of ['2026-03-07', '2026-03-08']) {
  const file = `C:/tmp/openclaw/openclaw-${day}.log`;
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  
  console.log(`\n=== ${day} (${lines.length} lines) ===`);
  
  // Find last entries (to see when it stopped)
  console.log('\nLast 5 entries:');
  for (const l of lines.slice(-5)) {
    try {
      const j = JSON.parse(l);
      const msg = typeof j['0'] === 'string' ? j['0'] : JSON.stringify(j['0']);
      console.log(`  ${j.time} [${j.logLevelName}] ${msg?.substring(0, 150)}`);
    } catch {}
  }
  
  // Find ERROR/FATAL
  console.log('\nErrors:');
  let errCount = 0;
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j.logLevelName === 'ERROR' || j.logLevelName === 'FATAL') {
        const msg = typeof j['0'] === 'string' ? j['0'] : JSON.stringify(j['0']);
        const detail = typeof j['1'] === 'string' ? j['1'] : (j['1'] ? JSON.stringify(j['1']).substring(0, 200) : '');
        console.log(`  ${j.time} ${msg?.substring(0, 120)}`);
        if (detail) console.log(`    ${detail}`);
        errCount++;
      }
    } catch {}
  }
  if (errCount === 0) console.log('  (none)');
}
