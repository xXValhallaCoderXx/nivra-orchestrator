import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { engineEnv, runTool, wslErrorCode, type RunResult } from "./process.ts";
import { engineArgs, TargetUnavailableError, type EngineLaunch, type ExecutionTarget, type LaunchRequest, type TargetProbe, type TargetProblem } from "./types.ts";
import type { WslDistro } from "./wsl-discovery.ts";

/** The Linux runtime this app ships for WSL (D5): a deterministic tarball and its content hash. */
export interface WslRuntime {
  tarball: string;
  contentHash: string;
}

/**
 * Reports what the engine needs, one `key=value` per line. `$1` is the runtime's content hash; it arrives as an
 * argument, never spliced into the script.
 */
export const PROBE_SCRIPT = [
  'printf "arch=%s\\n" "$(uname -m)"',
  'printf "libc=%s\\n" "$(getconf GNU_LIBC_VERSION 2>/dev/null || echo unknown)"',
  'printf "home=%s\\n" "$HOME"',
  'printf "user=%s\\n" "$(id -un)"',
  'printf "uid=%s\\n" "$(id -u)"',
  'printf "shell=%s\\n" "$(getent passwd "$(id -un)" | cut -d: -f7)"',
  'printf "git=%s\\n" "$(command -v git || true)"',
  'printf "tar=%s\\n" "$(command -v tar || true)"',
  'if [ -x "$HOME/.nivra/runtime/$1/node/bin/node" ]; then echo runtime=present; else echo runtime=absent; fi',
].join("; ");

/**
 * Installs the runtime streamed on stdin into `$HOME/.nivra/runtime/<hash>` (D5): extract into a temporary folder,
 * make Node executable, prove the runtime loads (`--self-check`), then rename into place. An existing runtime is kept
 * unless `$2` is "force". The newest two runtimes are kept.
 */
export const INSTALL_SCRIPT = [
  "set -eu",
  'hash="$1"; force="$2"',
  'root="$HOME/.nivra/runtime"',
  'mkdir -p "$root"',
  'if [ "$force" != force ] && [ -x "$root/$hash/node/bin/node" ]; then cat >/dev/null; echo present; exit 0; fi',
  'tmp=$(mktemp -d "$root/.incoming.XXXXXX")',
  "trap 'rm -rf \"$tmp\"' EXIT",
  'tar -xzf - -C "$tmp"',
  'chmod 0755 "$tmp/node/bin/node"',
  '"$tmp/node/bin/node" "$tmp/engine/main.mjs" --self-check >/dev/null',
  'rm -rf "$root/$hash"',
  'mv "$tmp" "$root/$hash"',
  "trap - EXIT",
  'for old in $(ls -1t "$root" | tail -n +3); do rm -rf "$root/$old"; done',
  "echo installed",
].join("\n");

const MIN_GLIBC: readonly [number, number] = [2, 28];

/**
 * A `pgrep`/`pkill -f` pattern for one engine's command line. The first character of the id sits in brackets, so the
 * pattern matches the engine and never the pkill or pgrep command that carries it.
 */
export const instancePattern = (instanceId: string): string => `--instance [${instanceId[0]}]${instanceId.slice(1)}`;

/** Facts the probe printed. */
export function parseProbe(text: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) facts[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return facts;
}

/** What stops this distribution from running the engine, or should be said before it does. */
export function problemsOf(distro: WslDistro, facts: Readonly<Record<string, string>>): TargetProblem[] {
  const problems: TargetProblem[] = [];
  const name = distro.name;
  if (distro.version === 1) {
    problems.push({ code: "wsl1", severity: "blocking", message: `${name} runs on WSL 1. Run \`wsl --set-version ${name} 2\` in a terminal, then try again.` });
  }
  if (facts["arch"] && facts["arch"] !== "x86_64") {
    problems.push({ code: "arch-unsupported", severity: "blocking", message: `${name} is ${facts["arch"]}; Nivra's engine runs on x86-64 distributions only for now.` });
  }
  const glibc = /^glibc (\d+)\.(\d+)/.exec(facts["libc"] ?? "");
  if (!glibc) {
    problems.push({ code: "musl", severity: "blocking", message: `${name} doesn't use glibc (Alpine and other musl distributions can't run Node's official build). Use Ubuntu or Debian.` });
  } else if (Number(glibc[1]) < MIN_GLIBC[0] || (Number(glibc[1]) === MIN_GLIBC[0] && Number(glibc[2]) < MIN_GLIBC[1])) {
    problems.push({ code: "glibc-too-old", severity: "blocking", message: `${name} has glibc ${glibc[1]}.${glibc[2]}; the engine needs ${MIN_GLIBC.join(".")} or newer (Ubuntu 20.04+, Debian 10+).` });
  }
  if (!facts["tar"]) problems.push({ code: "no-tar", severity: "blocking", message: `${name} has no tar, which installing the engine needs. Run \`sudo apt install tar\` there, then try again.` });
  if (!facts["git"]) problems.push({ code: "no-git", severity: "warning", message: `Git isn't installed in ${name}. Run \`sudo apt install git\` there, then try again.` });
  if (facts["uid"] === "0" || distro.defaultUid === 0) {
    problems.push({ code: "root-user", severity: "warning", message: `${name} opens as root, usually because it was never opened. Open it once from the Start menu to create your user.` });
  }
  return problems;
}

