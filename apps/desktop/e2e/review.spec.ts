import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { httpError, startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";
import { seedPlan } from "./seed-workspace.ts";

/**
 * Reviews of saved plan versions through the window (D31, NIV-39): a preview of exactly what a review sends, bound to
 * what starts; two reviewers and a chair played by a loopback stub of Token Factory, so no real model is called; reports
 * kept with their version through a failure, a cancel, a killed engine and a relaunch; and nothing that reads as
 * approval. A packaged app ignores the stub switch, so there only a seeded plan's review with no key, a relaunch and a
 * deletion run.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const SEEDED = { question: "How do we rename the users column safely?", plan: "Rename users.fullname to display_name in place during a rolling deploy, then roll back by redeploying release 40." };

// Each test builds on the one before (one profile, one key, the same conversations): see workspace.spec.ts.
test.describe.configure({ mode: "serial" });

let root: string;
let stub: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
let seeded: { conversationId: string; planId: string };

type Role = "architecture" | "risks" | "single" | "chair";
const roleOf = (request: StubRequest): Role | null => (/Nivra review role: (architecture|risks|single|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] as Role | undefined) ?? null;
const reviewBy = (role: string, refs: string[] = ["plan"]) =>
  toolCall("submit_review", {
    summary: `The ${role} reviewer's summary.`,
    findings: [{ title: `Old servers break mid-rollout (${role})`, detail: "Servers on the old release still read the old column.", recommendation: "Expand, then contract.", severity: "high", refs }],
    assumptions: [],
    gaps: [],
  });
const COUNCIL: Record<Role, Reply> = {
  architecture: reviewBy("architecture"),
  risks: reviewBy("risks"),
  single: reviewBy("single"),
  chair: toolCall("submit_synthesis", { summary: "Both reviewers say the rename breaks a rolling deploy.", priorities: ["arch-1", "risk-1"], agreements: [{ statement: "Old servers break mid-rollout.", findingIds: ["arch-1", "risk-1"] }], dissent: [], gaps: [] }),
};
/** A test sets a role's reply here for the reviews it starts, and clears it after. */
let script: Partial<Record<Role, Reply>> = {};
/** A test sets this to hold the reviewers' answers that arrive while it is set. */
let hold: Promise<void> | null = null;
const REPLY = {
  answer: "Add the new column, backfill it, then switch reads.",
  evidence: [{ statement: "The README names the table.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }],
  assumptions: ["Deploys are rolling."],
};

/** Reviewers and the chair as scripted; general turns with text; repository turns read the README, then reply. */
async function answer(request: StubRequest, index: number): Promise<Reply> {
  const role = roleOf(request);
  if (role) {
    if (hold) await hold;
    return script[role] ?? COUNCIL[role];
  }
  if (!request.body?.tools) return text("Rename users.fullname to display_name in place, then redeploy.");
  return request.raw.includes('"role":"tool"') ? toolCall("submit_reply", REPLY, { id: `r${index}` }) : toolCall("read_file", { path: "README.md" }, { id: `q${index}` });
}
const reviewRequests = () => stub.chats().filter((request) => roleOf(request) !== null);

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

async function send(message: string) {
  await page.getByTestId("composer").fill(message);
  await page.getByTestId("composer-send").click();
}

/** Opens the review dialog for the conversation's plan, waits for its preview, and starts it. */
async function review() {
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview")).toBeVisible();
  await page.getByTestId("review-start").click();
  await expect(page.getByTestId("review-preview")).toBeHidden();
}

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e reviews ü%# "));
  makeRepo(join(root, "alpha"), "# Alpha\nThe users table.\n");
  // A plan to review where no model can be reached, put there through the workspace's own functions.
  mkdirSync(join(root, "user data"), { recursive: true });
  seeded = seedPlan(join(root, "user data", "workspace.db"), SEEDED);
  stub = await startStub({ chat: answer });
  await launch(testInfo);
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, join(root, "alpha"));
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue("alpha");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await stub?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("with no key, a seeded plan's review shows what it would send, then fails before any request and says so", async () => {
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  await openConversation(SEEDED.question);
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v1");
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview-version")).toHaveText("Reviewing v1, the latest version.");
  await expect(page.getByTestId("review-preview-scope")).toHaveText("A general plan: no repository.");
  await expect(page.getByTestId("review-preview-sends")).toContainText(`The plan's text: ${SEEDED.plan.length} characters.`);
  await expect(page.getByTestId("review-preview-sends")).toContainText("No preferences: none of yours apply.");
  await expect(page.getByTestId("review-preview-not-sent")).toContainText("The reviewers can't read the repository, so anything they say about the code is an assumption.");
  await expect(page.getByTestId("review-preview-cost")).toHaveText("Two reviewers, then a chair: up to 3 model calls. Nothing is retried.");
  await page.getByTestId("review-start").click();
  const card = page.getByTestId("review");
  await expect(card.getByTestId("review-status")).toHaveText("Failed");
  await expect(card.getByTestId("review-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  await expect(card.getByTestId("review-not-approval")).toBeVisible();
  await expect(card).toHaveAttribute("data-plan-version", "1");
  if (!packaged) expect(reviewRequests()).toEqual([]);
});

test("a general plan's review shows exactly what it sends, runs two reviewers and a chair, and its report never reads as approval", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.evaluate((key) => window.nivra.setNebiusKey(key), KEY);
  await page.evaluate(() => window.nivra.addPreference("Prefer reversible changes", "personal", null, "default"));
  await newChat("general");
  await send("How do I rename the column?");
  await expect(page.getByTestId("answer-text")).toHaveText("Rename users.fullname to display_name in place, then redeploy.");
  await page.getByTestId("answer-save-plan").click();
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v1");
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview-preferences")).toHaveText(/^Your personal default:\s*Prefer reversible changes$/);
  await page.getByTestId("review-start").click();
  const card = page.getByTestId("review").first();
  await expect(card.getByTestId("review-status")).toHaveText("Complete");
  await expect(card.getByTestId("review-stage")).toHaveCount(3);
  await expect(card.getByTestId("review-finding")).toHaveCount(2);
  await expect(card.getByTestId("review-finding-basis")).toHaveText(["From the plan", "From the plan"]);
  await expect(card.getByTestId("review-synthesis")).toContainText("Agreement isn't proof: both reviewers saw the same plan and nothing else.");
  await expect(card.getByTestId("review-not-approval")).toHaveText("This review doesn't change the plan, mark a task ready, or approve anything.");
  await expect(card.getByTestId("review-usage")).toContainText("(test endpoint)");
  await expect(card.getByTestId("review-usage")).toContainText("Run budget: 3 of 3 model calls.");
  await expect(card.getByTestId("review-binding")).toHaveText(/^General plan · packet [0-9a-f]{12} · 1 preference \([0-9a-f]{12}\)$/);
  const sent = reviewRequests();
  expect(sent.map(roleOf).sort()).toEqual(["architecture", "chair", "risks"]);
  // The plan and the preference went; the conversation didn't.
  const all = sent.map((request) => request.raw).join("\n");
  expect([all.includes("Rename users.fullname to display_name in place, then redeploy."), all.includes("Prefer reversible changes"), all.includes("How do I rename the column?")]).toEqual([true, true, false]);
});

test("a preview gone stale is refused and sends nothing; the dialog then shows what a start would send now", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const before = reviewRequests().length;
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview-preferences")).toContainText("Prefer reversible changes");
  await page.evaluate(() => window.nivra.addPreference("Keep migrations backwards compatible", "personal", null, "default"));
  await page.getByTestId("review-start").click();
  await expect(page.getByTestId("review-error")).toHaveText("What this review would send has changed since you opened it. Check the new preview, then start again.");
  await expect(page.getByTestId("review-preview-preferences")).toContainText("Keep migrations backwards compatible");
  await page.getByTestId("review-dialog-cancel").click();
  await expect(page.getByTestId("review")).toHaveCount(1);
  expect(reviewRequests().length).toBe(before);
});

test("a reviewer that fails leaves an incomplete report with what the other found, and Review again makes a new review", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  script = { architecture: httpError(500, "the architecture reviewer is down") };
  await review();
  const failed = page.getByTestId("review").first();
  await expect(failed.getByTestId("review-status")).toHaveText("Incomplete");
  await expect(failed.getByTestId("review-incomplete")).toHaveText("Incomplete: this report holds only what the stages that answered produced.");
  expect(await failed.getByTestId("review-stage").evaluateAll((stages) => stages.map((stage) => [stage.getAttribute("data-role"), stage.getAttribute("data-status")]))).toEqual([
    ["architecture", "failed"],
    ["risks", "answered"],
    ["chair", "skipped"],
  ]);
  await expect(failed.getByTestId("review-note")).toContainText("This review is incomplete. The architecture review failed");
  script = {};
  await failed.getByTestId("review-again").click();
  await expect(page.getByTestId("review-preview")).toBeVisible();
  await page.getByTestId("review-start").click();
  await expect(page.getByTestId("review")).toHaveCount(3);
  await expect(page.getByTestId("review").first().getByTestId("review-status")).toHaveText("Complete");
});

test("a running review holds the conversation; cancelling it keeps what it saved, sends nothing more, and the conversation goes on", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  const before = reviewRequests().length;
  await review();
  const running = page.getByTestId("review").first();
  await expect(running.getByTestId("review-status")).toHaveText("Reviewing");
  await expect.poll(() => reviewRequests().length).toBe(before + 2);
  await expect(page.getByTestId("composer-review-running")).toBeVisible();
  await page.getByTestId("composer").fill("Meanwhile?");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByTestId("plan-review")).toBeDisabled();
  await running.getByTestId("review-cancel").click();
  await expect(running.getByTestId("review-status")).toHaveText("Cancelled");
  await expect(running.getByTestId("review-note")).toHaveText("Cancelled. Nothing was resent.");
  hold = null;
  release();
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("answer-text")).toHaveCount(2);
  expect(reviewRequests().length).toBe(before + 2);
});

