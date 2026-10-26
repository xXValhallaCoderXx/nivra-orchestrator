import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type ApplyIo, nodeIo } from "../src/apply/io.ts";
import { ApplyJournal } from "../src/apply/journal.ts";
import { ApplyRefusal, type PlannedPath, type RevalidatedPlan } from "../src/apply/plan.ts";
import { type ApplyHook, type ApplyResult, reconcile, restore, stateOf, writeChange } from "../src/apply/writer.ts";
import { Database } from "../src/db/database.ts";
import { byBytes } from "../src/exec/workspace-rules.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { cleanUp, folderState, git, repoWith } from "./workspace-fixtures.ts";

/**
 * The apply writer (NIV-8, D40) on disposable repositories: a change applied with its originals kept aside, the claim
 * and the lock, refusals that write nothing of the person's, another program's saves at each gap, and every
 * filesystem call failed in turn, rollback's own included. A plan is worked out here from the checkout, as
 * revalidation would give it: `revalidate.ts` has tests of its own.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

const ENGINE = "engine-home-a";
const FAULTS = ["EACCES", "ENOSPC", "EBUSY", "EXDEV", "EIO"] as const;
const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const FILES = { "greet.sh": { executable: "greet() {\n  printf 'Hello, %s\\n' \"$1\"\n}\n" }, "README.md": "# Greet\n", "docs/old.md": "old\n" };
/** One changed executable, one changed plain file, and one added two folders deep. */
const CHANGE = { "greet.sh": { text: "greet() {\n  printf 'Hello, %s\\n' \"${1:-world}\"\n}\n" }, "README.md": { text: "# Greet\n\nSays hello.\n" }, "notes/2026/today.md": { text: "Fixed the default name.\n" } };

/** Fresh copies of one fixture repository: quicker than making each with git, for the hundreds of fault runs. */
function copies(): () => string {
  const template = repoWith(FILES);
  return () => {
    const parent = tempDir();
    dirs.push(parent);
    const root = join(parent, "repo ü%#");
    cpSync(template, root, { recursive: true, preserveTimestamps: true });
    return root;
  };
}

function journalIn(): ApplyJournal {
  const dir = tempDir();
  dirs.push(dir);
  return new ApplyJournal(new Database(join(dir, "nivra.db")));
}

/** A plan as revalidation gives it: each path's state now, its new bytes, and the folders to make. */
function planFor(root: string, changes: Record<string, { text: string; executable?: boolean }>): RevalidatedPlan {
  const folder = realpathSync.native(root);
  const paths = Object.entries(changes)
    .map(([path, change]): PlannedPath => {
      const pre = stateOf(nodeIo, join(folder, path));
      const bytes = encode(change.text);
      const mode = change.executable ? "100755" : pre.kind === "file" ? pre.mode! : "100644";
      return { path, change: pre.kind === "absent" ? "added" : "changed", pre, post: { mode, size: bytes.byteLength, sha256: sha256(bytes) }, bytes };
    })
    .sort((a, b) => byBytes(a.path, b.path));
  const folders = new Set<string>();
  for (const one of paths) {
    const parts = one.path.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const name = parts.slice(0, depth).join("/");
      if (!existsSync(join(folder, name))) folders.add(name);
    }
  }
  return { folder, topLevel: folder, gitDir: realpathSync.native(join(folder, ".git")), folders: [...folders].sort(byBytes), paths };
}

async function apply(root: string, options: { changes?: Record<string, { text: string; executable?: boolean }>; io?: ApplyIo; before?: ApplyHook; journal?: ApplyJournal; plan?: RevalidatedPlan } = {}) {
  const plan = options.plan ?? planFor(root, options.changes ?? CHANGE);
  const journal = options.journal ?? journalIn();
  const applyId = randomUUID();
  journal.claim({ applyId, requestId: randomUUID(), runId: randomUUID(), proposalHash: "a".repeat(64), destination: plan.topLevel });
  let outcome: ApplyResult | ApplyRefusal;
  try {
    outcome = await writeChange({ applyId, plan, journal, engineId: ENGINE, ...(options.io ? { io: options.io } : {}), ...(options.before ? { before: options.before } : {}) });
  } catch (error) {
    if (!(error instanceof ApplyRefusal)) throw error;
    journal.refuse(applyId, error);
    outcome = error;
  }
  return { outcome, plan, journal, applyId, recovery: join(plan.gitDir, "nivra-apply", applyId) };
}

