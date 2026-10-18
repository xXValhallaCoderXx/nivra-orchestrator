// The live acceptance harness for packaged builds (NIV-14), run from WSL. It drives an installed (Linux deb) or
// extracted (Windows zip) Nivra through its UI with Playwright, in profiles of its own, and records what it saw.
//
//   rehearsal  token-free: no key and no model; it proves the mechanics before any key is entered
//   live       the person types the key into the window; the D20 journey, the lifecycle, a changed file, the
//              failures and restarts, and a bad key
//
//   pnpm accept:live --platform linux|windows --session rehearsal|live --fixture-a <path>
//       [--fixture-b-file <0600 file holding B's path>] [--evidence ~/nivra-acceptance] [--app /opt/Nivra/nivra]
//       [--distro <name>] [--move-wsl-home] [--network] [--electron-arg <arg>]
//   pnpm accept:live --recover [<recovery record>] [--dry-run]
//
// The key never passes through this script: it only polls whether one is saved, and never reads the field. Every
// attempt is recorded privately; the public summary is built from listed fields only (acceptance-record.ts). The
// Windows→WSL session moves the person's ~/.nivra aside, because every Windows profile's WSL engine uses it, and
// puts it back at the end (acceptance-state.ts). Cleanup is always the last thing a session does.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import type { ExplainResult, RunEvent, RunSummary } from "@nivra/domain";
import type { ProjectView } from "../src/shared/ipc.ts";
import { PROBE_SCRIPT } from "../src/main/targets/wsl.ts";
import {
  CHECKS,
  criteriaOutcomes,
  expectedReason,
  publicFiles,
  type AcceptanceRecord,
  type CheckId,
  type Fixture,
  type FixtureFacts,
  type Outcome,
  type PrivateIdentifiers,
  type Purpose,
  type RunEntry,
} from "./acceptance-record.ts";
import { copyRunStore, enginesUsing, finishSession, isEngine, loadRecord, moveHome, noteAcceptanceHome, readRuns, Refused, saveRecord, type RecoveryRecord } from "./acceptance-state.ts";
import { expectedSnapshot, sleep, Ui, waitFor } from "./live-ui.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const POINTER = join(homedir(), ".nivra-acceptance-recovery.json");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: "string" },
    session: { type: "string" },
    "fixture-a": { type: "string" },
    "fixture-b-file": { type: "string" },
    evidence: { type: "string", default: join(homedir(), "nivra-acceptance") },
    release: { type: "string", default: join(desktop, "release") },
    app: { type: "string", default: "/opt/Nivra/nivra" },
    distro: { type: "string", default: process.env["WSL_DISTRO_NAME"] ?? "Ubuntu" },
    "move-wsl-home": { type: "boolean", default: false },
    network: { type: "boolean", default: false },
    "electron-arg": { type: "string", multiple: true, default: [] },
    recover: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const stop = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(2);
};
const run = (command: string, args: string[], cwd = "/") => spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, WSL_UTF8: "1", GIT_OPTIONAL_LOCKS: "0" } });
const output = (command: string, args: string[], cwd = "/") => {
  const result = run(command, args, cwd);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const windowsBusy = () => {
  const result = run("/mnt/c/Windows/System32/tasklist.exe", ["/FI", "IMAGENAME eq Nivra.exe", "/FO", "CSV", "/NH"]);
  return result.stdout.toLowerCase().includes("nivra.exe") ? ["a Nivra window (Nivra.exe)"] : [];
};

// ─── Recovery ────────────────────────────────────────────────────────────────────────────────────────────────────
if (values.recover) {
  const file = positionals[0] ?? POINTER;
  if (!existsSync(file)) stop(`There is no recovery record at ${file}.`);
  const record = loadRecord(file);
  const files = [file, POINTER, join(record.evidence, "private", "recovery.json")].filter((f, i, all) => all.indexOf(f) === i);
  try {
    const steps = await finishSession(record, (r) => saveRecord(r, files), { dryRun: values["dry-run"], busy: record.home ? windowsBusy : undefined, log: (line) => console.log(`  ${line}`) });
    console.log(values["dry-run"] ? `Recovery would:\n${steps.map((s) => `  - ${s}`).join("\n")}` : `Recovered: ${record.state}.`);
    process.exit(0);
  } catch (error) {
    stop(`${error instanceof Error ? error.message : String(error)}\nBy hand: see restoreByHand in ${file}.`);
  }
}

// ─── Preflight ───────────────────────────────────────────────────────────────────────────────────────────────────
const platform = values.platform === "linux" || values.platform === "windows" ? values.platform : stop("--platform must be linux or windows.");
const session = values.session === "rehearsal" || values.session === "live" ? values.session : stop("--session must be rehearsal or live.");
if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) stop("Run this from WSL on a Windows machine.");
const fixtureA = realpathSync(values["fixture-a"] ?? stop("--fixture-a is required."));
let fixtureB: string | null = null;
if (session === "live") {
  const file = values["fixture-b-file"] ?? stop("A live session needs --fixture-b-file: a file, readable only by you, holding B's path.");
  if ((statSync(file).mode & 0o077) !== 0) stop(`${file} can be read by others. Run chmod 600 on it first.`);
  fixtureB = realpathSync(readFileSync(file, "utf8").trim());
}
const evidenceRoot = resolve(values.evidence);
for (const [what, path] of [["the repository", repo], ["fixture A", fixtureA], ["fixture B", fixtureB]] as const) {
  if (path && !relative(path, evidenceRoot).startsWith("..")) stop(`The evidence folder can't be inside ${what}.`);
}
if (evidenceRoot.startsWith("/mnt/") || fixtureA.startsWith("/mnt/") || fixtureB?.startsWith("/mnt/")) stop("Keep the evidence and the fixtures in the distribution's own filesystem, not under /mnt.");
if (platform === "windows" && !values["move-wsl-home"]) stop("A Windows session needs --move-wsl-home: every Windows profile's WSL engine uses ~/.nivra, which is moved aside and restored.");
type BuildInfo = {
  version: string;
  commit: string;
  clean: boolean;
  electron: { electron: string };
  runtimes: Array<{ target: string; contentHash: string; node: string; protocolVersion: number }>;
  apps: Array<{ target: string; asarSha256: string }>;
  artefacts: Array<{ name: string; sha256: string }>;
};
const buildInfo = JSON.parse(readFileSync(join(values.release, "build-info.json"), "utf8")) as BuildInfo;
const linuxRuntime = buildInfo.runtimes.find((r) => r.target === "linux-x64")!;
const uid = process.getuid!();
const user = output("id", ["-un"]);
const distro = values.distro;
const homePath = join(homedir(), ".nivra");

