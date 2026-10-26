import { readFileSync, writeFileSync } from "node:fs";
import { type ApplyIo, nodeIo } from "../src/apply/io.ts";
import { ApplyJournal } from "../src/apply/journal.ts";
import type { RevalidatedPlan } from "../src/apply/plan.ts";
import { writeChange } from "../src/apply/writer.ts";
import { Database } from "../src/db/database.ts";

/**
 * The child `apply-kill.test.ts` kills (NIV-8, D40): it claims one apply in the journal it is given and runs the
 * writer on the plan it is given, counting every filesystem call. At call `killAt` it kills itself with SIGKILL before
 * making the call, as a crash or a power cut would stop it; at call `failAt` the call fails with EIO instead, so the
 * writer rolls back and a later kill lands in rollback. With `calls`, it writes down every call it made.
 */
interface Job {
  database: string;
  plan: string;
  applyId: string;
  requestId: string;
  runId: string;
  killAt: number | null;
  failAt: number | null;
  calls: string | null;
}

type Planned = Omit<RevalidatedPlan["paths"][number], "bytes"> & { bytes: string };

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Job;
const written = JSON.parse(readFileSync(job.plan, "utf8")) as Omit<RevalidatedPlan, "paths"> & { paths: Planned[] };
const plan: RevalidatedPlan = { ...written, paths: written.paths.map((one) => ({ ...one, bytes: new Uint8Array(Buffer.from(one.bytes, "base64")) })) };

const calls: string[] = [];
const io = {} as ApplyIo;
for (const name of Object.keys(nodeIo) as Array<keyof ApplyIo>) {
  (io as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    const at = calls.length;
    calls.push(name);
    if (at === job.killAt) {
      process.kill(process.pid, "SIGKILL");
      // Nothing after the kill may run, however late the signal lands.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    if (at === job.failAt) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return (nodeIo[name] as (...given: unknown[]) => unknown)(...args);
  };
}

const journal = new ApplyJournal(new Database(job.database));
journal.claim({ applyId: job.applyId, requestId: job.requestId, runId: job.runId, proposalHash: "a".repeat(64), destination: plan.topLevel });
const result = await writeChange({ applyId: job.applyId, plan, journal, engineId: "engine-home-a", io });
if (job.calls) writeFileSync(job.calls, JSON.stringify({ calls, state: result.state }));
