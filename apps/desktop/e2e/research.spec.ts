import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyCall, type TavilyStub } from "../../engine/test/stub-tavily.ts";
import { startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";
import { RESEARCH_RETENTION } from "../src/shared/research.ts";
import { seedPlan } from "./seed-workspace.ts";

/**
 * Research of saved plan versions' assumptions through the window (D37): the permission and the key, a preview of
 * exactly what goes to Tavily and to the model, bound to what starts; loopback stand-ins for Tavily and Token Factory,
 * so nothing reaches the network and no real model is called; the card keeping the model's conclusion, the quotations
 * found, the quotations not found and the assessments that couldn't be used apart; cancelling, an amended version saved
 * once, a relaunch and a deletion; and the dialog's own rules. A packaged app ignores the stand-in switches, so there
 * only a seeded plan's preview with no key and the permission, and a relaunch, run.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const TAVILY = `tvly-dev-e2e-research-${"t".repeat(16)}`;
const SEEDED = { question: "Can we move the build image to Python 3.12?", plan: "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils." };
const ASSUMPTION = "distutils is still in Python 3.12's standard library.";
const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
const REMOVED = "The distutils package has been removed from the standard library.";

// Each test builds on the one before (one profile, the same keys and conversations): see workspace.spec.ts.
test.describe.configure({ mode: "serial" });

let root: string;
let model: Stub;
let tavily: TavilyStub;
let app: ElectronApplication;
let page: Page;
let packaged = false;

/**
 * The model's assessment, scripted to show all four things the card keeps apart: A1 contradicted with one quotation
 * found and one not; A2 matched with no outcome Nivra recognises; and an assessment naming an assumption that wasn't
 * asked about.
 */
const ASSESSED = {
  assessments: [
    {
      assumption: "A1",
      outcome: "contradicted",
      reasoning: "The 3.12 release notes say distutils was removed.",
      citations: [
        { passage: "S1.1", stance: "contradicts", quote: "has been removed from the standard library" },
        { passage: "S1.1", stance: "contradicts", quote: "distutils stays in the standard library for good" },
      ],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
      uncertainty: "",
      amendment: "Install setuptools in the 3.12 image before switching.",
    },
    { assumption: "A2", outcome: "likely", reasoning: "Probably fine.", citations: [], applicability: { plan: "", source: "", where: "unknown" }, uncertainty: "", amendment: "" },
    { assumption: "A9", outcome: "supported", reasoning: "About something else.", citations: [], applicability: { plan: "", source: "", where: "unknown" }, uncertainty: "", amendment: "" },
  ],
};
const REPLY = {
  answer: "Pin setuptools, then move the image to 3.12.",
  evidence: [{ statement: "The README names the image.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }],
  assumptions: ["Deploys are rolling."],
};
const isResearch = (request: StubRequest) => JSON.stringify(request.body?.tools ?? []).includes("submit_research");
/** Research gets the scripted assessment; general turns text; repository turns read the README, then reply. */
function answer(request: StubRequest, index: number): Reply {
  if (isResearch(request)) return toolCall("submit_research", ASSESSED);
  if (!request.body?.tools) return text(SEEDED.plan);
  return request.raw.includes('"role":"tool"') ? toolCall("submit_reply", REPLY, { id: `r${index}` }) : toolCall("read_file", { path: "README.md" }, { id: `q${index}` });
}
/** A test sets this to hold Tavily's searches that arrive while it is set. */
let hold: Promise<void> | null = null;
async function search(call: TavilyCall) {
  if (call.path === "/search") {
    if (hold) await hold;
    return { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }]) };
  }
  if (call.path === "/extract") return { body: extractAnswer([{ url: WHATSNEW, chunks: [`## Removed\n${REMOVED}`] }]) };
  return { status: 404, body: {} };
}
const researchRequests = () => model.chats().filter(isResearch);
const searches = () => tavily.calls.filter((call) => call.path === "/search");

function makeRepo(path: string, readme: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), readme);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

