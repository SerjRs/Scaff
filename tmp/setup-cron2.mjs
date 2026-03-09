import { execSync } from 'child_process';
const params = JSON.stringify({
  name: "hippocampus-refresh",
  everyMs: 7200000,
  session: "main",
  systemEvent: "HIPPOCAMPUS_REFRESH"
});
execSync(`node openclaw.mjs gateway call cron.add --params ${JSON.stringify(params)}`, {
  cwd: process.env.USERPROFILE + '/.openclaw',
  stdio: 'inherit'
});
