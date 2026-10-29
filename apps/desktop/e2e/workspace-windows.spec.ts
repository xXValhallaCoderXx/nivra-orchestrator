import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { goTo } from "./places.ts";
import { build } from "esbuild";
import { REMOVE_TEST_HOME, testWslHome } from "../scripts/test-homes.ts";

/**
 * The workspace (D26) in the packaged Windows app, run on Windows from WSL (D14), as `pnpm dev:win --no-launch` copied
 * it: `node:sqlite` opens in Electron's main process on Windows, a conversation survives a relaunch, starting one starts
 * no engine, and a file that isn't a database is kept aside with its journal files (renamed on NTFS) while the app still
 * starts. The same check as workspace-store.spec.ts. Then, on NTFS: a damaged workspace that a killed app left its WAL
 * beside is kept aside exactly as it was found. Then the window itself, with no key (no model is ever called): its
 * places, a turn refused on the native engine before any request, and a task, all kept across a relaunch. Last, a plan's
 * review (D31): the Windows build reaches no model, so a plan is seeded into its profile first, through the workspace's
 * own functions, bundled and run by the staged node.exe, so the file is only ever opened on Windows (D7). Any WSL engine
 * would use a home of this run's own (D27); none starts.
 */
test.skip(process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe"), "runs from WSL on a Windows machine");

const windows = (exe: string, args: string[]) => {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const wslpath = (flag: "-u" | "-w", path: string) => windows("/usr/bin/wslpath", [flag, path]);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const wslHome = testWslHome("e2e-workspace");
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");

test.afterAll(() => {
  spawnSync("/bin/sh", ["-c", REMOVE_TEST_HOME, "sh", wslHome]);
});

/** A fresh folder for one test under %LOCALAPPDATA%\nivra-dev, and a way to start the packaged app on it. */
function setUp(name: string) {
  const devWin = `${windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"])}\\nivra-dev`;
  const exe = `${wslpath("-u", devWin)}/app/Nivra.exe`;
  if (!existsSync(exe)) throw new Error(`No Windows build at ${exe}: run pnpm dev:win --no-launch first.`);
  const rootWin = `${devWin}\\${name}`;
  const root = wslpath("-u", rootWin);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const launch = async () => {
    const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${rootWin}\\user data`, `--nivra-engine-home=${rootWin}\\engine`, `--nivra-wsl-home=${wslHome}`], chromiumSandbox: true, timeout: 120_000 });
    return { app, page: await app.firstWindow() };
  };
  return { root, userData: `${root}/user data`, launch };
}

test("the workspace opens in the Windows app, keeps a conversation across a relaunch, and keeps a damaged file aside", async () => {
  const { root, userData, launch } = setUp("e2e-workspace");

  let { app, page } = await launch();
  const fresh = await page.evaluate(() => window.nivra.listConversations());
  expect(fresh.workspace).toMatchObject({ state: "ready", schemaVersion: 10, notice: null });
  const created = await page.evaluate(() => window.nivra.createConversation({ kind: "general" }));
  expect([created.kind, created.projectId, created.targetId]).toEqual(["general", null, "local"]);
  expect(await page.evaluate(() => window.nivra.listEngines())).toEqual([]);
  await app.close();

  ({ app, page } = await launch());
  const relaunched = await page.evaluate(() => window.nivra.listConversations());
  expect(relaunched.conversations.map((c) => c.id)).toEqual([created.id]);
  await app.close();

  writeFileSync(`${userData}/workspace.db`, "this is not a database ".repeat(40));
  writeFileSync(`${userData}/workspace.db-wal`, "its write-ahead log");
  ({ app, page } = await launch());
  const recovered = await page.evaluate(() => window.nivra.listConversations());
  expect(recovered.workspace.state).toBe("ready");
  expect(recovered.workspace.state === "ready" ? recovered.workspace.notice : null).toMatch(/kept it aside as workspace\.db\.unreadable-\d+, with its journal files, and started a new one/);
  expect(recovered.conversations).toEqual([]);
  expect(readdirSync(userData).filter((name) => name.includes("unreadable")).length).toBe(2);
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("keeps a damaged workspace that a killed app left its WAL beside exactly as it was found, on NTFS", async () => {
  const { root, userData, launch } = setUp("e2e-workspace-crash");
  // The first session makes the workspace and closes cleanly, so its schema is in the file itself.
  let { app, page } = await launch();
  await page.evaluate(() => window.nivra.createConversation({ kind: "general" }));
  await app.close();
  // The second writes one more conversation and is killed before it can close: that row is only in the WAL.
  ({ app, page } = await launch());
  await page.evaluate(() => window.nivra.createConversation({ kind: "general" }));
  const pid = await app.evaluate(() => process.pid);
  windows("/mnt/c/Windows/System32/taskkill.exe", ["/F", "/T", "/PID", String(pid)]);
  await expect.poll(() => windows("/mnt/c/Windows/System32/tasklist.exe", ["/FI", `PID eq ${pid}`, "/NH"]).includes(String(pid)), { timeout: 15_000 }).toBe(false);
  expect(existsSync(`${userData}/workspace.db-wal`)).toBe(true);
  // The schema page damaged past its header, where only SQLite can see it.
  const bytes = readFileSync(`${userData}/workspace.db`);
  bytes.fill(0xab, 100, 4096);
  writeFileSync(`${userData}/workspace.db`, bytes);
  const before = [sha(`${userData}/workspace.db`), sha(`${userData}/workspace.db-wal`)];
  ({ app, page } = await launch());
  const recovered = await page.evaluate(() => window.nivra.listConversations());
  expect(recovered.workspace.state === "ready" ? recovered.workspace.notice : null).toMatch(/^Nivra couldn't read its history file \(SQLite error 11\), so it kept it aside as workspace\.db\.unreadable-\d+, with its journal files, and started a new one\./);
  const aside = readdirSync(userData).filter((name) => name.includes("unreadable")).sort();
  expect(aside.length).toBe(2);
  expect(aside.map((name) => sha(`${userData}/${name}`))).toEqual(before);
  expect(recovered.conversations).toEqual([]);
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("the window on Windows: a turn with no key is refused on the native engine before any request, and a task keeps its state across a relaunch", async () => {
  const { root, launch } = setUp("e2e-window");
  let { app, page } = await launch();
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  await page.getByTestId("nav-planning").click();
  await page.getByTestId("planning-new-general").click();
  await expect(page.getByTestId("conversation-scope")).toHaveText("General · no repository access");
  await page.getByTestId("composer").fill("No key on Windows?");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("turn-status")).toHaveText("Failed", { timeout: 120_000 });
  await expect(page.getByTestId("turn-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  // A general conversation runs on the app's own OS: here, the native Windows engine, and no other.
  const engines = await page.evaluate(() => window.nivra.listEngines());
  expect(engines.map((engine) => [engine.targetId, engine.state.status, engine.state.status === "online" ? engine.state.info.platform : null])).toEqual([["local", "online", "win32"]]);
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("tasks-new").click();
  await page.getByTestId("task-form-title").fill("Tidy the README");
  await page.getByTestId("brief-goal").fill("Tidy it");
  await page.getByTestId("brief-criteria").fill("Every heading is sentence case");
  await page.getByTestId("task-form-create").click();
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");
  await expect(page.getByTestId("task-run")).toBeDisabled();
  await app.close();

  ({ app, page } = await launch());
  await goTo(page, "conversations");
  await page.getByTestId("nav-conversation").filter({ hasText: "No key on Windows?" }).click();
  await expect(page.getByTestId("conversation-title")).toHaveText("No key on Windows?");
  await expect(page.getByTestId("turn-status")).toHaveText("Failed");
  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("task-row").filter({ hasText: "Tidy the README" })).toContainText("Ready");
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a seeded plan's review on Windows shows what it would send, is refused on the native engine before any request with no key, and is kept across a relaunch", async () => {
  const { root, launch } = setUp("e2e-review");
  const staged = join(desktop, "build", "stage", "win-x64", "node", "node.exe");
  if (!existsSync(staged)) throw new Error("No staged Windows runtime: run pnpm stage:runtime all first.");
  copyFileSync(staged, `${root}/node.exe`);
  await build({ entryPoints: [join(desktop, "e2e", "seed-workspace-cli.ts")], outfile: `${root}/seed.mjs`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning" });
  mkdirSync(`${root}/user data`, { recursive: true });
  const rootWin = wslpath("-w", root);
  const seed = { question: "How do we rename the users column safely?", plan: "Rename users.fullname to display_name in place during a rolling deploy." };
  const seeded = JSON.parse(windows(`${root}/node.exe`, [`${rootWin}\\seed.mjs`, `${rootWin}\\user data\\workspace.db`, seed.question, seed.plan])) as { conversationId: string };

  let { app, page } = await launch();
  await page.getByTestId("nav-planning").click();
  await page.getByTestId("nav-conversation").filter({ hasText: seed.question }).click();
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview-version")).toHaveText("Reviewing v1, the latest version.");
  await expect(page.getByTestId("review-preview-sends")).toContainText(`The plan's text: ${seed.plan.length} characters.`);
  await page.getByTestId("review-start").click();
  await expect(page.getByTestId("review-status")).toHaveText("Failed", { timeout: 120_000 });
  await expect(page.getByTestId("review-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  const engines = await page.evaluate(() => window.nivra.listEngines());
  expect(engines.map((engine) => [engine.targetId, engine.state.status, engine.state.status === "online" ? engine.state.info.platform : null])).toEqual([["local", "online", "win32"]]);
  const kept = await page.evaluate((id) => window.nivra.listReviews(id), seeded.conversationId);
  expect(kept.map((review) => [review.planVersion, review.status, review.report])).toEqual([[1, "failed", null]]);
  await app.close();

  ({ app, page } = await launch());
  expect(await page.evaluate((id) => window.nivra.listReviews(id), seeded.conversationId)).toEqual(kept);
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a mission on Windows: its backlog and the review's exact preview, refused with no key on the native engine before any request, and kept across a relaunch", async () => {
  const { root, launch } = setUp("e2e-mission");
  let { app, page } = await launch();
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  const made = await page.evaluate(() =>
    window.nivra.createMission({ name: "Runner's log", intendedUsers: "Club runners.", outcome: "A runner sees this week's distance against their plan.", successCriteria: [], constraints: [], nonGoals: [] }),
  );
  await page.evaluate((id) => window.nivra.createMissionTask(id, "Store runs"), made.id);
  await page.getByTestId("nav-missions").click();
  await page.getByTestId("mission-open").filter({ hasText: "Runner's log" }).click();
  await page.getByTestId("backlog-row").filter({ hasText: "Store runs" }).getByTestId("backlog-select").check();
  await page.getByTestId("mission-review-open").click();
  await expect(page.getByTestId("mission-preview-text")).toContainText("T1. Store runs");
  await page.getByTestId("mission-review-start").click();
  await expect(page.getByTestId("mission-review").first().getByTestId("review-status")).toHaveText("Failed", { timeout: 120_000 });
  await expect(page.getByTestId("mission-review").first().getByTestId("review-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  const engines = await page.evaluate(() => window.nivra.listEngines());
  expect(engines.map((engine) => [engine.targetId, engine.state.status, engine.state.status === "online" ? engine.state.info.platform : null])).toEqual([["local", "online", "win32"]]);
  // A mission's own conversation isn't one of the person's.
  expect((await page.evaluate(() => window.nivra.listConversations())).conversations).toEqual([]);
  await app.close();

  ({ app, page } = await launch());
  const kept = await page.evaluate((id) => window.nivra.getMission(id), made.id);
  expect([kept.latest.version, kept.backlog.map((entry) => entry.task.title), kept.reviews.map((review) => [review.status, review.tasks.map((task) => task.title)])]).toEqual([1, ["Store runs"], [["failed", ["Store runs"]]]]);
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