async function launch(testInfo: TestInfo, extra: string[] = []) {
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-token-factory-url=${model.url}`, `--nivra-tavily-url=${tavily.url}`, ...extra];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
}

async function openConversation(title: string) {
  await page.getByTestId("nav-planning").click();
  await page.getByTestId("nav-conversation").filter({ hasText: title }).click();
  await expect(page.getByTestId("conversation-title")).toHaveText(title);
}

/** Starts a conversation and waits for it, not the one shown before, whose composer would otherwise take the typing. */
async function newChat(scope: "general" | string) {
  const shown = page.getByTestId("conversation");
  const before = (await shown.count()) ? await shown.getAttribute("data-conversation-id") : null;
  await page.getByTestId("new-chat").click();
  if (scope === "general") await page.getByTestId("new-chat-general").click();
  else await page.getByTestId("new-chat-project").filter({ hasText: scope }).click();
  await expect(shown).toBeVisible();
  if (before) await expect(shown).not.toHaveAttribute("data-conversation-id", before);
}

/** A general conversation with a plan saved from its answer. */
async function generalPlan() {
  await newChat("general");
  await page.getByTestId("composer").fill("Can we move to 3.12?");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("answer-text")).toHaveText(SEEDED.plan);
  await page.getByTestId("answer-save-plan").click();
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v1");
}

/**
 * Opens the research dialog and adds the typed assumptions, each with its query (a general plan's starts as its words).
 */
async function pick(assumptions: Array<{ text: string; query?: string }>) {
  await page.getByTestId("plan-research-open").click();
  await expect(page.getByTestId("research-type")).toBeVisible();
  for (const assumption of assumptions) {
    await page.getByTestId("research-type").fill(assumption.text);
    await page.getByTestId("research-add").click();
    if (assumption.query !== undefined) await page.getByTestId("research-query").last().fill(assumption.query);
  }
}

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e research ü%# "));
  makeRepo(join(root, "alpha"), "# Alpha\nThe build image.\n");
  // A plan to research where nothing can be reached, put there through the workspace's own functions.
  mkdirSync(join(root, "user data"), { recursive: true });
  seedPlan(join(root, "user data", "workspace.db"), SEEDED);
  model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: answer });
  tavily = await startTavilyStub(search);
  await launch(testInfo);
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, join(root, "alpha"));
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue("alpha");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await model?.close();
  await tavily?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("with research off and no Tavily key, a seeded plan's preview says what keeps research from starting, asks for the permission in words, and sends nothing", async () => {
  const settings = await page.evaluate(() => window.nivra.getSettings());
  expect([settings.tavilyKey, settings.webResearch]).toEqual(["none", false]);
  await openConversation(SEEDED.question);
  await pick([{ text: ASSUMPTION }]);
  // A general plan's query starts as the assumption's own words.
  await expect(page.getByTestId("research-query")).toHaveValue(ASSUMPTION);
  await page.getByTestId("research-preview-button").click();
  await expect(page.getByTestId("research-preview-queries")).toContainText(ASSUMPTION);
  await expect(page.getByTestId("research-preview-not-sent")).toHaveText("Not sent: the repository's files, this conversation, other plans or versions, your preferences and your tasks.");
  await expect(page.getByTestId("research-blocked")).toContainText("Research queries to Tavily are turned off. Turn them on, then start again.");
  await expect(page.getByTestId("research-start")).toBeDisabled();
  await page.getByTestId("research-allow-web").click();
  await expect(page.getByTestId("research-permission")).toContainText(RESEARCH_RETENTION);
  await expect(page.getByTestId("research-permission")).toContainText("Never the plan's text, your repositories, their paths, your preferences or your conversations.");
  await page.getByTestId("research-permission-allow").click();
  await expect(page.getByTestId("research-blocked")).toContainText("Nivra has no Tavily API key. Add one in Settings, then start again.");
  await expect(page.getByTestId("research-start")).toBeDisabled();
  await page.getByTestId("research-dialog-cancel").click();
  expect((await page.evaluate(() => window.nivra.getSettings())).webResearch).toBe(true);
  if (!packaged) expect([tavily.calls.length, researchRequests().length]).toEqual([0, 0]);
});

test("research of a general plan keeps the model's conclusion, the quotations found, the quotations not found and the assessments that couldn't be used apart, and holds the conversation while it runs", async () => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  await page.evaluate((key) => window.nivra.setNebiusKey(key), KEY);
  await page.evaluate((key) => window.nivra.setTavilyKey(key), TAVILY);
  await generalPlan();
  await pick([{ text: ASSUMPTION, query: "Python 3.12 distutils standard library" }, { text: "f-strings can reuse the enclosing quotes in 3.12." }]);
  await page.getByTestId("research-preview-button").click();
  await expect(page.getByTestId("research-preview-query")).toHaveCount(2);
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  await page.getByTestId("research-start").click();
  await expect(page.getByTestId("research-type")).toBeHidden();
  const card = page.getByTestId("research").first();
  await expect.poll(() => searches().length).toBeGreaterThan(0);
  await expect(page.getByTestId("composer-research-running")).toBeVisible();
  await page.getByTestId("composer").fill("Meanwhile?");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByTestId("plan-review")).toBeDisabled();
  hold = null;
  release();
  await expect(card.getByTestId("research-status")).toHaveText("Complete");
  const a1 = card.locator('[data-testid="research-assessment"][data-assumption="A1"]');
  await expect(a1.getByTestId("research-model")).toHaveText("Contradicted");
  // Shown as the model gave it, so Nivra's own label isn't repeated.
  await expect(a1.getByTestId("research-shown")).toHaveCount(0);
  await expect(a1.getByTestId("research-found").getByTestId("research-evidence")).toHaveCount(1);
  await expect(a1.getByTestId("research-found").getByTestId("research-quote")).toHaveText("“has been removed from the standard library”");
  await expect(a1.getByTestId("research-found").getByTestId("research-address")).toHaveText(WHATSNEW);
  await expect(a1.getByTestId("research-not-found").getByTestId("research-rejected")).toHaveText("“distutils stays in the standard library for good” (S1.1): isn't in the passage it names.");
  const a2 = card.locator('[data-testid="research-assessment"][data-assumption="A2"]');
  await expect(a2.getByTestId("research-model")).toHaveText("No assessment");
  await expect(a2.getByTestId("research-shown")).toHaveText("Unresolved");
  await expect(a2.getByTestId("research-rule")).toHaveText("The model gave no usable assessment of this assumption.");
  await expect(card.getByTestId("research-unusable-item")).toHaveText([
    "“A9” named no assumption that was asked about, so it was set aside.",
    "A2's assessment gave “likely”, not supported, contradicted or unresolved, so it can't be used.",
  ]);
  await expect(card.getByTestId("research-caveat").first()).toHaveText("Nivra checked that each quotation is in the page it names. Whether it supports the conclusion is for you to judge.");
  await expect(card.getByTestId("research-not-approval")).toHaveText("Research doesn't change the plan, mark a task ready, or approve anything.");
  // Tavily got the approved queries, and never the plan or a key; the model got one request.
  const sent = tavily.calls.map((call) => call.raw).join("\n");
  expect([sent.includes("Python 3.12 distutils standard library"), sent.includes(SEEDED.plan), sent.includes(KEY), researchRequests().length]).toEqual([true, false, false, 1]);
});

test("an amended version is saved from the research once; a second save is refused and saves nothing", async () => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  const card = page.getByTestId("research").first();
  await card.getByTestId("research-amend").click();
  await expect(page.getByTestId("research-amend-text")).toBeVisible();
  await page.getByTestId("research-amend-choice").first().check();
  await expect(page.getByTestId("research-amend-text")).toHaveValue(/Install setuptools in the 3\.12 image before switching\./);
  await page.getByTestId("research-amend-save").click();
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v2");
  await expect(card.getByTestId("research-amended")).toHaveText("Saved as v2 from this research.");
  const researchId = await card.getAttribute("data-research-id");
  const refused = await page.evaluate((id) => window.nivra.saveAmendedPlan(id!, "Another amended plan.", []).then(() => "saved", (error: unknown) => String(error)), researchId);
  expect(refused).toContain("A version amended from this research was saved already, so nothing new was saved.");
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v2");
});

test("cancelling research keeps what it saved, sends nothing more, and the conversation goes on", async () => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  const before = { searches: searches().length, extracts: tavily.calls.filter((call) => call.path === "/extract").length, research: researchRequests().length };
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  await pick([{ text: ASSUMPTION, query: "Python 3.12 distutils removed" }]);
  await page.getByTestId("research-preview-button").click();
  await page.getByTestId("research-start").click();
  const running = page.getByTestId("research").first();
  await expect.poll(() => searches().length).toBe(before.searches + 1);
  await running.getByTestId("research-cancel").click();
  await expect(running.getByTestId("research-status")).toHaveText("Cancelled");
  await expect(running.getByTestId("research-note")).toHaveText("Cancelled. What was already sent can't be withdrawn, and nothing was resent.");
  hold = null;
  release();
  await page.getByTestId("composer").fill("And now?");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("answer-text")).toHaveCount(2);
  expect([tavily.calls.filter((call) => call.path === "/extract").length, researchRequests().length]).toEqual([before.extracts, before.research]);
});

test("research and its reports are kept across a relaunch, and reopening sends nothing", async ({}, testInfo) => {
  const everyResearch = () => page.evaluate(async () => Promise.all((await window.nivra.listConversations()).conversations.map((c) => window.nivra.listResearch(c.id))));
  const kept = await everyResearch();
  expect(kept.flat().length).toBe(packaged ? 0 : 2);
  const sent = tavily.calls.length;
  await app.close();
  await launch(testInfo);
  expect(await everyResearch()).toEqual(kept);
  expect((await page.evaluate(() => window.nivra.getSettings())).webResearch).toBe(true);
  if (packaged) return;
  await openConversation("Can we move to 3.12?");
  await expect(page.getByTestId("research")).toHaveCount(2);
  expect(tavily.calls.length).toBe(sent);
});

test("deleting a conversation stops its research, keeps nothing of it, and says what the engine and Tavily keep", async () => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  await generalPlan();
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  const before = searches().length;
  await pick([{ text: ASSUMPTION }]);
  await page.getByTestId("research-preview-button").click();
  await page.getByTestId("research-start").click();
  await expect.poll(() => searches().length).toBe(before + 1);
  const conversationId = await page.getByTestId("conversation").getAttribute("data-conversation-id");
  const runOf = () => page.evaluate((id) => window.nivra.listResearch(id!).then((list) => list[0]?.runId ?? null), conversationId);
  await expect.poll(runOf).not.toBeNull();
  const runId = (await runOf())!;
  await page.getByTestId("conversation-delete").click();
  await expect(page.getByTestId("conversation-delete-research")).toHaveText(RESEARCH_RETENTION);
  await page.getByTestId("conversation-delete-confirm").click();
  await expect(page.getByTestId("nav-conversation").filter({ hasText: "Can we move to 3.12?" })).toHaveCount(1);
  await expect.poll(() => page.evaluate((id) => window.nivra.runEvents(id, 0).then((events) => events.status), runId)).toBe("cancelled");
  const sent = { extracts: tavily.calls.filter((call) => call.path === "/extract").length, research: researchRequests().length };
  // The search Tavily held is answered now: a run that went on would read its pages next.
  hold = null;
  release();
  await page.waitForTimeout(500);
  expect([tavily.calls.filter((call) => call.path === "/extract").length, researchRequests().length]).toEqual([sent.extracts, sent.research]);
  const gone = await page.evaluate((id) => window.nivra.listResearch(id!).then(() => "listed", (error: unknown) => String(error)), conversationId);
  expect(gone).toContain("That conversation is no longer in the list.");
});

test("a project's plan: every query starts empty, and Use the assumption's words fills one only when pressed", async ({}, testInfo) => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  // From here on, a preview's answer is held, so a test can change the selection before it arrives.
  await app.close();
  await launch(testInfo, ["--nivra-test-preview-delay-ms=1500"]);
  await newChat("alpha");
  await page.getByTestId("composer").fill("Plan the move to 3.12");
  await page.getByTestId("composer-send").click();
  await page.getByTestId("conversation-consent-allow").click();
  await expect(page.getByTestId("answer-repository")).toBeVisible();
  await page.getByTestId("answer-save-plan").click();
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v1");
  await page.getByTestId("plan-research-open").click();
  await page.getByRole("checkbox", { name: "Deploys are rolling." }).check();
  await page.getByTestId("research-type").fill(ASSUMPTION);
  await page.getByTestId("research-add").click();
  await expect(page.getByTestId("research-query")).toHaveCount(2);
  for (const query of await page.getByTestId("research-query").all()) await expect(query).toHaveValue("");
  await expect(page.getByTestId("research-preview-button")).toBeEnabled();
  await page.getByTestId("research-use-words").first().click();
  await expect(page.getByTestId("research-query").first()).toHaveValue("Deploys are rolling.");
  await expect(page.getByTestId("research-query").last()).toHaveValue("");
});

test("editing an assumption, a query or a site after a preview clears it, and Start research waits for a new one", async () => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  await page.getByTestId("research-query").last().fill("Python 3.12 distutils standard library");
  const previewed = async () => {
    await page.getByTestId("research-preview-button").click();
    await expect(page.getByTestId("research-preview")).toBeVisible();
    await expect(page.getByTestId("research-start")).toBeVisible();
  };
  const cleared = async () => {
    await expect(page.getByTestId("research-preview")).toBeHidden();
    await expect(page.getByTestId("research-start")).toBeHidden();
    await expect(page.getByTestId("research-preview-button")).toBeVisible();
  };
  await previewed();
  await page.getByTestId("research-query").last().fill("Python 3.12 distutils removed");
  await cleared();
  await previewed();
  await page.getByTestId("research-sites").fill("docs.python.org");
  await cleared();
  await previewed();
  await page.getByTestId("research-remove").first().click();
  await cleared();
  await previewed();
  await page.getByTestId("research-type").fill("Setuptools still provides distutils.");
  await page.getByTestId("research-add").click();
  await cleared();
});

test("a preview's answer that arrives after an edit is never shown", async () => {
  test.skip(packaged, "a packaged app ignores the stand-in switches");
  await page.getByTestId("research-query").last().fill("setuptools distutils shim");
  // The answer is held for 1.5 s; the query changes before it arrives.
  await page.getByTestId("research-preview-button").click();
  await page.getByTestId("research-query").last().fill("setuptools distutils");
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId("research-preview")).toBeHidden();
  await expect(page.getByTestId("research-start")).toBeHidden();
  // A new preview, of what the selection is now, is shown.
  await page.getByTestId("research-preview-button").click();
  await expect(page.getByTestId("research-preview-queries")).toContainText("setuptools distutils");
  await expect(page.getByTestId("research-preview-queries")).not.toContainText("setuptools distutils shim");
  await page.getByTestId("research-dialog-cancel").click();
});