export interface WslTargetOptions {
  distro: WslDistro;
  wslExe: string;
  runtime: WslRuntime | null;
  env?: NodeJS.ProcessEnv;
  /** Runs `wsl.exe` with these arguments; tests replace it. */
  runWsl?: (args: readonly string[], options: { input?: Readable | null; timeoutMs: number }) => Promise<RunResult>;
}

/** A WSL2 distribution as a target: the engine runs inside it, on the runtime streamed in from the app (D1, D5). */
export class WslTarget implements ExecutionTarget {
  readonly descriptor;
  readonly #options: WslTargetOptions;
  readonly #env: Record<string, string>;

  constructor(options: WslTargetOptions) {
    this.#options = options;
    this.#env = engineEnv(options.env ?? process.env, "win32", { WSL_UTF8: "1" });
    this.descriptor = { id: `wsl:${options.distro.name}`, kind: "wsl" as const, label: `${options.distro.name} · WSL`, platform: "linux" as const, distro: options.distro.name };
  }

  #run(args: readonly string[], options: { input?: Readable | null; timeoutMs: number }): Promise<RunResult> {
    if (this.#options.runWsl) return this.#options.runWsl(args, options);
    return runTool(this.#options.wslExe, args, { env: this.#env, input: options.input ?? null, timeoutMs: options.timeoutMs });
  }

  /** Runs a POSIX shell script inside the distribution, with positional arguments (`sh -c script sh args…`). */
  #script(script: string, args: readonly string[], options: { input?: Readable | null; timeoutMs: number }): Promise<RunResult> {
    return this.#run(["-d", this.#options.distro.name, "--cd", "/", "--exec", "/bin/sh", "-c", script, "sh", ...args], options);
  }

  async probe(): Promise<TargetProbe> {
    const hash = this.#options.runtime?.contentHash ?? "-";
    // A stopped distribution starts on this first call, which can take a while.
    const result = await this.#script(PROBE_SCRIPT, [hash], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      const code = wslErrorCode(`${result.stdout}\n${result.stderr}`);
      const message = result.timedOut
        ? `${this.descriptor.label} didn't answer within a minute.`
        : `${this.descriptor.label} couldn't run a command${code ? ` (${code})` : ""}. Open it once from the Start menu, then try again.`;
      return { ok: false, problems: [{ code: code ?? "unreachable", severity: "blocking", message }], facts: {} };
    }
    const facts = parseProbe(result.stdout);
    const problems = problemsOf(this.#options.distro, facts);
    if (!this.#options.runtime) problems.push({ code: "runtime-missing", severity: "blocking", message: "This installation has no engine runtime for WSL. Reinstall Nivra." });
    return { ok: !problems.some((p) => p.severity === "blocking"), problems, facts: { ...facts } };
  }

  async prepare(request: LaunchRequest): Promise<EngineLaunch> {
    request.onProgress?.(`Checking ${this.descriptor.label}…`);
    const probe = await this.probe();
    if (!probe.ok) throw new TargetUnavailableError(this.descriptor, probe.problems);
    const runtime = this.#options.runtime!;
    const home = String(probe.facts["home"]);
    if (!home.startsWith("/")) throw new TargetUnavailableError(this.descriptor, [{ code: "no-home", severity: "blocking", message: `${this.descriptor.label} reported no home folder.` }]);
    if (probe.facts["runtime"] !== "present" || request.reprovision) {
      request.onProgress?.(`Installing the engine runtime into ${this.descriptor.label}…`);
      await this.#provision(runtime, Boolean(request.reprovision));
    }
    const root = `${home}/.nivra/runtime/${runtime.contentHash}`;
    const distro = this.#options.distro.name;
    return {
      command: this.#options.wslExe,
      // `--exec` runs no shell: every path is absolute, built from the probe's $HOME (D5).
      args: ["-d", distro, "--cd", home, "--exec", `${root}/node/bin/node`, ...engineArgs(`${root}/engine/main.mjs`, `${home}/.nivra`, request)],
      cwd: undefined,
      env: this.#env,
      home: `${home}/.nivra`,
      cleanup: async () => {
        // pkill exits 1 when nothing matched, which is the expected outcome.
        await this.#run(["-d", distro, "--cd", "/", "--exec", "pkill", "-f", "--", instancePattern(request.instanceId)], { timeoutMs: 15_000 }).catch(() => undefined);
      },
    };
  }

  /** A Windows folder as this distribution sees it (`wslpath -u`, which honours a custom automount root); null if it can't say. */
  async toLinuxPath(windowsPath: string): Promise<string | null> {
    const result = await this.#run(["-d", this.#options.distro.name, "--cd", "/", "--exec", "wslpath", "-u", windowsPath], { timeoutMs: 30_000 });
    const path = result.stdout.trim();
    return result.code === 0 && path.startsWith("/") ? path : null;
  }

  async #provision(runtime: WslRuntime, force: boolean): Promise<void> {
    const result = await this.#script(INSTALL_SCRIPT, [runtime.contentHash, force ? "force" : "keep"], { input: createReadStream(runtime.tarball), timeoutMs: 300_000 });
    if (result.code !== 0 || !/^(installed|present)$/m.test(result.stdout)) {
      const detail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      throw new TargetUnavailableError(this.descriptor, [
        { code: "provision-failed", severity: "blocking", message: `Installing the engine into ${this.descriptor.label} failed${detail ? `: ${detail}` : "."} Try again; if it keeps failing, reinstall Nivra.` },
      ]);
    }
  }
}
