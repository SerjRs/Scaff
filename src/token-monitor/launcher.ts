/**
 * Launches `openclaw tokens --watch` in a separate visible terminal window
 * when the gateway starts. The child process is detached so it doesn't block
 * the gateway, and is killed when the gateway exits.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

let child: ChildProcess | null = null;

function resolveEntryScript(): string {
  // process.argv[1] is the CLI entrypoint (e.g. dist/entry.js or openclaw.mjs)
  const argv1 = process.argv[1];
  if (argv1) {
    return path.resolve(argv1);
  }
  throw new Error("[token-monitor] Cannot resolve CLI entrypoint from process.argv[1]");
}

export function launchTokenMonitorWindow(log: {
  warn: (msg: string) => void;
}): void {
  try {
    const entryScript = resolveEntryScript();
    const execPath = process.execPath; // node or bun binary

    if (process.platform === "win32") {
      // On Windows: open a new CMD window with a title
      child = spawn(
        "cmd.exe",
        ["/c", "start", "OpenClaw Token Monitor", execPath, entryScript, "tokens", "--watch"],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        },
      );
    } else {
      // On macOS/Linux: try common terminal emulators
      // Fallback: run detached in background (user can `openclaw tokens --watch` manually)
      const cmd = `${execPath} ${entryScript} tokens --watch`;
      if (process.platform === "darwin") {
        child = spawn("osascript", ["-e", `tell app "Terminal" to do script "${cmd}"`], {
          detached: true,
          stdio: "ignore",
        });
      } else {
        // Linux: try xterm, gnome-terminal, konsole in order
        child = spawn("sh", ["-c", `xterm -title "OpenClaw Token Monitor" -e "${cmd}" 2>/dev/null || gnome-terminal --title="OpenClaw Token Monitor" -- ${cmd} 2>/dev/null || konsole --noclose -e ${cmd} 2>/dev/null &`], {
          detached: true,
          stdio: "ignore",
          shell: true,
        });
      }
    }

    child.unref();
    log.warn("[token-monitor] Launched in separate window");

    // Clean up on gateway exit
    const cleanup = () => {
      if (child && !child.killed) {
        child.kill();
        child = null;
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (err) {
    log.warn(`[token-monitor] Failed to launch window: ${String(err)}`);
  }
}

export function stopTokenMonitorWindow(): void {
  if (child && !child.killed) {
    child.kill();
    child = null;
  }
}
