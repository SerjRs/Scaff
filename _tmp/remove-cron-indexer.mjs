import fs from "fs";
import path from "path";
import { homedir } from "os";
const p = path.resolve(homedir(), ".openclaw/cron/jobs.json");
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.jobs = j.jobs.filter(job => job.name !== "code-index-nightly");
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log("Removed code-index-nightly. Remaining:", j.jobs.map(x => x.name));
