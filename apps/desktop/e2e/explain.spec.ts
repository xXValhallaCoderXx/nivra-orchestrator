import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { httpError, startStub, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";

/**
 * Explain through the real UI (NIV-6, NIV-9, D22). The built app reaches a loopback stub of Token Factory through the
 * unpackaged-only `--nivra-token-factory-url` switch, so no real model is ever called: consent, then a run, then a
 * result whose citations say whether their lines were shown to the model. A packaged app ignores the switch: Doctor
 * shows Token Factory, and explaining without a key fails clearly before any request.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");

let root: string;
let repo: string;
let stub: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
/** What the stub answers once the first test's script has run out. */
let more: (request: StubRequest) => Reply = () => httpError(500, "the script ran out");

const ANSWER = {
  summary: "A small timer app whose component files use kebab-case.",
  findings: [
    { statement: "Component files use kebab-case.", citations: [{ path: "README.md", startLine: 2, endLine: 2 }] },
    { statement: "startTimer is defined in src/timer.ts.", citations: [{ path: "src/timer.ts", startLine: 1, endLine: 1 }] },
    { statement: "A claim about a file it never read.", citations: [{ path: "src/other.ts", startLine: 1, endLine: 1 }] },
  ],
  gaps: ["How the timer is tested."],
};

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e explain ü%# "));
  repo = join(root, "timer-app");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Timer app\nComponent files use kebab-case, like `start-timer.tsx`.\n");
  writeFileSync(join(repo, "src/timer.ts"), "export function startTimer() {}\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  // The answer cites a file the model never read: it is turned down twice, then accepted with that citation labelled.
  const script = [
    toolCall("read_file", { path: "README.md" }, { id: "c0" }),
    toolCall("search_code", { query: "startTimer" }, { id: "c1" }),
    ...[2, 3, 4].map((n) => toolCall("submit_answer", ANSWER, { id: `c${n}` })),
  ];
  stub = await startStub({ chat: (request, index) => script[index] ?? more(request) });
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-token-factory-url=${stub.url}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await stub?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("explaining asks for the project's consent first, then shows checked and unchecked citations", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.evaluate(() => window.nivra.setNebiusKey("test-key-0123456789"));
  await page.getByTestId("explain-question").fill("Which naming convention do component files follow?");
  await page.getByTestId("explain-start").click();
  await expect(page.getByTestId("explain-consent").getByText("excerpts and paths from the project's tracked files")).toBeVisible();
  await expect(page.getByTestId("explain-consent").getByText("your question, and any choices you added for this task")).toBeVisible();
  await page.getByTestId("explain-consent-allow").click();
  await expect(page.getByTestId("explain-status")).toHaveText("succeeded");
  await expect(page.getByTestId("explain-summary")).toHaveText(ANSWER.summary);
  await expect(page.getByTestId("explain-citation").and(page.locator("[data-checked=yes]"))).toHaveCount(2);
  await expect(page.getByTestId("explain-citation").and(page.locator("[data-checked=no]"))).toContainText("file not read");
  await expect(page.getByTestId("explain-run-line")).toContainText("(test endpoint)");
  await expect(page.getByTestId("explain-head")).toContainText("HEAD at run start");
  // The search hit is in the context used, though that line was never read.
  await expect(page.getByTestId("explain-context")).toContainText("1 search with 1 hit (src/timer.ts 1)");
  // The context view (D23): what the model was given, what was left out, and how the budget and the answer went.
  await page.getByTestId("explain-context").click();
  await expect(page.getByTestId("explain-context-preferences")).toHaveText("Preferences received: none (store revision 0)");
  await expect(page.getByTestId("explain-context-hidden")).toHaveText(
    "Hidden from the model: 0 files that may hold secrets, 0 dependency or build output files, and 0 files too large to read.",
  );
  await expect(page.getByTestId("explain-context-budget")).toContainText("The budget didn't run out.");
  await expect(page.getByTestId("explain-context-answer")).toContainText(
    "The model answered before it had to. Turned down before it was accepted: 2 for citations, 0 for conflicts, 0 for its shape.",
  );
  await expect(page.getByTestId("explain-sharing")).toBeVisible();
  await expect(page.getByTestId("explain-timeline")).toContainText("No confirmed preferences from the app (revision 0)");
  await expect(page.getByTestId("explain-timeline")).toContainText("submit_answer refused: 1 citation of lines the model wasn't shown");
  expect(stub.chats().length).toBe(5);
});

test("turning sharing off refuses the next explanation before any request", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const before = stub.requests.length;
  await page.getByTestId("explain-sharing-off").click();
  await expect(page.getByTestId("explain-sharing")).toHaveCount(0);
  await page.getByTestId("explain-start").click();
  // Mantine puts the test id on a wrapper with no size: the dialog's button is what shows it is open.
  await expect(page.getByTestId("explain-consent-allow")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("explain-consent-allow")).toHaveCount(0);
  expect(stub.requests.length).toBe(before);
});