if (platform === "windows") {
  // The WSL engine runs as the distribution's default user, from that user's $HOME: this script must be that user.
  const probe = Object.fromEntries(
    output("/mnt/c/Windows/System32/wsl.exe", ["-d", distro, "--exec", "sh", "-c", PROBE_SCRIPT, "sh", linuxRuntime.contentHash])
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (process.env["WSL_DISTRO_NAME"] !== distro || probe["uid"] !== String(uid) || probe["home"] !== homedir()) {
    stop(`Run this in ${distro} as its default user (${probe["user"] ?? "unknown"}, home ${probe["home"] ?? "unknown"}): the WSL engine runs there as that user.`);
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const runName = `${stamp}-${platform}-${session}-${buildInfo.commit.slice(0, 7)}`;
const evidence = join(evidenceRoot, runName);
const privateDir = join(evidence, "private");
const work = join(evidence, "work");
mkdirSync(privateDir, { recursive: true });
mkdirSync(work, { recursive: true });
chmodSync(evidence, 0o700);
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);

// The Windows side of a Windows session: the extracted app and its profiles, as Windows and as this distribution see them.
const localAppData = platform === "windows" ? output("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"], "/mnt/c") : "";
const win = (path: string) => output("/usr/bin/wslpath", ["-u", path]);
const winRoot = platform === "windows" ? `${localAppData}\\nivra-acceptance\\${runName}` : "";
const profiles = {
  main: platform === "windows" ? `${winRoot}\\user data` : join(work, "profile"),
  badKey: platform === "windows" ? `${winRoot}\\bad-key user data` : join(work, "bad-key profile"),
  engine: platform === "windows" ? `${winRoot}\\engine` : join(work, "engine home"),
  badKeyEngine: platform === "windows" ? `${winRoot}\\bad-key engine` : join(work, "bad-key engine home"),
};
const local = (path: string) => (platform === "windows" ? win(path) : path);

const record: RecoveryRecord = {
  version: 1,
  run: runName,
  state: "planned",
  uid,
  user,
  distro: platform === "windows" ? distro : null,
  home: platform === "windows" ? { path: homePath, movedTo: `${homePath}.niv14-${runName}`, original: null, movedAt: null } : null,
  acceptanceHomeIno: null,
  profiles: platform === "windows" ? [win(winRoot)] : [local(profiles.main), local(profiles.badKey)],
  engines: [],
  evidence,
};
const recordFiles = [join(privateDir, "recovery.json"), POINTER];
const save = (r: RecoveryRecord) => saveRecord(r, recordFiles);
save(record);

// ─── The record ──────────────────────────────────────────────────────────────────────────────────────────────────
const label = (path: string) => basename(path);
const bIds: PrivateIdentifiers | null = fixtureB
  ? {
      paths: [fixtureB, `\\\\wsl.localhost\\${distro}${fixtureB.replace(/\//g, "\\")}`],
      label: label(fixtureB),
      name: label(fixtureB),
      remote: run("git", ["-C", fixtureB, "remote", "get-url", "origin"]).stdout.trim() || null,
      head: output("git", ["-C", fixtureB, "rev-parse", "HEAD"]),
    }
  : null;
const redact = (text: string) => (bIds ? [...bIds.paths, bIds.label].reduce((t, secret) => t.split(secret).join("<B>"), text) : text);
const log = (line: string) => {
  const text = `${String(elapsed()).padStart(8)} ms  ${redact(line)}`;
  console.log(text);
  appendFileSync(join(privateDir, "trace.log"), `${text}\n`);
};

const acceptance: AcceptanceRecord = {
  platform,
  session,
  startedAt: new Date().toISOString(),
  build: { version: buildInfo.version, commit: buildInfo.commit, clean: buildInfo.clean, artefacts: buildInfo.artefacts.map(({ name, sha256 }) => ({ name, sha256 })), runtimes: buildInfo.runtimes.map(({ target, contentHash }) => ({ target, contentHash })) },
  harness: { commit: output("git", ["-C", repo, "rev-parse", "HEAD"]), clean: output("git", ["-C", repo, "status", "--porcelain"]) === "" },
  machine: {},
  fixtures: {},
  checks: [],
  runs: [],
  commands: [
    `pnpm accept:live --platform ${platform} --session ${session} --fixture-a ${fixtureA.replace(homedir(), "~")}${fixtureB ? " --fixture-b-file <private>" : ""}${platform === "windows" ? " --move-wsl-home" : ""}${values.network ? " --network" : ""}`,
  ],
};
const persist = () => writeFileSync(join(privateDir, "record.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
function note(id: CheckId, fixture: Fixture, outcome: Outcome, detail: string, attempt = 1): boolean {
  const entry = { id, outcome, attempt, fixture, at: elapsed(), detail };
  acceptance.checks.push(entry);
  appendFileSync(join(privateDir, "record.jsonl"), `${JSON.stringify(entry)}\n`);
  log(`${outcome === "pass" ? "✓" : outcome === "fail" ? "✗" : "…"} ${id}${attempt > 1 ? ` (attempt ${attempt})` : ""} [${CHECKS[id][1]}] ${detail}`);
  return outcome === "pass";
}
const expect = (id: CheckId, fixture: Fixture, ok: boolean, detail: string, attempt = 1) => note(id, fixture, ok ? "pass" : "fail", detail, attempt);
class Gate extends Error {}

// ─── Machine, build and fixtures ─────────────────────────────────────────────────────────────────────────────────
function machine(): void {
  const m = acceptance.machine;
  const reg = run("/mnt/c/Windows/System32/reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"]).stdout;
  const value = (name: string) => reg.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, "m"))?.[1]?.trim() ?? null;
  m["windowsBuild"] = value("CurrentBuild") && value("UBR") ? `${value("CurrentBuild")}.${Number.parseInt(value("UBR")!, 16)}` : null;
  m["windowsVersion"] = value("DisplayVersion");
  m["wslVersion"] = run("wslinfo", ["--version"]).stdout.trim() || null;
  m["wslNetworking"] = run("wslinfo", ["--networking-mode"]).stdout.trim() || null;
  m["wslg"] = existsSync("/mnt/wslg/versions.txt") ? (readFileSync("/mnt/wslg/versions.txt", "utf8").match(/WSLg[^:]*:\s*(\S+)/)?.[1] ?? null) : null;
  m["distro"] = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? null;
  m["kernel"] = output("uname", ["-r"]);
  m["linuxCpu"] = readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)?.[1] ?? null;
  m["linuxRamGiB"] = Math.round(Number(readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s*(\d+)/m)?.[1] ?? 0) / 1_048_576);
}

function facts(path: string): FixtureFacts {
  const files = output("git", ["-C", path, "--no-optional-locks", "ls-files", "-z"]).split("\0").filter(Boolean);
  const tsx = files.filter((f) => f.endsWith(".tsx")).map((f) => basename(f, ".tsx")).filter((n) => n !== "index");
  const manifests = files.filter((f) => basename(f) === "package.json").slice(0, 100).map((f) => {
    try {
      return readFileSync(join(path, f), "utf8");
    } catch {
      return "";
    }
  });
  return {
    name: basename(path),
    head: output("git", ["-C", path, "rev-parse", "HEAD"]),
    dirty: output("git", ["-C", path, "--no-optional-locks", "status", "--porcelain"]).split("\n").filter(Boolean).length,
    tracked: files.length,
    conventions: {
      pascalTsx: tsx.filter((n) => /^[A-Z][A-Za-z0-9]*$/.test(n)).length,
      kebabTsx: tsx.filter((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)).length,
      vitest: manifests.some((m) => m.includes('"vitest"')),
      jest: manifests.some((m) => /"jest(-expo)?"/.test(m)),
    },
  };
}

