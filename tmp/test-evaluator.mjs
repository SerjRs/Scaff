// Test the evaluator directly via Ollama
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";

const tasks = [
  "What is 2+2?",
  "Read the file workspace/IDENTITY.md and summarize it",
  "Analyze architectural trade-offs between event sourcing and CQRS for financial systems"
];

for (const task of tasks) {
  console.log(`\n=== Task: ${task.slice(0, 60)} ===`);
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2:3b",
        prompt: `Score the complexity of the following task:\n\n${task}`,
        system: `You are a task complexity evaluator. Your job is to score how complex a task is on a scale from 1 to 10.\n\nScoring criteria:\n- 1-3: Trivial\n- 4-7: Moderate\n- 8-10: Complex\n\nRespond with ONLY a JSON object:\n{"weight": <number 1-10>, "reasoning": "<brief explanation>"}`,
        stream: false,
        options: { temperature: 0.1, num_predict: 128 }
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await resp.json();
    console.log("  Ollama response:", data.response?.trim());
  } catch (e) {
    console.log("  ERROR:", e.message);
  }
}

// Check Ollama is healthy
console.log("\n=== Ollama health ===");
const tags = await fetch("http://127.0.0.1:11434/api/tags").then(r => r.json());
console.log("Models:", tags.models?.map(m => m.name).join(", "));

// Check token monitor
const { execSync } = await import("child_process");
console.log("\n=== TOKEN MONITOR ===");
const tokens = execSync(`node "${process.env.USERPROFILE}/.openclaw/openclaw.mjs" tokens`, { timeout: 10000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" });
console.log(tokens);
