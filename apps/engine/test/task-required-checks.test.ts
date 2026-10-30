import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { TaskCheck } from "@nivra/domain";
import { operationsFor, reserveMs, runLimitsFor, runNeedsMs, TASK_LIMITS } from "../src/task/limits.ts";
import { clock } from "./fake-sandboxes.ts";
import { attempt, BRIEF, FIX, FIXTURE, labels } from "./task-fixtures.ts";
import { cleanUp } from "./workspace-fixtures.ts";

after(cleanUp);

// Nivra-owned code, compiled with Nivra's pinned TypeScript. No user repository or dependency install is involved.
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const compiler = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
const original = `type Units = "kg" | "lb";
export function getPriorBestsByMovement(load: number, historicalUnits: Units, current: number, movement: string): number {
  return load;
}
export function currentBest(): number { return getPriorBestsByMovement(100, "kg", 110, "squat"); }
`;
const changed = original.replace("movement: string)", "movement: string, finishingUnits: Units)").replace("return load;", 'return historicalUnits === finishingUnits ? load : historicalUnits === "kg" ? load * 2.20462 : load / 2.20462;');
const check = `node ${quote(compiler)} --noEmit --strict --skipLibCheck --target es2022 history.ts`;
const cases = `import { getPriorBestsByMovement as best } from './history.ts'; console.log(Math.round(best(100, 'kg', 110, 'squat', 'lb'))); console.log(best(100, 'kg', 110, 'squat', 'kg')); console.log(best(100, 'lb', 110, 'squat', 'lb'));`;
const brief = { ...BRIEF, checks: [check], acceptanceCases: [{ name: "mixed and same-unit kg/lb history", command: `node --input-type=module -e ${quote(cases)}`, expectedOutput: "220\n100\n100\n", expectedExitCode: 0 }] };