/** The release files match SHA256SUMS, and the installed or extracted app is the candidate's. Returns the executable. */
function identity(): string {
  const sums = readFileSync(join(values.release, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.split(/\s+/) as [string, string]);
  const mismatched = sums.filter(([hash, name]) => !existsSync(join(values.release, name)) || sha256(join(values.release, name)) !== hash).map(([, name]) => name);
  expect("identity.sums", "none", mismatched.length === 0, mismatched.length ? `not matching: ${mismatched.join(", ")}` : `${sums.length} files match SHA256SUMS`);
  if (platform === "linux") {
    const installedRoot = dirname(realpathSync(values.app));
    // An app no package owns (an unpacked build, for a smoke test of this harness) fails this check and nothing else.
    const owned = run("dpkg", ["-S", realpathSync(values.app)]);
    if (owned.status === 0) {
      const owner = owned.stdout.split(":")[0]!.trim();
      const version = output("dpkg-query", ["-W", "-f=${Version}", owner]);
      const verify = run("dpkg", ["--verify", owner]);
      expect("identity.package", "none", version === buildInfo.version && verify.status === 0 && verify.stdout.trim() === "", `package ${owner} ${version}; dpkg --verify ${verify.status === 0 && !verify.stdout.trim() ? "clean" : verify.stdout.trim()}`);
      acceptance.machine["deb"] = `${owner} ${version}`;
    } else {
      note("identity.package", "none", "fail", `${values.app} wasn't installed from a package`);
    }
    acceptance.machine["chromeSandbox"] = (statSync(join(installedRoot, "chrome-sandbox")).mode & 0o7777).toString(8);
    const asar = sha256(join(installedRoot, "resources", "app.asar"));
    expect("identity.app", "none", asar === buildInfo.apps.find((a) => a.target === "linux-x64")?.asarSha256, `app.asar ${asar.slice(0, 16)}`);
    const manifest = JSON.parse(readFileSync(join(installedRoot, "resources", "runtime", "linux-x64", "engine", "manifest.json"), "utf8")) as { contentHash: string };
    expect("identity.runtime", "none", manifest.contentHash === linuxRuntime.contentHash, `installed runtime ${manifest.contentHash}`);
    return values.app;
  }
  const zip = buildInfo.artefacts.find((a) => a.name.endsWith(".zip"))!;
  const zipHash = sha256(join(values.release, zip.name));
  const appWin = `${winRoot}\\app`;
  mkdirSync(win(appWin), { recursive: true });
  output("/mnt/c/Windows/System32/tar.exe", ["-xf", output("/usr/bin/wslpath", ["-w", join(values.release, zip.name)]), "-C", appWin], "/mnt/c");
  const exe = [join(win(appWin), "Nivra.exe")].find(existsSync) ?? stop(`The zip has no Nivra.exe at its top level (${appWin}).`);
  expect("identity.package", "none", zipHash === zip.sha256, `${zip.name} sha256 ${zipHash.slice(0, 16)}, extracted to ${appWin}`);
  const resources = join(dirname(exe), "resources");
  const asar = sha256(join(resources, "app.asar"));
  expect("identity.app", "none", asar === buildInfo.apps.find((a) => a.target === "win-x64")?.asarSha256, `app.asar ${asar.slice(0, 16)}`);
  const native = JSON.parse(readFileSync(join(resources, "runtime", "win-x64", "engine", "manifest.json"), "utf8")) as { contentHash: string };
  const wsl = JSON.parse(readFileSync(join(resources, "runtime", "runtime-linux-x64.json"), "utf8")) as { contentHash: string };
  const nativeExpected = buildInfo.runtimes.find((r) => r.target === "win-x64")!.contentHash;
  expect("identity.runtime", "none", native.contentHash === nativeExpected && wsl.contentHash === linuxRuntime.contentHash, `native ${native.contentHash}, WSL ${wsl.contentHash}`);
  return exe;
}

// ─── Launching ───────────────────────────────────────────────────────────────────────────────────────────────────
let app: ElectronApplication | null = null;
let ui: Ui | null = null;
const executable = { path: "" };
const providerFree = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/NEBIUS|TOKEN_FACTORY|_API_KEY$/i.test(name))) as Record<string, string>;

async function launch(profile: string, engineHome: string, env: Record<string, string> = {}): Promise<Ui> {
  log(`launching ${platform === "windows" ? "Nivra.exe" : values.app} with its own profile`);
  const at = performance.now();
  app = await electron.launch({
    executablePath: executable.path,
    args: [`--user-data-dir=${profile}`, `--nivra-engine-home=${engineHome}`, ...values["electron-arg"]],
    chromiumSandbox: true,
    timeout: 120_000,
    env: { ...providerFree(), ...env },
  });
  app.process().stderr?.on("data", (chunk: Buffer) => appendFileSync(join(privateDir, "app-stderr.log"), chunk));
  ui = new Ui(app, await app.firstWindow());
  log(`window shown in ${Math.round(performance.now() - at)} ms`);
  const info = await ui.appInfo();
  acceptance.machine["electron"] = info.electron;
  acceptance.machine["chrome"] = info.chrome;
  acceptance.machine["appNode"] = info.node;
  return ui;
}

/** Copies the logs before an engine restart or a relaunch rotates them. */
function keepLogs(profile: string, phase: string): void {
  const logs = join(local(profile), "logs");
  if (existsSync(logs)) output("cp", ["-r", logs, join(privateDir, "logs", `${String(elapsed()).padStart(8, "0")}-${phase}`)]);
}

async function quit(profile: string, phase: string): Promise<void> {
  if (!app) return;
  await app.close().catch(() => undefined);
  app = null;
  ui = null;
  await waitFor(() => record.engines.every((e) => !existsSync(`/proc/${e.pid}`)), 30_000, "this session's engines to exit");
  keepLogs(profile, phase);
}

const target = platform === "windows" ? `wsl:${distro}` : "local";
const pathFor = (path: string) => (platform === "windows" ? `\\\\wsl.localhost\\${distro}${path.replace(/\//g, "\\")}` : path);
const engineHomeNow = () => (platform === "windows" ? homePath : local(profiles.engine));

async function engineOnline(phase: string) {
  const info = await ui!.online(target);
  if (!record.engines.some((e) => e.pid === info.pid)) {
    record.engines.push({ pid: info.pid, instanceId: info.instanceId });
    if (record.state === "moved" || record.state === "planned") record.state = "running";
    save(record);
  }
  if (platform === "windows") noteAcceptanceHome(record, save);
  acceptance.machine["engineNode"] = info.node;
  log(`engine ${info.instanceId} online (pid ${info.pid}) for ${phase}`);
  return info;
}

