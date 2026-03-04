import { readFileSync } from "fs";
const lines = readFileSync(process.env.USERPROFILE + "/.openclaw/agents/main/sessions/d8754ef3-667f-45c9-9d7b-cd19c48c3c9f.jsonl", "utf-8").split("\n").filter(Boolean);
for (const line of lines) {
  if (line.includes("run 20 tasks") && line.includes('"role":"user"')) {
    const obj = JSON.parse(line);
    console.log(JSON.stringify(obj, null, 2).slice(0, 2000));
    break;
  }
}