test("a conflict shows what the code does now, what governs this task and why, and stops quoting a preference once it is edited (D23)", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const statement = "Name component files in PascalCase";
  const choice = "Keep kebab-case for this task";
  await page.getByTestId("preference-scope").getByText("Every project", { exact: true }).click();
  await page.getByTestId("preference-input").fill(statement);
  await page.getByTestId("preference-confirm").click();
  await expect(page.getByTestId("preference-list")).toContainText(statement);
  const id = await page.getByTestId("preference-row").filter({ hasText: statement }).getAttribute("data-preference-id");
  const conflict = { topic: "component file names", repositoryConvention: "Component files use kebab-case.", citations: [{ path: "README.md", startLine: 2, endLine: 2 }], preferenceIds: [id], choiceIds: ["c1"] };
  more = (request) => (request.raw.includes('"role":"tool"') ? toolCall("submit_answer", { ...ANSWER, conflicts: [conflict] }, { id: "d1" }) : toolCall("read_file", { path: "README.md" }, { id: "d0" }));

  await page.getByTestId("explain-choice-add").click();
  await page.getByTestId("explain-choice").fill(choice);
  // The previous test turned sharing off, so consent is asked for again.
  await page.getByTestId("explain-start").click();
  await page.getByTestId("explain-consent-allow").click();
  await expect(page.getByTestId("explain-result-choices")).toHaveText(`Choices for this task: c1 “${choice}”`);
  const shown = page.getByTestId("explain-conflict");
  await expect(shown).toHaveAttribute("data-reason", "choice");
  await expect(shown.getByTestId("explain-conflict-currently")).toHaveText("Currently: Component files use kebab-case.");
  await expect(shown.getByTestId("explain-conflict-intended")).toHaveText(`Intended: c1: “${choice}”`);
  await expect(shown.getByTestId("explain-conflict-governs")).toHaveText("Governs this task: this task's choice. Choices for this task come first.");
  await expect(shown.getByTestId("explain-conflict-others")).toContainText(`your personal default “${statement}”`);
  await expect(shown.getByTestId("explain-conflict-others")).toContainText("the repository's convention Component files use kebab-case.");

  const row = page.locator(`[data-testid="preference-row"][data-preference-id="${id}"]`);
  await row.getByTestId("preference-edit").click();
  await row.getByTestId("preference-edit-input").fill(`${statement}, always`);
  await row.getByTestId("preference-save").click();
  await expect(shown.getByTestId("explain-conflict-others")).toContainText("changed or was deleted since this run");
  await expect(shown).not.toContainText(`${statement}, always`);

  // Replaced, it is named as replaced, with what replaced it, and never shown as current (D23).
  await row.getByTestId("preference-replace").click();
  await row.getByTestId("preference-edit-input").fill("Name component files in camelCase");
  await row.getByTestId("preference-replace-save").click();
  await expect(shown.getByTestId("explain-conflict-others")).toContainText("replaced since this run by “Name component files in camelCase”");
});

test("a suggestion can be kept, in the person's own wording, as the project's own default (D23)", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const suggestion = { statement: "Name component files in kebab-case", citations: [{ path: "README.md", startLine: 2, endLine: 2 }] };
  more = (request) => (request.raw.includes('"role":"tool"') ? toolCall("submit_answer", { ...ANSWER, suggestions: [suggestion] }, { id: "k1" }) : toolCall("read_file", { path: "README.md" }, { id: "k0" }));
  while (await page.getByTestId("explain-choice-remove").count()) await page.getByTestId("explain-choice-remove").first().click();
  await page.getByTestId("explain-start").click();
  const item = page.getByTestId("explain-suggestion");
  await expect(item).toContainText(suggestion.statement);
  await expect(item.getByTestId("explain-citation")).toHaveAttribute("data-checked", "yes");

  const kept = "Name component files in kebab-case, like start-timer.tsx";
  await item.getByTestId("explain-suggestion-keep").click();
  await item.getByTestId("explain-suggestion-input").fill(kept);
  await item.getByTestId("explain-suggestion-confirm").click();
  await expect(item.getByTestId("explain-suggestion-kept")).toHaveText(`Kept as this project's own default: “${kept}”.`);
  const row = page.getByTestId("preference-row").filter({ hasText: kept });
  await expect(row.getByTestId("preference-intent")).toHaveText("Default");
  await expect(row.getByTestId("preference-revision")).toContainText("kept from a suggestion");
});

test("an answer with no findings is asked for them once, then shown labelled, never as an explanation with evidence (NIV-26)", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const before = stub.chats().length;
  more = (request) => (request.raw.includes('"role":"tool"') ? toolCall("submit_answer", { ...ANSWER, findings: [] }, { id: "n1" }) : toolCall("read_file", { path: "README.md" }, { id: "n0" }));
  while (await page.getByTestId("explain-choice-remove").count()) await page.getByTestId("explain-choice-remove").first().click();
  await page.getByTestId("explain-start").click();
  await expect(page.getByTestId("explain-standing")).toHaveAttribute("data-standing", "no-findings");
  await expect(page.getByTestId("explain-standing")).toContainText("No findings established.");
  await expect(page.getByTestId("explain-status")).toHaveText("no findings");
  await expect(page.getByTestId("explain-finding")).toHaveCount(0);
  await expect(page.getByTestId("explain-timeline")).toContainText("submit_answer refused: no findings");
  await page.getByTestId("explain-context").click();
  await expect(page.getByTestId("explain-context-answer")).toContainText("0 for its shape, 1 for having no findings.");
  await expect(page.getByTestId("explain-context-answer")).toContainText("Answers turned down took 1 model step");
  // A read, the answer turned down, the answer taken: no request beyond the one repair.
  expect(stub.chats().length - before).toBe(3);
});

test("a packaged app ignores the test endpoint switch, and explaining without a key fails before any request", async () => {
  test.skip(!packaged, "only a packaged app ignores the switch");
  await page.getByTestId("doctor-run").click();
  await expect(page.getByTestId("doctor-report")).toContainText("Nebius Token Factory");
  await page.getByTestId("explain-start").click();
  await page.getByTestId("explain-consent-allow").click();
  await expect(page.getByTestId("explain-status")).toHaveText("failed");
  await expect(page.getByTestId("explain-failure")).toContainText("No Nebius key is set");
  expect(stub.requests.length).toBe(0);
});
