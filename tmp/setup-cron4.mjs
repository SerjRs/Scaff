import { execSync } from 'child_process';
const params = JSON.stringify({
  name: "hippocampus-refresh",
  schedule: { everyMs: 7200000 },
  sessionTarget: "main",
  payload: { kind: "message", message: "[System] HIPPOCAMPUS_REFRESH: Run node scripts/refresh-hippocampus-context.mjs to update MEMORY.md with latest facts." }
});
execSync(`node openclaw.mjs gateway call cron.add --params ${JSON.stringify(params)}`, {
  cwd: process.env.USERPROFILE + '/.openclaw',
  stdio: 'inherit'
});