// ─── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Observed {
  runId: string;
  summary: RunSummary;
  result: ExplainResult | null;
  events: RunEvent[];
  received: { revision: number; count: number; records: Array<{ id: string; scope: string; intent: string; revision: number }>; digest: string } | null;
}

async function observe(runId: string, fixture: Fixture, purpose: Purpose, attempt: number): Promise<Observed> {
  const { summary, result } = await ui!.result(runId);
  const { events } = await ui!.events(runId);
  const received = await ui!.received(runId);
  writeFileSync(join(privateDir, "runs", `${runId}.json`), `${JSON.stringify({ fixture, purpose, attempt, summary, result, events }, null, 2)}\n`);
  const failed = events.find((e) => e.type === "run.failed");
  const reasons: Record<string, number> = {};
  for (const conflict of result?.conflicts ?? []) reasons[conflict.reason] = (reasons[conflict.reason] ?? 0) + 1;
  const entry: RunEntry = {
    runId,
    fixture,
    purpose,
    attempt,
    status: summary.status,
    failureKind: (failed?.data?.["kind"] as string | undefined) ?? null,
    model: summary.route?.model ?? null,
    endpoint: summary.route?.endpoint ?? null,
    durationMs: summary.durationMs,
    usage: summary.usage ? { inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens, calls: summary.usage.calls, reportedCalls: summary.usage.reportedCalls } : null,
    citations: result ? { total: result.checks.citations, checked: result.checks.checked } : null,
    conflicts: result ? reasons : null,
    suggestions: result ? result.suggestions.length : null,
    refusals: result?.context.answer ? { citations: result.context.answer.refusals.citations, conflicts: result.context.answer.refusals.conflicts, schema: result.context.answer.refusals.schema } : null,
    preferences: received ? { count: received.count, revision: received.revision } : null,
  };
  acceptance.runs.push(entry);
  persist();
  return { runId, summary, result, events, received };
}

/** The strict checks every live explanation must pass: what it received, where it went, and the HEAD it read. */
function handoff(observed: Observed, fixture: Fixture, expected: ReturnType<typeof expectedSnapshot>, head: string, attempt = 1): void {
  const got = observed.received;
  const stored = observed.result?.context.preferences ?? null;
  const same = (r: { revision: number; digest: string; records: Array<{ id: string; revision: number }> } | null) =>
    r !== null && r.revision === expected.revision && r.digest === expected.digest && JSON.stringify([...r.records].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => [x.id, x.revision])) === JSON.stringify(expected.ids.map((id, i) => [id, expected.revisions[i]]));
  expect("handoff.snapshot", fixture, same(got) && (observed.result === null || same(stored)), `received ${got?.count ?? "nothing"} at revision ${got?.revision ?? "?"}, fingerprint ${got?.digest.slice(0, 12) ?? "none"}; expected ${expected.ids.length} at ${expected.revision}, ${expected.digest.slice(0, 12)}`, attempt);
  const route = observed.summary.route;
  expect("handoff.route", fixture, route?.endpoint === "token-factory" && /^nvidia\/[\w.-]+$/.test(route.model), `route ${route ? `${route.endpoint} ${route.model}` : "none"}`, attempt);
  expect("handoff.head", fixture, observed.result?.headAtStart === head, `HEAD at start ${observed.result?.headAtStart?.slice(0, 12) ?? "none"}`, attempt);
}

async function explainOn(project: ProjectView, fixture: Fixture, purpose: Purpose, question: string, choices: readonly string[] = [], attempt = 1): Promise<Observed> {
  await ui!.choose(project);
  const runId = await ui!.explain(question, choices);
  log(`explaining ${fixture} (${purpose}${attempt > 1 ? `, attempt ${attempt}` : ""}): run ${runId}`);
  await ui!.ended(runId);
  return observe(runId, fixture, purpose, attempt);
}

async function hello(project: ProjectView, fixture: Fixture, seconds: 0 | 5 | 60 = 0) {
  await ui!.choose(project);
  const runId = await ui!.hello(seconds);
  if (seconds === 0) await ui!.ended(runId, 120_000);
  return runId;
}

/** Runs an explanation and acts on it while it is still active. A run that already ended is a missed window. */
async function interrupt(project: ProjectView, purpose: Purpose, id: CheckId, act: (runId: string) => Promise<string | null>): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ui!.choose(project);
    const runId = await ui!.explain("");
    await ui!.firstModelCall(runId);
    const status = await ui!.status(runId);
    if (status !== "running") {
      await observe(runId, "A", purpose, attempt);
      note(id, "A", "incomplete", `missed window: run ${runId} was already ${status} when the action was due`, attempt);
      continue;
    }
    const problem = await act(runId);
    await observe(runId, "A", purpose, attempt);
    expect(id, "A", problem === null, problem ?? `acted on run ${runId} while it was running`, attempt);
    return;
  }
}

