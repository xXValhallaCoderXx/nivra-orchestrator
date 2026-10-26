import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ABSENT, ApplyRefusal, type ApplyRefusalCode, type RevalidationInput } from "../src/apply/plan.ts";
import { revalidate } from "../src/apply/revalidate.ts";
import type { ExecutionSession } from "../src/exec/backend.ts";
import { proposalHash, type Proposal, type ProposalBinding } from "../src/exec/proposal.ts";
import { readTar, writeTar, type TarEntry } from "../src/exec/tar.ts";
import { FIXED_GREET } from "../scripts/task-fixture.ts";
import { attempt, FIX, FIXTURE, type Step } from "./task-fixtures.ts";
import { changedSince, cleanUp, folderState, git, GIT, localSession, put, scratch, sha } from "./workspace-fixtures.ts";

/**
 * Revalidation before an apply (NIV-8, D40), on disposable repositories with real proposals: the worker's own, made
 * against the fake Nebius service by `attempt()`. Every refusal leaves the checkout as it was, names no path the
 * proposal doesn't bind, and holds no absolute path in its words. Nothing reaches a network.
 */
after(cleanUp);

const NOTES: Step = ["create_file", { path: "docs/NOTES.md", content: "Notes.\n" }];
const DEEP: Step = ["create_file", { path: "new/deep/run.sh", content: "echo hi\n" }];
const FIXING: Step = ["edit_file", FIX];

async function proposed(options: { calls?: Step[]; files?: Record<string, string> } = {}): Promise<{ proposal: Proposal; root: string }> {
  const run = await attempt({ ...(options.calls ? { calls: options.calls } : {}), ...(options.files ? { files: options.files } : {}) });
  assert.ok(run.result.proposal, `no proposal: ${run.result.outcome} ${run.result.stopped?.message ?? ""}`);
  return { proposal: run.result.proposal, root: run.root };
}

async function check(root: string, proposal: Proposal, overrides: Partial<RevalidationInput> = {}, wrap?: (session: ExecutionSession) => ExecutionSession) {
  const opened = await localSession(root);
  try {
    return await revalidate({ proposal, approvedHash: proposal.hash, repoPath: root, project: proposal.binding.project, target: proposal.binding.target, task: proposal.binding.task!, git: { session: wrap ? wrap(opened) : opened, git: GIT }, ...overrides });
  } finally {
    await opened.close();
  }
}

