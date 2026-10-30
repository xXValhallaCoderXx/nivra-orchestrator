// NIV-53: one explicitly invoked real coaching in a frozen native Windows app. Never part of pnpm verify.
// From WSL: --state ~/nivra-acceptance/niv53/completion-<name>, then --freeze, --plan, --rehearse,
// --live --approved <digest>, --save --reviewed <answer sha256> --fields acceptanceCriteria, --cleanup.
// --live records the answer and removes the key. Review it before --save; neither save nor cleanup asks a model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COACH_RUN_LIMITS, CoachField } from "@nivra/domain";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { z } from "zod";
import { claimApproval } from "../../engine/scripts/research-check/claim.ts";
import { CoachAnswer, COACH_TOOL_DESCRIPTION } from "../../engine/src/coach/answers.ts";
import { COACH_INSTRUCTIONS, COACH_INSTRUCTIONS_SHA256 } from "../../engine/src/coach/prompt.ts";
import { APP_TOKEN_CAP, policyFor, requestBudget } from "../../engine/src/providers/policy.ts";
import { PREFERRED_NEMOTRON, TOKEN_FACTORY_BASE_URL } from "../../engine/src/providers/tokenfactory.ts";
import type { CoachPreview, CoachingView } from "../src/shared/coach.ts";
import type { EngineView, TaskView } from "../src/shared/ipc.ts";
import { COACH_DEMO, COACH_FOLLOW_MS, checkCoachAnswer, coachingsOf, coachPreview, createCoachTask, endedCoach, openCoachTask, saveCoachSelection, taskOf } from "./coach-journey.ts";
import { coachDigest, coachFiles, coachHash, coachOutput, coachState, writeCoachOutput } from "./coach-live-checks.ts";
import { RELEASE_HOME_STATE } from "./test-homes.ts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(desktop, "..", "..");
const { values } = parseArgs({ options: {
  state: { type: "string" }, freeze: { type: "boolean" }, plan: { type: "boolean" }, rehearse: { type: "boolean" },
  live: { type: "boolean" }, save: { type: "boolean" }, cleanup: { type: "boolean" },
  approved: { type: "string" }, reviewed: { type: "string" }, fields: { type: "string" }, credentials: { type: "string" },
} });
const mode = (["freeze", "plan", "rehearse", "live", "save", "cleanup"] as const).filter((name) => values[name]);
assert.equal(mode.length, 1, "Choose one of --freeze, --plan, --rehearse, --live, --save or --cleanup.");
assert.ok(values.state, "Give --state a new ~/nivra-acceptance/niv53/completion-* folder.");
const state = coachState(values.state, homedir());
const claims = join(homedir(), "nivra-acceptance", "claims", "coach-desktop");
const keyFile = values.credentials ?? join(homedir(), ".config", "nivra", "token-factory.env");
const file = (name: string) => coachOutput(state, name);
const write = (name: string, value: unknown) => writeCoachOutput(state, name, `${JSON.stringify(value, null, 2)}\n`);
const read = <T>(name: string): T => JSON.parse(readFileSync(file(name), "utf8")) as T;
const run = (exe: string, args: string[], cwd = repository, input?: string): string => {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  if (result.status !== 0) throw new Error(`${exe} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const git = (...args: string[]) => run("git", args);
const wslpath = (flag: "-u" | "-w", path: string) => run("/usr/bin/wslpath", [flag, path]);
const powershell = (script: string) => run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], "/mnt/c");
const source = () => coachFiles(repository, git("ls-files", "-co", "--exclude-standard", "-z").split("\0").filter(Boolean));
const model = PREFERRED_NEMOTRON[0];
assert.ok(policyFor(model).forceAnswer, "the current preferred coach model has no forced-answer evidence");

interface Frozen {
  revision: string; source: ReturnType<typeof coachFiles>; localChanges: boolean;
  folderWin: string; build: ReturnType<typeof coachFiles>; node: string;
  before: TaskView; preview: CoachPreview; protectedHomes: Record<string, string>;
}
const folder = (frozen: Frozen) => wslpath("-u", frozen.folderWin);
const nativeNode = (frozen: Frozen) => join(folder(frozen), "app", "resources", "runtime", "win-x64", "node", "node.exe");
const exe = (frozen: Frozen) => join(folder(frozen), "app", "Nivra.exe");

function windowsBuild(frozen: Pick<Frozen, "folderWin">): ReturnType<typeof coachFiles> {
  const root = wslpath("-u", frozen.folderWin);
  const script = 'const fs=require("node:fs"),p=require("node:path"),c=require("node:crypto"),root=process.argv[1],rows=[];const hash=x=>c.createHash("sha256").update(x).digest("hex");function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const path=p.join(dir,item.name);if(item.isSymbolicLink())throw Error("Linked build file");if(item.isDirectory())walk(path);else if(item.isFile())rows.push([p.relative(root,path),hash(fs.readFileSync(path))]);}}walk(root);rows.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);console.log(JSON.stringify({count:rows.length,sha256:hash(JSON.stringify(rows))}));';
  return JSON.parse(run(join(root, "app", "resources", "runtime", "win-x64", "node", "node.exe"), ["-e", script, `${frozen.folderWin}\\app`], "/mnt/c")) as ReturnType<typeof coachFiles>;
}

function windowsIdle(): void {
  const processes = powershell('Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("Nivra.exe", "electron.exe") } | Select-Object ProcessId,Name | ConvertTo-Json -Compress');
  assert.equal(processes, "", "another Nivra/Electron is running on Windows; finish its test slot before starting this one");
}

function protectedHomes(): Record<string, string> {
  const sh = (script: string) => run("/bin/sh", ["-c", script], homedir());
  const windows = powershell('$roots=@((Join-Path $env:LOCALAPPDATA "Nivra"),(Join-Path $env:APPDATA "Nivra"),(Join-Path $env:LOCALAPPDATA "nivra-dev\\engine"),(Join-Path $env:LOCALAPPDATA "nivra-dev\\user data")); foreach($root in $roots){ if(Test-Path -LiteralPath $root){ Get-ChildItem -LiteralPath $root -File -Recurse | Sort-Object FullName | ForEach-Object { $_.FullName + " " + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }}');
  return { releaseWsl: sh(RELEASE_HOME_STATE), sharedWsl: sh(RELEASE_HOME_STATE.replace('"$HOME/.nivra"', '"$HOME/.nivra-dev"')), windows: coachHash(windows) };
}

function checkFrozen(checkSource = true): Frozen {
  const frozen = read<Frozen>("freeze.json");
  if (checkSource) {
    assert.equal(git("rev-parse", "HEAD"), frozen.revision, "the source revision changed; freeze a new recipe");
    assert.equal(source().sha256, frozen.source.sha256, "source bytes changed; freeze and review a new recipe");
  }
  assert.equal(windowsBuild(frozen).sha256, frozen.build.sha256, "the frozen Windows build changed");
  return frozen;
}

async function launch(frozen: Frozen): Promise<ElectronApplication> {
  return electron.launch({ executablePath: exe(frozen), args: [
    `--user-data-dir=${frozen.folderWin}\\profile`, `--nivra-engine-home=${frozen.folderWin}\\engine`,
    `--nivra-wsl-home=.nivra-test/coach-${frozen.before?.summary.id ?? "freeze"}`,
  ], chromiumSandbox: true, timeout: 120_000 });
}

function recipe(frozen: Frozen) {
  return {
    kind: "NIV-53 desktop acceptance", revision: frozen.revision, source: frozen.source, localChanges: frozen.localChanges,
    build: frozen.build, node: frozen.node, folderWin: frozen.folderWin, fixture: COACH_DEMO,
    taskId: frozen.before.summary.id, preview: frozen.preview, model, endpoint: TOKEN_FACTORY_BASE_URL,
    instructions: COACH_INSTRUCTIONS, instructionsSha256: COACH_INSTRUCTIONS_SHA256,
    toolSha256: coachDigest([COACH_TOOL_DESCRIPTION, z.toJSONSchema(CoachAnswer)]), limits: COACH_RUN_LIMITS,
    contextReservation: { totalTokens: APP_TOKEN_CAP, completionTokens: COACH_RUN_LIMITS.outputTokensPerRequest, maxInputTokens: requestBudget(null, COACH_RUN_LIMITS.outputTokensPerRequest) },
    observerMs: COACH_FOLLOW_MS,
    measurement: { fields: ["finishReason", "inputTokens", "outputTokens", "reasoningTokens", "elapsedMs"], reasoning: "A reported subset of output, already counted in outputTokens; unknown is null." },
    liveAdmission: { blocked: "Paid coach acceptance is deferred: the desktop coach start route does not yet obtain a host-ledger grant. Connect and verify that route under AGENTS.md D49 before sending another paid request. Freeze, plan and rehearsal remain available.", rule: "AGENTS.md D49" },
    inputNote: "Input tokens are estimated for admission, not an exact ceiling. No monetary price is asserted.",
    modelNote: "The app selects from its listing. A report naming another model fails this acceptance; no second coaching is sent.",
    actions: ["One Start in the actual coach dialog", "Retain and inspect the real answer", "Remove the key and close", "After review, select a proper subset of fields and save once", "Reopen the saved brief and report"],
    never: ["repository context", "personal preferences", "research", "sandbox", "coding attempt", "automatic retry", "state transition", "automatic acceptance cases"],
  };
}

async function freeze(): Promise<void> {
  assert.equal(existsSync(file("freeze.json")), false, "this state already has a frozen build; use another completion-* folder");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const beforeHomes = protectedHomes();
  const beforeSource = source();
  console.log("Building the native Windows app; output goes to build.log.");
  const built = spawnSync("pnpm", ["dev:win", "--no-launch"], { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeCoachOutput(state, "build.log", `${built.stdout}\n${built.stderr}`);
  assert.equal(built.status, 0, "the Windows build failed; see build.log");
  assert.equal(source().sha256, beforeSource.sha256, "source changed while the build was made");
  const localAppData = run("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"], "/mnt/c");
  const folderWin = `${localAppData}\\nivra-dev\\niv53-completion-${randomUUID()}`;
  const root = wslpath("-u", folderWin);
  mkdirSync(root, { recursive: true });
  console.log("Copying and hashing the frozen build on Windows.");
  // Copy on Windows: thousands of runtime files are prohibitively slow through WSL's 9P mount.
  const copied = spawnSync("/mnt/c/Windows/System32/robocopy.exe", [`${localAppData}\\nivra-dev\\app`, `${folderWin}\\app`, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"], { cwd: "/mnt/c", encoding: "utf8" });
  assert.ok(copied.status !== null && copied.status < 8, "the frozen Windows copy failed");
  const frozen = { revision: git("rev-parse", "HEAD"), source: beforeSource, localChanges: git("status", "--porcelain") !== "", folderWin, build: windowsBuild({ folderWin }), node: process.version, protectedHomes: beforeHomes } as Frozen;
  const app = await launch(frozen);
  try {
    const page = await app.firstWindow();
    frozen.before = await createCoachTask(page);
    frozen.preview = await coachPreview(page, frozen.before.summary.id);
    assert.equal((await coachingsOf(page, frozen.before.summary.id)).length, 0);
    writeCoachOutput(state, "preview.png", await page.getByTestId("coach-dialog").screenshot());
    await page.getByTestId("coach-dialog-cancel").click();
    assert.equal((await page.evaluate("window.nivra.listEngines()") as unknown[]).length, 0);
  } finally { await app.close(); }
  assert.deepEqual(protectedHomes(), beforeHomes, "a protected home changed during freezing");
  write("freeze.json", frozen);
  console.log(`Frozen ${frozen.revision.slice(0, 12)} with source ${frozen.source.sha256}. No model request was made.`);
}

function readKey(): string {
  const stat = statSync(keyFile);
  assert.equal(stat.uid, process.getuid?.(), "the credentials file must belong to this user");
  assert.equal(stat.mode & 0o077, 0, "the credentials file must have mode 0600");
  const match = readFileSync(keyFile, "utf8").match(/^(?:export\s+)?NEBIUS_API_KEY\s*=\s*["']?([^\r\n"']+)/m);
  assert.ok(match && match[1]?.trim(), "the private file has no Token Factory key");
  return match[1].trim();
}

/** Scan native databases only with a native process, after Electron and its engine have closed (D7). */
function scan(frozen: Frozen, key: string): { files: number; leaks: number } {
  const script = 'const fs=require("node:fs"),p=require("node:path"); let input=""; process.stdin.on("data",x=>input+=x); process.stdin.on("end",()=>{const {key,roots}=JSON.parse(input);let files=0,leaks=0;function walk(root){if(!fs.existsSync(root))return;for(const item of fs.readdirSync(root,{withFileTypes:true})){const path=p.join(root,item.name);if(item.isDirectory())walk(path);else if(item.isFile()){files++;if(fs.readFileSync(path).includes(Buffer.from(key)))leaks++;}}}for(const root of roots)walk(root);console.log(JSON.stringify({files,leaks}));});';
  const scanPath = join(folder(frozen), "scan.cjs");
  writeFileSync(scanPath, script);
  return JSON.parse(run(nativeNode(frozen), [wslpath("-w", scanPath)], "/mnt/c", JSON.stringify({ key, roots: [`${frozen.folderWin}\\profile`, `${frozen.folderWin}\\engine`, wslpath("-w", state)] }))) as { files: number; leaks: number };
}

/** Only numeric usage and the finish reason, read natively after close. No response/reasoning text is copied. */
function measuredUsage(frozen: Frozen, runId: string): unknown {
  const script = 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;const rows=db.prepare("SELECT data FROM run_events WHERE run_id=? AND type=?").all(process.argv[2],"model.call");console.log(JSON.stringify(rows.map(row=>{const d=JSON.parse(row.data),output=count(d.outputTokens),reasoning=count(d.reasoningTokens);return {finishReason:typeof d.finishReason==="string"?d.finishReason.slice(0,40):null,inputTokens:count(d.inputTokens),outputTokens:output,reasoningTokens:reasoning!==null&&output!==null&&reasoning<=output?reasoning:null,elapsedMs:count(d.elapsedMs)};})));db.close();';
  return JSON.parse(run(nativeNode(frozen), ["-e", script, `${frozen.folderWin}\\engine\\nivra.db`, runId], "/mnt/c"));
}

async function session(kind: "rehearse" | "live" | "save" | "cleanup"): Promise<void> {
  const frozen = checkFrozen(kind !== "cleanup");
  const bound = recipe(frozen);
  const digest = coachDigest(bound);
  if (kind === "live") {
    assert.equal(values.approved, digest, "--approved must name this exact recipe");
    if (bound.liveAdmission.blocked) throw new Error(bound.liveAdmission.blocked);
    const claim = claimApproval(claims, { digest, run: 1, revision: frozen.revision, out: state, pid: process.pid, claimedAt: new Date().toISOString() });
    assert.equal(claim.ok, true, "this recipe was already claimed, including any interrupted launch");
  }
  let secret: string | null = null;
  let app = await launch(frozen);
  let failure: unknown;
  try {
    let page = await app.firstWindow();
    if (kind === "cleanup") {
      await page.evaluate("window.nivra.setNebiusKey(null)");
    } else if (kind === "save") {
      const coaching = read<CoachingView>("answer.json");
      assert.equal(values.reviewed, coachDigest(coaching), "review the retained answer and pass its SHA-256 with --reviewed");
      const fields = (values.fields ?? "").split(",").map((field) => CoachField.parse(field));
      const [current] = await coachingsOf(page, frozen.before.summary.id);
      assert.ok(current && current.report);
      assert.equal(coachDigest(current.report), coachDigest(coaching.report), "the report changed since it was reviewed");
      const saved = await saveCoachSelection(page, frozen.before, current, fields);
      write("saved.json", saved);
      writeCoachOutput(state, "saved.png", await page.getByTestId("task-coach-main").screenshot());
      await app.close();
      app = await launch(frozen);
      page = await app.firstWindow();
      await openCoachTask(page, frozen.before.summary.id);
      await expect(page.getByTestId("coach-applied")).toBeVisible();
      const reopened = await taskOf(page, frozen.before.summary.id);
      assert.equal(reopened.brief.version, saved.brief.version);
      assert.equal(coachDigest(reopened.brief.content), coachDigest(saved.brief.content));
      const records = await coachingsOf(page, frozen.before.summary.id);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0]!.applied?.fields, fields);
      assert.equal(records[0]!.report?.stage.requests, 1);
      writeCoachOutput(state, "reopened.png", await page.getByTestId("task-coach-main").screenshot());
      write("result.json", { outcome: "journey-passed", recipe: digest, reviewed: values.reviewed, fields, briefVersion: reopened.brief.version, model: current.report.stage.servedModel, usage: current.report.usage, note: "Structural journey passed. Assess actual usefulness separately in quality.md; this is not proof of engineering correctness." });
      console.log("Selected changes persisted across restart. No coaching was started by save or reopening.");
    } else {
      const before = await taskOf(page, frozen.before.summary.id);
      assert.equal(coachDigest(before.brief.content), coachDigest(frozen.before.brief.content));
      assert.equal((await coachingsOf(page, before.summary.id)).length, 0, "this profile already contains a coaching");
      await coachPreview(page, before.summary.id, frozen.preview);
      if (kind === "rehearse") {
        await page.getByTestId("coach-dialog-cancel").click();
        assert.equal((await coachingsOf(page, before.summary.id)).length, 0);
        console.log("Windows preview matches the frozen recipe. No key was read and Start was not pressed.");
      } else {
        secret = readKey();
        await page.evaluate(`window.nivra.setNebiusKey(${JSON.stringify(secret)})`);
        await page.getByTestId("coach-start").click();
        const coaching = await endedCoach(page, before.summary.id);
        write("answer.json", coaching);
        write("live-binding.json", { recipe: digest, answerSha256: coachDigest(coaching) });
        writeCoachOutput(state, "answer.png", await page.getByTestId("task-coach-main").screenshot());
        assert.equal((await taskOf(page, before.summary.id)).brief.version, before.brief.version);
        const engines = await page.evaluate("window.nivra.listEngines()") as EngineView[];
        const local = engines.find((engine) => engine.targetId === "local");
        assert.equal(engines.length, 1);
        assert.equal(local?.state.status, "online");
        if (local?.state.status === "online") { assert.equal(local.state.info.platform, "win32"); assert.equal(local.state.info.home.toLowerCase(), `${frozen.folderWin}\\engine`.toLowerCase()); }
        checkCoachAnswer(coaching);
        assert.equal(coaching.report!.route?.model.toLowerCase(), model.toLowerCase(), "the selected model differs from this recipe; do not retry automatically");
        console.log(`Answer retained. Review ${file("answer.json")}; then use --save --reviewed ${coachDigest(coaching)} --fields <selected fields>.`);
      }
    }
  } catch (error) { failure = error; }
  finally {
    try { await (await app.firstWindow()).evaluate("window.nivra.setNebiusKey(null)"); }
    catch { if (!failure) failure = new Error("The key could not be removed; run --cleanup on this isolated profile."); }
    await app.close();
    if (secret) {
      const checked = scan(frozen, secret);
      write("credential-scan.json", checked);
      assert.ok(checked.files > 0);
      assert.equal(checked.leaks, 0, "a file contains the exact saved key; keep evidence private and clean the isolated profile");
      const answer = existsSync(file("answer.json")) ? read<CoachingView>("answer.json") : null;
      if (answer?.runId) write("measurements.json", measuredUsage(frozen, answer.runId));
    }
    assert.deepEqual(protectedHomes(), frozen.protectedHomes, "a protected home changed during acceptance");
  }
  if (failure) throw new Error(secret ? String(failure).split(secret).join("[redacted]") : String(failure));
}

let lock: number | undefined;
const lockPath = join(homedir(), "nivra-acceptance", "niv53-windows-slot.lock");
try {
  assert.ok(existsSync("/mnt/c/Windows/System32/cmd.exe"), "Run this Windows acceptance helper from WSL.");
  mkdirSync(dirname(lockPath), { recursive: true });
  lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, state }));
  windowsIdle();
  if (values.freeze) await freeze();
  else if (values.plan) {
    const bound = recipe(checkFrozen());
    write("recipe.json", bound);
    console.log(JSON.stringify({ digest: coachDigest(bound), recipe: bound }, null, 2));
  } else await session(mode[0] as "rehearse" | "live" | "save" | "cleanup");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (lock !== undefined) { closeSync(lock); rmSync(lockPath); }
}
