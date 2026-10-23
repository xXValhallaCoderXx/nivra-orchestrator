import { createHash } from "node:crypto";
import type { CloseReport, ExecutionBackend, ExecutionSession, SessionStep } from "../src/exec/backend.ts";
import { SandboxApi, type Transport } from "../src/exec/nebius/api.ts";
import { collectResult } from "../src/exec/patch.ts";
import type { Snapshot } from "../src/exec/snapshot.ts";
import { WorkspaceCopy } from "../src/task/copy.ts";
import { checkRequest, judgeCase, type CheckResult } from "../src/task/harness.ts";
import { writeRequest } from "../src/task/scripts.ts";
import { TASK_BRIEF, trickyGreet } from "./task-fixture.ts";

/**
 * The toolchain probe's five operations (NIV-7, D39), on any backend: the live script runs them on Nebius, and a test
 * rehearses them on the fake service with a guest that really runs commands. No model is called and nothing is
 * installed; networking is off for every operation.
 * 1. prepare: the fixture's snapshot extracted, its listing checked (the session's own open);
 * 2. `/bin/busybox --list`, disposable: which tools the image has;
 * 3. one persisted write of greet.sh, fixed, with tricky content padded to the most one write carries; then a read
 *    back, compared byte for byte, and a read of the operation's record, to see whether it keeps the arguments;
 * 4. the acceptance case, disposable: it must see the write, from the image the write left;
 * 5. collect, with its two reads: the result must be exactly the fixture plus the write.
 */

export interface ProbeOutcome {
  opened: boolean;
  /** What stopped the probe early, in its own words; null when all five ran. */
  stopped: string | null;
  applets: { exitCode: number | null; status: string | null; list: string[] } | null;
  write: { exitCode: number | null; persisted: boolean; bytes: number; sha256: string; readBack: string | null; exact: boolean } | null;
  /** Whether the write's operation record holds its content: what Nebius keeps of a write's arguments. */
  record: { read: boolean; holdsContent: boolean | null; fields: string[] } | null;
  kase: CheckResult | null;
  collect: { entries: number; integrity: string | null } | null;
  steps: SessionStep[];
  cleanup: CloseReport | null;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
/** A phrase only the tricky write holds: found in a record, the record keeps the write's content. */
export const WRITE_MARKER = "padding to the most one write carries";

/** The fields of an operation's record, at any depth, whose text holds the marker. */
function fieldsHolding(value: unknown, marker: string, path = ""): string[] {
  if (typeof value === "string") return value.includes(marker) ? [path || "(root)"] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => fieldsHolding(item, marker, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => fieldsHolding(item, marker, path ? `${path}.${key}` : key));
  return [];
}

export async function runToolchainProbe(input: {
  backend: ExecutionBackend;
  snapshot: Snapshot;
  /** For reading the write's operation record. */
  transport: Transport;
  budgetMs: number;
  closeBudgetMs: number;
  workspace?: string;
  applets?: string;
  signal?: AbortSignal;
  closeSignal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<ProbeOutcome> {
  const workspace = input.workspace ?? "/workspace";
  const log = input.log ?? (() => {});
  const closing = { budgetMs: input.closeBudgetMs, ...(input.closeSignal ? { signal: input.closeSignal } : {}) };
  const outcome: ProbeOutcome = { opened: false, stopped: null, applets: null, write: null, record: null, kase: null, collect: null, steps: [], cleanup: null };
  let session: ExecutionSession;
  try {
    session = await input.backend.open({ workspace, network: "deny", requires: { isolatesFilesystem: true }, snapshot: input.snapshot.archive, budgetMs: input.budgetMs, closing, ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    outcome.stopped = `prepare: ${error instanceof Error ? error.message : String(error)}`;
    outcome.cleanup = error && typeof error === "object" && "report" in error ? ((error as { report: CloseReport }).report ?? null) : null;
    return outcome;
  }
  outcome.opened = true;
  log("1. prepare: the fixture is in the sandbox, its listing matched.");
  try {
    const applets = await session.exec({ argv: ["/bin/busybox", "--list"], cwd: workspace, timeoutMs: 30_000, maxOutputBytes: 65_536, persist: false, label: "applets" });
    outcome.applets = { exitCode: applets.exitCode, status: session.steps?.().at(-1)?.status ?? null, list: applets.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort() };
    log(`2. applets: exit ${String(applets.exitCode)}, ${outcome.applets.list.length} listed.`);

    const content = trickyGreet();
    const bytes = new TextEncoder().encode(content);
    const wrote = await session.exec(writeRequest({ workspace, path: "greet.sh", content, created: false, timeoutMs: 30_000, ...(input.applets !== undefined ? { applets: input.applets } : {}) }));
    const back = wrote.persisted ? await session.download!(`${workspace}/greet.sh`, bytes.byteLength + 1, { timeoutMs: 30_000 }) : null;
    outcome.write = { exitCode: wrote.exitCode, persisted: wrote.persisted, bytes: bytes.byteLength, sha256: sha256(bytes), readBack: back?.sha256 ?? null, exact: back?.sha256 === sha256(bytes) };
    log(`3. write: exit ${String(wrote.exitCode)}, ${wrote.persisted ? "kept" : "not kept"}, read back ${outcome.write.exact ? "exactly" : "differently"} (${bytes.byteLength} bytes).`);
    const operationId = session.steps?.().at(-1)?.operationId ?? null;
    if (operationId) {
      try {
        const record = await new SandboxApi(input.transport, { requestTimeoutMs: 30_000 }).operation(operationId, { until: performance.now() + 60_000 });
        const fields = fieldsHolding(record, WRITE_MARKER);
        outcome.record = { read: true, holdsContent: fields.length > 0, fields };
      } catch {
        outcome.record = { read: false, holdsContent: null, fields: [] };
      }
      log(`   record: ${outcome.record.read ? (outcome.record.holdsContent ? `keeps the content (${outcome.record.fields.join(", ")})` : "doesn't hold the content") : "couldn't be read"}.`);
    }
    if (!outcome.write.exact) {
      outcome.stopped = "write: the sandbox doesn't hold exactly what was written, so the probe stopped.";
      return outcome;
    }

    const given = TASK_BRIEF.acceptanceCases[0]!;
    const ran = await session.exec(checkRequest({ workspace, command: given.command, label: "case" }));
    outcome.kase = judgeCase(1, given, ran);
    log(`4. case: ${outcome.kase.verdict}${outcome.kase.reason ? ` (${outcome.kase.reason})` : ""}.`);

    const collected = await collectResult(session, { workspace, timeoutMs: 60_000, downloadTimeoutMs: 60_000, ...(input.applets !== undefined ? { applets: input.applets } : {}) });
    const copy = new WorkspaceCopy(input.snapshot);
    copy.record("greet.sh", bytes);
    let integrity: string | null = null;
    try {
      copy.checkIntegrity(collected.collected);
    } catch (error) {
      integrity = error instanceof Error ? error.message : String(error);
    }
    outcome.collect = { entries: collected.collected.entries.length, integrity };
    log(`5. collect: ${collected.collected.entries.length} entries; ${integrity ?? "exactly the fixture plus the write"}.`);
  } catch (error) {
    outcome.stopped = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    outcome.cleanup = await session.close(closing);
    outcome.steps = [...(session.steps?.() ?? [])];
  }
  return outcome;
}
