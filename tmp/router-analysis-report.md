# Router Module Analysis Report
_Generated: 2026-03-04 14:57 EET_

## 1. src/router/ Source Analysis (11 non-test .ts files)

### Line Counts

| File | Total | Code | Comments | Blank | Comment:Code Ratio |
|------|------:|-----:|---------:|------:|-------------------:|
| dispatcher.ts | 76 | 41 | 25 | 10 | 61.0% |
| evaluator.ts | 329 | 255 | 49 | 25 | 19.2% |
| gateway-integration.ts | 458 | 264 | 143 | 51 | 54.2% |
| index.ts | 168 | 105 | 35 | 28 | 33.3% |
| loop.ts | 210 | 128 | 54 | 28 | 42.2% |
| notifier.ts | 136 | 66 | 47 | 23 | 71.2% |
| queue.ts | 295 | 233 | 31 | 31 | 13.3% |
| recovery.ts | 91 | 59 | 21 | 11 | 35.6% |
| types.ts | 60 | 52 | 0 | 8 | 0.0% |
| worker.ts | 135 | 60 | 57 | 18 | 95.0% |
| templates/index.ts | 55 | 32 | 16 | 7 | 50.0% |
| **TOTALS** | **2,013** | **1,295** | **478** | **240** | **36.9%** |

### Cyclomatic Complexity Estimates

| File | Complexity Score |
|------|----------------:|
| evaluator.ts | 62 |
| queue.ts | 59 |
| gateway-integration.ts | 54 |
| loop.ts | 21 |
| dispatcher.ts | 9 |
| index.ts | 9 |
| recovery.ts | 8 |
| notifier.ts | 7 |
| templates/index.ts | 3 |
| worker.ts | 2 |
| types.ts | 0 |

**Average complexity per file: 21.3**

The highest complexity files (evaluator, queue, gateway-integration) contain the core routing logic — model selection, job persistence, and gateway communication.

### Top 3 Functions by Length

| Rank | Function | File | Lines |
|------|----------|------|------:|
| 1 | `createGatewayExecutor` | gateway-integration.ts | 75 |
| 2 | `recover` | recovery.ts | 68 |
| 3 | `initRouterDb` | queue.ts | 67 |

Runners-up: `initGatewayRouter` (67 lines), `processTick` (66 lines).

---

## 2. src/config/schema.help.ts Analysis (139 KB)

### Config Keys Documented
- **618 keys** in the main file + **16 IRC keys** imported from `schema.irc.ts`
- **Total: 634 documented config options**

### Is It Auto-Generated?
**No.** Despite its size, this file is **hand-authored**, not auto-generated:
- No `DO NOT EDIT`, `@generated`, or generator tool comments
- Zero comment lines in the entire 1,390-line file
- The "auto-gen" matches found were config *keys about* auto-generation (`gateway.tls.autoGenerate`, etc.), not generator markers
- Each description is a carefully written human-readable help string with opinionated guidance ("Use only for local/dev setups", "Keep false by default")
- It's a hand-maintained `Record<string, string>` mapping, not a code-gen output

### String Literals vs Code

| Metric | Value |
|--------|------:|
| Total characters | 139,320 |
| String literal characters | 120,859 |
| **String literal percentage** | **86.7%** |
| Code/structure characters | 18,461 (13.3%) |

The file is overwhelmingly string content — it's essentially a structured documentation database stored as a TypeScript constant.

---

## Summary

The router module is compact (2,013 lines across 11 files) with a healthy 37% comment-to-code ratio. Complexity concentrates in three files that handle model evaluation, job queuing, and gateway integration. The longest functions (~68–75 lines) manage initialization/setup logic. The schema help file is a massive hand-written documentation map covering 634 config keys, where 87% of the file content is descriptive string literals.
