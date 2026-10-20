import { createHash } from "node:crypto";
import { WorkspaceRefusal } from "./git-tool.ts";
import { PATCH_POLICY, type PatchPolicy, type PatchResult } from "./patch.ts";
import type { Snapshot } from "./snapshot.ts";

/**
 * A proposal binds a patch to where it may go (NIV-42, D34, D15). The binding holds:
 * - the project and the target;
 * - the destination: the repository's top level as it really is, and the picked folder's path in it;
 * - the object format and the baseline commit;
 * - the trees B and R the patch was checked between, and the snapshot's fingerprint;
 * - the policy the patch was made under, its version and its limits, taken from the patch itself;
 * - the digests of the patch and of the report made before the session closed.
 *
 * Its hash is the sha256 of the binding's canonical JSON, and that is what the person approves. Applying it (NIV-8)
 * first checks it again here: a wrong baseline, destination or hash is refused. Cleanup is a record of its own, so it
 * can't change what was approved.
 */

export const PROPOSAL_VERSION = 1;

export interface ProposalBinding {
  version: number;
  project: string;
  target: string;
  destination: { root: string; prefix: string };
  objectFormat: "sha1" | "sha256";
  baseline: string;
  baseTree: string;
  resultTree: string;
  fingerprint: string;
  policy: PatchPolicy;
  patchSha256: string;
  reportSha256: string;
}

export interface Proposal {
  binding: ProposalBinding;
  hash: string;
  patch: Uint8Array;
  report: Uint8Array;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const short = (id: string) => id.slice(0, 12);

/** JSON with every object's keys sorted and no spaces, so one value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON holds only finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON can't hold a ${typeof value}.`);
}

export const proposalHash = (binding: ProposalBinding) => sha256(canonicalJson(binding));

export function makeProposal(input: { project: string; target: string; snapshot: Snapshot; patch: PatchResult; report: Uint8Array }): Proposal {
  const { snapshot, patch } = input;
  const binding: ProposalBinding = {
    version: PROPOSAL_VERSION,
    project: input.project,
    target: input.target,
    destination: { root: snapshot.topLevel, prefix: snapshot.prefix },
    objectFormat: snapshot.objectFormat,
    baseline: snapshot.baseline,
    baseTree: patch.baseTree,
    resultTree: patch.resultTree,
    fingerprint: snapshot.fingerprint,
    policy: { ...patch.policy },
    patchSha256: patch.sha256,
    reportSha256: sha256(input.report),
  };
  return { binding, hash: proposalHash(binding), patch: patch.bytes, report: input.report };
}

export interface ProposalExpectation {
  project: string;
  target: string;
  destination: { root: string; prefix: string };
  /** The checkout's HEAD now: a patch goes only onto the commit it was made from. */
  head: string;
  /** The hash the person approved. */
  approvedHash: string;
  /** The rules a proposal must have been made under: Nivra's own unless a check says otherwise. */
  policy?: PatchPolicy;
}

/** Refuses a proposal that isn't intact, isn't the one approved, or isn't for these rules, this destination and commit. */
export function verifyProposal(proposal: Proposal, expected: ProposalExpectation): void {
  const { binding } = proposal;
  const refuse = (message: string) => new WorkspaceRefusal(message, "proposal");
  if (binding.version !== PROPOSAL_VERSION) throw refuse("This proposal was made under another version of Nivra's rules, so it can't be applied. Run the task again.");
  if (sha256(proposal.patch) !== binding.patchSha256 || sha256(proposal.report) !== binding.reportSha256 || proposalHash(binding) !== proposal.hash) {
    throw refuse("This proposal isn't intact: its patch, its report or what it binds no longer matches its hash, so it can't be applied. Run the task again.");
  }
  if (proposal.hash !== expected.approvedHash) throw refuse(`This isn't the proposal you approved (its hash is ${short(proposal.hash)}, not ${short(expected.approvedHash)}), so it wasn't applied.`);
  if (canonicalJson(binding.policy) !== canonicalJson(expected.policy ?? PATCH_POLICY)) throw refuse("This proposal was checked under other rules than the ones Nivra applies now, so it can't be applied. Run the task again.");
  if (binding.project !== expected.project || binding.target !== expected.target) throw refuse("This proposal was made for another project, or on another target, so it can't be applied here.");
  if (binding.destination.root !== expected.destination.root || binding.destination.prefix !== expected.destination.prefix) throw refuse("This proposal was made for another folder, so it can't be applied here.");
  if (binding.baseline !== expected.head) throw refuse(`Your checkout has moved to another commit (HEAD is ${short(expected.head)}, and the proposal was made from ${short(binding.baseline)}). Run the task again from the commit it is on now.`);
}

/** One step the run took, as its report shows it. */
export interface StepRecord {
  label: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  persisted: boolean;
  durationMs: number;
  /** The end of what it printed, bounded: text from the sandbox, never instructions. */
  stdoutTail: string;
  stderrTail: string;
}

const TAIL = 2_000;
const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text);

/**
 * The report the person reads before approving, as canonical JSON, so its digest can be bound. It holds what the
 * snapshot sent and left out, every step's outcome, and the change: deletions first, then additions, then changes, by
 * path, mode, size and digest, with the content only in the patch.
 */
export function buildReport(input: { snapshot: Snapshot; patch: PatchResult; steps: readonly StepRecord[] }): Uint8Array {
  const { snapshot, patch } = input;
  const { changes } = patch;
  const describe = (kind: string) => (change: PatchResult["changes"]["added"][number]) => ({ change: kind, path: change.path, mode: change.mode, bytes: change.bytes.byteLength, sha256: change.sha256 });
  const report = {
    version: 1,
    baseline: snapshot.baseline,
    prefix: snapshot.prefix,
    snapshot: {
      files: snapshot.files.length,
      leftOut: { secret: snapshot.leftOut.secret.count, output: snapshot.leftOut.output.count, submodule: snapshot.leftOut.submodule.count, excluded: snapshot.leftOut.excluded.count },
      untracked: snapshot.untracked.count,
      lfsPointers: snapshot.lfsPointers.count,
    },
    steps: input.steps.map((step) => ({ ...step, stdoutTail: tail(step.stdoutTail), stderrTail: tail(step.stderrTail) })),
    changes: [...changes.deleted.map((path) => ({ change: "deleted", path })), ...changes.added.map(describe("added")), ...changes.changed.map(describe("changed"))],
    modeChanges: changes.modeChanges,
    generatedLeftOut: changes.generated,
    patch: { bytes: patch.bytes.byteLength, sha256: patch.sha256 },
  };
  return new TextEncoder().encode(canonicalJson(report));
}