/** Wraps the filesystem, counting each call: one fails with `code` at a chosen count, so every step can be failed. */
function faulty(fail: Array<{ at: number; code: string }> = []): ApplyIo & { calls: string[] } {
  const calls: string[] = [];
  const io = { calls } as ApplyIo & { calls: string[] };
  for (const name of Object.keys(nodeIo) as Array<keyof ApplyIo>) {
    (io as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const at = calls.length;
      calls.push(name);
      const failing = fail.find((one) => one.at === at);
      if (failing) throw Object.assign(new Error(`injected ${failing.code}`), { code: failing.code });
      return (nodeIo[name] as (...given: unknown[]) => unknown)(...args);
    };
  }
  return io;
}

const files = (root: string, path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null);
const modeOf = (root: string, path: string) => lstatSync(join(root, path)).mode & 0o7777;
/** Every file's digest in a folder, for finding where a version went. */
const digests = (folder: string) => (existsSync(folder) ? readdirSync(folder).map((name) => sha256(readFileSync(join(folder, name)))) : []);

/**
 * What must hold however an apply ends: every version of every file is in place or in the recovery folder; what the
 * result says matches what is on disk; and one that wasn't applied left every path as it was.
 */
function holds(outcome: ApplyResult | ApplyRefusal, run: { plan: RevalidatedPlan; recovery: string; journal: ApplyJournal; applyId: string }, what: string): void {
  const { plan, recovery } = run;
  const root = plan.folder;
  if (outcome instanceof ApplyRefusal) {
    for (const one of plan.paths) assert.deepEqual(stateOf(nodeIo, join(root, one.path)), one.pre, `${what}: refused, yet ${one.path} changed`);
    return;
  }
  // The person's originals: each one in place or in the recovery folder. (A new file that was never written existed
  // nowhere, and the proposal keeps its bytes.)
  const kept = new Set(digests(recovery));
  for (const one of plan.paths) {
    const here = stateOf(nodeIo, join(root, one.path)).sha256;
    if (one.change === "changed") assert.ok(here === one.pre.sha256 || kept.has(one.pre.sha256!), `${what}: ${one.path}'s original is neither in place nor kept`);
  }
  // What the result claims is so: a path it couldn't read it calls other, which claims nothing.
  const record = run.journal.get(run.applyId)!;
  const seen = reconcile(record.intent!);
  for (const [index, one] of outcome.paths.entries()) {
    if (one.place === "pre" || one.place === "post" || one.place === "aside") assert.equal(one.place, seen.paths[index]!.place, `${what}: the result says ${one.path} is ${one.place}`);
  }
  assert.equal(record.state, outcome.state, `${what}: the journal says ${record.state}`);
  if (outcome.state === "applied") assert.equal(seen.state, "applied", `${what}: applied, yet not on disk`);
  if (outcome.state === "not-applied") for (const one of plan.paths) assert.deepEqual(stateOf(nodeIo, join(root, one.path)), one.pre, `${what}: not applied, yet ${one.path} changed`);
}