describe("required repository checks (NIV-67)", () => {
  it("blocks verification when a signature changes without its caller, though mixed and same-unit kg/lb cases pass", async () => {
    const run = await attempt({ files: { "history.ts": original }, brief, calls: [["edit_file", { path: "history.ts", old_text: original, new_text: changed }]] });
    assert.equal(run.result.outcome, "proposed");
    assert.equal(run.core!.checks[0]!.verdict, "passed");
    assert.deepEqual([run.core!.beforeChecks[0]!.verdict, run.core!.checks[1]!.verdict, run.core!.verified], ["passed", "failed", false]);
    assert.match(run.core!.checks[1]!.stdoutTail, /TS2554: Expected 5 arguments, but got 4/);
    assert.equal(run.core!.beforeChecks[0]!.commandSha256, run.core!.manifest.checks[1]!.commandSha256);
    assert.equal(run.core!.checks[1]!.commandSha256, run.core!.manifest.checks[1]!.commandSha256);
    assert.equal(run.changed.length, 0);
  });

  it("verifies the repaired caller with mixed-unit and same-unit kg/lb acceptance coverage", async () => {
    const repaired = changed.replace('110, "squat");', '110, "squat", "kg");');
    const run = await attempt({ files: { "history.ts": original }, brief, calls: [["edit_file", { path: "history.ts", old_text: original, new_text: repaired }]] });
    assert.deepEqual([run.core!.beforeChecks[0]!.verdict, run.core!.checks.map((result) => result.verdict), run.core!.verified], ["passed", ["passed", "passed"], true]);
  });

  it("never waives a final failure because both sides failed, even when clipped output and exit codes match", async () => {
    const broken = { ...FIXTURE, "check.sh": 'i=0; while [ "$i" -lt 10000 ]; do printf "long diagnostic\\n"; i=$((i + 1)); done; exit 1\n' };
    const run = await attempt({ files: broken, calls: [["edit_file", FIX]] });
    assert.deepEqual([run.core!.beforeChecks[0]!.verdict, run.core!.checks[0]!.verdict, run.core!.checks[1]!.verdict, run.core!.verified], ["failed", "passed", "failed", false]);
    assert.equal(run.core!.beforeChecks[0]!.exitCode, run.core!.checks[1]!.exitCode);
    const raw = JSON.parse(new TextDecoder().decode(run.result.proposal!.report));
    assert.equal(raw.beforeChecks.length, 1);
    for (const result of [...raw.beforeChecks, ...raw.checks]) TaskCheck.parse(result);
    assert.ok(raw.beforeChecks[0].stdoutTail.length <= 4_000);
  });

  for (const ending of ["timeout", "unknown"] as const) it(`doesn't verify a required final check with ${ending} evidence`, async () => {
    let written = false;
    const run = await attempt({
      calls: [["edit_file", FIX]],
      setup: (guest) => {
        guest.override = ({ label, args }) => {
          if (label === "nivra-write") written = true;
          return written && args[1] === "/bin/sh check.sh" && ending === "timeout" ? { timedOut: true } : undefined;
        };
      },
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        if (ending !== "unknown" || request.method !== "GET" || !written) return answer;
        const id = /^\/v1\/operations\/([^/]+)$/.exec(request.path)?.[1];
        const operation = guest.service.operations.find((candidate) => candidate.uuid === id);
        if ((operation?.body["args"] as string[] | undefined)?.[1] !== "/bin/sh check.sh") return answer;
        const body = JSON.parse(new TextDecoder().decode(answer.body));
        if (body.metadata?.result) delete body.metadata.result.stdout;
        return { ...answer, body: new TextEncoder().encode(JSON.stringify(body)) };
      },
    });
    assert.equal(run.core!.checks[0]!.verdict, "passed");
    assert.equal(run.core!.checks[1]!.verdict, ending === "timeout" ? "failed" : "unknown");
    assert.equal(run.core!.verified, false);
  });

  it("never retries an uncertain before-change check or starts the worker after it", async () => {
    let interrupted = false;
    const run = await attempt({
      wrap: (transport, guest) => async (request) => {
        if (!interrupted && request.method === "POST" && request.path === "/v1/instances" && String(request.body).includes("check.sh")) {
          interrupted = true;
          await transport(request);
          throw new Error("lost start reply");
        }
        if (interrupted && request.path === "/v1/operations") throw new Error("lookup unavailable");
        return transport(request);
      },
    });
    assert.equal(interrupted, true);
    assert.deepEqual([run.result.outcome, run.result.proposal, run.requests()], ["uncertain", null, 0]);
    assert.equal(run.core!.beforeChecks[0]!.verdict, "unknown");
    assert.equal(run.guest.ran.filter((entry) => entry.script === "/bin/sh check.sh").length, 1);
    assert.ok(!labels(run.guest).includes("nivra-collect"));
  });

  it("keeps unavailable comparison evidence unknown while allowing a settled, passing final result", async () => {
    let written = false;
    const run = await attempt({
      calls: [["edit_file", FIX]],
      setup: (guest) => void (guest.override = ({ label }) => { if (label === "nivra-write") written = true; return undefined; }),
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        if (written || request.method !== "GET") return answer;
        const id = /^\/v1\/operations\/([^/]+)$/.exec(request.path)?.[1];
        const operation = guest.service.operations.find((candidate) => candidate.uuid === id);
        if ((operation?.body["args"] as string[] | undefined)?.[1] !== "/bin/sh check.sh") return answer;
        const body = JSON.parse(new TextDecoder().decode(answer.body));
        if (body.metadata?.result) delete body.metadata.result.stdout;
        return { ...answer, body: new TextEncoder().encode(JSON.stringify(body)) };
      },
    });
    assert.deepEqual([run.core!.beforeChecks[0]!.verdict, run.core!.checks[1]!.verdict, run.core!.verified], ["unknown", "passed", true]);
  });

  it("stops before another comparison would consume the final-check reserve, without starting the model", async () => {
    const time = clock();
    const many = { ...BRIEF, checks: ["/bin/sh check.sh", "/bin/sh check.sh", "/bin/sh check.sh"] };
    const run = await attempt({ time, brief: many, extra: { progress: (message) => {
      if (message.startsWith("Before-change check 1:")) void time.sleep(TASK_LIMITS.sessionMs - reserveMs(4) - runNeedsMs() + 1_000);
    } } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.requests(), run.result.proposal], ["failed", "time", 0, null]);
    assert.deepEqual(run.core!.beforeChecks.map((result) => result.verdict), ["failed", "not-run", "not-run"]);
    assert.match(run.core!.beforeChecks[1]!.reason ?? "", /there wasn't time left/);
    assert.ok(!labels(run.guest).includes("nivra-collect"));
  });

  it("includes every comparison operation in the preview without increasing model, worker or session bounds", () => {
    const limits = runLimitsFor(4, 3, 3);
    assert.equal(operationsFor(4, 3, 3), 25);
    assert.deepEqual([limits.operations, limits.baselineChecks, limits.comparisonChecks, limits.writes, limits.runs, limits.sessionMinutes, limits.runMinutes], [25, 3, 3, 8, 4, 45, 58]);
  });
});
