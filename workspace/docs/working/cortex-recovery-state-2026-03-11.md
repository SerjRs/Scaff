# Cortex Recovery State — 2026-03-11 (continue tomorrow)

## Status
Cortex is NOT responding on WhatsApp. Config is `"live"` but channel is still silent.

## Root Cause (confirmed via debug log)
The shard `dca8eda1` had a corrupted tool pair:
- `sessions_spawn` tool_use stored with no matching `tool_result`
- Every new message loaded this history → Anthropic API returned 400 → silent NO_REPLY

I deleted the 41 corrupted messages + shard record. Injected a test message → Cortex responded correctly in the debug log: `stopReason=stop`, textContent="Hey Serj, I'm here..."

So the **underlying engine works**. But real WhatsApp messages still aren't reaching it.

## Likely Remaining Issue
`cortex/config.json` channels keep resetting to `"off"` after gateway restarts. Config is read fresh on every message so no restart needed — but something resets it. Suspect: `do-rebuild.cmd` hardcoded PID (24776) doesn't kill the right process, so multiple gateway instances may be running, and one of them has Cortex in "off" mode.

## Current State of Files
- `src/cortex/gateway-bridge.ts` — has debug logger (temp, remove later):
  ```typescript
  fs.appendFileSync("C:\\Users\\Temp User\\.openclaw\\cortex-debug.log", ...)
  ```
- `cortex/config.json` — set to `"live"` for both channels (may have reset again)
- All other src/ files — clean HEAD (all Claude Code changes reverted)
- `src/library/` — still present (untracked, not imported by HEAD code)
- Debug log at: `C:\Users\Temp User\.openclaw\cortex-debug.log`

## Steps to Fix Tomorrow

### Step 1: Check if multiple gateway processes running
```powershell
Get-Process node | Select-Object Id, CPU, StartTime
Get-NetTCPConnection -LocalPort 18789 -State Listen
```
If multiple node processes, kill all and restart once cleanly.

### Step 2: Verify config is "live"
```powershell
Get-Content "C:\Users\Temp User\.openclaw\cortex\config.json" | Select-String "whatsapp|webchat"
```
If "off", set to "live". The config resets because something overwrites it — need to find the source.

### Step 3: Fix do-rebuild.cmd
The hardcoded PID 24776 is stale. Update it or replace with:
```cmd
FOR /F "tokens=5" %%P IN ('netstat -ano ^| findstr ":18789"') DO taskkill /F /PID %%P
```

### Step 4: Send real test from WhatsApp (not injected)
After confirming single process + config="live", ask Serj to send a WhatsApp message while watching the debug log:
```powershell
Get-Content "C:\Users\Temp User\.openclaw\cortex-debug.log" -Wait
```

### Step 5: If still not working — check dispatch.ts
Add logging to `src/auto-reply/dispatch.ts` around `cortexMode` check to see what mode is actually being resolved at runtime.

## What Works Confirmed
- Direct Anthropic API call with token: ✅ 200 OK
- Model resolution (claude-opus-4-6): ✅ 
- Auth profile (anthropic:scaff): ✅
- Cortex loop processes messages (cortex_bus state=completed): ✅
- LLM call returns valid response when shard is clean: ✅ (stopReason=stop)
- Config "live" triggers cortex_bus enqueue: ✅

## What's Not Working
- Real WhatsApp messages → Cortex (config may be "off" again)
- config.json keeps resetting to "off" — root cause unknown

## Files Modified (cleanup needed)
- Remove debug logger from `src/cortex/gateway-bridge.ts` once fixed
- Remove `workspace/tmp/` test scripts
- Consider committing the debug logger removal + config fix
