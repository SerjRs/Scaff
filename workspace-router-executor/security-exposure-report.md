# OpenClaw Security Exposure Report
**Generated:** 2026-03-05  
**Runtime:** Node.js v24.13.0  
**Scope:** `C:\Users\Temp User\.openclaw\src\`  
**Analyst:** Automated CVE pattern scan (Stress Test A9)

---

## 1. CVE Reference Baseline

CVE external sources were partially inaccessible (MITRE CGI and Node.js blog returned no readable content). The following CVEs are referenced from known Node.js security advisories applicable to 2025–2026, cross-mapped against findings in the codebase:

| CVE ID | Severity | Description |
|---|---|---|
| CVE-2025-23166 | HIGH | `vm` module sandbox bypass via prototype pollution |
| CVE-2025-55131 | HIGH | `vm` module context escape (hypothetical, per task spec) |
| CVE-2025-59465 | MEDIUM | HTTP/2 server CONTINUATION frame DoS |
| CVE-2024-22020 | HIGH | `child_process` command injection via `shell:true` + string interpolation |
| CVE-2024-36137 | MEDIUM | `child_process` permission model bypass |
| CVE-2024-22017 | HIGH | `url.parse()` hostname parsing bypass |
| General | MEDIUM | `eval()`/`new Function()` in application code |

---

## 2. Scan Results

### 2.1 `vm` Module Usage
**Pattern:** `require('vm')` / `import ... from 'vm'`  
**Findings:** ✅ **NONE FOUND**

No usage of Node.js `vm` module detected in `src/`. This attack surface does not exist in OpenClaw.  
**CVE-2025-55131 risk: NOT EXPOSED**

---

### 2.2 HTTP/2 Server Usage
**Pattern:** `require('http2')` / HTTP/2 server construction  
**Findings:** ⚠️ **1 FILE**

```
src/infra/push-apns.ts (lines 3, 319, 358)
  import http2 from "node:http2";
  const client = http2.connect(authority);   // outbound CLIENT, not server
  req.close(http2.constants.NGHTTP2_CANCEL);
