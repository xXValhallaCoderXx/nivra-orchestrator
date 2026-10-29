import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { goTo, openSwitcher } from "./places.ts";
import { startStub, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";

/**
 * D20's demonstration, end to end, through the real UI against a loopback stub of Token Factory (NIV-14's scenario,
 * prepared with NIV-11): explain repository A with evidence; confirm a portable preference and one of A's own; explain
 * repository B, whose conventions contrast with A's, and see B's convention govern while A's own never reaches B; give a
 * task choice that governs without changing the stored profile; then edit and delete the preference and see each change
 * reach the next request. The stub plays the model, so what it "reports" is scripted: this checks Nivra's side of the
 * sequence (what is sent, what is ranked and what is shown), not a model's judgement.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORTABLE = "Name component files in PascalCase; write tests with Vitest";
// Not containing PORTABLE, so a request still carrying the old wording can be told apart from one with the new.
const EDITED = "Prefer PascalCase component files, and Vitest for new tests";
const A_OWN = "fitness-a builds its web UI with Mantine";
const CHOICE = "Use PascalCase for this task";
const README_LINE = (line: number) => ({ path: "README.md", startLine: line, endLine: line });

let root: string;
let stub: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
/** What the model answers once it has read the README: set by each step. */
let answer: Record<string, unknown> = {};

function makeRepo(name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return repo;
}

async function pick(path: string): Promise<void> {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
}

/** Explains the chosen project and returns what its requests carried. Consent is asked for once per project. */
async function explain(consent: boolean): Promise<string> {
  const before = stub.chats().length;
  const status = page.getByTestId("explain-status");
  const previous = (await status.count()) ? await status.getAttribute("data-run-id") : null;
  await goTo(page, "explain");
  await page.getByTestId("explain-start").click();
  if (consent) await page.getByTestId("explain-consent-allow").click();
  await expect.poll(async () => ((await status.count()) ? await status.getAttribute("data-run-id") : previous)).not.toBe(previous);
  await expect(status).toHaveText("succeeded");
  return stub.chats().slice(before).map((chat) => chat.raw).join("\n");
}

const preferenceId = async (statement: string) =>
  (await page.evaluate(() => window.nivra.listPreferences())).records.find((record) => record.statement === statement && record.status === "confirmed")!.id;
const store = () => readFileSync(join(root, "user data", "nivra.json"));

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e d20 ü%# "));
  makeRepo("fitness-a", {
    "README.md": "# Fitness\nComponent files use PascalCase, like `WorkoutCard.tsx`.\nTests use Vitest.\n",
    "package.json": JSON.stringify({ name: "fitness-a", devDependencies: { vitest: "1.0.0" } }),
  });
  makeRepo("timer-b", {
    "README.md": "# Timer\nComponent files use kebab-case, like `start-timer.tsx`.\nTests use Jest.\n",
    "package.json": JSON.stringify({ name: "timer-b", scripts: { test: "jest" }, devDependencies: { jest: "29.0.0" } }),
  });
  // Stateless: the model reads the README, then gives the step's answer.
  stub = await startStub({ chat: (request: StubRequest): Reply => (request.raw.includes('"role":"tool"') ? toolCall("submit_answer", answer, { id: "a1" }) : toolCall("read_file", { path: "README.md" }, { id: "r0" })) });
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-token-factory-url=${stub.url}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await stub?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("the D20 sequence: evidence from A, a preference that follows to B without overriding B, a task choice, then edit and delete", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.evaluate(() => window.nivra.setNebiusKey("test-key-0123456789"));

  await test.step("1. A is explained with the lines it rests on", async () => {
    await pick(join(root, "fitness-a"));
    answer = {
      summary: "A fitness app: PascalCase component files, tests with Vitest.",
      findings: [
        { statement: "Component files use PascalCase.", citations: [README_LINE(2)] },
        { statement: "Tests use Vitest.", citations: [README_LINE(3)] },
      ],
      suggestions: [{ statement: "Name component files in PascalCase", citations: [README_LINE(2)] }],
    };
    await explain(true);
    await expect(page.getByTestId("explain-finding").getByTestId("explain-citation").and(page.locator("[data-checked=yes]"))).toHaveCount(2);
  });

  await test.step("2. A portable preference is confirmed, and one of A's own", async () => {
    await goTo(page, "settings-preferences");
    await page.getByTestId("preference-scope").getByText("Every project", { exact: true }).click();
    await page.getByTestId("preference-input").fill(PORTABLE);
    await page.getByTestId("preference-confirm").click();
    await page.getByTestId("preference-scope").getByText("fitness-a only", { exact: true }).click();
    await page.getByTestId("preference-input").fill(A_OWN);
    await page.getByTestId("preference-confirm").click();
    await expect(page.getByTestId("preferences-summary")).toContainText("Runs on fitness-a get 2 confirmed preferences");
  });

  const portable = await preferenceId(PORTABLE);
  const conflict = (choiceIds: string[]) => ({
    topic: "component file names",
    repositoryConvention: "kebab-case component files",
    citations: [README_LINE(2)],
    preferenceIds: [portable],
    choiceIds,
  });
  const bAnswer = (conflicts: unknown[]) => ({ summary: "A timer app: kebab-case component files, tests with Jest.", findings: [{ statement: "Component files use kebab-case.", citations: [README_LINE(2)] }], conflicts });
  const shown = page.getByTestId("explain-conflict");

  await test.step("3–4. B's convention governs over the personal default, and A's own never reaches B", async () => {
    await pick(join(root, "timer-b"));
    await expect(page.getByTestId("preferences-summary")).toContainText("Runs on timer-b get 1 confirmed preference");
    answer = bAnswer([conflict([])]);
    const sent = await explain(true);
    expect([sent.includes(PORTABLE), sent.includes(A_OWN)]).toEqual([true, false]);
    await expect(shown).toHaveAttribute("data-reason", "repository");
    await expect(shown.getByTestId("explain-conflict-currently")).toHaveText("Currently: kebab-case component files");
    await expect(shown.getByTestId("explain-conflict-governs")).toHaveText("Governs this task: the repository's convention. The repository's own conventions come before defaults.");
    await expect(shown.getByTestId("explain-conflict-others")).toContainText(`your personal default “${PORTABLE}”`);
  });

  await test.step("An explicit task choice governs this run only, without changing the stored profile", async () => {
    const before = store();
    await page.getByTestId("explain-choice-add").click();
    await page.getByTestId("explain-choice").fill(CHOICE);
    answer = bAnswer([conflict(["c1"])]);
    const sent = await explain(false);
    expect(sent.includes(CHOICE)).toBe(true);
    await expect(shown).toHaveAttribute("data-reason", "choice");
    await expect(shown.getByTestId("explain-conflict-intended")).toHaveText(`Intended: c1: “${CHOICE}”`);
    await expect(shown.getByTestId("explain-conflict-currently")).toHaveText("Currently: kebab-case component files");
    expect(store().equals(before)).toBe(true);
    await page.getByTestId("explain-choice-remove").click();
  });

  await test.step("5. An edit, then a deletion, reach the next request; the old result stops quoting the preference", async () => {
    const row = page.locator(`[data-testid="preference-row"][data-preference-id="${portable}"]`);
    await goTo(page, "settings-preferences");
    await row.getByTestId("preference-edit").click();
    await row.getByTestId("preference-edit-input").fill(EDITED);
    await row.getByTestId("preference-save").click();
    await expect(shown.getByTestId("explain-conflict-others")).toContainText("changed or was deleted since this run");
    answer = bAnswer([conflict([])]);
    const afterEdit = await explain(false);
    expect([afterEdit.includes(EDITED), afterEdit.includes(PORTABLE)]).toEqual([true, false]);
    await expect(shown.getByTestId("explain-conflict-others")).toContainText(`your personal default “${EDITED}”`);

    await goTo(page, "settings-preferences");
    await row.getByTestId("preference-delete").click();
    await expect(shown.getByTestId("explain-conflict-others")).toContainText("changed or was deleted since this run");
    answer = bAnswer([]);
    const afterDelete = await explain(false);
    expect([afterDelete.includes(EDITED), afterDelete.includes("The engineer has no confirmed preferences for this project.")]).toEqual([false, true]);
    await expect(shown).toHaveCount(0);
  });
});