test("a review whose engine is killed waits, unresolved; after Restart it is interrupted and nothing is resent", async () => {
  test.skip(packaged || process.platform === "win32", "needs the test endpoint switch, and a signal to kill the engine with");
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  const before = reviewRequests().length;
  await review();
  const running = page.getByTestId("review").first();
  await expect.poll(() => reviewRequests().length).toBe(before + 2);
  const pid = await page.evaluate(async () => {
    const local = (await window.nivra.listEngines()).find((engine) => engine.targetId === "local");
    return local?.state.status === "online" ? local.state.info.pid : null;
  });
  expect(pid).not.toBeNull();
  process.kill(pid!, "SIGKILL");
  await expect(page.getByTestId("conversation-engine-restart")).toBeVisible();
  await expect(running.getByTestId("review-unresolved")).toBeVisible();
  await page.getByTestId("conversation-engine-restart").click();
  await expect(running.getByTestId("review-status")).toHaveText("Interrupted");
  await expect(running.getByTestId("review-note")).toHaveText("Interrupted: Nivra or its engine stopped before the review finished. Nothing was resent.");
  hold = null;
  release();
  expect(reviewRequests().length).toBe(before + 2);
});

test("a project plan's review asks for the project's consent in the dialog, shows its historical references as such, and sends no path of the project's", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await newChat("alpha");
  await send("Plan the rename");
  await page.getByTestId("conversation-consent-allow").click();
  await expect(page.getByTestId("answer-repository")).toBeVisible();
  await page.getByTestId("answer-save-plan").click();
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v1");
  const projectId = await page.evaluate(async () => (await window.nivra.listProjects()).find((project) => project.label === "alpha")!.id);
  await page.evaluate((id) => window.nivra.setSharing(id, false), projectId);
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview-scope")).toHaveText(/^alpha · .+ · HEAD [0-9a-f]{12} when its answer was written · sharing off$/);
  await expect(page.getByTestId("review-blocked")).toContainText("This project doesn't allow sending its content to Token Factory. Allow sharing for it, then start the review.");
  await expect(page.getByTestId("review-start")).toBeDisabled();
  await page.getByTestId("review-allow-sharing").click();
  await expect(page.getByText("where the answer it came from looked: file paths and line numbers, never the lines;")).toBeVisible();
  await page.getByTestId("review-consent-allow").click();
  await expect(page.getByTestId("review-preview-scope")).toHaveText(/ · sharing on$/);
  await expect(page.getByTestId("review-preview-sends")).toContainText("1 historical reference: where the answer it came from looked, as paths and line numbers. Not the lines: nobody reads them again for this review.");
  script = { risks: reviewBy("risks", ["E1"]) };
  const before = reviewRequests().length;
  await page.getByTestId("review-start").click();
  const card = page.getByTestId("review").first();
  await expect(card.getByTestId("review-status")).toHaveText("Complete");
  script = {};
  const risk = card.getByTestId("review-finding").filter({ hasText: "(risks)" });
  await expect(risk.getByTestId("review-finding-basis")).toHaveText("Assumption");
  await expect(risk.locator("[data-ref=E1]")).toHaveText("E1 · README.md:1 · historical");
  const sent = reviewRequests().slice(before).map((request) => request.raw).join("\n");
  expect([sent.includes("README.md"), sent.includes(join(root, "alpha"))]).toEqual([true, false]);
});

