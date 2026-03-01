import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HASH_FILE = path.join(rootDir, "src", "canvas-host", "a2ui", ".bundle.hash");
const OUTPUT_FILE = path.join(rootDir, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(rootDir, "vendor", "a2ui", "renderers", "lit");
const A2UI_APP_DIR = path.join(rootDir, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Docker builds exclude vendor/apps via .dockerignore.
// In that environment we can keep a prebuilt bundle only if it exists.
if (!isDir(A2UI_RENDERER_DIR) || !isDir(A2UI_APP_DIR)) {
  if (isFile(OUTPUT_FILE)) {
    console.log("A2UI sources missing; keeping prebuilt bundle.");
    process.exit(0);
  }
  console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
  process.exit(1);
}

// --- Hash computation ---

const INPUT_PATHS = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "pnpm-lock.yaml"),
  A2UI_RENDERER_DIR,
  A2UI_APP_DIR,
];

function walk(entryPath: string, out: string[]): void {
  const st = fs.statSync(entryPath);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(entryPath)) {
      walk(path.join(entryPath, entry), out);
    }
    return;
  }
  out.push(entryPath);
}

function normalize(p: string): string {
  return p.split(path.sep).join("/");
}

function computeHash(): string {
  const files: string[] = [];
  for (const input of INPUT_PATHS) {
    walk(input, files);
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(rootDir, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const currentHash = computeHash();

if (isFile(HASH_FILE)) {
  const previousHash = fs.readFileSync(HASH_FILE, "utf8").trim();
  if (previousHash === currentHash && isFile(OUTPUT_FILE)) {
    console.log("A2UI bundle up to date; skipping.");
    process.exit(0);
  }
}

// --- Build ---

try {
  execSync(`pnpm -s exec tsc -p ${JSON.stringify(path.join(A2UI_RENDERER_DIR, "tsconfig.json"))}`, {
    cwd: rootDir,
    stdio: "inherit",
  });

  const rolldownConfig = path.join(A2UI_APP_DIR, "rolldown.config.mjs");
  const whichCmd = process.platform === "win32" ? "where" : "which";
  let hasRolldown = false;
  try {
    execSync(`${whichCmd} rolldown`, { stdio: "ignore" });
    hasRolldown = true;
  } catch {
    // not found
  }

  if (hasRolldown) {
    execSync(`rolldown -c ${JSON.stringify(rolldownConfig)}`, {
      cwd: rootDir,
      stdio: "inherit",
    });
  } else {
    execSync(`pnpm -s dlx rolldown -c ${JSON.stringify(rolldownConfig)}`, {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  fs.writeFileSync(HASH_FILE, currentHash + "\n");
} catch {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}
