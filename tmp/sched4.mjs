import { execSync } from 'child_process';
const at = new Date(Date.now() + 900000).toISOString();
const params = JSON.stringify({
  name: "code-index-check",
  schedule: { kind: "once", at },
  sessionTarget: "main",
  payload: { kind: "system-event", text: "CODE_INDEX_CHECK" }
});
const cmd = `node openclaw.mjs gateway call cron.add --params ${JSON.stringify(params)}`;
execSync(cmd, { cwd: process.env.USERPROFILE + '/.openclaw', stdio: 'inherit' });
