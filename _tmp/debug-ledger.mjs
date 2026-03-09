// Hit the gateway to get raw ledger state
import { createConnection } from "net";

const payload = JSON.stringify({ method: "usage.tokens.debug" });

// Use the gateway RPC - but we need a different approach
// Let's just query the running process's globalThis via the tokens endpoint
// and also dump the raw map keys

import http from "http";

const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "usage.tokens", params: {} });

const req = http.request({
  hostname: "127.0.0.1",
  port: 18789,
  path: "/api/rpc",
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
}, (res) => {
  let body = "";
  res.on("data", c => body += c);
  res.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      const result = parsed.result ?? parsed;
      if (result.rows) {
        console.log(`${result.rows.length} rows:`);
        result.rows.forEach((r, i) => {
          console.log(`  [${i}] pid=${r.pid} agent=${r.agentId} model=${r.model} channel=${r.channel} status=${r.status} in=${r.tokensIn} out=${r.tokensOut}`);
        });
      } else {
        console.log("Response:", body.substring(0, 500));
      }
    } catch {
      console.log("Raw:", body.substring(0, 500));
    }
  });
});
req.write(data);
req.end();