test("editing a plan makes v2: its reviews say the plan moved on and stay as they were, and the dialog offers each version", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await openConversation("How do I rename the column?");
  const cards = page.getByTestId("review");
  const count = await cards.count();
  await page.getByTestId("plan-edit").click();
  await page.getByTestId("plan-input").fill("Add display_name first, backfill it, switch reads, then drop fullname.");
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("plan-version")).toHaveText("Plan · v2");
  await expect(cards).toHaveCount(count);
  await expect(page.getByTestId("review-stale")).toHaveCount(count);
  await expect(page.getByTestId("review-stale").first()).toHaveText("The plan is now at v2. This review is of v1, and stays as it was.");
  await page.getByTestId("plan-review").click();
  await expect(page.getByTestId("review-preview-version")).toHaveText("Reviewing v2, the latest version.");
  await page.getByTestId("review-version").selectOption({ label: "v1" });
  await expect(page.getByTestId("review-preview-version")).toHaveText("Reviewing v1; the plan is now at v2.");
  await page.getByTestId("review-dialog-cancel").click();
});

test("reviews and their reports are kept across a relaunch, and reopening sends nothing", async ({}, testInfo) => {
  const before = packaged ? 0 : stub.chats().length;
  const everyReview = () => page.evaluate(async () => Promise.all((await window.nivra.listConversations()).conversations.map((c) => window.nivra.listReviews(c.id))));
  const kept = await everyReview();
  expect(kept.flat().length).toBe(packaged ? 1 : 7);
  await app.close();
  await launch(testInfo);
  expect(await everyReview()).toEqual(kept);
  await openConversation(SEEDED.question);
  await expect(page.getByTestId("review").getByTestId("review-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  if (packaged) return;
  await openConversation("How do I rename the column?");
  await expect(page.getByTestId("review").getByTestId("review-status")).toHaveText(["Interrupted", "Cancelled", "Complete", "Incomplete", "Complete"]);
  await expect(page.getByTestId("review").last().getByTestId("review-finding")).toHaveCount(2);
  expect(stub.chats().length).toBe(before);
});

test("deleting a conversation says its reviews go with it and what each engine keeps, then takes them", async () => {
  await openConversation(SEEDED.question);
  await page.getByTestId("conversation-delete").click();
  await expect(page.getByText("Its messages, turns, plans and reviews are deleted from Nivra.")).toBeVisible();
  await expect(page.getByText("(a report can quote the plan)")).toBeVisible();
  await page.getByTestId("conversation-delete-confirm").click();
  await expect(page.getByTestId("nav-conversation").filter({ hasText: SEEDED.question })).toHaveCount(0);
  await expect(page.evaluate((id) => window.nivra.listReviews(id), seeded.conversationId)).rejects.toThrow("That conversation is no longer in the list.");
});
