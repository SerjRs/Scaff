# 🚨 RECOVERY RUNBOOK — If Scaff Broke The Gateway

**When to use this:** The OpenClaw gateway won't start, Scaff is unreachable on all channels (webchat, WhatsApp, etc.), and you need to bring him back.

**Location of this file:** `C:\Users\Temp User\.openclaw\RECOVERY.md`
**Also on GitHub:** https://github.com/SerjRs/Scaff (in workspace docs)

---

## Quick Fix (90% of cases)

The most likely cause is bad code in `src/`. The gateway is a source build, so reverting code fixes it.

### Option A: Git Revert (fastest)

```powershell
cd "C:\Users\Temp User\.openclaw"

# See what changed
git diff --stat HEAD

# Revert ALL code changes back to last known good
git checkout -- src/
git checkout -- dist/

# Rebuild
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"
pnpm build

# Restart gateway
node openclaw.mjs gateway stop
node openclaw.mjs gateway start
```

### Option B: Disable Cortex Only

If Cortex integration broke things but the rest is fine:

```powershell
# Edit the Cortex config to disable it
# File: C:\Users\Temp User\.openclaw\cortex\config.json
# Set: { "enabled": false }

# Or if the config doesn't exist yet, the gateway shouldn't load Cortex at all.
# Check server-startup.ts for the Cortex init block and comment it out.

# Rebuild & restart
cd "C:\Users\Temp User\.openclaw"
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"
pnpm build
node openclaw.mjs gateway stop
node openclaw.mjs gateway start
```

### Option C: Disable Router Only

If the Router broke things:

```powershell
# File: C:\Users\Temp User\.openclaw\router\config.json
# Set: { "enabled": false }

# Rebuild & restart
cd "C:\Users\Temp User\.openclaw"
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"
pnpm build
node openclaw.mjs gateway stop
node openclaw.mjs gateway start
```

---

## Nuclear Option: Full Reset

If git revert doesn't work or the build is completely broken:

### Option D: Restore From Backup

```powershell
# Check if backup exists
ls "C:\Users\Temp User\backup-2026-02-25"

# If it does, copy the critical files back:
Copy-Item "C:\Users\Temp User\backup-2026-02-25\dist\*" "C:\Users\Temp User\.openclaw\dist\" -Recurse -Force

# Restart
node "C:\Users\Temp User\.openclaw\openclaw.mjs" gateway start
```

### Option E: Fresh Install From npm

```powershell
# Install OpenClaw globally (bypasses the source build entirely)
npm install -g openclaw

# Start gateway using the global install
openclaw gateway start
```

This will use the published version, not the source build. Scaff will lose Router and Cortex customizations but will be alive.

---

## Diagnostics

### Check if gateway is running
```powershell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "openclaw" }
```

### Check gateway logs
```powershell
# Try starting in foreground to see errors
cd "C:\Users\Temp User\.openclaw"
node openclaw.mjs gateway start --foreground
```

### Check if it's a build error
```powershell
cd "C:\Users\Temp User\.openclaw"
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"
pnpm build 2>&1 | Select-Object -Last 30
```

### Check if it's a config error
```powershell
# Validate openclaw.json
node -e "const c = require('./openclaw.json'); console.log('Config OK, model:', c.agents?.defaults?.model?.primary)"
```

### Check if it's a port conflict
```powershell
netstat -ano | findstr ":3578"
```

---

## Key Paths

| What | Path |
|------|------|
| OpenClaw root | `C:\Users\Temp User\.openclaw\` |
| Entry point | `C:\Users\Temp User\.openclaw\openclaw.mjs` |
| Config | `C:\Users\Temp User\.openclaw\openclaw.json` |
| Built output | `C:\Users\Temp User\.openclaw\dist\` |
| Source code | `C:\Users\Temp User\.openclaw\src\` |
| Router config | `C:\Users\Temp User\.openclaw\router\config.json` |
| Cortex config | `C:\Users\Temp User\.openclaw\cortex\config.json` |
| Workspace | `C:\Users\Temp User\.openclaw\workspace\` |
| Workspace (main session) | `C:\Users\Temp User\.openclaw\workspace-main\` |
| Auth files | `C:\Users\Temp User\.openclaw\agents\main\agent\` |
| Backup | `C:\Users\Temp User\backup-2026-02-25\` |
| Gateway script | `C:\Users\Temp User\.openclaw\gateway.cmd` |

## Build Requirements

```powershell
# Git Bash must be in PATH for pnpm build
$env:PATH = "C:\Program Files\Git\bin;$env:PATH"

# Then build
pnpm build
```

---

## After Recovery

Once the gateway is running again, open webchat at the gateway URL and tell Scaff what happened. He'll know what to fix.

**Webchat URL:** Check `openclaw.json` → `webchat` section for the port, or try: `http://localhost:3578`

---

*Last updated: 2026-02-26 by Scaff*
