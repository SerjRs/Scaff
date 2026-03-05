import fs from "node:fs";
const home = process.env.USERPROFILE + "/.openclaw";

// 1. Validate openclaw.json
const raw = fs.readFileSync(home + "/openclaw.json", "utf8");
const cfg = JSON.parse(raw);

// 2. Validate cortex/config.json (separate file!)
let cortexCfg = null;
try {
  cortexCfg = JSON.parse(fs.readFileSync(home + "/cortex/config.json", "utf8"));
} catch {}

const checks = [
  ["openclaw.json: Valid JSON", true],
  ["openclaw.json: agents.list", Array.isArray(cfg.agents?.list) && cfg.agents.list.length > 0],
  ["openclaw.json: agents.defaults.thinkingDefault", !!cfg.agents?.defaults?.thinkingDefault],
  ["openclaw.json: router.enabled", cfg.router?.enabled === true],
  ["openclaw.json: router.evaluator", !!cfg.router?.evaluator],
  ["openclaw.json: router.tiers", !!cfg.router?.tiers],
  ["openclaw.json: NO cortex key (it belongs in cortex/config.json!)", !cfg.cortex],
  ["cortex/config.json: exists", !!cortexCfg],
  ["cortex/config.json: enabled", cortexCfg?.enabled === true],
  ["cortex/config.json: channels.webchat=live", cortexCfg?.channels?.webchat === "live"],
  ["cortex/config.json: model set", !!cortexCfg?.model],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
