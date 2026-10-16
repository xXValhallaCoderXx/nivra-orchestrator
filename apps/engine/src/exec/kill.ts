import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const alive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

const exited = (child: ChildProcess, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (!alive(child)) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/** `taskkill /T /F` by absolute path, so a program called taskkill in some folder on PATH is never the one run. */
function taskkill(pid: number): Promise<void> {
  const exe = join(process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise((resolve) => {
    const killer = spawn(exe, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

/**
 * Stops a child and everything it started (D4).
 * - POSIX: the child was spawned detached, so it leads its own process group: SIGTERM to the group, SIGKILL after
 *   `graceMs`. The group is signalled even when its leader already exited, since its descendants may not have.
 * - Windows: `taskkill /T /F`, only while the child itself is still running, so a reused process id is never hit.
 *   Descendants are also in libuv's kill-on-close job object.
 */
export async function killTree(child: ChildProcess, options: { graceMs?: number; platform?: NodeJS.Platform } = {}): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if ((options.platform ?? process.platform) === "win32") {
    if (alive(child)) await taskkill(pid);
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false; // ESRCH: nobody left in the group
    }
  };
  if (!signalGroup("SIGTERM")) return;
  await exited(child, options.graceMs ?? 2_000);
  // Whether or not the leader left in time, nothing it started may stay behind.
  signalGroup("SIGKILL");
}