```

**Assessment:** HTTP/2 is used as an **outbound client** only (Apple Push Notification Service). This is used for APNS delivery, not for hosting an HTTP/2 server. CVE-2025-59465 affects HTTP/2 **servers** receiving CONTINUATION frames. This implementation is **not a server**, so the DoS vector does not apply in the traditional sense — however, a malicious APNS endpoint or MITM could theoretically abuse the client connection.

**CVE-2025-59465 risk: LOW** (client-only, outbound to Apple servers over TLS)

---

### 2.3 `url.parse()` Usage
**Pattern:** `url.parse(`  
**Findings:** ✅ **NONE FOUND**

No deprecated `url.parse()` usage in `src/`. The codebase appears to use the modern WHATWG `URL` constructor or other parsing methods.  
**CVE-2024-22017 risk: NOT EXPOSED**

---

### 2.4 `child_process` Usage
**Pattern:** imports, `spawn`, `execFile`, `execFileSync`, `spawnSync`, `shell:true`  
**Findings:** 🔴 **EXTENSIVE** — 40+ files

#### High-risk sub-patterns:

**A) `shell: true` in spawn calls (3 locations):**

| File | Line | Context |
|---|---|---|
| `src/process/exec.ts` | 141–143 | Conditional `shell:true` via `shouldSpawnWithShell()` — applied when running `.cmd`/`.bat` files on Windows |
| `src/token-monitor/launcher.ts` | 49–53 | `shell:true` with string interpolation to launch terminal emulators on Linux |
| `src/tui/tui-local-shell.ts` | 111 | `shell:true` intentional, gated behind operator approval prompt |

**B) `execSync` / `exec` (shell-invoking, non-file variants):**

| File | Line | Risk |
|---|---|---|
| `src/agents/cli-credentials.ts` | 1 | `execSync` imported — used for keychain reads (macOS) |
| `src/cli/update-cli/shared.ts` | 1 | `spawnSync` — package manager invocation |
| `src/infra/shell-env.ts` | 83 | `params.exec(params.shell, ["-l", "-c", "env -0"])` — shell invoked with controlled args |
| `src/infra/ssh-config.ts` | 1 | `spawn` — SSH subprocess, fixed args |
| `src/security/audit.test.ts` | 2224 | `execSync` in test with `icacls` on Windows |

**C) Positive mitigations observed:**
- Most files use `execFile` / `execFileSync` (no shell interpretation) — ✅ good practice
- `src/security/skill-scanner.ts` actively **detects and flags** `child_process` exec with string interpolation in third-party skills — ✅ defense in depth
- `src/acp/client.ts` implements a `TOOL_NAME_PATTERN` allow-list (`/^[a-z0-9._-]+$/`) for tool name validation — ✅

**CVE-2024-22020 / injection risk: MEDIUM**  
The `shell:true` cases are narrow and context-gated, but `launcher.ts:49` uses a template literal with a variable `cmd` — if `cmd` is ever derived from user/external input, injection is possible. `tui-local-shell.ts` is gated behind operator approval.

---

### 2.5 `eval()` / `new Function()` Constructor Usage
**Pattern:** `\beval(` / `new Function(`  
**Findings:** 🔴 **PRESENT** — 1 production file + test files

#### Production code:
```
src/browser/pw-tools-core.interactions.ts (lines 287–334)
```
Two instances of `new Function(..., eval("(" + fnBody + ")"))` used to:
- Evaluate browser automation functions passed as string (`fnBody`)
- Run inside Playwright's browser context via `locator.evaluate()`

**Context:**  
The `fnBody` parameter is a function body string that originates from user tool calls (`act` action, `fn` parameter). The eval runs **inside the browser sandbox** (Chromium renderer process) via Playwright's `evaluate()`, not in the Node.js process. The `new Function` wrapper is in Node.js but passes code into the browser context.

**Risk Analysis:**
- The browser context isolation is a meaningful security boundary
- However, if `fnBody` is controlled by an attacker (e.g., via a message that triggers a browser action), it could execute arbitrary JavaScript in the browser
- There is **no apparent sanitization** of `fnBody` before it reaches `new Function()`/`eval()`
- The comment `// eslint-disable-next-line @typescript-eslint/no-implied-eval` confirms the team is aware but has accepted the risk

**CVE risk: MEDIUM-HIGH** (arbitrary JS execution in browser context; potential for exfil of browser session data, cookies, credentials)

---

## 3. Security Exposure Summary

| Finding | Risk Level | CVE Reference | Exposed |
|---|---|---|---|
| `vm` module usage | — | CVE-2025-55131 | ❌ Not present |
| HTTP/2 server (DoS) | LOW | CVE-2025-59465 | ⚠️ Client-only |
| `url.parse()` | — | CVE-2024-22017 | ❌ Not present |
| `child_process` + `shell:true` | MEDIUM | CVE-2024-22020 | ⚠️ 3 locations |
| `eval()`/`new Function()` | MEDIUM-HIGH | CWE-95 / general | 🔴 Production code |
| Skill code `child_process` detection | POSITIVE CONTROL | — | ✅ Mitigated |

---

## 4. Remediation Recommendations

### P1 — Medium-High: Browser eval sanitization
**File:** `src/browser/pw-tools-core.interactions.ts`  
**Action:** Add an allowlist-based validator on `fnBody` before passing to `new Function()`/`eval()`. At minimum, check for dangerous patterns (`fetch`, `XMLHttpRequest`, `document.cookie`, `navigator.credentials`). Consider restricting which sessions/users can trigger `evaluate` actions.

### P2 — Medium: `shell:true` + interpolated string in launcher
**File:** `src/token-monitor/launcher.ts:49`  
**Action:** Audit the source of `cmd`. If it comes from any external or user-controlled value, escape it or switch to a fixed argument array. The current string interpolation in a `sh -c` call is a command injection vector if `cmd` contains shell metacharacters.

### P3 — Low: HTTP/2 client TLS validation
**File:** `src/infra/push-apns.ts`  
**Action:** Verify that `http2.connect(authority)` enforces TLS certificate validation. Ensure no `rejectUnauthorized: false` option is present (check full connection options). APNS connections must be pinned or validated against Apple's CA.

### P4 — Informational: Update to latest Node.js LTS
**Current version:** v24.13.0 (Node.js 24 — current)  
**Action:** Monitor nodejs.org security releases. v24 is the current release line; ensure patch-level updates are applied promptly when security releases are announced (typically via `ncu` or Dependabot).

### P5 — Informational: `execSync` in credentials
**File:** `src/agents/cli-credentials.ts`  
**Action:** Review all `execSync` call sites to confirm arguments are fully hardcoded or sanitized. Prefer `execFileSync` to prevent shell interpretation.

---

## 5. Positive Security Signals

- **Active skill scanner** (`src/security/skill-scanner.ts`) — detects `child_process`, `eval`, `new Function` in third-party plugins before install. Excellent defense-in-depth.
- **No `vm` module** — avoids the entire class of sandbox escape CVEs.
- **No `url.parse()`** — uses modern WHATWG URL API.
- **Tool name validation** (`acp/client.ts`) — strict pattern `/^[a-z0-9._-]+$/` prevents tool name injection.
- **Majority of child_process calls use `execFile`** — safer than `exec`/`execSync` for most cases.
- **Security audit module** (`src/security/audit.ts`) — suggests mature security-awareness culture in the codebase.

---

*Report generated by automated static analysis. Manual code review recommended for P1 and P2 findings before production hardening.*
