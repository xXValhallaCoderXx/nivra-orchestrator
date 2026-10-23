import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyCall, type TavilyStub } from "../../engine/test/stub-tavily.ts";
import { startStub, toolCall, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";
import { DEMO_PROJECT, DEMO_SEED, DEMO_SITES, demoFingerprint } from "../scripts/research-demo.ts";
import { hostPreview, openDemo, pickDemo, previewAllowing, previewShown, runApproved } from "../scripts/research-journey.ts";
import { seedProjectPlan } from "./seed-workspace.ts";

/**
 * R3's whole journey, offline (D37, NIV-45): the same functions research-live.ts drives the Windows app with, here on
 * the unpackaged app against loopback stand-ins for Tavily and Token Factory, so the live run takes no step for the
 * first time. The project is added through the window, the plan seeded into its conversation with the app closed, then
 * the dialog, both permissions through their own dialogs, the preview bound to the fingerprint the recipe works out,
 * Start, the report, an amended version, and a relaunch that keeps all of it. A packaged app ignores the stand-ins.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
const REMOVED = "The distutils package has been removed from the standard library.";
const VENV = "gh-95299: Stop pre-installing setuptools in virtual environments created with venv.";
/** The model's assessment, scripted: both assumptions contradicted, each with a quotation in the passage read. */
const ASSESSED = {
  assessments: [
    {
      assumption: "A1",
      outcome: "contradicted",
      reasoning: "The 3.12 release notes say distutils was removed.",
      citations: [{ passage: "S1.1", stance: "contradicts", quote: "has been removed from the standard library" }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
      uncertainty: "",
      amendment: "Install setuptools into the virtual environment before building the wheel.",
    },
    {
      assumption: "A2",
      outcome: "contradicted",
      reasoning: "3.12's venv no longer pre-installs setuptools.",
      citations: [{ passage: "S1.1", stance: "contradicts", quote: "Stop pre-installing setuptools in virtual environments created with venv" }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
      uncertainty: "",
      amendment: "Run pip install setuptools in /opt/venv before python setup.py bdist_wheel.",
    },
  ],
};

let root: string;
let model: Stub;
let tavily: TavilyStub;
let app: ElectronApplication;
let page: Page;
const roots: string[] = [];

const isResearch = (request: StubRequest) => JSON.stringify(request.body?.tools ?? []).includes("submit_research");
async function answer(call: TavilyCall) {
  if (call.path === "/search") return { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }]) };
  if (call.path === "/extract") return { body: extractAnswer([{ url: WHATSNEW, chunks: [`## Removed\n${REMOVED} ${VENV}`] }]) };
  return { status: 404, body: {} };
}

async function launch(testInfo: TestInfo) {
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-token-factory-url=${model.url}`, `--nivra-tavily-url=${tavily.url}`];
  app = await electron.launch({ args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  void testInfo;
}

/**
 * A fresh profile for one test: the app adds the project, as the person would; the plan is seeded into its conversation
 * with the app closed; then the app opens on it.
 */
async function fresh(testInfo: TestInfo) {
  await app?.close().catch(() => undefined);
  root = mkdtempSync(join(tmpdir(), "nivra e2e research journey "));
  roots.push(root);
  const repo = join(root, DEMO_PROJECT);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "setup.py"), "from distutils.core import setup\n\nsetup(name='kestrelyard', version='1.0')\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  await launch(testInfo);
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue(DEMO_PROJECT);
  await app.close();
  expect(seedProjectPlan(join(root, "user data"), DEMO_SEED).targetId).toBe("local");
  await launch(testInfo);
}

/** The keys saved, then the journey to a preview whose fingerprint is the recipe's. */
async function toPreview(lines: string[]) {
  await page.evaluate(() => Promise.all([window.nivra.setNebiusKey("test-key-0123456789"), window.nivra.setTavilyKey("tavily-test-key-0123456789")]));
  const settings = await page.evaluate(() => window.nivra.getSettings());
  expect([settings.webResearch, settings.nebiusProjectId]).toEqual([false, "none"]);
  await openDemo(page);
  await pickDemo(page);
  await previewAllowing(page, (line) => lines.push(line));
  await previewShown(page);
  const expected = await demoFingerprint();
  const preview = await hostPreview(page);
  expect([preview.blocked, preview.expected]).toEqual([null, expected.fingerprint]);
  return expected;
}

/** The person's part, done here as the e2e's while runApproved only watches: an amendment picked, edited and saved. */
async function amend() {
  const card = page.getByTestId("research").first();
  await expect(card.getByTestId("research-status")).toHaveText("Complete");
  await card.getByTestId("research-amend").click();
  await page.getByTestId("research-amend-choice").first().check();
  const text = page.getByTestId("research-amend-text");
  await text.fill(`${await text.inputValue()}\nPin setuptools in the image's requirements.`);
  await page.getByTestId("research-amend-save").click();
}

test.beforeAll(async ({}, testInfo) => {
  test.skip(testInfo.project.metadata["executable"] !== undefined, "a packaged app ignores the stand-in switches");
  model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: (request) => (isResearch(request) ? toolCall("submit_research", ASSESSED) : toolCall("submit_reply", {})) });
  tavily = await startTavilyStub(answer);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await model?.close();
  await tavily?.close();
  for (const made of roots) rmSync(made, { recursive: true, force: true, maxRetries: 5 });
});

