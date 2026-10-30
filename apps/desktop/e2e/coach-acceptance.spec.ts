import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { startStub, toolCall } from "../../engine/test/stub-token-factory.ts";
import { startSandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startTavilyStub } from "../../engine/test/stub-tavily.ts";
import { checkCoachAnswer, coachingsOf, coachPreview, createCoachTask, endedCoach, openCoachTask, saveCoachSelection, taskOf } from "../scripts/coach-journey.ts";

test("NIV-53 acceptance runner: reviewed partial save, preserved draft and restart, with no extra requests", async ({}, testInfo) => {
  test.skip(Boolean(testInfo.project.metadata["executable"]), "the complete mocked journey uses unpackaged-only provider switches");
  const root = mkdtempSync(join(tmpdir(), "nivra coach acceptance "));
  const model = await startStub({ models: [{ id: "nvidia/Nemotron-3.5-Super-VL", context_length: 131_072 }], chat: () => toolCall("submit_coaching", {
    summary: "The unit comparison needs an observable example.",
    questions: [{ text: "Which unit is used for comparison?", why: "The comparison must use one unit.", field: "acceptanceCriteria" }],
    changes: [
      { field: "acceptanceCriteria", reword: [{ item: 1, text: "Equivalent runs entered as 5 kilometres and 3.106856 miles compare as equal" }], add: [], reason: "Makes the comparison observable.", refs: ["C1"] },
      { field: "scope", text: "The personal record comparison", reason: "Bounds the work.", refs: [] },
    ], suggestedChecks: [], unknowns: ["The comparison unit has not been decided."],
  }) });
  const sandbox = await startSandboxStub();
  const research = await startTavilyStub(() => ({ status: 500, body: { error: "not used" } }));
  const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
  const launch = () => electron.launch({ args: [desktop, `--user-data-dir=${join(root, "profile")}`, `--nivra-engine-home=${join(root, "engine")}`, `--nivra-token-factory-url=${model.url}`, `--nivra-sandboxes-url=${sandbox.url}`, `--nivra-tavily-url=${research.url}`], chromiumSandbox: true });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(() => window.nivra.setNebiusKey("nivra-coach-acceptance-test-key"));
    const before = await createCoachTask(page);
    const preview = await coachPreview(page, before.summary.id);
    assert.equal(model.requests.length, 0);
    await page.getByTestId("coach-start").click();
    const coaching = await endedCoach(page, before.summary.id);
    await expect(page.getByTestId("coach-question")).toBeVisible();
    await page.getByTestId("task-tab-brief").click();
    await page.getByTestId("task-edit-brief").click();
    await page.getByTestId("brief-goal").fill("A deliberately unsaved user draft");
    await page.getByTestId("task-tab-coach").click();
    await page.getByTestId("coach-update-field").click();
    await expect(page.getByTestId("brief-goal")).toHaveValue("A deliberately unsaved user draft");
    await expect(page.getByTestId("coach-save")).toBeDisabled();
    await page.getByTestId("task-brief-cancel").click();
    const saved = await saveCoachSelection(page, before, coaching, ["acceptanceCriteria"]);
    assert.equal(saved.brief.content.scope, "");
    assert.equal(preview.profile.version, coaching.profile.version);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await openCoachTask(page, before.summary.id);
    await expect(page.getByTestId("coach-applied")).toBeVisible();
    await expect(page.getByTestId("coach-unknowns")).toContainText("has not been decided");
    assert.equal((await taskOf(page, before.summary.id)).brief.version, 2);
    assert.equal((await coachingsOf(page, before.summary.id)).length, 1);
    assert.equal(model.chats().length, 1);
    assert.equal(model.requests.filter((request) => request.path.endsWith("/models")).length, 1);
    assert.equal(sandbox.requests.length, 0);
    assert.equal(research.calls.length, 0);
  } finally {
    await app.close();
    await Promise.all([model.close(), sandbox.close(), research.close()]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("NIV-53 live failure regression: 4,000 output tokens with no form preserves the brief across restart and cannot be saved", async ({}, testInfo) => {
  test.skip(Boolean(testInfo.project.metadata["executable"]), "the output-limit response is a provider stand-in");
  const root = mkdtempSync(join(tmpdir(), "nivra coach cut off "));
  const model = await startStub({ models: [{ id: "nvidia/Nemotron-3.5-Super-VL", context_length: 131_072 }], chat: () => ({ body: {
    id: "cut-off-coaching", object: "chat.completion", created: 0, model: "nvidia/Nemotron-3.5-Super-VL",
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 2410, completion_tokens: 4000, total_tokens: 6410 },
  } }) });
  const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
  const launch = () => electron.launch({ args: [desktop, `--user-data-dir=${join(root, "profile")}`, `--nivra-engine-home=${join(root, "engine")}`, `--nivra-token-factory-url=${model.url}`], chromiumSandbox: true });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(() => window.nivra.setNebiusKey("nivra-coach-acceptance-test-key"));
    const before = await createCoachTask(page);
    await coachPreview(page, before.summary.id);
    await page.getByTestId("coach-start").click();
    const coaching = await endedCoach(page, before.summary.id);
    assert.equal(coaching.status, "failed");
    assert.equal(coaching.report?.stage.outputTokens, 4000);
    assert.equal(coaching.report?.stage.finishReason, "length");
    assert.throws(() => checkCoachAnswer(coaching), /cut off at the output limit/);
    assert.equal(coaching.changes.length, 0);
    await page.evaluate(() => window.nivra.setNebiusKey(null));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await openCoachTask(page, before.summary.id);
    await expect(page.getByTestId("coaching-note")).toContainText("cut off at the output limit");
    await expect(page.getByTestId("coach-save")).toHaveCount(0);
    const after = await taskOf(page, before.summary.id);
    assert.equal(after.brief.version, 1);
    assert.deepEqual(after.brief.content.acceptanceCriteria, before.brief.content.acceptanceCriteria);
    assert.equal(after.summary.state, "draft");
    assert.equal(after.attempts.length, 0);
    assert.equal((await coachingsOf(page, before.summary.id)).length, 1);
    assert.equal(model.chats().length, 1);
    assert.equal(model.requests.filter((request) => request.path.endsWith("/models")).length, 1);
  } finally {
    await app.close();
    await model.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
