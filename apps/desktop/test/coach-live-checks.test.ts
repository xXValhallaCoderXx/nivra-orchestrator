import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coachDigest, coachFiles, coachState } from "../scripts/coach-live-checks.ts";
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
