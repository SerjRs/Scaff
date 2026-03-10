const fs = require('fs');
const path = require('path');

const jobsPath = path.join(process.env.USERPROFILE, '.openclaw', 'cron', 'jobs.json');
const data = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));

const newJob = {
  "id": "b7c3e901-4f2a-4d8b-9e1c-code1ndex001",
  "name": "code-index-nightly",
  "enabled": true,
  "createdAtMs": 1773112200000,
  "updatedAtMs": 1773112200000,
  "schedule": {
    "kind": "every",
    "everyMs": 86400000,
    "anchorMs": 1773112500000
  },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": {
    "kind": "message",
    "message": "Run the code indexer now. Execute: node scripts/code-index.mjs and return the output. If it fails, try node scripts/code-index.mjs --full"
  },
  "state": {
    "nextRunAtMs": 1773112500000,
    "lastRunAtMs": null,
    "lastRunStatus": null,
    "lastStatus": null,
    "lastDurationMs": null,
    "lastDeliveryStatus": "not-requested",
    "consecutiveErrors": 0
  }
};

data.jobs.push(newJob);
fs.writeFileSync(jobsPath, JSON.stringify(data, null, 2));
console.log('Job added successfully');