test("R3's journey, offline: both permissions through their dialogs, a preview bound to the recipe's fingerprint, one start, the report, an amended version, and a relaunch that keeps them all", async ({}, testInfo) => {
  await fresh(testInfo);
  const log: string[] = [];
  const expected = await toPreview(log);
  expect(log).toEqual(["The preview asks for research's permission: turning it on through its dialog.", "The preview asks for the project's sharing: allowing it through the research consent."]);
  expect([tavily.calls.length, model.chats().length]).toEqual([0, 0]);

  expect([model.requests.length, tavily.calls.length]).toEqual([0, 0]);

  // Everything after Start, as the live run does it: runApproved presses Start once and only watches, while the
  // person's part (here the e2e's) amends the plan; then a go-close file lets it close, relaunch, check and remove the
  // keys.
  const evidence = mkdtempSync(join(root, "evidence "));
  const lines: string[] = [];
  const saved = new Map<string, unknown>();
  const running = runApproved({
    page: () => page,
    evidence,
    log: (line) => lines.push(line),
    save: (name, value) => saved.set(name, value),
    shot: async (locator, name) => {
      await locator.screenshot({ path: join(evidence, name) });
    },
    close: () => app.close(),
    relaunch: async () => {
      await launch(testInfo);
      return page;
    },
    routeProblem: async () => null,
    packetDigest: expected.packetDigest,
  });
  await amend();
  await expect.poll(() => lines.some((line) => line.startsWith("Waiting for the go-ahead"))).toBe(true);
  const sent = { requests: model.requests.length, tavily: tavily.calls.length };
  writeFileSync(join(evidence, "go-close"), "");
  const outcome = await running;

  expect(outcome.failures).toEqual([]);
  expect([outcome.research?.status, outcome.research?.report?.outcome, outcome.research?.packetDigest, outcome.kept.length, outcome.keysRemoved]).toEqual([
    "answered",
    "complete",
    expected.packetDigest,
    2,
    true,
  ]);
  expect(outcome.research?.report?.assessments.map((assessment) => [assessment.assumption, assessment.model, assessment.shown, assessment.citations.filter((citation) => citation.valid).length])).toEqual([
    ["A1", "contradicted", "contradicted", 1],
    ["A2", "contradicted", "contradicted", 1],
  ]);
  const v2 = outcome.amended?.find((plan) => plan.version === 2);
  expect([outcome.amended?.find((plan) => plan.version === 1)?.latest, v2?.text.includes("Pin setuptools in the image's requirements.")]).toEqual([2, true]);
  expect([...saved.keys()].sort()).toEqual(["events.json", "plans-after.json", "plans-before.json", "report.json", "research.json"]);
  expect(readdirSync(evidence).sort()).toEqual(["card.png", "go-close", "plan-v2.png", "relaunched.png"]);
  // Exactly what the recipe lists went out: one model listing and one chat; the two approved queries with the sites; at
  // most two extracts. Nothing was sent after the go-ahead: not by the relaunch, not by removing the keys.
  const listings = model.requests.filter((request) => request.path.endsWith("/models")).length;
  const searched = tavily.calls.filter((call) => call.path === "/search").map((call) => [call.body?.["query"], call.body?.["include_domains"]]);
  expect([listings, model.chats().length, tavily.calls.filter((call) => call.path === "/extract").length <= 2]).toEqual([1, 1, true]);
  expect(searched).toEqual(DEMO_SEED.assumptions.map((query) => [query, DEMO_SITES.hosts]));
  expect([model.requests.length, tavily.calls.length]).toEqual([sent.requests, sent.tavily]);
});

test("a full disk after Start can't end the run early: the person still decides when to close, and the keys are still removed", async ({}, testInfo) => {
  await fresh(testInfo);
  const expected = await toPreview([]);
  // Every log, save and screenshot fails, as on a full disk, from the moment the run starts.
  const full = () => {
    throw new Error("ENOSPC: no space left on device, write");
  };
  const evidence = mkdtempSync(join(root, "evidence "));
  const lines: string[] = [];
  const calls = { close: 0, relaunch: 0 };
  const running = runApproved({
    page: () => page,
    evidence,
    log: (line) => {
      lines.push(line);
      full();
    },
    save: () => full(),
    shot: async () => full(),
    close: async () => {
      calls.close++;
      await app.close();
    },
    relaunch: async () => {
      calls.relaunch++;
      await launch(testInfo);
      return page;
    },
    routeProblem: async () => null,
    packetDigest: expected.packetDigest,
  });
  await amend();
  await expect.poll(() => lines.some((line) => line.startsWith("Waiting for the go-ahead"))).toBe(true);
  expect(calls.close).toBe(0);
  writeFileSync(join(evidence, "go-close"), "");
  const outcome = await running;
  expect([calls.close, calls.relaunch, outcome.keysRemoved, outcome.kept.length, outcome.research?.status]).toEqual([2, 1, true, 2, "answered"]);
  // Each failure is a write that couldn't be made, said once; nothing else failed.
  expect(outcome.failures.length).toBeGreaterThan(0);
  expect(outcome.failures.filter((failure) => !failure.includes("ENOSPC"))).toEqual([]);
});
