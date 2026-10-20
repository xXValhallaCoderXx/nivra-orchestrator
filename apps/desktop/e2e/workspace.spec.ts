import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
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
  await page.getByTestId("project-add").click();
}

async function newChat(scope: "general" | string) {
  await page.getByTestId("new-chat").click();
  if (scope === "general") await page.getByTestId("new-chat-general").click();
  else await page.getByTestId("new-chat-project").filter({ hasText: scope }).click();
  await expect(page.getByTestId("conversation")).toBeVisible();
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

test("choosing another project on Projects & settings changes neither an open conversation's scope nor the repository its next turn reads", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const conversation = page.getByTestId("nav-conversation").filter({ hasText: "Plan a CSV export" });
  await page.getByTestId("nav-projects").click();
  // Choosing the project already chosen would clear the choice: choose alpha, the conversation's own, then beta.
  for (const label of ["alpha", "beta"]) {
    await page.getByTestId("project-select").click();
    await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByTestId("project-select")).toHaveValue(label);
  }
  await conversation.click();
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
  const count = await page.getByTestId("nav-conversation").count();
  const before = chats();
  await app.close();
  await launch(testInfo);
  await expect(page.getByTestId("nav-conversation")).toHaveCount(count);
  await page.getByTestId("nav-conversation").filter({ hasText: "No key yet?" }).click();
  await expect(page.getByTestId("turn-status")).toHaveText("Failed");
  if (packaged) return;
  await page.getByTestId("nav-conversation").filter({ hasText: "Plan a CSV export" }).click();
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
  await listed.click();
  await page.getByTestId("conversation-delete").click();
  await expect(page.getByTestId("conversation-delete-confirm")).toBeVisible();
  await expect(page.getByText("each engine keeps its own record of these runs, your messages included")).toBeVisible();
  await page.getByTestId("conversation-delete-confirm").click();
  await expect(listed).toHaveCount(0);
  await expect(page.getByTestId("planning-new-general")).toBeVisible();
});
