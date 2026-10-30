import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coachDigest, coachFiles, coachOutput, coachState, writeCoachOutput } from "../scripts/coach-live-checks.ts";
import { claimApproval } from "../../engine/scripts/research-check/claim.ts";

test("a frozen coach source detects edits, additions, removals and linked source files", () => {
  const root = mkdtempSync(join(tmpdir(), "coach freeze "));
  try {
    writeFileSync(join(root, "a"), "before");
    const original = coachFiles(root);
    writeFileSync(join(root, "a"), "after");
    assert.notEqual(coachFiles(root).sha256, original.sha256);
    writeFileSync(join(root, "a"), "before");
    writeFileSync(join(root, "b"), "new");
    assert.notEqual(coachFiles(root).sha256, original.sha256);
    assert.equal(coachFiles(root, ["b", "a"]).sha256, coachFiles(root, ["a", "b"]).sha256);
    rmSync(join(root, "b"));
    assert.equal(coachFiles(root).sha256, original.sha256);
    rmSync(join(root, "a"));
    assert.notEqual(coachFiles(root).sha256, original.sha256);
    symlinkSync(join(root, "absent"), join(root, "link"));
    assert.throws(() => coachFiles(root, ["link"]), /ordinary file/);
    assert.throws(() => coachFiles(root, ["../outside"]), /ordinary file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a coach recipe binds its build, model, packet, instructions and enforced limits", () => {
  const recipe = { build: "a", model: "b", preview: "c", instructions: "d", requests: 1 };
  const digest = coachDigest(recipe);
  for (const field of ["build", "model", "preview", "instructions"] as const) assert.notEqual(coachDigest({ ...recipe, [field]: "changed" }), digest, field);
  assert.notEqual(coachDigest({ ...recipe, requests: 2 }), digest);
});

test("a coach approval remains spent after an interrupted or repeated launch", () => {
  const root = mkdtempSync(join(tmpdir(), "coach claim "));
  try {
    const claim = { digest: coachDigest("one run"), revision: null, run: 1, out: root, pid: process.pid, claimedAt: new Date().toISOString() };
    assert.equal(claimApproval(root, claim).ok, true);
    assert.equal(claimApproval(root, claim).ok, false);
    writeFileSync(join(root, `${claim.digest}.json`), "");
    assert.equal(claimApproval(root, claim).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coach state cannot use historical evidence, a sibling prefix or a release home", () => {
  const home = "/home/tester";
  assert.equal(coachState(`${home}/nivra-acceptance/niv53/completion-current`, home), `${home}/nivra-acceptance/niv53/completion-current`);
  for (const path of [`${home}/nivra-acceptance/niv53`, `${home}/nivra-acceptance/niv530/completion-x`, `${home}/.nivra`, `${home}/nivra-acceptance/niv53/completion-x/../../old`]) assert.throws(() => coachState(path, home), /completion-/);
});

test("coach state rejects a linked completion folder, its parents and nested folders without changing historical evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "coach evidence home "));
  try {
    const root = join(home, "nivra-acceptance", "niv53");
    const historical = join(home, "historical");
    mkdirSync(root, { recursive: true });
    mkdirSync(historical, { recursive: true });
    const receipt = join(historical, "recipe.json");
    writeFileSync(receipt, "historical receipt");
    const completion = join(root, "completion-linked");
    symlinkSync(historical, completion, "junction");
    assert.throws(() => coachState(completion, home), /linked|ordinary/);
    assert.throws(() => coachState(join(completion, "new-folder"), home), /linked|ordinary/);
    rmSync(completion);
    mkdirSync(completion);
    symlinkSync(historical, join(completion, "nested"), "junction");
    assert.throws(() => coachState(join(completion, "nested"), home), /linked|ordinary/);
    rmSync(join(completion, "nested"));
    rmSync(completion, { recursive: true });
    rmSync(root, { recursive: true });
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root, "junction");
    assert.throws(() => coachState(join(root, "completion-new"), home), /linked|ordinary/);
    rmSync(root);
    rmSync(join(home, "nivra-acceptance"), { recursive: true });
    symlinkSync(elsewhere, join(home, "nivra-acceptance"), "junction");
    assert.throws(() => coachState(join(root, "completion-new"), home), /linked|ordinary/);
    assert.equal(readFileSync(receipt, "utf8"), "historical receipt");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("coach evidence rejects linked and non-file outputs, including links added after state validation", () => {
  const home = mkdtempSync(join(tmpdir(), "coach evidence outputs "));
  try {
    const state = coachState(join(home, "nivra-acceptance", "niv53", "completion-current"), home);
    mkdirSync(state, { recursive: true });
    const historical = join(home, "historical.json");
    writeFileSync(historical, "historical receipt");
    const output = join(state, "recipe.json");
    symlinkSync(historical, output);
    assert.throws(() => coachOutput(state, "recipe.json"), /unlinked/);
    assert.throws(() => writeCoachOutput(state, "recipe.json", "replacement"), /unlinked/);
    assert.equal(readFileSync(historical, "utf8"), "historical receipt");
    rmSync(output);
    symlinkSync(join(home, "absent.json"), output);
    assert.throws(() => writeCoachOutput(state, "recipe.json", "replacement"), /unlinked/);
    rmSync(output);
    linkSync(historical, output);
    assert.throws(() => writeCoachOutput(state, "recipe.json", "replacement"), /unlinked/);
    assert.equal(readFileSync(historical, "utf8"), "historical receipt");
    rmSync(output);
    mkdirSync(output);
    assert.throws(() => writeCoachOutput(state, "recipe.json", "replacement"), /unlinked/);
    rmSync(output, { recursive: true });
    assert.throws(() => writeCoachOutput(state, "../outside.json", "replacement"), /unlinked/);
    assert.throws(() => coachOutput(state, ""), /unlinked/);
    writeCoachOutput(state, "recipe.json", "long ordinary receipt");
    writeCoachOutput(state, "recipe.json", "new");
    assert.equal(readFileSync(output, "utf8"), "new");
    writeCoachOutput(state, "preview.png", new Uint8Array([137, 80, 78, 71]));
    assert.deepEqual([...readFileSync(join(state, "preview.png"))], [137, 80, 78, 71]);
    rmSync(state, { recursive: true });
    const linked = join(home, "linked");
    mkdirSync(linked);
    symlinkSync(linked, state, "junction");
    assert.throws(() => writeCoachOutput(state, "recipe.json", "replacement"), /unlinked/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