/** The refusal revalidation gives, checked for what it may say and name. */
async function refusalOf(root: string, proposal: Proposal, overrides: Partial<RevalidationInput> = {}, wrap?: (session: ExecutionSession) => ExecutionSession): Promise<ApplyRefusal> {
  const error = await check(root, proposal, overrides, wrap).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof ApplyRefusal, `expected a refusal, got ${String(error)}`);
  assert.ok(error.path === null || proposal.binding.paths.some((bound) => bound.path === error.path), `it names ${error.path}, which the proposal doesn't bind`);
  assert.doesNotMatch(error.message, /(^|[\s(])\//, "its words hold an absolute path");
  return error;
}

/** Refused with `code`, naming `path`, and the checkout exactly as it was, `.git` included. */
async function refused(root: string, proposal: Proposal, code: ApplyRefusalCode, path: string | null, overrides: Partial<RevalidationInput> = {}): Promise<void> {
  const before = folderState(root);
  const error = await refusalOf(root, proposal, overrides);
  assert.deepEqual([error.code, error.path], [code, path], `${error.message} (${error.detail})`);
  assert.deepEqual(changedSince(before, root), [], "the checkout changed");
}

/** The local session, with `change` made once git's status has been read: a save while revalidation runs. */
const racing =
  (change: () => void) =>
  (session: ExecutionSession): ExecutionSession => {
    let done = false;
    return {
      capabilities: session.capabilities,
      exec: async (request) => {
        const result = await session.exec(request);
        if (!done && request.argv.includes("status")) {
          done = true;
          change();
        }
        return result;
      },
      close: (options) => session.close(options),
    };
  };

/** The proposal with its binding (and, when given, its post-image) changed, hashed again and approved as such. */
function rebuilt(proposal: Proposal, change: (binding: ProposalBinding) => void, postImage?: Uint8Array): Proposal {
  const binding = structuredClone(proposal.binding);
  if (postImage) binding.postImageSha256 = sha(postImage);
  change(binding);
  return { ...proposal, binding, hash: proposalHash(binding), postImage: postImage ?? proposal.postImage };
}

const filesOf = (proposal: Proposal): TarEntry[] => readTar(proposal.postImage, { maxEntries: 64, maxBytes: proposal.postImage.byteLength, maxEntryBytes: proposal.postImage.byteLength, maxPathBytes: 1_024 }).filter((entry) => entry.kind === "file");

describe("revalidating a proposal before it is applied (NIV-8, D40)", () => {
  it("plans a change to the baseline's own file: its state now, its new bytes and mode, and writes nothing", async () => {
    const { proposal, root } = await proposed();
    const before = folderState(root);
    const plan = await check(root, proposal);
    assert.deepEqual(changedSince(before, root), []);
    const real = realpathSync.native(root);
    assert.deepEqual([plan.folder, plan.topLevel, plan.gitDir, plan.folders], [real, real, join(real, ".git"), []]);
    assert.deepEqual(plan.paths.map((one) => [one.path, one.change]), [["greet.sh", "changed"]]);
    const [greet] = plan.paths;
    assert.deepEqual(greet!.pre, { kind: "file", mode: "100644", size: Buffer.byteLength(FIXTURE["greet.sh"]!), sha256: sha(FIXTURE["greet.sh"]!) });
    assert.deepEqual(greet!.post, { mode: "100644", size: Buffer.byteLength(FIXED_GREET), sha256: sha(FIXED_GREET) });
    assert.equal(Buffer.from(greet!.bytes).toString(), FIXED_GREET);
  });

  it("plans added files and the folders to make for them, parents first", async () => {
    const { proposal, root } = await proposed({ calls: [NOTES, DEEP, FIXING] });
    const plan = await check(root, proposal);
    assert.deepEqual(plan.folders, ["docs", "new", "new/deep"]);
    assert.deepEqual(plan.paths.map((one) => [one.path, one.change, one.pre.kind, one.post.mode]), [
      ["docs/NOTES.md", "added", "absent", "100644"],
      ["greet.sh", "changed", "file", "100644"],
      ["new/deep/run.sh", "added", "absent", "100644"],
    ]);
    assert.deepEqual(plan.paths[0]!.pre, ABSENT);
    assert.deepEqual([Buffer.from(plan.paths[0]!.bytes).toString(), plan.paths[0]!.post.sha256], ["Notes.\n", sha("Notes.\n")]);
  });

  it("refuses a checkout whose HEAD moved since the proposal was made", async () => {
    const { proposal, root } = await proposed();
    put(root, "later.txt", "later\n");
    git(root, ["add", "later.txt"]);
    git(root, ["commit", "-q", "-m", "later"]);
    await refused(root, proposal, "baseline-moved", null);
  });

  it("refuses tracked changes, staged or not, and files git is told not to look at", async () => {
    const { proposal, root } = await proposed();
    writeFileSync(join(root, "check.sh"), "exit 0\n");
    await refused(root, proposal, "uncommitted", null);
    git(root, ["checkout", "-q", "--", "check.sh"]);
    put(root, "staged.txt", "staged\n");
    git(root, ["add", "staged.txt"]);
    await refused(root, proposal, "uncommitted", null);
    git(root, ["rm", "-q", "--cached", "staged.txt"]);
    rmSync(join(root, "staged.txt"));
    git(root, ["update-index", "--assume-unchanged", "check.sh"]);
    await refused(root, proposal, "uncommitted", null);
    git(root, ["update-index", "--no-assume-unchanged", "check.sh"]);
    // A file the change replaces, made a link or a folder, or edited: git sees it first.
    writeFileSync(join(root, "greet.sh"), "edited\n");
    await refused(root, proposal, "uncommitted", null);
    rmSync(join(root, "greet.sh"));
    symlinkSync("check.sh", join(root, "greet.sh"));
    await refused(root, proposal, "uncommitted", null);
    rmSync(join(root, "greet.sh"));
    mkdirSync(join(root, "greet.sh"));
    await refused(root, proposal, "uncommitted", null);
  });

  it("refuses while a merge or a rebase is under way, though HEAD is still the baseline", async () => {
    const { proposal, root } = await proposed();
    git(root, ["checkout", "-q", "-b", "other"]);
    put(root, "other.txt", "other\n");
    git(root, ["add", "other.txt"]);
    git(root, ["commit", "-q", "-m", "other"]);
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-commit", "--no-ff", "other"]);
    assert.ok(existsSync(join(root, ".git", "MERGE_HEAD")));
    await refused(root, proposal, "operation", null);
    git(root, ["merge", "--abort"]);
    // Stopped by its own command after the first pick, which fast-forwards: HEAD is still the baseline.
    assert.throws(() => git(root, ["-c", "sequence.editor=:", "rebase", "-x", "false", "--root"]));
    assert.ok(existsSync(join(root, ".git", "rebase-merge")));
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), proposal.binding.baseline);
    await refused(root, proposal, "operation", null);
  });

  it("refuses a changed file whose mode changed where git doesn't look (core.fileMode off)", async () => {
    const { proposal, root } = await proposed();
    git(root, ["config", "core.fileMode", "false"]);
    chmodSync(join(root, "greet.sh"), 0o755);
    await refused(root, proposal, "changed-since", "greet.sh");
  });

  it("refuses a changed file saved after git's check: its bytes, a link, a folder, a parent made a link", async () => {
    const { proposal, root } = await proposed();
    const greet = join(root, "greet.sh");
    const original = readFileSync(greet);
    for (const change of [
      () => writeFileSync(greet, "saved meanwhile\n"),
      () => (rmSync(greet), symlinkSync("check.sh", greet)),
      () => (rmSync(greet), mkdirSync(greet)),
    ]) {
      const error = await refusalOf(root, proposal, {}, racing(change));
      assert.deepEqual([error.code, error.path], ["changed-since", "greet.sh"], `${error.message} (${error.detail})`);
      rmSync(greet, { recursive: true, force: true });
      writeFileSync(greet, original);
    }
    // A file in a folder that becomes a link to an identical copy of it: never written through.
    const nested = await proposed({ files: { ...FIXTURE, "lib/notes.txt": "a\n" }, calls: [["edit_file", { path: "lib/notes.txt", old_text: "a", new_text: "b" }]] });
    const lib = join(nested.root, "lib");
    const error = await refusalOf(nested.root, nested.proposal, {}, racing(() => (renameSync(lib, `${lib}-real`), symlinkSync(`${lib}-real`, lib))));
    assert.deepEqual([error.code, error.path], ["changed-since", "lib/notes.txt"], `${error.message} (${error.detail})`);
  });

  it("refuses an added path that is taken, or whose folder is a file or a link", async () => {
    const { proposal, root } = await proposed({ calls: [NOTES] });
    put(root, "docs/NOTES.md", "mine\n");
    await refused(root, proposal, "collision", "docs/NOTES.md");
    rmSync(join(root, "docs"), { recursive: true });
    put(root, "docs", "a file\n");
    await refused(root, proposal, "collision", "docs/NOTES.md");
    rmSync(join(root, "docs"));
    symlinkSync(scratch("elsewhere"), join(root, "docs"));
    await refused(root, proposal, "collision", "docs/NOTES.md");
  });

  it("refuses an added name that differs from one there only by case or Unicode form", async () => {
    const { proposal, root } = await proposed({ calls: [["create_file", { path: "Notes.md", content: "n\n" }], ["create_file", { path: "café.md", content: "c\n" }], NOTES] });
    put(root, "NOTES.md", "mine\n");
    await refused(root, proposal, "collision", "Notes.md");
    rmSync(join(root, "NOTES.md"));
    put(root, "café.md", "mine\n");
    await refused(root, proposal, "collision", "café.md");
    rmSync(join(root, "café.md"));
    // A folder the change makes, beside one there that differs only by case.
    put(root, "DOCS/other.txt", "mine\n");
    await refused(root, proposal, "collision", "docs/NOTES.md");
    rmSync(join(root, "DOCS"), { recursive: true });
    await check(root, proposal);
  });

  it("refuses a proposal that isn't intact, isn't the approved one, or isn't for this project, folder, attempt or engine", async () => {
    const { proposal, root } = await proposed();
    const task = proposal.binding.task!;
    await refused(root, { ...proposal, patch: new Uint8Array([...proposal.patch, 0x0a]) }, "proposal", null);
    await refused(root, { ...proposal, postImage: new Uint8Array([...proposal.postImage.slice(0, -1), 1]) }, "proposal", null);
    await refused(root, proposal, "proposal", null, { approvedHash: "0".repeat(64) });
    await refused(root, proposal, "proposal", null, { project: randomUUID() });
    await refused(root, proposal, "proposal", null, { target: "wsl:Other" });
    await refused(root, proposal, "proposal", null, { task: { ...task, attempt: { ...task.attempt, attemptId: randomUUID() } } });
    await refused(root, proposal, "proposal", null, { task: { ...task, engine: { homeId: randomUUID() } } });
    await refused(root, proposal, "proposal", null, { task: { ...task, brief: { ...task.brief, version: task.brief.version + 1 } } });
    // A clone at the same commit is another folder.
    const clone = join(scratch("clone"), "repo");
    git(root, ["clone", "-q", root, clone]);
    await refused(clone, proposal, "proposal", null);
  });

  it("refuses a proposal whose post-image doesn't hold exactly the bound files, or whose paths Nivra doesn't apply", async () => {
    const { proposal, root } = await proposed({ calls: [NOTES, FIXING] });
    const unbound: ProposalBinding["paths"][number] = { path: "extra.txt", change: "added", before: null, after: { mode: "100644", sha256: sha("x") } };
    const bound = (binding: ProposalBinding, one: ProposalBinding["paths"][number]) => void binding.paths.push(one);
    const missing = rebuilt(proposal, (binding) => bound(binding, unbound));
    await refused(root, missing, "proposal", "extra.txt", { approvedHash: missing.hash });
    const extra = rebuilt(proposal, () => {}, writeTar([...filesOf(proposal), { path: "extra.txt", kind: "file", executable: false, bytes: new TextEncoder().encode("x") }]));
    await refused(root, extra, "proposal", null, { approvedHash: extra.hash });
    // As many entries as it should hold, one of them a link where a file is bound.
    const swapped = rebuilt(proposal, () => {}, writeTar(filesOf(proposal).map((entry): TarEntry => (entry.path === "docs/NOTES.md" ? { path: entry.path, kind: "link", target: "greet.sh" } : entry))));
    await refused(root, swapped, "proposal", null, { approvedHash: swapped.hash });
    const deletion = rebuilt(proposal, (binding) => bound(binding, { path: "check.sh", change: "deleted", before: null, after: null }));
    await refused(root, deletion, "path", "check.sh", { approvedHash: deletion.hash });
    assert.equal((await refusalOf(root, deletion, { approvedHash: deletion.hash })).detail, "a deletion");
    // A name with a control character in it is refused without being named.
    const odd = rebuilt(proposal, (binding) => bound(binding, { path: "odd\u0007.txt", change: "added", before: null, after: { mode: "100644", sha256: sha("x") } }));
    await refused(root, odd, "path", null, { approvedHash: odd.hash });
    // A new path must hold on every target, as for the patch: Windows reserves con.
    const reserved = rebuilt(proposal, (binding) => bound(binding, { path: "con.txt", change: "added", before: null, after: { mode: "100644", sha256: sha("x") } }));
    await refused(root, reserved, "path", null, { approvedHash: reserved.hash });
    const linked = rebuilt(proposal, (binding) => {
      const notes = binding.paths.find((one) => one.path === "docs/NOTES.md")!;
      notes.after = { ...notes.after!, mode: "120000" };
    });
    await refused(root, linked, "path", "docs/NOTES.md", { approvedHash: linked.hash });
    const born = rebuilt(proposal, (binding) => {
      const notes = binding.paths.find((one) => one.path === "docs/NOTES.md")!;
      notes.before = { mode: "100644", sha256: sha("") };
    });
    await refused(root, born, "proposal", "docs/NOTES.md", { approvedHash: born.hash });
    const other = rebuilt(proposal, (binding) => {
      const greet = binding.paths.find((one) => one.path === "greet.sh")!;
      greet.after = { ...greet.after!, sha256: sha("something else") };
    });
    await refused(root, other, "proposal", "greet.sh", { approvedHash: other.hash });
    const modeChange = rebuilt(proposal, (binding) => {
      const greet = binding.paths.find((one) => one.path === "greet.sh")!;
      greet.after = { ...greet.after!, mode: "100755" };
    });
    await refused(root, modeChange, "path", "greet.sh", { approvedHash: modeChange.hash });
    const git_ = rebuilt(proposal, (binding) => bound(binding, { path: ".gitattributes", change: "added", before: null, after: { mode: "100644", sha256: sha("") } }));
    await refused(root, git_, "path", ".gitattributes", { approvedHash: git_.hash });
    // Two new folders one filesystem would take for one.
    const docs = { path: "Docs/more.md", kind: "file" as const, executable: false, bytes: new TextEncoder().encode("more\n") };
    const folded = rebuilt(proposal, (binding) => bound(binding, { path: docs.path, change: "added", before: null, after: { mode: "100644", sha256: sha(docs.bytes) } }), writeTar([...filesOf(proposal), docs]));
    await refused(root, folded, "collision", "docs/NOTES.md", { approvedHash: folded.hash });
  });

  it("refuses a touched file with an attribute that rewrites it on checkout: a filter, ident, eol, crlf, or text that converts", async () => {
    for (const attributes of ["greet.sh filter=x\n", "greet.sh ident\n", "greet.sh eol=crlf\n", "greet.sh working-tree-encoding=UTF-8\n"]) {
      const { proposal, root } = await proposed({ files: { ...FIXTURE, ".gitattributes": attributes } });
      await refused(root, proposal, "attributes", "greet.sh");
    }
    // Text, or the old crlf, converts nothing on checkout until the configuration asks for CRLF; eol=lf never does.
    for (const attributes of ["greet.sh text\n", "greet.sh crlf\n", "* text=auto eol=lf\n"]) {
      const { proposal, root } = await proposed({ files: { ...FIXTURE, ".gitattributes": attributes } });
      await check(root, proposal);
      git(root, ["config", "core.autocrlf", "true"]);
      if (attributes.includes("eol=lf")) await check(root, proposal);
      else await refused(root, proposal, "attributes", "greet.sh");
    }
    // core.autocrlf alone converts every file not marked binary: refused for that, never as a file changed since.
    const plain = await proposed();
    git(plain.root, ["config", "core.autocrlf", "true"]);
    await refused(plain.root, plain.proposal, "attributes", "greet.sh");
  });

  it("refuses when the picked folder, or a folder the change writes in, can't be read, saying so", async () => {
    const { proposal, root } = await proposed();
    await refused(root, proposal, "filesystem", null, { repoPath: join(root, "gone") });
    // A folder made unreadable once git's status has been read.
    const nested = await proposed({ files: { ...FIXTURE, "lib/notes.txt": "a\n" }, calls: [["edit_file", { path: "lib/notes.txt", old_text: "a", new_text: "b" }]] });
    const lib = join(nested.root, "lib");
    try {
      const error = await refusalOf(nested.root, nested.proposal, {}, racing(() => chmodSync(lib, 0)));
      assert.deepEqual([error.code, error.path], ["filesystem", null], `${error.message} (${error.detail})`);
    } finally {
      chmodSync(lib, 0o755);
    }
  });
});
