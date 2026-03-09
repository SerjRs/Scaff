// Test verifySonnet path by importing the actual evaluator
import { pathToFileURL } from "url";
import { readFileSync } from "fs";

const home = process.env.USERPROFILE + "/.openclaw";

// Find the evaluator in dist
import { readdirSync } from "fs";
const distFiles = readdirSync(home + "/dist");
const evalFile = distFiles.find(f => f.startsWith("evaluator-"));
if (!evalFile) { console.log("No evaluator dist file found"); process.exit(1); }

console.log("Loading evaluator from:", evalFile);
const mod = await import(pathToFileURL(home + "/dist/" + evalFile).href);

console.log("Exports:", Object.keys(mod));

if (mod.evaluate) {
  console.log("\nRunning evaluate()...");
  const config = {
    model: "anthropic/claude-sonnet-4-6",
    tier: "sonnet",
    timeout: 30,
    fallback_weight: 5
  };
  
  const result = await mod.evaluate(config, "Analyze the architectural trade-offs between microservices and monoliths");
  console.log("Result:", JSON.stringify(result));
} else {
  console.log("No evaluate export found");
}
