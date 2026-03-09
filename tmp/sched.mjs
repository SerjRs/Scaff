import { execSync } from 'child_process';
const params = JSON.stringify({offsetMs: 900000, session: "main", systemEvent: "CODE_INDEX_CHECK"});
const cmd = `node openclaw.mjs gateway call cron.add --params ${JSON.stringify(params)}`;
console.log('Running:', cmd);
execSync(cmd, { cwd: process.env.USERPROFILE + '/.openclaw', stdio: 'inherit' });
