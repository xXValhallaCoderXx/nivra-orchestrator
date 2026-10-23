import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyCall, type TavilyStub } from "../../engine/test/stub-tavily.ts";
import { startStub, toolCall, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";
import { DEMO_PROJECT, DEMO_SEED, DEMO_SITES, demoFingerprint } from "../scripts/research-demo.ts";
import { amendedVersion, checkKept, followToEnd, hostPreview, openDemo, pickDemo, plansOf, previewAllowing, previewShown, researchOf, startOnce } from "../scripts/research-journey.ts";
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
const log: string[] = [];

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

test.beforeAll(async ({}, testInfo) => {
  test.skip(testInfo.project.metadata["executable"] !== undefined, "a packaged app ignores the stand-in switches");
  root = mkdtempSync(join(tmpdir(), "nivra e2e research journey "));
  const repo = join(root, DEMO_PROJECT);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "setup.py"), "from distutils.core import setup\n\nsetup(name='kestrelyard', version='1.0')\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: (request) => (isResearch(request) ? toolCall("submit_research", ASSESSED) : toolCall("submit_reply", {})) });
  tavily = await startTavilyStub(answer);
  // The app adds the project, as the person would; the plan is seeded into its conversation with the app closed.
  await launch(testInfo);
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue(DEMO_PROJECT);
  await app.close();
  expect(seedProjectPlan(join(root, "user data"), DEMO_SEED).targetId).toBe("local");
  await launch(testInfo);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await model?.close();
  await tavily?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("R3's journey, offline: both permissions through their dialogs, a preview bound to the recipe's fingerprint, one start, the report, an amended version, and a relaunch that keeps them all", async ({}, testInfo) => {
  await page.evaluate(() => Promise.all([window.nivra.setNebiusKey("test-key-0123456789"), window.nivra.setTavilyKey("tavily-test-key-0123456789")]));
  const settings = await page.evaluate(() => window.nivra.getSettings());
  expect([settings.webResearch, settings.nebiusProjectId]).toEqual([false, "none"]);
  await openDemo(page);
  await pickDemo(page);
  await previewAllowing(page, (line) => log.push(line));
  expect(log).toEqual(["The preview asks for research's permission: turning it on through its dialog.", "The preview asks for the project's sharing: allowing it through the research consent."]);
  await previewShown(page);
  const expected = await demoFingerprint();
  const preview = await hostPreview(page);
  expect([preview.blocked, preview.expected]).toEqual([null, expected.fingerprint]);
  expect([tavily.calls.length, model.chats().length]).toEqual([0, 0]);

  const started = await startOnce(page);
  const research = await followToEnd(page, started.id, 60_000, (line) => log.push(line));
  expect([research.status, research.report?.outcome, research.report?.packetDigest]).toEqual(["answered", "complete", expected.packetDigest]);
  expect(research.report?.assessments.map((assessment) => [assessment.assumption, assessment.model, assessment.shown, assessment.citations.filter((citation) => citation.valid).length])).toEqual([
    ["A1", "contradicted", "contradicted", 1],
    ["A2", "contradicted", "contradicted", 1],
  ]);
  // Exactly the approved queries and sites went to Tavily, and one request to the model.
  const searched = tavily.calls.filter((call) => call.path === "/search").map((call) => [call.body?.["query"], call.body?.["include_domains"]]);
  expect(searched).toEqual(DEMO_SEED.assumptions.map((query) => [query, DEMO_SITES.hosts]));
  expect(model.chats().filter(isResearch)).toHaveLength(1);

  // The person's part, done here as the e2e's: an amendment picked, edited, and saved as v2. v1 stays as it was.
  const before = await plansOf(page);
  const card = page.locator(`[data-testid="research"][data-research-id="${started.id}"]`);
  await card.getByTestId("research-amend").click();
  await page.getByTestId("research-amend-choice").first().check();
  const text = page.getByTestId("research-amend-text");
  await text.fill(`${await text.inputValue()}\nPin setuptools in the image's requirements.`);
  await page.getByTestId("research-amend-save").click();
  const plans = await amendedVersion(page, 30_000);
  expect(plans.find((plan) => plan.version === 1)).toEqual({ ...before[0]!, latest: 2 });
  expect(plans.find((plan) => plan.version === 2)?.text).toContain("Pin setuptools in the image's requirements.");

  const kept = { plans, research: await researchOf(page) };
  const sent = { tavily: tavily.calls.length, model: model.chats().length };
  await app.close();
  await launch(testInfo);
  expect(await checkKept(page, kept)).toHaveLength(2);
  expect([tavily.calls.length, model.chats().length]).toEqual([sent.tavily, sent.model]);
});
