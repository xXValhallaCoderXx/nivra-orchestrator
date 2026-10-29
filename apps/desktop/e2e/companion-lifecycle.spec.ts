import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { CompanionContextView, CompanionTurnView } from "../src/shared/ipc";
import { goTo, openSwitcher } from "./places.ts";

/** Renderer timing/failure regressions over named IPC stand-ins. No provider or engine request is made by the fixture. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const message = "Remember this private task decision.";
const reply = "Your task decision is remembered. Here is the next step.";
interface Fixture {
  epoch: string; mode: string; reads: number; sends: number; ends: number; gets: number;
  waiting: Array<{ requestId: string; resolve(value: CompanionTurnView): void }>;
  oldContext: (() => void) | null;
  failEnd: boolean;
  result: CompanionTurnView | null;
}
let root: string;
let app: ElectronApplication;
let page: Page;

test.beforeEach(async ({}, info) => {
  root = mkdtempSync(join(tmpdir(), "nivra companion lifecycle "));
  const executable = info.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await expect(page.getByTestId("home-title")).toBeVisible();
});
test.afterEach(async () => { await app?.close().catch(() => undefined); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

async function installFixture(mode: string, failEnd = false) {
  await app.evaluate(({ ipcMain }, options) => {
    const state: Fixture = { epoch: "before", mode: options.mode, reads: 0, sends: 0, ends: 0, gets: 0, waiting: [], oldContext: null, failEnd: options.failEnd, result: null };
    (globalThis as { companionFixture?: Fixture }).companionFixture = state;
    const context = (): CompanionContextView => ({ scope: { kind: "general" }, label: "General planning", dialogueEpoch: state.epoch, fingerprint: state.epoch, sources: [], blockers: [], knowledge: [], canAsk: true, askBlocked: null, projectId: null });
    for (const channel of ["companion:context", "companion:send", "companion:get", "companion:end"]) ipcMain.removeHandler(channel);
    ipcMain.handle("companion:context", () => {
      state.reads++;
      const value = context();
      if (state.mode === "old-context-after-reply" && state.reads === 2) return new Promise((resolve) => { state.oldContext = () => resolve(value); });
      return value;
    });
    ipcMain.handle("companion:send", (_event, input: { clientRequestId: string }) => { state.sends++; return { requestId: input.clientRequestId, runId: input.clientRequestId }; });
    ipcMain.handle("companion:get", (_event, _sessionId: string, requestId: string) => {
      state.gets++;
      if (state.epoch === "external") return { status: "interrupted", message: "The saved work or knowledge changed." } satisfies CompanionTurnView;
      if (state.result) return state.result;
      if (state.mode === "context-before-reply") state.epoch = "own";
      return new Promise<CompanionTurnView>((resolve) => { state.waiting.push({ requestId, resolve }); });
    });
    ipcMain.handle("companion:end", () => { state.ends++; if (state.failEnd) throw new Error("The local dialogue was cleared, but the engine couldn't confirm cancellation. Restart that engine to stop it."); });
  }, { mode, failEnd });
  await page.getByTestId("companion-launcher").click();
  await page.getByTestId("companion-message").fill(message);
  await expect(page.getByTestId("companion-send")).toBeEnabled();
  await page.getByTestId("companion-send").click();
  await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.gets)).toBeGreaterThan(0);
}

async function deliverReply() {
  await app.evaluate((_electron, text) => {
    const state = (globalThis as { companionFixture?: Fixture }).companionFixture!;
    state.epoch = "own";
    const result: CompanionTurnView = { status: "answered", reply: text, dialogueEpoch: "own", fingerprint: "own", retained: [{ id: "note", revision: 1, statement: "This private task decision.", kind: "decision", origin: "user-stated", status: "active", sourceLabel: "Your explicit statement" }] };
    state.result = result;
    for (const pending of state.waiting.splice(0)) pending.resolve(result);
  }, reply);
}

for (const order of ["context-before-reply", "old-context-after-reply"]) {
  test(`own retention keeps the answer and composer when ${order}`, async () => {
    await installFixture(order);
    await page.getByTestId("companion-message").fill("An unsent follow-up.");
    await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.reads)).toBeGreaterThanOrEqual(2);
    await deliverReply();
    await expect(page.getByTestId("companion-dialogue")).toContainText(reply);
    if (order === "old-context-after-reply") {
      await app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.oldContext?.());
      await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.reads)).toBeGreaterThanOrEqual(3);
    }
    await expect(page.getByTestId("companion-dialogue")).toContainText(message);
    await expect(page.getByTestId("companion-dialogue")).toContainText(reply);
    await expect(page.getByTestId("companion-message")).toHaveValue("An unsent follow-up.");
    expect(await app.evaluate(() => { const state = (globalThis as { companionFixture?: Fixture }).companionFixture!; return [state.sends, state.ends]; })).toEqual([1, 0]);
  });
}

test("external forgetting clears an in-flight dialogue and its late answer cannot restore it", async () => {
  await installFixture("external");
  await page.getByTestId("companion-message").fill("Unsent private follow-up.");
  await app.evaluate(() => { (globalThis as { companionFixture?: Fixture }).companionFixture!.epoch = "external"; });
  await page.getByTestId("companion-minimise").click();
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-message")).toHaveValue("");
  await expect(page.getByTestId("companion-dialogue")).not.toContainText(message);
  await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.ends)).toBe(1);
  await deliverReply();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("companion-dialogue")).not.toContainText(reply);
});

test("ending clears private text immediately even when engine cancellation fails", async () => {
  await installFixture("end", true);
  await page.getByTestId("companion-message").fill("Unsent private follow-up.");
  await page.getByTestId("companion-end").click();
  await expect(page.getByTestId("companion-message")).toHaveValue("");
  await expect(page.getByTestId("companion-dialogue")).not.toContainText(message);
  await expect(page.getByTestId("companion-turn-error")).toContainText("couldn't confirm cancellation");
  await deliverReply();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("companion-dialogue")).not.toContainText(reply);
});

test("a duplicate late result from the previous turn cannot finish the next turn", async () => {
  await installFixture("duplicate");
  await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.waiting.length)).toBeGreaterThanOrEqual(2);
  const firstRequest = await app.evaluate(() => {
    const state = (globalThis as { companionFixture?: Fixture }).companionFixture!;
    const pending = state.waiting.shift()!;
    pending.resolve({ status: "answered", reply: "First answer", dialogueEpoch: "before", fingerprint: "before" });
    return pending.requestId;
  });
  await expect(page.getByTestId("companion-dialogue")).toContainText("First answer");
  await page.getByTestId("companion-message").fill("A second question.");
  await page.getByTestId("companion-send").click();
  await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.sends)).toBe(2);
  await app.evaluate((_electron, requestId) => {
    const state = (globalThis as { companionFixture?: Fixture }).companionFixture!;
    for (const pending of state.waiting.filter((one) => one.requestId === requestId)) pending.resolve({ status: "answered", reply: "Late duplicate first answer", dialogueEpoch: "before", fingerprint: "before" });
    state.waiting = state.waiting.filter((one) => one.requestId !== requestId);
  }, firstRequest);
  await expect.poll(() => app.evaluate(() => (globalThis as { companionFixture?: Fixture }).companionFixture!.waiting.some((one) => one.requestId !== ""))).toBe(true);
  await app.evaluate(() => {
    const state = (globalThis as { companionFixture?: Fixture }).companionFixture!;
    for (const pending of state.waiting.splice(0)) pending.resolve({ status: "answered", reply: "Second answer", dialogueEpoch: "before", fingerprint: "before" });
  });
  await expect(page.getByTestId("companion-dialogue")).toContainText("Second answer");
  await expect(page.getByTestId("companion-dialogue")).not.toContainText("Late duplicate first answer");
});

for (const selection of ["Project A", "General"]) {
test(`a task opens its own project's Settings then restores ${selection}`, async () => {
  const ids: string[] = [];
  for (const name of ["Project A", "Project B"]) {
    const folder = join(root, name); mkdirSync(folder);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog; }, folder);
    await openSwitcher(page);
    await page.getByTestId("project-add").click();
    await expect(page.getByTestId("home-title")).toHaveText(name);
    ids.push((await page.evaluate(() => window.nivra.listProjects())).at(-1)!.id);
  }
  const task = await page.evaluate((projectId) => window.nivra.createTask({ title: "Task belonging to B", projectId, planId: null, fields: { goal: "Plan this task", scope: "", exclusions: "", context: "", acceptanceCriteria: [], assumptions: [], checks: [], acceptanceCases: [] } }), ids[1]!);
  await openSwitcher(page);
  await page.getByRole("option", { name: selection === "General" ? /^General/ : /Project A/ }).click();
  await goTo(page, "tasks");
  await page.locator(`[data-testid="task-row"][data-task-id="${task.summary.id}"]`).getByTestId("task-open").click();
  await expect(page.getByTestId("project-select")).toHaveValue(selection);
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-context")).toContainText("Task belonging to B");
  await page.getByRole("button", { name: "Open Settings", exact: true }).first().click();
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await expect(page.getByTestId("project-select")).toHaveValue("Project B");
  await page.getByTestId("settings-tab-diagnostics").click();
  await expect(page.getByTestId("diagnostics-engine")).toContainText("The engine Project B runs on.");
  await page.getByTestId("companion-return").click();
  await expect(page.getByTestId("project-select")).toHaveValue(selection);
  await expect(page.locator(`[data-testid="task"][data-task-id="${task.summary.id}"]`)).toBeVisible();
  await expect(page.getByTestId("companion-context")).toContainText("Task belonging to B");
});
}
