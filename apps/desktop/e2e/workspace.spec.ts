import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { goTo, openSwitcher } from "./places.ts";
import { startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";

/**
 * The planning workspace through the window (D26, NIV-30, NIV-31): conversations, general or about one project, whose
 * turns are followed to their end and never resent, through cancels, a killed engine and relaunches. The built app
 * reaches a loopback stub of Token Factory, so no real model is called. A packaged app ignores that switch, so the tests
 * that need a model are skipped there, and no key is ever set in it.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";

// Each test builds on the one before (one profile, one key, the same conversations). Playwright starts a failed test's
// successors in a fresh worker, with a fresh profile, so they would fail for the wrong reason: they are skipped instead.
test.describe.configure({ mode: "serial" });

let root: string;
let stub: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;

/** A test sets this to hold the answers that arrive while it is set. */
let hold: Promise<void> | null = null;
let generalAnswers = 0;
const REPLY = {
  answer: "Add the export beside the list.",
  evidence: [{ statement: "The README names the project.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }],
  proposals: [{ title: "A CSV export", detail: "An export button that writes the list as CSV.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }],
  assumptions: ["The list fits in memory"],
};

/** General turns are answered with text; repository turns read the README, then reply with evidence. */
async function answer(request: StubRequest, index: number): Promise<Reply> {
  if (hold) await hold;
  if (!request.body?.tools) return text(`General answer ${++generalAnswers}.`);
  return request.raw.includes('"role":"tool"') ? toolCall("submit_reply", REPLY, { id: `r${index}` }) : toolCall("read_file", { path: "README.md" }, { id: `q${index}` });
}

function makeRepo(path: string, readme: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), readme);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

async function launch(testInfo: TestInfo) {
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-token-factory-url=${stub.url}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
}

async function addProject(path: string) {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
}

/** Starts a conversation and waits for it, not the one shown before, whose composer would otherwise take the typing. */
async function newChat(scope: "general" | string) {
  const shown = page.getByTestId("conversation");
  const before = (await shown.count()) ? await shown.getAttribute("data-conversation-id") : null;
  if (!(await page.getByTestId("new-chat").isVisible())) await goTo(page, "conversations");
  await page.getByTestId("new-chat").click();
  if (scope === "general") await page.getByTestId("new-chat-general").click();
  else await page.getByTestId("new-chat-project").filter({ hasText: scope }).click();
  await expect(shown).toBeVisible();
  if (before) await expect(shown).not.toHaveAttribute("data-conversation-id", before);
  await expect(page.getByTestId("conversation-empty")).toBeVisible();
}

/** Opens a conversation from the list and waits until it is the one shown. */
async function openConversation(title: string) {
  await goTo(page, "conversations");
  await page.getByTestId("nav-conversation").filter({ hasText: title }).click();
  await expect(page.getByTestId("conversation-title")).toHaveText(title);
}

async function send(message: string) {
  await page.getByTestId("composer").fill(message);
  await page.getByTestId("composer-send").click();
}

const chats = () => stub.chats().length;

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e workspace ü%# "));
  makeRepo(join(root, "alpha"), "# Alpha\nA list of things.\n");
  makeRepo(join(root, "beta"), "# Beta\nAnother list.\n");
  stub = await startStub({ chat: answer });
  await launch(testInfo);
  await addProject(join(root, "alpha"));
  await expect(page.getByTestId("project-select")).toHaveValue("alpha");
  await addProject(join(root, "beta"));
  await expect(page.getByTestId("project-select")).toHaveValue("beta");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await stub?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("with no key, a turn fails before any request and says so; the conversation keeps its fixed scope", async () => {
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  await page.getByTestId("nav-planning").click();
  await expect(page.getByTestId("page-projects")).toBeHidden();
  await newChat("general");
  await expect(page.getByTestId("conversation-scope")).toHaveText("General · no repository access");
  await send("No key yet?");
  await expect(page.getByTestId("turn-status")).toHaveText("Failed");
  await expect(page.getByTestId("turn-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  await expect(page.getByTestId("turn-send-again")).toBeEnabled();
  await expect(page.getByTestId("nav-conversation").filter({ hasText: "No key yet?" })).toHaveCount(1);
  expect(chats()).toBe(0);
});

test("a general chat answers, carries the exchange into a follow-up, and shows what each answer was given", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.evaluate((key) => window.nivra.setNebiusKey(key), KEY);
  await newChat("general");
  await send("How should I stage this?");
  await expect(page.getByTestId("answer-text")).toHaveText("General answer 1.");
  await expect(page.getByTestId("conversation-title")).toHaveText("How should I stage this?");
  await expect(page.getByTestId("conversation-engine-state")).toHaveText("Engine online");
  await send("And then?");
  await expect(page.getByTestId("answer-text")).toHaveText(["General answer 1.", "General answer 2."]);
  const second = page.getByTestId("answer").nth(1);
  await second.getByTestId("answer-details").click();
  await expect(second.getByTestId("answer-context-preferences")).toHaveText("Preferences received: none (store revision 0)");
  await expect(second.getByTestId("answer-history-sent")).toHaveText(/^Sent: 1 earlier exchange, \d+ characters \(fingerprint [0-9a-f]{12}\)\.$/);
  await expect(second.getByTestId("answer-history-left-out")).toHaveText("Left out: nothing.");
  await expect(second.getByTestId("answer-run-line")).toContainText("(test endpoint)");
  expect(stub.chats().map((request) => request.body?.tools)).toEqual([undefined, undefined]);
});

test("a repository chat asks for its project's consent first, then answers in its parts with checked citations", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await newChat("alpha");
  await expect(page.getByTestId("conversation-scope")).toHaveText(/^alpha · .+ · sharing off$/);
  const before = chats();
  await send("Plan a CSV export");
  // Mantine puts the test id on a wrapper with no size: the dialog's button is what shows it is open.
  await expect(page.getByTestId("conversation-consent-allow")).toBeVisible();
  await expect(page.getByText("your message, and the conversation so far;")).toBeVisible();
  expect(chats()).toBe(before);
  await page.getByTestId("conversation-consent-allow").click();
  await expect(page.getByTestId("answer-repository")).toBeVisible();
  await expect(page.getByTestId("conversation-scope")).toHaveText(/ · sharing on$/);
  await expect(page.getByTestId("answer-evidence-item")).toContainText("The README names the project.");
  await expect(page.getByTestId("answer-proposals")).toContainText("Proposed, not verified");
  await expect(page.getByTestId("answer-assumptions")).toContainText("The list fits in memory");
  await expect(page.getByTestId("answer-citation").and(page.locator("[data-checked=yes]"))).toHaveCount(2);
  await expect(page.getByTestId("answer-head")).toContainText("2 of 2 citations point to lines the model was shown");
  await page.getByTestId("answer-details").click();
  await expect(page.getByTestId("answer-context-details")).toContainText("Read: README.md 1-2");
  expect(chats() - before).toBe(2);
});

test("choosing another project in the switcher changes neither an open conversation's scope nor the repository its next turn reads", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await goTo(page, "home");
  // Choose alpha, the conversation's own, then beta.
  for (const label of ["alpha", "beta"]) {
    await page.getByTestId("project-select").click();
    await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByTestId("project-select")).toHaveValue(label);
  }
  await openConversation("Plan a CSV export");
  await expect(page.getByTestId("conversation-scope")).toHaveText(/^alpha · /);
  const before = chats();
  await send("And how would we test it?");
  await expect(page.getByTestId("answer-repository")).toHaveCount(2);
  const sent = stub.chats().slice(before).map((request) => request.raw).join("\n");
  expect([sent.includes("# Alpha"), sent.includes("# Beta")]).toEqual([true, false]);
  // The follow-up carried the first exchange.
  const second = page.getByTestId("answer").nth(1);
  await second.getByTestId("answer-details").click();
  await expect(second.getByTestId("answer-history-sent")).toContainText("Sent: 1 earlier exchange");
});

test("a turn can be cancelled while its answer is held, and sending it again makes a new turn that is answered", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  await newChat("general");
  const before = chats();
  await send("Hold this one.");
  await expect(page.getByTestId("turn-status")).toHaveText("Answering");
  await expect.poll(chats).toBe(before + 1);
  // One turn at a time: another message waits until this one ends.
  await page.getByTestId("composer").fill("And another?");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await page.getByTestId("composer").fill("");
  await page.getByTestId("turn-cancel").click();
  await expect(page.getByTestId("turn-status")).toHaveText("Cancelled");
  await expect(page.getByTestId("turn-note")).toHaveText("Cancelled. Nothing was resent.");
  hold = null;
  release();
  await page.getByTestId("turn-send-again").click();
  await expect(page.getByTestId("turn")).toHaveCount(2);
  await expect(page.getByTestId("answer-text")).toHaveText(/^General answer \d+\.$/);
  expect(chats()).toBe(before + 2);
});

test("a turn whose engine is killed waits, unresolved; after Restart it is interrupted, nothing is resent, and Send again is answered", async () => {
  test.skip(packaged || process.platform === "win32", "needs the test endpoint switch, and a signal to kill the engine with");
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  await newChat("general");
  const before = chats();
  await send("Slow?");
  await expect(page.getByTestId("turn-status")).toHaveText("Answering");
  await expect.poll(chats).toBe(before + 1);
  const pid = await page.evaluate(async () => {
    const local = (await window.nivra.listEngines()).find((engine) => engine.targetId === "local");
    return local?.state.status === "online" ? local.state.info.pid : null;
  });
  expect(pid).not.toBeNull();
  process.kill(pid!, "SIGKILL");
  await expect(page.getByTestId("conversation-engine-restart")).toBeVisible();
  await expect(page.getByTestId("turn-status")).toHaveText("Answering");
  await expect(page.getByTestId("turn-unresolved")).toBeVisible();
  await page.getByTestId("conversation-engine-restart").click();
  await expect(page.getByTestId("turn-status")).toHaveText("Interrupted");
  await expect(page.getByTestId("turn-note")).toHaveText("Interrupted: Nivra or its engine stopped before the answer arrived. Nothing was resent.");
  hold = null;
  release();
  expect(chats()).toBe(before + 1);
  await page.getByTestId("turn-send-again").click();
  await expect(page.getByTestId("answer-text")).toHaveText(/^General answer \d+\.$/);
  expect(chats()).toBe(before + 2);
});

test("conversations are kept across a relaunch, nothing is sent on reopening, and a repository chat goes on", async ({}, testInfo) => {
  await goTo(page, "conversations");
  const count = await page.getByTestId("nav-conversation").count();
  const before = chats();
  await app.close();
  await launch(testInfo);
  await goTo(page, "conversations");
  await expect(page.getByTestId("nav-conversation")).toHaveCount(count);
  await openConversation("No key yet?");
  await expect(page.getByTestId("turn-status")).toHaveText("Failed");
  if (packaged) return;
  await openConversation("Plan a CSV export");
  await expect(page.getByTestId("answer-repository")).toHaveCount(2);
  expect(chats()).toBe(before);
  await send("What should the first commit hold?");
  await expect(page.getByTestId("answer-repository")).toHaveCount(3);
  const third = page.getByTestId("answer").nth(2);
  await third.getByTestId("answer-details").click();
  await expect(third.getByTestId("answer-history-sent")).toContainText("Sent: 2 earlier exchanges");
});

test("deleting a conversation asks first, says what stays, and takes it out of the list", async () => {
  const listed = page.getByTestId("nav-conversation").filter({ hasText: "No key yet?" });
  await openConversation("No key yet?");
  await page.getByTestId("conversation-delete").click();
  await expect(page.getByTestId("conversation-delete-confirm")).toBeVisible();
  await expect(page.getByText("each engine keeps its own record of these runs, your messages and the reviews' reports included")).toBeVisible();
  await page.getByTestId("conversation-delete-confirm").click();
  await expect(listed).toHaveCount(0);
  await expect(page.getByTestId("planning-new-general")).toBeVisible();
});

const BRIEF_FIELDS = ["goal", "criteria", "scope", "exclusions", "context", "assumptions", "checks"].map((field) => `task-brief-${field}`);

async function openTask(title: string) {
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("task-open").filter({ hasText: title }).click();
  await expect(page.getByTestId("task-title")).toHaveText(title);
}

test("a plan saved from an answer, as shown first, becomes a task's brief v1, which stays until the plan's v2 is taken in", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await openConversation("Plan a CSV export");
  const first = page.getByTestId("answer").first();
  await first.getByTestId("answer-save-plan").click();
  await expect(first.getByTestId("plan-input")).toHaveValue(
    "Add the export beside the list.\n\nProposed:\n- A CSV export: An export button that writes the list as CSV.\n\nAssumed:\n- The list fits in memory",
  );
  await first.getByTestId("plan-save").click();
  await expect(first.getByTestId("plan-version")).toHaveText("Plan · v1");
  await first.getByTestId("plan-create-task").click();
  // The form starts with the plan's text, its assumptions and its repository; another repository would take none of it.
  await expect(page.getByTestId("task-form-title")).toHaveValue("Plan a CSV export");
  await expect(page.getByTestId("brief-context")).toHaveValue(/^Add the export beside the list\./);
  await expect(page.getByTestId("brief-assumptions")).toHaveValue("The list fits in memory");
  await expect(page.getByTestId("task-form-repository")).toHaveValue(/^alpha · /);
  await expect(page.getByTestId("task-form-leaves-plan")).toHaveCount(0);
  for (const [label, warned] of [["beta", 1], ["No repository yet", 1], ["alpha", 0]] as const) {
    await page.getByTestId("task-form-repository").click();
    await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByTestId("task-form-leaves-plan")).toHaveCount(warned);
  }
  await page.getByTestId("brief-goal").fill("Export the list as CSV");
  await page.getByTestId("brief-criteria").fill("The export opens in a spreadsheet");
  await page.getByTestId("task-form-create").click();
  await expect(page.getByTestId("task-title")).toHaveText("Plan a CSV export");
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v1");
  await expect(page.getByTestId("task-plan-source")).toContainText("From plan v1");
  await expect(page.getByTestId("task-repository")).toHaveText("alpha");
  // The plan moves on in its conversation.
  await page.getByTestId("task-open-conversation").click();
  await expect(page.getByTestId("conversation-title")).toHaveText("Plan a CSV export");
  await page.getByTestId("answer").first().getByTestId("plan-edit").click();
  await page.getByTestId("answer").first().getByTestId("plan-input").fill("Export as CSV first, then add filters.");
  await page.getByTestId("answer").first().getByTestId("plan-save").click();
  await expect(page.getByTestId("answer").first().getByTestId("plan-version")).toHaveText("Plan · v2");
  await page.getByTestId("answer").first().getByTestId("plan-earlier-toggle").click();
  await expect(page.getByTestId("answer").first().getByTestId("plan-earlier")).toContainText("Add the export beside the list.");
  // The task says so, and keeps brief v1 until the change is taken in.
  await openTask("Plan a CSV export");
  await expect(page.getByTestId("task-plan-changed")).toContainText("this brief uses v1, and v2 is the latest");
  await expect(page.getByTestId("task-brief-context")).toContainText("Add the export beside the list.");
  await page.getByTestId("task-update-from-plan").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await expect(page.getByTestId("task-brief-context")).toHaveText(/Export as CSV first, then add filters\.$/);
  await expect(page.getByTestId("task-plan-changed")).toHaveCount(0);
});

