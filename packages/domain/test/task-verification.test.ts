import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateTaskVerification, taskVerificationManifest, type TaskCheck, type TaskVerificationManifest } from "../src/index.ts";

const brief = { acceptanceCases: [{ name: "Behaviour", command: "node acceptance.mjs", expectedOutput: "ok\n", expectedExitCode: 0 }], checks: ["pnpm typecheck"], frozen: ["acceptance.mjs"] };
const evidence = (manifest: TaskVerificationManifest) => manifest.checks.map((check) => ({ ...check, verdict: "passed" as const, exitCode: 0 }));

describe("complete required verification evidence (NIV-67)", () => {
  it("requires every unique bound final result; a failed, unknown or unrun required check blocks passing acceptance", async () => {
    const manifest = await taskVerificationManifest(brief, false);
    const checks = evidence(manifest);
    const assess = (rows: typeof checks) => evaluateTaskVerification({ manifest, checks: rows, frozen: [{ path: "acceptance.mjs", unchanged: true }] });
    assert.equal(assess(checks).verified, true);
    for (const verdict of ["failed", "unknown", "not-run", "couldnt-run"] as TaskCheck["verdict"][]) {
      const failed = [{ ...checks[0]! }, { ...checks[1]!, verdict }];
      assert.equal(evaluateTaskVerification({ manifest, checks: failed, frozen: [{ path: "acceptance.mjs", unchanged: true }] }).verified, false, verdict);
    }
    assert.equal(assess(checks.slice(0, 1)).verified, false);
    assert.equal(assess([checks[0]!, checks[0]!]).verified, false);
    assert.equal(assess([checks[0]!, { ...checks[1]!, commandSha256: "f".repeat(64) }]).verified, false);
  });

  it("never verifies zero acceptance cases, even when every repository check passes", async () => {
    const manifest = await taskVerificationManifest({ acceptanceCases: [], checks: ["pnpm typecheck"] }, false);
    const result = evaluateTaskVerification({ manifest, checks: evidence(manifest) });
    assert.equal(result.verified, false);
    assert.match(result.reason!, /No acceptance cases/);
  });

  it("requires the manifest and complete frozen/setup evidence; an absent row isn't unchanged", async () => {
    const manifest = await taskVerificationManifest(brief, true);
    const checks = evidence(manifest);
    const frozen = [{ path: "acceptance.mjs", unchanged: true }];
    const assess = (extra: Partial<Parameters<typeof evaluateTaskVerification>[0]>) => evaluateTaskVerification({ manifest, checks, frozen, setup: { unchanged: true, changed: [] }, ...extra });
    assert.equal(assess({}).verified, true);
    assert.equal(assess({ manifest: undefined }).verified, false);
    assert.equal(assess({ frozen: [] }).verified, false);
    assert.equal(assess({ frozen: [...frozen, ...frozen] }).verified, false);
    assert.equal(assess({ setup: null }).verified, false);
    assert.equal(assess({ setup: { unchanged: null, changed: [] } }).verified, false);
    assert.equal(assess({ setup: { unchanged: false, changed: ["package.json"] } }).verified, false);
  });

  it("permits no repository checks and retains an originally unverified historical verdict", async () => {
    const manifest = await taskVerificationManifest({ acceptanceCases: brief.acceptanceCases, checks: [] }, false);
    const checks = evidence(manifest);
    assert.equal(evaluateTaskVerification({ manifest, checks }).verified, true);
    assert.equal(evaluateTaskVerification({ manifest, checks, originalVerified: false, legacy: true }).verified, false);
    const historical = checks.map(({ commandSha256: _missing, ...check }) => check);
    assert.equal(evaluateTaskVerification({ manifest, checks: historical, originalVerified: true, legacy: true }).verified, true);
    assert.equal(evaluateTaskVerification({ manifest, checks: historical }).verified, false);
  });
});
