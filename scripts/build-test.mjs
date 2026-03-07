#!/usr/bin/env node
/**
 * Structured Build + Test Runner
 * Wraps `pnpm build` and `vitest run` with machine-readable JSON output.
 * 
 * Usage:
 *   node scripts/build-test.mjs              # build + test
 *   node scripts/build-test.mjs --build      # build only
 *   node scripts/build-test.mjs --test       # test only
 *   node scripts/build-test.mjs --test --scope src/cortex  # test subset
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const buildOnly = args.includes('--build');
const testOnly = args.includes('--test');
const scopeIdx = args.indexOf('--scope');
const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : null;
const runBuild = !testOnly;
const runTest = !buildOnly;

const result = {
  timestamp: new Date().toISOString(),
  build: null,
  tests: null,
};

// --- BUILD ---
if (runBuild) {
  try {
    const stdout = execSync('pnpm run build 2>&1', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    
    // Parse TypeScript errors from output
    const errors = [];
    const errorRegex = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
    let match;
    while ((match = errorRegex.exec(stdout)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        code: match[4],
        message: match[5],
      });
    }

    // Also catch vite/rollup errors
    const viteErrors = [];
    const viteRegex = /error during build:[\s\S]*?(?:Error:\s*(.+?)(?:\n|$))/gi;
    while ((match = viteRegex.exec(stdout)) !== null) {
      viteErrors.push({ message: match[1] });
    }

    result.build = {
      success: errors.length === 0 && viteErrors.length === 0,
      errors,
      viteErrors: viteErrors.length > 0 ? viteErrors : undefined,
      duration: undefined, // Could parse from output
    };
  } catch (err) {
    // Build command failed
    const stdout = err.stdout || err.message || '';
    const errors = [];
    const errorRegex = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
    let match;
    while ((match = errorRegex.exec(stdout)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        code: match[4],
        message: match[5],
      });
    }
    result.build = {
      success: false,
      errors,
      exitCode: err.status,
      rawError: errors.length === 0 ? stdout.substring(0, 500) : undefined,
    };
  }
}

// --- TESTS ---
if (runTest) {
  try {
    const testCmd = scope
      ? `npx vitest run ${scope} --reporter json 2>&1`
      : `npx vitest run --reporter json 2>&1`;
    
    const stdout = execSync(testCmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 300_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    // vitest --reporter json outputs JSON to stdout
    // But it may have non-JSON preamble — find the JSON object
    const jsonStart = stdout.indexOf('{"');
    if (jsonStart >= 0) {
      const jsonStr = stdout.substring(jsonStart);
      const vitest = JSON.parse(jsonStr);
      
      const passed = vitest.numPassedTests || 0;
      const failed = vitest.numFailedTests || 0;
      const skipped = vitest.numPendingTests || 0;
      const total = vitest.numTotalTests || 0;

      const failures = [];
      if (vitest.testResults) {
        for (const suite of vitest.testResults) {
          if (suite.status === 'failed') {
            for (const test of (suite.assertionResults || [])) {
              if (test.status === 'failed') {
                failures.push({
                  file: suite.name?.replace(ROOT + path.sep, '') || suite.name,
                  test: test.fullName || test.title,
                  error: (test.failureMessages || []).join('\n').substring(0, 500),
                });
              }
            }
          }
        }
      }

      result.tests = {
        success: failed === 0,
        passed,
        failed,
        skipped,
        total,
        failures: failures.length > 0 ? failures : undefined,
        duration: vitest.startTime ? `${((Date.now() - vitest.startTime) / 1000).toFixed(1)}s` : undefined,
      };
    } else {
      // Couldn't parse JSON — fallback to text parsing
      result.tests = {
        success: stdout.includes('Tests  ') && !stdout.includes('failed'),
        rawOutput: stdout.substring(0, 1000),
        parseError: 'Could not find JSON in vitest output',
      };
    }
  } catch (err) {
    const stdout = err.stdout || err.message || '';
    
    // Try to parse JSON from failed test run
    const jsonStart = stdout.indexOf('{"');
    if (jsonStart >= 0) {
      try {
        const vitest = JSON.parse(stdout.substring(jsonStart));
        const failures = [];
        if (vitest.testResults) {
          for (const suite of vitest.testResults) {
            for (const test of (suite.assertionResults || [])) {
              if (test.status === 'failed') {
                failures.push({
                  file: suite.name?.replace(ROOT + path.sep, '') || suite.name,
                  test: test.fullName || test.title,
                  error: (test.failureMessages || []).join('\n').substring(0, 500),
                });
              }
            }
          }
        }
        result.tests = {
          success: false,
          passed: vitest.numPassedTests || 0,
          failed: vitest.numFailedTests || 0,
          total: vitest.numTotalTests || 0,
          failures,
        };
      } catch {
        result.tests = { success: false, rawOutput: stdout.substring(0, 1000) };
      }
    } else {
      result.tests = {
        success: false,
        exitCode: err.status,
        rawOutput: stdout.substring(0, 1000),
      };
    }
  }
}

console.log(JSON.stringify(result, null, 2));