// ─── Phases ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function rehearsal(): Promise<void> {
  await launch(profiles.main, profiles.engine);
  const info = await ui!.appInfo();
  expect("identity.app-info", "none", info.packaged && info.version === buildInfo.version && info.electron === buildInfo.electron.electron, `packaged ${info.packaged}, version ${info.version}, Electron ${info.electron}`);
  const runtimeFolder = join(homePath, "runtime", linuxRuntime.contentHash);
  const freshBefore = platform === "windows" ? !existsSync(runtimeFolder) : null;
  const a = await ui!.pick(pathFor(fixtureA), target);
  const engine = await engineOnline("the rehearsal");
  expect("identity.engine", "none", engine.runtimeHash === linuxRuntime.contentHash && engine.node === `v${linuxRuntime.node}` && engine.protocolVersion === linuxRuntime.protocolVersion, `runtime ${engine.runtimeHash}, Node ${engine.node}, protocol ${engine.protocolVersion}`);
  if (platform === "windows") expect("identity.provisioned", "none", freshBefore === true && existsSync(runtimeFolder), `runtime ${linuxRuntime.contentHash} installed into a fresh ${homePath}`);

  expect("consent.refused", "A", !(await ui!.refuseConsent()) && !(await ui!.projects()).find((p) => p.id === a.id)!.sharing.modelContext, "Cancel in the consent dialog started nothing, and sharing stayed off");
  const refusal = await ui!.refusal(`window.nivra.startExplain(${JSON.stringify(a.id)}, "", [])`);
  expect("consent.refused-bridge", "A", refusal !== null && /doesn't allow sending its content/.test(refusal), `the host said: ${refusal ?? "nothing (it started)"}`);

  const noKey = await ui!.explain("");
  await ui!.ended(noKey);
  const observed = await observe(noKey, "A", "no-key", 1);
  const kind = observed.events.find((e) => e.type === "run.failed")?.data?.["kind"];
  expect("provider.no-key", "A", observed.summary.status === "failed" && kind === "no-key" && observed.summary.route === null && observed.summary.usage === null && !observed.events.some((e) => e.type === "model.call"), `status ${observed.summary.status}, kind ${String(kind)}, no model call`);

  const helloRun = await hello(a, "A");
  const got = await ui!.received(helloRun);
  const want = expectedSnapshot(await ui!.preferences(), a.id);
  expect("handoff.snapshot", "A", got !== null && got.digest === want.digest && got.count === 0, `hello received ${got?.count ?? "nothing"} preferences, fingerprint ${got?.digest.slice(0, 12) ?? "none"}`);

  const cancelled = await hello(a, "A", 60);
  await ui!.page.getByTestId("hello-cancel").click();
  await ui!.ended(cancelled, 30_000);
  const c = await ui!.events(cancelled);
  expect("cancel.held", "A", c.status === "cancelled" && c.events.at(-1)?.message === "Cancelled", `held run ${c.status}: "${c.events.at(-1)?.message ?? ""}"`);

  const graceful = await hello(a, "A", 60);
  keepLogs(profiles.main, "before-graceful-restart");
  await ui!.restartEngine(a.id);
  const after = await engineOnline("after a graceful restart");
  await ui!.ended(graceful, 30_000);
  const g = await ui!.events(graceful);
  expect("engine.graceful-held", "A", g.status === "cancelled" && g.events.at(-1)?.message === "Cancelled: the app asked it to stop" && after.instanceId !== engine.instanceId, `held run ${g.status}: "${g.events.at(-1)?.message ?? ""}"; new engine ${after.instanceId}`);

  const killed = await hello(a, "A", 60);
  const victim = (await ui!.online(target));
  if (!isEngine(victim.pid, victim.instanceId, uid)) throw new Refused(`pid ${victim.pid} isn't engine ${victim.instanceId}; nothing was killed.`);
  keepLogs(profiles.main, "before-kill");
  process.kill(victim.pid, "SIGKILL");
  await ui!.page.getByTestId("engine-failed").waitFor({ timeout: 30_000 });
  await ui!.page.getByTestId("engine-restart").click();
  const revived = await engineOnline("after a kill");
  await waitFor(async () => (await ui!.status(killed)) !== "running", 30_000, "the killed run to be reconciled");
  const k = await ui!.events(killed);
  const starts = k.events.filter((e) => e.type === "run.started").length;
  expect("engine.kill-held", "A", k.status === "failed" && k.events.at(-1)?.type === "run.interrupted" && starts === 1 && revived.instanceId !== victim.instanceId, `held run ${k.status}, last event ${k.events.at(-1)?.type}: "${k.events.at(-1)?.message ?? ""}"; started ${starts} time(s)`);

  const closed = await hello(a, "A", 60);
  await quit(profiles.main, "app-close");
  const copy = join(privateDir, "db", `${String(elapsed()).padStart(8, "0")}-app-close`);
  copyRunStore(engineHomeNow(), copy);
  const rows = readRuns(copy);
  const row = rows.find((r) => r.id === closed);
  expect("app.closed-run", "A", row !== undefined && row.status !== "running", `the held run ended ${row?.status ?? "missing"}: "${row?.lastEvent?.message ?? ""}"`);
  expect("app.no-running", "none", rows.every((r) => r.status !== "running" && r.status !== "queued"), `${rows.length} runs in the store, none left running`);

  await launch(profiles.main, profiles.engine);
  await ui!.choose(a);
  await engineOnline("after relaunching");
  const back = (await ui!.projects()).find((p) => p.id === a.id);
  expect("app.intact", "A", back !== undefined && back.sharing.modelContext, "the project and its consent are still there");
  const unknown = await ui!.refusal(`window.nivra.runEvents(${JSON.stringify(closed)}, 0)`);
  expect("app.old-run-unknown", "A", unknown !== null && /no record of that run in this session/.test(unknown), `asking for the earlier run: ${unknown ?? "answered"}`);
  expect("cleanup.key-removed", "none", (await ui!.settings()).nebiusKey === "none", "no key was ever saved in this profile");
  if (platform === "windows") expect("identity.no-native-engine", "none", (await ui!.engineOf("local"))?.state.status !== "online", "the native engine never started");
  await quit(profiles.main, "rehearsal-end");
}

const PERSONAL = "Name component files in PascalCase; write tests with Vitest";
const EDITED = "Prefer PascalCase component files, and Vitest for new tests";
const A_OWN = (name: string) => `${name} builds its web UI with Mantine`;
const A_REPLACED = (name: string) => `${name} builds its web UI with Mantine and Tailwind`;
const CHOICE = "Use PascalCase for this task";
const RETRY = {
  a: "Which files show how this repository names its component files and runs its tests? Cite the lines you read.",
  b: "How does this repository name component files, and which test runner does it use? Where that differs from the engineer's preferences, report a conflict that cites the lines showing the repository's convention.",
  choice: "How does this repository name component files? Report any conflict with this task's choice, citing the lines that show the repository's convention.",
};

