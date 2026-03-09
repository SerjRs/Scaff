import { execSync } from 'child_process';
const params = JSON.stringify({
  name: "code-index-check",
  schedule: { offsetMs: 900000 },
  sessionTarget: { session: "main" },
  payload: { systemEvent: "CODE_INDEX_CHECK" }
});
const cmd = `node openclaw.mjs gateway call cron.add --params ${JSON.stringify(params)}`;
execSync(cmd, { cwd: process.env.USERPROFILE + '/.openclaw', stdio: 'inherit' });
