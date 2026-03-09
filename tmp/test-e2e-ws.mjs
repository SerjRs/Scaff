import { randomUUID, createHmac } from "crypto";
import { readFileSync } from "fs";
import WebSocket from "ws";

const cfg = JSON.parse(readFileSync(process.env.USERPROFILE + "/.openclaw/openclaw.json", "utf8"));
const token = cfg.gateway?.auth?.token;
if (!token) { console.log("No auth token found"); process.exit(1); }

console.log("Connecting to gateway WS...");
const ws = new WebSocket("ws://127.0.0.1:18789/ws");

ws.on("open", () => {
  console.log("Connected. Sending auth...");
  ws.send(JSON.stringify({ type: "connect", token }));
});

let authenticated = false;
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === "event" && msg.event === "connect.challenge") {
    // Respond to challenge with HMAC
    const nonce = msg.payload.nonce;
    const hmac = createHmac("sha256", token).update(nonce).digest("hex");
    console.log("Responding to challenge...");
    ws.send(JSON.stringify({ type: "connect", token, challenge: hmac, nonce }));
    return;
  }
  
  if (msg.type === "connected") {
    authenticated = true;
    console.log("Authenticated! Sending webchat message...");
    ws.send(JSON.stringify({
      type: "req",
      id: randomUUID(),
      method: "chat",
      params: {
        message: "Run a web search for 'OpenClaw AI agent' and summarize top 3 results",
        channel: "webchat"
      }
    }));
    return;
  }
  
  if (msg.type === "res") {
    console.log("\n=== RESPONSE ===");
    console.log("ok:", msg.ok);
    if (msg.error) console.log("error:", JSON.stringify(msg.error));
    if (msg.payload?.text) console.log("text:", msg.payload.text.slice(0, 300));
    if (msg.payload?.result) console.log("result keys:", Object.keys(msg.payload.result));
    
    // Wait a bit for router to process, then check tokens
    setTimeout(async () => {
      const { execSync } = await import("child_process");
      console.log("\n=== TOKEN MONITOR ===");
      const tokens = execSync(`node "${process.env.USERPROFILE}/.openclaw/openclaw.mjs" tokens`, { 
        timeout: 10000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" 
      });
      console.log(tokens);
      ws.close();
      process.exit(0);
    }, 5000);
    return;
  }
  
  if (msg.type === "event") {
    if (msg.event === "chat.delta") {
      process.stdout.write(".");
    } else {
      console.log("event:", msg.event);
    }
    return;
  }
  
  console.log("msg:", msg.type, JSON.stringify(msg).slice(0, 200));
});

ws.on("error", (err) => {
  console.error("WS error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("\n❌ TIMEOUT");
  ws.close();
  process.exit(1);
}, 120000);