async function live(): Promise<void> {
  await launch(profiles.main, profiles.engine);
  const info = await ui!.appInfo();
  expect("identity.app-info", "none", info.packaged && info.version === buildInfo.version && info.electron === buildInfo.electron.electron, `packaged ${info.packaged}, version ${info.version}, Electron ${info.electron}`);
  const a = await ui!.pick(pathFor(fixtureA), target);
  const engine = await engineOnline("the live session");
  expect("identity.engine", "none", engine.runtimeHash === linuxRuntime.contentHash && engine.node === `v${linuxRuntime.node}`, `runtime ${engine.runtimeHash}, Node ${engine.node}`);
  const headA = acceptance.fixtures.A!.head;

  // 1. The key: typed by the person; this only waits for Settings to say one is saved.
  await ui!.page.getByTestId("nebius-key").focus();
  log("→ Type your Nebius key into Settings in the Nivra window and press Save. Waiting up to 15 minutes…");
  await waitFor(async () => ["encrypted", "unencrypted"].includes((await ui!.settings()).nebiusKey), 15 * 60_000, "a saved key");
  log(`key saved (${(await ui!.settings()).nebiusKey})`);
  const check = await ui!.checkTokenFactory(a.id);
  writeFileSync(join(privateDir, "provider-check.json"), `${JSON.stringify(check, null, 2)}\n`);
  expect("provider.check", "none", check.endpoint === "token-factory" && check.models.nvidia.length > 0 && check.call !== null, `${check.models.nvidia.length} NVIDIA models; called ${check.call?.model ?? "none"} in ${check.call?.elapsedMs ?? "?"} ms; context ${check.models.contextLength ?? "not reported"}`);

  // 2. The journey.
  expect("consent.refused", "A", !(await ui!.refuseConsent()), "Cancel in the consent dialog started nothing");
  const refusal = await ui!.refusal(`window.nivra.startExplain(${JSON.stringify(a.id)}, "", [])`);
  expect("consent.refused-bridge", "A", refusal !== null && /doesn't allow sending its content/.test(refusal), `the host said: ${refusal ?? "nothing (it started)"}`);
  let want = expectedSnapshot(await ui!.preferences(), a.id);
  let observed = await explainOn(a, "A", "explain", "");
  expect("a.explain", "A", observed.summary.status === "succeeded", `run ${observed.summary.status}`);
  handoff(observed, "A", want, headA);
  const shown = (o: Observed) => (o.result?.checks.checked ?? 0) > 0;
  if (!note("a.checked-citations", "A", shown(observed) ? "pass" : "incomplete", `${observed.result?.checks.checked ?? 0} of ${observed.result?.checks.citations ?? 0} citations shown to the model`)) {
    observed = await explainOn(a, "A", "explain", RETRY.a, [], 2);
    handoff(observed, "A", want, headA, 2);
    note("a.checked-citations", "A", shown(observed) ? "pass" : "incomplete", `${observed.result?.checks.checked ?? 0} of ${observed.result?.checks.citations ?? 0} citations shown to the model`, 2);
  }

  const personal = await ui!.confirmPreference(PERSONAL, "Every project");
  const aOwn = await ui!.confirmPreference(A_OWN(a.label), `${a.label} only`);
  const records = (await ui!.preferences()).records;
  expect("prefs.confirmed", "A", records.some((r) => r.id === personal && r.scope === "personal") && records.some((r) => r.id === aOwn && r.scope === "project" && r.projectId === a.id), "a personal preference and one of A's own are confirmed");

  const b = await ui!.pick(pathFor(fixtureB!), target);
  const headB = acceptance.fixtures.B!.head;
  const gate = await ui!.received(await hello(b, "B"));
  if (!expect("b.privacy-gate", "B", gate !== null && gate.records.every((r) => r.id !== aOwn) && gate.records.some((r) => r.id === personal), `B's hello received ${gate?.count ?? "nothing"} preference(s), A's own ${gate?.records.some((r) => r.id === aOwn) ? "INCLUDED" : "absent"}`)) {
    throw new Gate("A's own preference reached B's snapshot, so nothing about B was sent to the model.");
  }
  want = expectedSnapshot(await ui!.preferences(), b.id);
  const bChecks = (o: Observed, attempt: number) => {
    handoff(o, "B", want, headB, attempt);
    const conflicts = o.result?.conflicts ?? [];
    expect("b.isolation", "B", !(o.received?.records ?? []).some((r) => r.id === aOwn) && !conflicts.some((c) => c.preferences.some((p) => p.id === aOwn)), "A's own preference is in neither B's context nor its conflicts", attempt);
    const wrong = conflicts.filter((c) => c.reason !== expectedReason(c));
    expect("b.ranking", "B", wrong.length === 0, `${conflicts.length} conflict(s), ${wrong.length} ranked differently from their sides`, attempt);
    const governs = conflicts.some((c) => c.reason === "repository" && c.preferences.some((p) => p.id === personal));
    return note("b.repository-governs", "B", governs ? "pass" : "incomplete", governs ? "the repository governs over the personal default" : `no conflict where the repository governs over the personal default (reasons: ${conflicts.map((c) => c.reason).join(", ") || "none reported"})`, attempt);
  };
  observed = await explainOn(b, "B", "explain", "");
  expect("b.explain", "B", observed.summary.status === "succeeded", `run ${observed.summary.status}`);
  if (!bChecks(observed, 1)) bChecks(await explainOn(b, "B", "explain", RETRY.b, [], 2), 2);

  const store = join(local(profiles.main), "nivra.json");
  const choiceChecks = async (o: Observed, before: Buffer, prefsBefore: string, attempt: number) => {
    expect("choice.explain", "B", o.summary.status === "succeeded" && JSON.stringify(o.result?.choices.map((x) => x.id)) === '["c1"]', `run ${o.summary.status}; choices ${o.result?.choices.map((x) => x.id).join(", ") ?? "none"}`, attempt);
    handoff(o, "B", want, headB, attempt);
    expect("choice.store-unchanged", "B", readFileSync(store).equals(before) && JSON.stringify(await ui!.preferences()) === prefsBefore, "nivra.json is byte-identical and the preferences are unchanged", attempt);
    const conflicts = o.result?.conflicts ?? [];
    expect("choice.ranking", "B", conflicts.every((c) => c.reason === expectedReason(c)), `${conflicts.length} conflict(s) ranked as their sides say`, attempt);
    const governed = conflicts.find((c) => c.reason === "choice" && c.choices.includes("c1") && c.repositoryConvention !== null && c.citations.some((x) => x.checked));
    const intended = governed ? await ui!.page.locator('[data-testid="explain-conflict"][data-reason="choice"]').first().getByTestId("explain-conflict-intended").textContent().catch(() => null) : null;
    const ok = governed !== undefined && (intended ?? "").includes("c1");
    return note("choice.governs", "B", ok ? "pass" : "incomplete", ok ? "the choice governs; Currently shows the repository's convention and Intended names c1" : `no conflict governed by c1 with the repository's convention shown (reasons: ${conflicts.map((c) => c.reason).join(", ") || "none reported"})`, attempt);
  };
  let before = readFileSync(store);
  let prefsBefore = JSON.stringify(await ui!.preferences());
  if (!(await choiceChecks(await explainOn(b, "B", "choice", "", [CHOICE]), before, prefsBefore, 1))) {
    before = readFileSync(store);
    prefsBefore = JSON.stringify(await ui!.preferences());
    await choiceChecks(await explainOn(b, "B", "choice", RETRY.choice, [CHOICE], 2), before, prefsBefore, 2);
  }
  while (await ui!.page.getByTestId("explain-choice-remove").count()) await ui!.page.getByTestId("explain-choice-remove").first().click();

  // 4. The lifecycle.
  await ui!.editPreference(personal, EDITED);
  const edited = (await ui!.preferences()).records.find((r) => r.id === personal)!;
  want = expectedSnapshot(await ui!.preferences(), b.id);
  const helloAfterEdit = await ui!.received(await hello(b, "B"));
  observed = await explainOn(b, "B", "edit", "");
  handoff(observed, "B", want, headB);
  expect("life.edit", "B", edited.revision === 2 && helloAfterEdit?.digest === want.digest && observed.received?.digest === want.digest, `revision ${edited.revision}; hello and the next explanation received fingerprint ${observed.received?.digest.slice(0, 12) ?? "none"}`);
  note("life.wording", "B", (await ui!.page.getByTestId("explain-conflict-others").allTextContents()).some((t) => t.includes(EDITED)) ? "pass" : "incomplete", "the edited wording in the result's conflicts");

  const replacement = await ui!.replacePreference(aOwn, A_REPLACED(a.label));
  const replaced = (await ui!.preferences()).records.find((r) => r.id === aOwn);
  want = expectedSnapshot(await ui!.preferences(), a.id);
  const helloAfterReplace = await ui!.received(await hello(a, "A"));
  observed = await explainOn(a, "A", "replace", "");
  handoff(observed, "A", want, headA);
  const ids = (r: Observed["received"]) => (r?.records ?? []).map((x) => x.id);
  expect("life.replace", "A", replacement !== aOwn && replaced?.status === "superseded" && ids(helloAfterReplace).includes(replacement) && !ids(helloAfterReplace).includes(aOwn) && ids(observed.received).includes(replacement) && !ids(observed.received).includes(aOwn), "the replacement is sent and the replaced one isn't");

  await ui!.deletePreference(personal);
  want = expectedSnapshot(await ui!.preferences(), b.id);
  const helloAfterDelete = await ui!.received(await hello(b, "B"));
  observed = await explainOn(b, "B", "delete", "");
  handoff(observed, "B", want, headB);
  expect("life.delete", "B", helloAfterDelete?.count === 0 && observed.received?.count === 0 && !(observed.result?.conflicts ?? []).some((c) => c.preferences.length > 0), `after the deletion B received ${observed.received?.count ?? "?"} preferences, and no conflict names one`);

  // 5. A changed file reaches the next request.
  const fresh = join(work, "nivra-fresh-amber");
  mkdirSync(join(fresh, "src"), { recursive: true });
  writeFileSync(join(fresh, "package.json"), `${JSON.stringify({ name: "nivra-fresh-amber-1", version: "1.0.0", private: true, scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(fresh, "README.md"), "# Fresh\n\nA throwaway repository for Nivra's acceptance run.\n");
  writeFileSync(join(fresh, "src", "index.js"), "export const greet = (name) => `Hello, ${name}`;\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=nivra", "-c", "user.email=acceptance@nivra.invalid", "commit", "-q", "-m", "init"]]) output("git", ["-C", fresh, ...args]);
  const freshProject = await ui!.pick(pathFor(fresh), target);
  const freshHead = output("git", ["-C", fresh, "rev-parse", "HEAD"]);
  const question = "What is the exact name field in this repository's package.json? Quote it exactly.";
  want = expectedSnapshot(await ui!.preferences(), freshProject.id);
  const first = await explainOn(freshProject, "fresh", "fresh", question);
  handoff(first, "fresh", want, freshHead);
  writeFileSync(join(fresh, "package.json"), readFileSync(join(fresh, "package.json"), "utf8").replace("nivra-fresh-amber-1", "nivra-fresh-amber-2"));
  const second = await explainOn(freshProject, "fresh", "fresh", question);
  handoff(second, "fresh", want, freshHead);
  const manifestHash = (o: Observed) => o.result?.context.map.find((m) => m.path === "package.json")?.sha256 ?? null;
  expect("fresh.map-changed", "fresh", manifestHash(first) !== null && manifestHash(second) !== null && manifestHash(first) !== manifestHash(second) && second.result?.headAtStart === freshHead, `package.json ${manifestHash(first)?.slice(0, 12)} then ${manifestHash(second)?.slice(0, 12)}; HEAD unchanged`);
  note("fresh.name-seen", "fresh", JSON.stringify(second.result?.summary ?? "").includes("nivra-fresh-amber-2") || (second.result?.findings ?? []).some((f) => f.statement.includes("nivra-fresh-amber-2")) ? "pass" : "incomplete", "the new name in the answer");

  // 6. Failures, on A, each while its run is still active.
  await interrupt(a, "withdraw", "consent.withdrawn", async (runId) => {
    await ui!.page.getByTestId("explain-sharing-off").click();
    await ui!.ended(runId, 60_000);
    const e = await ui!.events(runId);
    return e.status === "cancelled" && e.events.at(-1)?.message === "Cancelled" ? null : `run ${e.status}: "${e.events.at(-1)?.message ?? ""}"`;
  });
  await interrupt(a, "cancel", "cancel.live", async (runId) => {
    await ui!.page.getByTestId("explain-cancel").click();
    await ui!.ended(runId, 60_000);
    const e = await ui!.events(runId);
    return e.status === "cancelled" && e.events.at(-1)?.message === "Cancelled" ? null : `run ${e.status}: "${e.events.at(-1)?.message ?? ""}"`;
  });
  await interrupt(a, "graceful-restart", "engine.graceful-live", async (runId) => {
    const was = await ui!.online(target);
    keepLogs(profiles.main, "before-graceful-restart");
    await ui!.restartEngine(a.id);
    const now = await engineOnline("after a graceful restart");
    await ui!.ended(runId, 60_000);
    const e = await ui!.events(runId);
    return e.status === "cancelled" && e.events.at(-1)?.message === "Cancelled: the app asked it to stop" && now.instanceId !== was.instanceId ? null : `run ${e.status}: "${e.events.at(-1)?.message ?? ""}"`;
  });
  await interrupt(a, "kill", "engine.kill-live", async (runId) => {
    const victim = await ui!.online(target);
    if (!isEngine(victim.pid, victim.instanceId, uid)) return `pid ${victim.pid} isn't engine ${victim.instanceId}; nothing was killed`;
    const callsBefore = (await ui!.events(runId)).events.filter((e) => e.type === "model.call").length;
    keepLogs(profiles.main, "before-kill");
    process.kill(victim.pid, "SIGKILL");
    await ui!.page.getByTestId("engine-failed").waitFor({ timeout: 30_000 });
    await ui!.page.getByTestId("engine-restart").click();
    const revived = await engineOnline("after a kill");
    await waitFor(async () => (await ui!.status(runId)) !== "running", 30_000, "the killed run to be reconciled");
    const e = await ui!.events(runId);
    const calls = e.events.filter((x) => x.type === "model.call");
    const extra = calls.slice(callsBefore);
    const ok =
      e.status === "failed" &&
      e.events.at(-1)?.type === "run.interrupted" &&
      e.events.filter((x) => x.type === "run.started").length === 1 &&
      extra.length <= 1 &&
      extra.every((x) => x.data?.["kind"] === "cancelled") &&
      revived.instanceId !== victim.instanceId;
    return ok ? null : `run ${e.status}, last ${e.events.at(-1)?.type}, ${extra.length} model call(s) after the kill`;
  });

  // 7. The app restarts while a run is going.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ui!.choose(a);
    const runId = await ui!.explain("");
    await ui!.firstModelCall(runId);
    if ((await ui!.status(runId)) !== "running") {
      await observe(runId, "A", "app-restart", attempt);
      note("app.closed-run", "A", "incomplete", `missed window: run ${runId} had already ended`, attempt);
      continue;
    }
    const prefsBeforeQuit = JSON.stringify((await ui!.preferences()).records);
    const projectsBefore = JSON.stringify((await ui!.projects()).map((p) => [p.id, p.label, p.sharing.modelContext]));
    await quit(profiles.main, "app-restart");
    const copy = join(privateDir, "db", `${String(elapsed()).padStart(8, "0")}-app-restart`);
    copyRunStore(engineHomeNow(), copy);
    const rows = readRuns(copy);
    const row = rows.find((r) => r.id === runId);
    expect("app.closed-run", "A", row !== undefined && row.status !== "running", `the run ended ${row?.status ?? "missing"}: "${row?.lastEvent?.message ?? ""}"`, attempt);
    expect("app.no-running", "none", rows.every((r) => r.status !== "running" && r.status !== "queued"), `${rows.length} runs in the store, none left running`, attempt);
    await launch(profiles.main, profiles.engine, values.network ? { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", NO_PROXY: "" } : {});
    // With several projects, none is chosen at start, and an engine starts only for a chosen one (D17).
    await ui!.choose(a);
    await engineOnline("after relaunching");
    expect("app.intact", "A", JSON.stringify((await ui!.preferences()).records) === prefsBeforeQuit && JSON.stringify((await ui!.projects()).map((p) => [p.id, p.label, p.sharing.modelContext])) === projectsBefore, "preferences, projects and consent are as they were", attempt);
    const unknown = await ui!.refusal(`window.nivra.runEvents(${JSON.stringify(runId)}, 0)`);
    expect("app.old-run-unknown", "A", unknown !== null && /no record of that run in this session/.test(unknown), `asking for the earlier run: ${unknown ?? "answered"}`, attempt);
    break;
  }
  if (values.network) {
    // 8. With the proxy pointing nowhere, the local engine can't reach Token Factory.
    const refusalText = await ui!.refusal(`window.nivra.checkTokenFactory(${JSON.stringify(freshProject.id)})`);
    const failed = await explainOn(freshProject, "fresh", "network", question);
    const kind = failed.events.find((e) => e.type === "run.failed")?.data?.["kind"];
    note("provider.network", "fresh", failed.summary.status === "failed" && kind === "network" ? "pass" : "incomplete", `provider check: ${refusalText ?? "answered"}; the explanation ${failed.summary.status}, kind ${String(kind)}`);
    await quit(profiles.main, "network");
    await launch(profiles.main, profiles.engine);
    await ui!.choose(a);
    await engineOnline("after the network check");
  }
  want = expectedSnapshot(await ui!.preferences(), freshProject.id);
  const afterRestart = await explainOn(freshProject, "fresh", "after-restart", question);
  handoff(afterRestart, "fresh", want, freshHead);
  expect("app.live-after", "fresh", afterRestart.summary.status === "succeeded", `a run after the restart ${afterRestart.summary.status}`);
  if (platform === "windows") expect("identity.no-native-engine", "none", (await ui!.engineOf("local"))?.state.status !== "online", "the native engine never started");

  // The main profile's last launch: the key goes while the app can still answer.
  await ui!.setKey(null);
  expect("cleanup.key-removed", "none", (await ui!.settings()).nebiusKey === "none", "the key was removed from the main profile");
  await quit(profiles.main, "main-profile-end");
  const finalCopy = join(privateDir, "db", "final");
  copyRunStore(engineHomeNow(), finalCopy);
  const finalRows = readRuns(finalCopy);
  writeFileSync(join(privateDir, "db-states.json"), `${JSON.stringify(finalRows, null, 2)}\n`);
  expect("app.no-running", "none", finalRows.every((r) => r.status !== "running" && r.status !== "queued"), `${finalRows.length} runs in the final store, none left running`);

  // 9. A bad key, in a profile of its own, after the main profile's app has quit.
  await launch(profiles.badKey, profiles.badKeyEngine);
  const freshAgain = await ui!.pick(pathFor(fresh), target);
  await engineOnline("the bad-key profile");
  await ui!.setKey("nivra-acceptance-invalid-key-0000");
  const bad = await explainOn(freshAgain, "fresh", "bad-key", question);
  const badKind = bad.events.find((e) => e.type === "run.failed")?.data?.["kind"];
  expect("provider.bad-key", "fresh", bad.summary.status === "failed" && badKind === "auth" && bad.summary.route === null && bad.summary.usage === null && !bad.events.some((e) => e.type === "model.call"), `the run ${bad.summary.status}, kind ${String(badKind)}, no model call`);
  await ui!.setKey(null);
  await quit(profiles.badKey, "bad-key-end");
}

// ─── The session ─────────────────────────────────────────────────────────────────────────────────────────────────
let stopped: string | null = null;
try {
  machine();
  acceptance.fixtures.A = facts(fixtureA);
  if (fixtureB) acceptance.fixtures.B = facts(fixtureB);
  if (fixtureB) writeFileSync(join(privateDir, "b-details.md"), `# Fixture B (private: for NIV-6)\n\n- ${fixtureB}\n- HEAD ${bIds!.head}\n`);
  mkdirSync(join(privateDir, "runs"), { recursive: true });
  executable.path = identity();
  if (platform === "windows") {
    log(`moving ${homePath} aside to ${record.home!.movedTo}; the recovery record is ${POINTER}`);
    moveHome(record, save, () => [...windowsBusy(), ...enginesUsing(homePath, uid).map((e) => `engine pid ${e.pid}`)]);
  }
  if (session === "rehearsal") await rehearsal();
  else await live();
} catch (error) {
  stopped = error instanceof Error ? error.message : String(error);
  log(`✗ the session stopped: ${stopped}`);
} finally {
  // Cleanup is always last: the key while the app can answer, then the engines, the evidence, the profiles and the home.
  // (They are set inside the phases, which the compiler can't see from here.)
  const openUi = ui as Ui | null;
  const openApp = app as ElectronApplication | null;
  if (openUi) {
    const removed = await Promise.race([openUi.setKey(null).then(() => true, () => false), sleep(10_000).then(() => false)]);
    log(removed ? "removed the key from the open profile" : "the open app didn't answer; its profile is deleted below, with any key");
  }
  if (openApp) {
    await Promise.race([openApp.close().catch(() => undefined), sleep(15_000)]);
    openApp.process().kill("SIGKILL");
  }
  try {
    const notes = await finishSession(record, save, { busy: platform === "windows" ? windowsBusy : undefined, log });
    expect("cleanup.engines-exited", "none", true, "every engine this session started has exited");
    expect("cleanup.profiles-deleted", "none", record.profiles.every((p) => !existsSync(p)), `${record.profiles.length} profile folder(s) deleted`);
    if (record.home) expect("cleanup.home-restored", "none", record.state === "restored", notes.filter((n) => n.includes("restored") || n.includes("untouched") || n.includes("original")).join("; "));
  } catch (error) {
    note(error instanceof Refused ? "cleanup.home-restored" : "cleanup.engines-exited", "none", "fail", `${error instanceof Error ? error.message : String(error)} Recover with: pnpm accept:live --recover`);
  }
  persist();
  const outcomes = criteriaOutcomes(acceptance.checks);
  if (bIds || session === "rehearsal") {
    try {
      const { json, markdown } = publicFiles(acceptance, bIds ?? { paths: [], label: "", name: "", remote: null, head: "" });
      writeFileSync(join(evidence, "public-summary.json"), json);
      writeFileSync(join(evidence, "public-summary.md"), markdown);
    } catch (error) {
      log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${platform} ${session} session${stopped ? ` stopped early: ${redact(stopped)}` : ""}`);
  for (const [criterion, outcome] of Object.entries(outcomes)) if (outcome !== "not-run") console.log(`  ${outcome.padEnd(10)} ${criterion}`);
  console.log(`  evidence: ${evidence} (private/ is yours alone; public-summary.* is shareable)`);
  process.exitCode = stopped || Object.values(outcomes).some((o) => o === "fail") ? 1 : 0;
}
