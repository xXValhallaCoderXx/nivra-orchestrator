import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { goTo, openSwitcher } from "./places.ts";
import { RELEASE_HOME_STATE, releaseHomeChange, REMOVE_TEST_HOME, STALE_TEST_HOMES, testWslHome } from "../scripts/test-homes.ts";
import { png, pdf } from "../test/fixtures/reference-files.ts";

/**
 * The packaged Windows app, run on Windows from WSL through interop (D14: no CI), as copied by `pnpm dev:win`. One
 * session drives both engines through the real UI, each chosen by its folder (D17): a folder picked as
 * \\wsl.localhost\… runs in the distribution (provisioned from the shipped tarball), a folder made by Git for Windows
 * runs on the native engine, a run held on WSL keeps going and cancels on its own engine while the native one starts and
 * works, and quitting leaves no engine on either side. Preferences confirmed in the window reach each engine with its
 * runs (D21): every value intact, and one project's own never in the other's. Explaining asks for each project's
 * consent and, with no key, fails on both engines before any request (D22). Research starts with no Tavily key and its
 * queries off, and the person turns the permission on and off (D37). The WSL engine runs in a home of this run's own,
 * and the release's ~/.nivra is left exactly as it was (D27).
 */
test.skip(process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe"), "runs from WSL on a Windows machine");

const windows = (exe: string, args: string[]) => {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const wslpath = (flag: "-u" | "-w", path: string) => windows("/usr/bin/wslpath", [flag, path]);
const GIT_EXE = "/mnt/c/Program Files/Git/cmd/git.exe";
/** Runs a shell script in this distribution, where the app's WSL engine runs too. */
const sh = (script: string, ...args: string[]) => {
  const result = spawnSync("/bin/sh", ["-c", script, "sh", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${script.split("\n")[0]}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};

let app: ElectronApplication;
let page: Page;
let devWin: string;
let nativeRepoWin: string;
let wslRepo: string;
let distro: string;
let wslHome: string;
let releaseBefore: string;
const engines: { native: number | null; wslInstance: string | null; wslRun: string | null } = { native: null, wslInstance: null, wslRun: null };

test.beforeAll(async () => {
  devWin = `${windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"])}\\nivra-dev`;
  const exe = `${wslpath("-u", devWin)}/app/Nivra.exe`;
  if (!existsSync(exe)) throw new Error(`No Windows build at ${exe}: run pnpm dev:win --no-launch first.`);
  const e2e = wslpath("-u", `${devWin}\\e2e`);
  rmSync(e2e, { recursive: true, force: true });
  mkdirSync(`${e2e}/repo ü%#`, { recursive: true });
  nativeRepoWin = `${devWin}\\e2e\\repo ü%#`;
  windows(GIT_EXE, ["-C", nativeRepoWin, "init", "-q", "-b", "main"]);
  windows(GIT_EXE, ["-C", nativeRepoWin, "-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);

  distro = process.env["WSL_DISTRO_NAME"] ?? "Ubuntu";
  sh(STALE_TEST_HOMES);
  wslHome = testWslHome("e2e");
  releaseBefore = sh(RELEASE_HOME_STATE);
  const made = spawnSync("/bin/sh", ["-c", 'set -e; d="$HOME/.nivra-e2e/repo ü%#"; rm -rf "$d"; mkdir -p "$d"; cd "$d"; git init -q -b main; git -c user.name=t -c user.email=t@nivra.invalid commit -q --allow-empty -m init; pwd'], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(made.stderr);
  wslRepo = made.stdout.trim();

  // chromiumSandbox: otherwise Playwright adds --no-sandbox, and the app (app.enableSandbox) refuses to start (exit 5).
  app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${devWin}\\e2e\\user data`, `--nivra-engine-home=${devWin}\\e2e\\engine`, `--nivra-wsl-home=${wslHome}`], chromiumSandbox: true, timeout: 120_000 });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (wslHome) sh(REMOVE_TEST_HOME, wslHome);
});

const engineInfo = (targetId: string) =>
  page.evaluate(async (id) => {
    const view = (await window.nivra.listEngines()).find((e) => e.targetId === id);
    return view?.state.status === "online" ? view.state.info : null;
  }, targetId);

const wslEngineAlive = (instanceId: string) => spawnSync("pgrep", ["-af", "--", `--instance [${instanceId[0]}]${instanceId.slice(1)}`]).status === 0;

async function pick(path: string) {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
}

/** The fingerprint the next run on a target's project should receive, worked out here from the app's records (D21). */
async function expectedFor(targetId: string): Promise<{ ids: string[]; digest: string }> {
  const { projects, preferences } = await page.evaluate(async () => ({ projects: await window.nivra.listProjects(), preferences: await window.nivra.listPreferences() }));
  const projectId = projects.find((p) => p.targetId === targetId)!.id;
  const records = preferences.records.filter((r) => r.status === "confirmed" && (r.scope === "personal" || r.projectId === projectId));
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [r.id, r.scope, r.intent, r.revision, r.statement]);
  return { ids: records.map((r) => r.id), digest: createHash("sha256").update(JSON.stringify(sorted)).digest("hex") };
}

/** Runs hello on the chosen project and returns, once it has succeeded, what its engine recorded about the context it got. */
async function helloContext(): Promise<{ ids: string[]; digest: string }> {
  const status = page.getByTestId("hello-status");
  const previous = (await status.count()) ? await status.getAttribute("data-run-id") : null;
  await goTo(page, "settings-diagnostics");
  await page.getByTestId("hello-start").click();
  await expect.poll(async () => ((await status.count()) ? await status.getAttribute("data-run-id") : previous) !== previous).toBe(true);
  const runId = (await status.getAttribute("data-run-id"))!;
  await expect(status).toHaveText("succeeded");
  const events = await page.evaluate(async (id) => (await window.nivra.runEvents(id, 0)).events, runId);
  const data = events.find((e) => e.stepId === "context" && e.type === "step.output")!.data as { records: Array<{ id: string }>; digest: string };
  return { ids: data.records.map((r) => r.id), digest: data.digest };
}

async function confirmPreference(statement: string, scope: string) {
  await goTo(page, "settings-preferences");
  await page.getByTestId("preference-scope").getByText(scope, { exact: true }).click();
  await page.getByTestId("preference-input").fill(statement);
  await page.getByTestId("preference-confirm").click();
  await expect(page.getByTestId("preference-list")).toContainText(statement);
}

async function choose(targetLabel: string) {
  // The select clears a project that is picked again, so one already chosen is left as it is.
  const target = page.getByTestId("project-target");
  if ((await target.count()) && (await target.textContent()) === targetLabel) return;
  await page.getByTestId("project-select").click();
  await page.getByRole("option", { name: new RegExp(targetLabel) }).click();
  await expect(target).toHaveText(targetLabel);
}

test("the native Windows window becomes visible after startup", async () => {
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.length === 1 && windows[0]!.isVisible();
  }), { timeout: 10_000 }).toBe(true);
});

test("a fresh profile offers no target to choose, starts no engine, and has nothing to say about a working WSL", async () => {
  await expect(page.getByTestId("engine-badge")).toHaveText("No folder chosen");
  await expect(page.getByTestId("target-select")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await window.nivra.getWsl())?.status)).toBe("ready");
  await expect(page.getByTestId("wsl-guidance")).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.nivra.listEngines()).length)).toBe(0);
});

test("a \\\\wsl.localhost folder runs in its distribution, provisioned on first use", async () => {
  await pick(`\\\\wsl.localhost\\${distro}${wslRepo.replace(/\//g, "\\")}`);
  await expect(page.getByTestId("project-target")).toHaveText(`${distro} · WSL`);
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 120_000 });
  const info = (await engineInfo(`wsl:${distro}`))!;
  expect([info.platform, info.home]).toEqual(["linux", `${homedir()}/${wslHome}`]);
  engines.wslInstance = info.instanceId;
  await confirmPreference("Prefer named exports, “quoted”, ü%#, 日本語", "Every project");
  const expected = await expectedFor(`wsl:${distro}`);
  expect(await helloContext()).toEqual(expected);
  await expect(page.getByTestId("hello-timeline")).toContainText(wslRepo);
  await expect(page.getByTestId("hello-timeline")).toContainText(`1 confirmed preference from the app (revision 1), fingerprint ${expected.digest.slice(0, 12)}`);
});

test("a run held on WSL keeps going on its own engine while a Windows folder starts and works on the native engine (the review's race)", async () => {
  await goTo(page, "settings-diagnostics");
  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  engines.wslRun = await page.getByTestId("hello-status").getAttribute("data-run-id");

  await pick(nativeRepoWin);
  await expect(page.getByTestId("project-target")).toHaveText("Windows · Local");
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 60_000 });
  const native = (await engineInfo("local"))!;
  expect(native.platform).toBe("win32");
  engines.native = native.pid;
  await goTo(page, "settings-diagnostics");
  await page.getByText("0 s", { exact: true }).click();
  await confirmPreference("Windows checkouts keep CRLF line endings", "repo ü%# only");
  const forNative = await expectedFor("local");
  expect(forNative.ids).toHaveLength(2);
  expect(await helloContext()).toEqual(forNative);
  await expect(page.getByTestId("hello-timeline")).toContainText("on main");

  // Back on the WSL folder: the same run, on the same engine, is still holding; Cancel reaches that engine.
  await choose(`${distro} · WSL`);
  await expect(page.getByTestId("hello-status")).toHaveText("running");
  await expect(page.getByTestId("hello-status")).toHaveAttribute("data-run-id", engines.wslRun!);
  expect((await engineInfo(`wsl:${distro}`))?.instanceId).toBe(engines.wslInstance);
  await page.getByTestId("hello-cancel").click();
  await expect(page.getByTestId("hello-status")).toHaveText("cancelled");
  expect((await engineInfo("local"))?.pid).toBe(engines.native);

  // The next WSL run gets the personal preference and not the Windows project's own.
  const forWsl = await expectedFor(`wsl:${distro}`);
  expect(forWsl.ids).toHaveLength(1);
  expect(await helloContext()).toEqual(forWsl);
});

test("explaining on either engine asks for the project's consent, then fails before any request without a key", async () => {
  // A fresh profile holds no key, so neither engine can send anything; the run says so, and no model was chosen.
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  for (const target of [`${distro} · WSL`, "Windows · Local"]) {
    await choose(target);
    await goTo(page, "explain");
    const status = page.getByTestId("explain-status");
    const previous = (await status.count()) ? await status.getAttribute("data-run-id") : null;
    await page.getByTestId("explain-start").click();
    await page.getByTestId("explain-consent-allow").click();
    await expect.poll(async () => ((await status.count()) ? await status.getAttribute("data-run-id") : previous) !== previous).toBe(true);
    await expect(status).toHaveText("failed");
    await expect(page.getByTestId("explain-failure")).toContainText("No Nebius key is set");
    const runId = (await status.getAttribute("data-run-id"))!;
    const { summary } = await page.evaluate((id) => window.nivra.runResult(id), runId);
    expect([target, summary.route, summary.usage]).toEqual([target, null, null]);
  }
});

test("the same Windows folder picked through WSL is the Windows project, with a note saying why", async () => {
  const throughWsl = `\\\\wsl.localhost\\${distro}\\mnt\\${nativeRepoWin[0]!.toLowerCase()}${nativeRepoWin.slice(2)}`;
  await pick(throughWsl);
  await expect(page.getByTestId("project-target")).toHaveText("Windows · Local");
  await expect(page.getByTestId("project-add-notice")).toContainText(`drive ${nativeRepoWin[0]!.toUpperCase()}:`);
  expect(await page.evaluate(async () => (await window.nivra.listProjects()).length)).toBe(2);
});

test("research starts with no Tavily key and its queries off, and the permission is the person's to turn on and off (D37)", async () => {
  const settings = await page.evaluate(() => window.nivra.getSettings());
  expect([settings.tavilyKey, settings.webResearch]).toEqual(["none", false]);
  expect((await page.evaluate(() => window.nivra.setWebResearch(true))).webResearch).toBe(true);
  expect((await page.evaluate(() => window.nivra.setWebResearch(false))).webResearch).toBe(false);
  expect((await page.evaluate(() => window.nivra.getSettings())).webResearch).toBe(false);
});

test("task references use the Windows picker, Chromium image worker and packaged PDF worker without provider calls", async () => {
  await choose("Windows · Local");
  const taskId = await page.evaluate(async () => {
    const project = (await window.nivra.listProjects()).find((project) => project.targetId === "local")!;
    const task = await window.nivra.createTask({ title: "Windows reference acceptance", projectId: project.id, planId: null, fields: { goal: "Review supporting references", acceptanceCriteria: ["Prepared context is visible"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] } });
    await window.nivra.addTaskComment(task.summary.id, "Windows task context ü 中文");
    return task.summary.id;
  });
  const imageWin = `${devWin}\\e2e\\reference.png`, pdfWin = `${devWin}\\e2e\\reference.pdf`;
  writeFileSync(wslpath("-u", imageWin), png()); writeFileSync(wslpath("-u", pdfWin), pdf("Windows packaged PDF text"));
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Windows reference acceptance", exact: true }).click();
  const panel = page.getByTestId("task-discussion");
  await app.evaluate(async ({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, imageWin);
  await panel.getByRole("button", { name: "Attach reference file", exact: true }).click();
  await expect(page.getByRole("dialog").locator("img")).toBeVisible(); await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByLabel("Include reference.png", { exact: true }).check();
  await app.evaluate(async ({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, pdfWin);
  await panel.getByRole("button", { name: "Attach reference file", exact: true }).click();
  await panel.getByLabel("Include reference.pdf", { exact: true }).check();
  const context = await page.evaluate((id) => window.nivra.previewTaskReferences(id), taskId);
  expect(context.comments[0]!.text).toBe("Windows task context ü 中文"); expect(context.attachments.length).toBe(2);
  expect(context.attachments.find((file) => file.kind === "image")!.image!.base64.length).toBeGreaterThan(20);
  expect(context.attachments.find((file) => file.kind === "pdf")!.text).toContain("Windows packaged PDF text");
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  const discussion = await page.evaluate((id) => window.nivra.getTaskDiscussion(id), taskId);
  const privateFolder = wslpath("-u", `${userData}\\task-assets\\${discussion.attachments[0]!.projectId}\\${taskId}`);
  expect(existsSync(privateFolder)).toBe(true);
  await page.evaluate((id) => window.nivra.deleteTask(id), taskId);
  expect(existsSync(privateFolder)).toBe(false);
  expect(existsSync(wslpath("-u", imageWin))).toBe(true);
});

test("quitting leaves no engine on Windows or in the distribution", async () => {
  await app.close();
  const nativeGone = () => !windows("/mnt/c/Windows/System32/tasklist.exe", ["/FI", `PID eq ${engines.native}`, "/NH"]).includes(String(engines.native));
  await expect.poll(nativeGone, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => wslEngineAlive(engines.wslInstance!), { timeout: 15_000 }).toBe(false);
});

test("the release's WSL home, ~/.nivra, is as it was, and this run's own home goes", async () => {
  expect(releaseHomeChange(releaseBefore, sh(RELEASE_HOME_STATE))).toBeNull();
  expect(existsSync(`${homedir()}/${wslHome}/runtime`)).toBe(true);
  sh(REMOVE_TEST_HOME, wslHome);
  expect(existsSync(`${homedir()}/${wslHome}`)).toBe(false);
});