test("a task written directly has the same brief; its states follow the rules, a stale view is read again, and Run says why it can't", async () => {
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("tasks-new").click();
  await expect(page.getByTestId("task-form-repository")).toHaveValue("No repository yet");
  await page.getByTestId("task-form-title").fill("Tidy the README");
  await page.getByTestId("task-form-create").click();
  await expect(page.getByTestId("task-title")).toHaveText("Tidy the README");
  for (const field of BRIEF_FIELDS) await expect(page.getByTestId(field)).toBeVisible();
  await expect(page.getByTestId("task-state")).toHaveText("Draft");
  // The key and project ID, asked for where readiness needs them (NIV-56, G3): Esc with something typed asks first, and
  // closing without saving keeps nothing anywhere.
  const before = await page.evaluate(() => window.nivra.getSettings());
  await expect(page.locator('[data-testid="task-readiness-row"][data-row="keys"]')).toBeVisible();
  await page.getByTestId("task-readiness-add-keys").click();
  await expect(page.getByTestId("key-prompt-key")).toBeFocused();
  await page.getByTestId("key-prompt-key").fill("typed, never saved");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("key-prompt-leaving")).toBeVisible();
  await page.getByTestId("key-prompt-discard").click();
  await expect(page.getByTestId("key-prompt-key")).toBeHidden();
  const after = await page.evaluate(() => window.nivra.getSettings());
  expect([after.nebiusKey, after.nebiusProjectId]).toEqual([before.nebiusKey, before.nebiusProjectId]);
  // The aside's tabs move with the arrow keys.
  await page.getByTestId("task-tab-brief").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("task-tab-coach")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("task-coach-back")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("task-tab-brief")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-error")).toHaveText("A task is ready once its brief has a goal and at least one acceptance criterion. Add them, then mark it ready.");
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-goal").fill("Tidy it");
  await page.getByTestId("brief-criteria").fill("Every heading is sentence case\n\n");
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await expect(page.getByTestId("task-brief-criteria")).toHaveText(/Every heading is sentence case$/);
  // Changed behind this view: the next change is refused, and the view reads the task again.
  const id = await page.getByTestId("task").getAttribute("data-task-id");
  await page.evaluate(async (taskId) => {
    const task = await window.nivra.getTask(taskId!);
    await window.nivra.renameTask(taskId!, task.revision, "Tidy the README files");
  }, id);
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-error")).toHaveText("This task changed since you opened it. Open it again, then try again.");
  await expect(page.getByTestId("task-title")).toHaveText("Tidy the README files");
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");
  await page.getByTestId("task-complete").click();
  await expect(page.getByTestId("task-state")).toHaveText("Completed");
  await expect(page.getByTestId("task-edit-brief")).toBeDisabled();
  await page.getByTestId("task-reopen").click();
  await expect(page.getByTestId("task-state")).toHaveText("Draft");
  await expect(page.getByTestId("task-attempt")).toHaveCount(0);
  await expect(page.getByTestId("task-run")).toBeDisabled();
  await expect(page.getByTestId("task-run-blocked")).toHaveText("Mark the task ready first: a run needs a goal and at least one acceptance criterion.");
  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("task-row").filter({ hasText: "Tidy the README files" })).toContainText("No repository yet");
});

test("deleting the conversation a plan came from keeps the task's brief, and moving the task to another repository clears what came from it", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await openConversation("Plan a CSV export");
  await page.getByTestId("conversation-delete").click();
  await page.getByTestId("conversation-delete-confirm").click();
  await expect(page.getByTestId("nav-conversation").filter({ hasText: "Plan a CSV export" })).toHaveCount(0);
  await openTask("Plan a CSV export");
  await expect(page.getByTestId("task-plan-gone")).toBeVisible();
  await expect(page.getByTestId("task-brief-context")).toHaveText(/Export as CSV first, then add filters\.$/);
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-move").click();
  await page.getByTestId("task-move-repository").click();
  await page.getByRole("option", { name: /^beta/ }).click();
  await expect(page.getByTestId("task-move-clears")).toBeVisible();
  await page.getByTestId("task-move-save").click();
  await expect(page.getByTestId("task-repository")).toHaveText("beta");
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v3");
  await expect(page.getByTestId("task-revalidate")).toContainText("To write again for this repository: the context and the assumptions.");
  await expect(page.getByTestId("task-brief-context")).toHaveText(/None yet$/);
  await expect(page.getByTestId("task-brief-goal")).toHaveText(/Export the list as CSV$/);
});
