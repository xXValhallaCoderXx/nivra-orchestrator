import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

/** Provider variables that must not reach an engine through its environment (D8): keys travel in `initialize`. */
const PROVIDER_ENV_VARS = new Set(["NEBIUS_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);

/**
 * The environment an engine (or `wsl.exe`) starts with: the host's own, without Electron's variables, NODE_OPTIONS or
 * provider keys, with exactly one PATH key.
 */
export function engineEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  let path: string | undefined;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "path") {
      path ??= value || undefined;
      continue;
    }
    if (key === "NODE_OPTIONS" || key.startsWith("ELECTRON_") || PROVIDER_ENV_VARS.has(key)) continue;
    env[key] = value;
  }
  if (path !== undefined) env[platform === "win32" ? "Path" : "PATH"] = path;
  return { ...env, ...extra };
}

/**
 * Text a Windows tool printed. `wsl.exe` writes UTF-16LE unless `WSL_UTF8=1` reached it, so NUL bytes mean UTF-16
 * (D3). Line endings become `\n`.
 */
export function decodeToolText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf16 = buffer.includes(0);
  let text = utf16 ? buffer.toString("utf16le") : buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n").replace(/\0/g, "");
}

/** The `WSL_E_*` code in a `wsl.exe` message ("Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND"), never its words. */
export function wslErrorCode(text: string): string | null {
  return /\b(WSL_E_[A-Z0-9_]+)\b/.exec(text)?.[1] ?? null;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program to its end without a shell, stdin from `input` (or closed), output decoded with `decodeToolText`.
 * Rejects only when the program could not be started.
 */
export function runTool(
  command: string,
  args: readonly string[],
  options: { env?: Record<string, string>; cwd?: string; input?: Readable | Buffer | null; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin?.on("error", () => undefined);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: decodeToolText(Buffer.concat(out)), stderr: decodeToolText(Buffer.concat(err)), timedOut });
    });
    const input = options.input;
    if (input && child.stdin) {
      if (Buffer.isBuffer(input)) child.stdin.end(input);
      else {
        input.on("error", () => child.stdin?.destroy());
        input.pipe(child.stdin);
      }
    } else child.stdin?.end();
  });
}

const alive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

/**
 * Forces an engine process down (D4, the last step of the quit order). On Windows `taskkill /T /F`, by absolute path
 * and only while the process still runs, so a reused process id is never hit; elsewhere SIGKILL.
 */
export async function forceKill(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!alive(child) || child.pid === undefined) return;
  if (platform === "win32") {
    const exe = join(process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows", "System32", "taskkill.exe");
    await runTool(exe, ["/PID", String(child.pid), "/T", "/F"], { timeoutMs: 10_000 }).catch(() => undefined);
    if (alive(child)) child.kill();
    return;
  }
  child.kill("SIGKILL");
}