describe("the apply writer (NIV-8, D40)", () => {
  it("applies a change: each original moved aside and kept, each new file linked into place with its exact mode, nothing staged", async () => {
    const root = repoWith(FILES);
    const umask = process.umask(0o077);
    let run;
    try {
      run = await apply(root);
    } finally {
      process.umask(umask);
    }
    const { outcome, recovery, journal, applyId } = run;
    assert.ok(!(outcome instanceof ApplyRefusal));
    assert.deepEqual([outcome.state, outcome.paths.map((one) => `${one.path} ${one.place}`), outcome.folders, outcome.failure], ["applied", ["README.md post", "greet.sh post", "notes/2026/today.md post"], ["notes", "notes/2026"], null]);
    assert.deepEqual([String(files(root, "greet.sh")), String(files(root, "notes/2026/today.md"))], [CHANGE["greet.sh"].text, CHANGE["notes/2026/today.md"].text]);
    // The executable stays executable, and an added file gets 0644 whatever the umask; the originals' bytes are kept.
    assert.deepEqual([modeOf(root, "greet.sh"), modeOf(root, "README.md"), modeOf(root, "notes/2026/today.md")], [0o755, 0o644, 0o644]);
    assert.deepEqual(readdirSync(recovery).sort(), ["new-0", "new-1", "new-2", "orig-0", "orig-1"]);
    assert.deepEqual(outcome.paths.map((one) => one.kept), [["orig-0"], ["orig-1"], []]);
    assert.equal(String(readFileSync(join(recovery, "orig-1"))), FILES["greet.sh"].executable);
    // Unstaged: the index is the commit's, and git sees two changed files and an untracked folder.
    assert.deepEqual([git(root, ["diff", "--cached", "--name-only"]), git(root, ["status", "--porcelain"]).split("\n").filter(Boolean).sort()], ["", [" M README.md", " M greet.sh", "?? notes/"]]);
    assert.deepEqual([journal.get(applyId)?.state, journal.get(applyId)?.created, existsSync(join(root, ".git", "nivra-apply", "lock"))], ["applied", ["notes", "notes/2026"], false]);
  });

  it("claims a folder for one apply: a repeated request gets its apply, another is refused while one is open, and an applied proposal isn't applied again", () => {
    const journal = journalIn();
    const claim = (requestId: string, runId: string) => journal.claim({ applyId: randomUUID(), requestId, runId, proposalHash: "a".repeat(64), destination: "/repo" });
    const first = claim("request-1", "run-1");
    assert.deepEqual([claim("request-1", "run-1").record.id, claim("request-1", "run-1").repeated, first.record.state], [first.record.id, true, "claimed"]);
    // Refused while one is open, and kept under its request id: a repeat gets the same refusal.
    const busy = claim("request-2", "run-2");
    assert.deepEqual([busy.record.state, busy.record.refusal, claim("request-2", "run-2").record.id], ["refused", { code: "busy", path: null }, busy.record.id]);
    journal.intend(first.record.id, { version: 1, applyId: first.record.id, folder: "/repo", gitDir: "/repo/.git", recovery: "/repo/.git/nivra-apply/x", folders: [], paths: [] });
    journal.settle(first.record.id, { state: "applied", paths: [], folders: [], failure: null });
    assert.deepEqual(claim("request-3", "run-1").record.refusal, { code: "duplicate", path: null });
    // A claim refused after it was made frees the folder; so does an applied one.
    const second = claim("request-4", "run-2");
    journal.refuse(second.record.id, new ApplyRefusal("collision", "a.txt"));
    assert.deepEqual([journal.get(second.record.id)?.refusal, claim("request-5", "run-2").record.state], [{ code: "collision", path: "a.txt" }, "claimed"]);
  });

  it("refuses while another engine holds the folder's lock, writing nothing", async () => {
    const root = repoWith(FILES);
    mkdirSync(join(root, ".git", "nivra-apply"));
    writeFileSync(join(root, ".git", "nivra-apply", "lock"), JSON.stringify({ engine: "engine-home-b", applyId: "theirs" }));
    const before = folderState(root);
    const run = await apply(root);
    assert.ok(run.outcome instanceof ApplyRefusal && run.outcome.code === "busy");
    assert.deepEqual([...folderState(root)].filter(([key, value]) => before.get(key) !== value), []);
  });

  it("takes over its own engine's lock left by an apply that is over", async () => {
    const root = repoWith(FILES);
    const journal = journalIn();
    const first = await apply(root, { journal, changes: { "README.md": { text: "first\n" } } });
    assert.ok(!(first.outcome instanceof ApplyRefusal) && first.outcome.state === "applied");
    // As if the unlock had failed: the lock names an apply that is over, so the same engine takes it over.
    writeFileSync(join(root, ".git", "nivra-apply", "lock"), JSON.stringify({ engine: ENGINE, applyId: first.applyId }));
    git(root, ["checkout", "--", "README.md"]);
    const second = await apply(root, { journal, changes: { "README.md": { text: "second\n" } } });
    assert.ok(!(second.outcome instanceof ApplyRefusal) && second.outcome.state === "applied");
  });

  it("refuses when hard links don't work in the git folder or it is on another filesystem, taking back what it made there", async () => {
    const root = repoWith(FILES);
    const tree = () => [...folderState(root)].filter(([key]) => !key.startsWith(".git")).sort();
    const before = tree();
    // Links refused in the recovery folder: everything made in the git folder is taken back.
    const noLinks = faulty();
    const linkless: ApplyIo = { ...noLinks, link: () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); } };
    const refused = await apply(root, { io: linkless });
    assert.ok(refused.outcome instanceof ApplyRefusal && refused.outcome.code === "recovery");
    assert.deepEqual([tree(), existsSync(join(root, ".git", "nivra-apply"))], [before, false]);
    // The git folder on another device: refused before anything is made at all.
    const all = folderState(root);
    const elsewhere: ApplyIo = { ...nodeIo, stat: (path) => (path.endsWith(".git") ? ({ ...nodeIo.stat(path), dev: -1 } as ReturnType<ApplyIo["stat"]>) : nodeIo.stat(path)) };
    const far = await apply(root, { io: elsewhere });
    assert.ok(far.outcome instanceof ApplyRefusal && far.outcome.code === "recovery");
    assert.deepEqual([...folderState(root)].filter(([key, value]) => all.get(key) !== value), []);
  });

  it("refuses a changed file whose mode changed since it was checked, before anything of the person's is touched", async () => {
    const root = repoWith(FILES);
    const plan = planFor(root, CHANGE);
    chmodSync(join(root, "README.md"), 0o755);
    const run = await apply(root, { plan });
    assert.ok(run.outcome instanceof ApplyRefusal && run.outcome.code === "changed-since" && run.outcome.path === "README.md");
    assert.deepEqual([String(files(root, "README.md")), existsSync(run.recovery)], [FILES["README.md"], false]);
  });

  it("puts back a save made between the check and the move aside: not applied, nothing lost", async () => {
    const root = repoWith(FILES);
    const run = await apply(root, { before: (step) => void (step === "aside 0" && writeFileSync(join(root, "README.md"), "saved by an editor\n")) });
    assert.ok(!(run.outcome instanceof ApplyRefusal));
    assert.deepEqual([run.outcome.state, run.outcome.paths.map((one) => `${one.path} ${one.place}`), run.outcome.failure?.code], ["not-applied", ["README.md theirs", "greet.sh pre", "notes/2026/today.md pre"], "changed"]);
    assert.equal(String(files(root, "README.md")), "saved by an editor\n");
    assert.deepEqual(run.outcome.folders, []);
  });

  it("leaves a save made after the move aside in place: the link refuses, and the original is kept", async () => {
    const root = repoWith(FILES);
    const run = await apply(root, { before: (step) => void (step === "link 0" && writeFileSync(join(root, "README.md"), "saved in the gap\n")) });
    assert.ok(!(run.outcome instanceof ApplyRefusal));
    assert.deepEqual([run.outcome.state, run.outcome.paths[0]?.place, run.outcome.paths[0]?.kept, run.outcome.failure?.code], ["not-applied", "theirs", ["orig-0"], "EEXIST"]);
    assert.deepEqual([String(files(root, "README.md")), String(readFileSync(join(run.recovery, "orig-0")))], ["saved in the gap\n", FILES["README.md"]]);
  });

  it("keeps a save made after Nivra's write when it rolls back: that version stays, the path is partial, and the original is kept", async () => {
    const root = repoWith(FILES);
    let edited = false;
    const io = faulty();
    const failing: ApplyIo = {
      ...io,
      // The added file's link fails, after both changed files were written.
      link: (existing, created) => {
        if (created.endsWith("today.md")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        nodeIo.link(existing, created);
      },
    };
    const run = await apply(root, {
      io: failing,
      before: (step) => {
        if (step === "link 2" && !edited) {
          edited = true;
          writeFileSync(join(root, "README.md"), "edited after Nivra wrote it\n");
        }
      },
    });
    assert.ok(!(run.outcome instanceof ApplyRefusal));
    assert.deepEqual([run.outcome.state, run.outcome.paths.map((one) => `${one.path} ${one.place}${one.changedSince ? " since" : ""}`)], ["partial", ["README.md theirs since", "greet.sh pre", "notes/2026/today.md pre"]]);
    assert.equal(String(files(root, "README.md")), "edited after Nivra wrote it\n");
    // Left where it was, never moved: the original stays in the recovery folder.
    assert.deepEqual(run.outcome.paths[0]!.kept, ["orig-0"]);
    assert.equal(String(readFileSync(join(run.recovery, "orig-0"))), FILES["README.md"]);
  });

  it("reports a file another program saved after Nivra wrote it, and never overwrites it: still applied", async () => {
    const root = repoWith(FILES);
    const run = await apply(root, { before: (step) => void (step === "read back" && writeFileSync(join(root, "greet.sh"), "saved after the write\n")) });
    assert.ok(!(run.outcome instanceof ApplyRefusal));
    assert.deepEqual([run.outcome.state, run.outcome.paths.map((one) => `${one.path} ${one.place}${one.changedSince ? " since" : ""}`)], ["applied", ["README.md post", "greet.sh theirs since", "notes/2026/today.md post"]]);
    assert.equal(String(files(root, "greet.sh")), "saved after the write\n");
  });

  it("keeps every version and says where each path is when any filesystem call fails, at every step", async () => {
    const fresh = copies();
    const clean = faulty();
    await apply(fresh(), { io: clean });
    assert.ok(clean.calls.length > 30, `only ${clean.calls.length} calls`);
    for (let at = 0; at < clean.calls.length; at++) {
      for (const code of FAULTS) {
        const root = fresh();
        const run = await apply(root, { io: faulty([{ at, code }]) });
        holds(run.outcome, run, `${code} at call ${at} (${clean.calls[at]})`);
      }
    }
  });

  it("keeps every version when rollback's own steps fail too: partial or unknown, never anything lost", async () => {
    const fresh = copies();
    const clean = faulty();
    await apply(fresh(), { io: clean });
    // The first and the last link into place: a failure there rolls back what was written.
    const links = clean.calls.flatMap((name, at) => (name === "link" ? [at] : [])).filter((at) => at > clean.calls.indexOf("rename"));
    for (const first of [links[0]!, links.at(-1)!]) {
      const once = faulty([{ at: first, code: "EIO" }]);
      await apply(fresh(), { io: once });
      for (let second = first + 1; second < once.calls.length; second++) {
        const root = fresh();
        const run = await apply(root, { io: faulty([{ at: first, code: "EIO" }, { at: second, code: FAULTS[second % FAULTS.length]! }]) });
        holds(run.outcome, run, `EIO at ${first}, then ${FAULTS[second % FAULTS.length]} at ${second} (${once.calls[second]})`);
      }
    }
  });

  it("never takes away a version another program saved just before restore moves the file: it goes back in place, and the original stays kept", async () => {
    const root = repoWith(FILES);
    const run = await apply(root);
    assert.ok(!(run.outcome instanceof ApplyRefusal) && run.outcome.state === "applied");
    const record = run.journal.get(run.applyId)!;
    const restored = await restore(record.intent!, { created: record.created, before: (step) => void (step === "take back 0" && writeFileSync(join(root, "README.md"), "saved as restore began\n")) });
    assert.deepEqual([restored.state, restored.paths[0]?.place, restored.paths[0]?.changedSince, String(files(root, "README.md"))], ["partial", "theirs", true, "saved as restore began\n"]);
    assert.ok(restored.paths[0]!.kept.includes("orig-0"), restored.paths[0]!.kept.join(", "));
  });

  it("restores the originals of a partial apply without overwriting anything, and removes only the folders it made", async () => {
    const root = repoWith(FILES);
    const run = await apply(root);
    assert.ok(!(run.outcome instanceof ApplyRefusal) && run.outcome.state === "applied");
    const record = run.journal.get(run.applyId)!;
    // As the person asks after the change was applied in full: every path taken back, the folders Nivra made removed.
    const restored = await restore(record.intent!, { created: record.created });
    assert.deepEqual([restored.state, restored.folders, existsSync(join(root, "notes"))], ["not-applied", [], false]);
    assert.deepEqual([String(files(root, "README.md")), String(files(root, "greet.sh")), modeOf(root, "greet.sh")], [FILES["README.md"], FILES["greet.sh"].executable, 0o755]);
    assert.equal(git(root, ["status", "--porcelain"]), "");
  });
});
