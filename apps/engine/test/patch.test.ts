import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WorkspaceRefusal } from "../src/exec/git-tool.ts";
import { buildPatch, checkCollected, lineEndingProblem, lineStyle, type Change, type Collected, type PatchOptions } from "../src/exec/patch.ts";
import type { Snapshot } from "../src/exec/snapshot.ts";
import { readTar, writeTar } from "../src/exec/tar.ts";
import { changedSince, cleanUp, collect, folderState, GIT, git, guestRun, localSession, put, refusal, repoWith, scratch, sha, snap, type GuestFiles } from "./workspace-fixtures.ts";

/**
 * Patches from a sandbox's result (NIV-42, D34, D15). The guest is simulated here: the snapshot extracted by the real
 * prepare step, the edit made on disk, the real collect step. Each patch is applied in a fresh clone from its top
 * level, and the person's checkout is byte-identical afterwards. Nothing here reaches the network.
 */
after(cleanUp);

async function patchFor(snapshot: Snapshot, collected: Collected, extra: Partial<PatchOptions> = {}) {
  const session = await localSession(snapshot.folder);
  try {
    return await buildPatch({ snapshot, collected, session, git: GIT, ...extra });
  } finally {
    await session.close();
  }
}

/**
 * The patch applied in a fresh clone of `root`, from its top level: what changed there, and the tree it then holds. The
 * clone copies objects rather than linking them, so nothing done in it can touch `root`'s files.
 */
function applyInClone(root: string, patch: Uint8Array): { clone: string; changed: string[]; tree: string } {
  const parent = scratch("clone");
  const clone = join(parent, "fresh clone");
  git(parent, ["clone", "-q", "--no-hardlinks", root, clone]);
  const file = join(parent, "change.patch");
  writeFileSync(file, patch);
  git(clone, ["apply", "--check", file]);
  git(clone, ["apply", file]);
  const changed = git(clone, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .split("\0")
    .filter(Boolean)
    .map((record) => record.slice(3))
    .sort();
  git(clone, ["add", "-A"]);
  return { clone, changed, tree: git(clone, ["write-tree"]).trim() };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const noChange = (files: GuestFiles) => files;

describe("patches from a sandbox's result", () => {
  it("proposes an add, an edit, a delete, a mode change and a binary edit as a patch a fresh clone applies, leaving the checkout byte-identical", async () => {
    const root = repoWith({
      "README.md": "# Demo\n",
      "src/app.ts": "export const app = 1;\n",
      "old.txt": "going\n",
      "run.sh": "#!/bin/sh\necho run\n",
      "data.bin": new Uint8Array([0, 1, 2, 3, 0, 255]),
      link: { link: "README.md" },
    });
    const before = folderState(root);
    const snapshot = await snap(root);
    const LONG = `added/${"a-long-folder-name/".repeat(5)}new-file.ts`;
    const files = guestRun(snapshot, (workspace) => {
      writeFileSync(join(workspace, "src/app.ts"), "export const app = 2;\n");
      rmSync(join(workspace, "old.txt"));
      chmodSync(join(workspace, "run.sh"), 0o755);
      writeFileSync(join(workspace, "data.bin"), new Uint8Array([0, 1, 2, 4, 0, 255, 7]));
      put(workspace, LONG, "export const added = true;\n");
      put(workspace, "node_modules/dep/index.js", "dependency output\n");
      put(workspace, "__pycache__/x.pyc", "generated\n");
    });
    const collected = collect(files);
    assert.equal(collected.entries.filter((entry) => entry.path.startsWith("node_modules/")).length, 0, "the collect step took dependency output");

    const result = await patchFor(snapshot, collected);
    assert.deepEqual(result.changes.deleted, ["old.txt"]);
    assert.deepEqual(
      result.changes.added.map((change) => change.path),
      [LONG],
    );
    assert.deepEqual(
      result.changes.changed.map((change) => change.path),
      ["data.bin", "run.sh", "src/app.ts"],
    );
    assert.deepEqual(result.changes.modeChanges, [{ path: "run.sh", from: "100644", to: "100755" }]);
    assert.deepEqual([result.changes.generated.count, result.changes.generated.sample], [1, ["__pycache__/x.pyc"]]);
    assert.equal(result.sha256, sha(result.bytes));
    assert.equal(result.baseTree, git(root, ["rev-parse", "HEAD^{tree}"]).trim());
    const text = decode(result.bytes);
    assert.match(text, /GIT binary patch/);
    assert.match(text, /^old mode 100644\nnew mode 100755$/m);
    assert.match(text, /^deleted file mode 100644$/m);
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");

    const { clone, changed, tree } = applyInClone(root, result.bytes);
    assert.deepEqual(changed, [LONG, "data.bin", "old.txt", "run.sh", "src/app.ts"]);
    assert.equal(tree, result.resultTree);
    assert.equal(readFileSync(join(clone, "src/app.ts"), "utf8"), "export const app = 2;\n");
    assert.deepEqual([...readFileSync(join(clone, "data.bin"))], [0, 1, 2, 4, 0, 255, 7]);
    assert.equal(statSync(join(clone, "run.sh")).mode & 0o100, 0o100);
  });

  it("gives an empty patch for an empty change, with the baseline's tree as the result", async () => {
    const root = repoWith({ "a.txt": "a\n", link: { link: "a.txt" } });
    const snapshot = await snap(root);
    const result = await patchFor(snapshot, collect(noChange(guestRun(snapshot))));
    assert.deepEqual([result.bytes.byteLength, result.changes.deleted.length, result.changes.added.length, result.changes.changed.length], [0, 0, 0, 0]);
    assert.equal(result.resultTree, result.baseTree);
    assert.equal(result.sha256, sha(""));
  });

  it("takes only the picked folder of a larger repository, and its patch targets that folder from the top level of a fresh clone", async () => {
    const root = repoWith({
      ".gitattributes": "*.sh text eol=lf\n",
      "README.md": "# Monorepo\n",
      "apps/web/src/a.ts": "export const a = 1;\n",
      "apps/web/b.sh": "echo b\n",
      "apps/api/a.ts": "export const api = 1;\n",
      "apps/web-other/a.ts": "export const other = 1;\n",
    });
    const before = folderState(root);
    const snapshot = await snap(join(root, "apps", "web"));
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["b.sh", "src/a.ts"],
    );
    const sent = readTar(snapshot.archive.archive, { maxEntries: 100, maxBytes: 1 << 20, maxEntryBytes: 1 << 20, maxPathBytes: 1_024 }).filter((entry) => entry.kind !== "dir");
    assert.deepEqual(
      sent.map((entry) => entry.path),
      ["b.sh", "src/a.ts"],
    );
    const files = guestRun(snapshot, (workspace) => {
      writeFileSync(join(workspace, "src/a.ts"), "export const a = 2;\n");
      put(workspace, "src/c.ts", "export const c = 3;\n");
      rmSync(join(workspace, "b.sh"));
    });
    const result = await patchFor(snapshot, collect(files));
    const headers = decode(result.bytes).match(/^diff --git .*$/gm) ?? [];
    assert.equal(headers.length, 3);
    for (const header of headers) assert.match(header, /^diff --git a\/apps\/web\/\S+ b\/apps\/web\/\S+$/);
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
    const { clone, changed } = applyInClone(root, result.bytes);
    assert.deepEqual(changed, ["apps/web/b.sh", "apps/web/src/a.ts", "apps/web/src/c.ts"]);
    assert.deepEqual([readFileSync(join(clone, "apps/web/src/a.ts"), "utf8"), readFileSync(join(clone, "apps/web/src/c.ts"), "utf8")], ["export const a = 2;\n", "export const c = 3;\n"]);

    // The top level's .gitattributes holds for the picked folder's files.
    const crlf = collect(guestRun(snapshot, (workspace) => put(workspace, "run.sh", "echo run\r\n")));
    await assert.rejects(patchFor(snapshot, crlf), refusal(/"run\.sh" has CRLF line endings, which this repository's \.gitattributes keeps out of its commits/));
  });

  it("refuses new links, retargeted links and a file and a link swapped, and lets a link be deleted", async () => {
    const root = repoWith({ "README.md": "# r\n", "file.txt": "f\n", link: { link: "README.md" }, "other-link": { link: "README.md" } });
    const snapshot = await snap(root);
    const escape = collect(guestRun(snapshot, (workspace) => symlinkSync("../../../etc/passwd", join(workspace, "escape"))));
    await assert.rejects(patchFor(snapshot, escape), refusal(/^Nivra won't propose this change: "escape" is a new link, and a change may not add links\.$/));
    const retarget = collect(
      guestRun(snapshot, (workspace) => {
        rmSync(join(workspace, "link"));
        symlinkSync("file.txt", join(workspace, "link"));
      }),
    );
    await assert.rejects(patchFor(snapshot, retarget), refusal(/"link" is a link whose target changed, and a change may not retarget links/));
    const swapped = collect(
      guestRun(snapshot, (workspace) => {
        rmSync(join(workspace, "file.txt"));
        symlinkSync("README.md", join(workspace, "file.txt"));
        rmSync(join(workspace, "link"));
        writeFileSync(join(workspace, "link"), "now a file\n");
      }),
    );
    await assert.rejects(patchFor(snapshot, swapped), refusal(/^Nivra won't propose this change: "file\.txt" was a file and is now a link; "link" was a link and is now a file\.$/));
    const deleted = await patchFor(snapshot, collect(guestRun(snapshot, (workspace) => rmSync(join(workspace, "other-link")))));
    assert.deepEqual(deleted.changes.deleted, ["other-link"]);
    assert.deepEqual(applyInClone(root, deleted.bytes).changed, ["other-link"]);
  });

  it("refuses a path traversal, a hard link, a pipe, a file the archive skipped and a download that isn't what was written", async () => {
    const root = repoWith({ "README.md": "# r\n", "src/a.ts": "a\n" });
    const snapshot = await snap(root);
    const good = guestRun(snapshot);
    const lines = (text: string) => text.split("\n").filter(Boolean);
    /** The collect step's output for an archive and a listing, consistent with both. */
    const consistent = (archive: Uint8Array, listing: string) => ({
      stdout: `entries ${lines(listing).length}\nlisting ${sha(listing)}\narchive ${sha(archive)}\n`,
      archive: { bytes: archive, sha256: sha(archive) },
      listing: { bytes: new TextEncoder().encode(listing), sha256: sha(listing) },
    });

    const traversal = writeTar([{ path: "../escape", kind: "file", executable: false, bytes: new TextEncoder().encode("x\n") }]);
    const tl = consistent(traversal, `f ${sha("x\n")} ./../escape\n`);
    assert.throws(() => checkCollected(tl.stdout, tl.archive, tl.listing), refusal(/^The sandbox's result can't be taken: The archive holds a path with a \.\. component/));

    const hard = guestRun(snapshot, (workspace) => linkSync(join(workspace, "README.md"), join(workspace, "hard")));
    assert.throws(() => collect(hard), refusal(/^The sandbox's result can't be taken: The archive holds a hard link/));

    const pipe = guestRun(snapshot, (workspace) => assert.equal(spawnSync("mkfifo", [join(workspace, "pipe")]).status, 0));
    assert.throws(() => collect(pipe), refusal(/^The workspace holds "pipe", which is neither a file, a folder nor a link/));

    // The archiver skipped src/a.ts: the listing still names it, so it is never taken for a deletion.
    const kept = readTar(good.archive.bytes, { maxEntries: 100, maxBytes: 1 << 20, maxEntryBytes: 1 << 20, maxPathBytes: 1_024 }).filter((entry) => entry.path !== "src/a.ts");
    const skipped = consistent(writeTar(kept), decode(good.listing.bytes));
    assert.throws(() => checkCollected(skipped.stdout, skipped.archive, skipped.listing), refusal(/^The sandbox's archive doesn't match its listing \("src\/a\.ts" differs\), so a file it skipped can't be taken for a deletion\./));

    // What was read back differs from what was written: one byte, with the digest the collect step printed.
    const tampered = new Uint8Array(good.archive.bytes);
    tampered[600] = tampered[600]! ^ 1;
    assert.throws(() => checkCollected(good.stdout, { bytes: tampered, sha256: good.archive.sha256 }, good.listing), refusal(/isn't what its collect step wrote/));
    assert.throws(() => checkCollected(good.stdout, { bytes: tampered, sha256: sha(tampered) }, good.listing), refusal(/isn't what its collect step wrote/));
    assert.throws(() => checkCollected("entries 2\n", good.archive, good.listing), refusal(/didn't print what it should have/));
    assert.throws(() => checkCollected(good.stdout.replace(/^entries \d+$/m, "entries 3"), good.archive, good.listing), refusal(/doesn't hold the number of lines its collect step counted/));
    assert.equal(collect(good).entries.length, 2);
    // busybox's wc may pad its count.
    assert.equal(checkCollected(good.stdout.replace(/^entries /m, "entries       "), good.archive, good.listing).entries.length, 2);
  });

  it("holds new names to every target's rules, and leaves a repository's own awkward names alone", async () => {
    const root = repoWith({ "aux.c": "int main;\n", README: "upper\n", readme: "lower\n", "src/a.ts": "a\n" });
    const snapshot = await snap(root);
    const fine = collect(
      guestRun(snapshot, (workspace) => {
        writeFileSync(join(workspace, "aux.c"), "int main(void);\n");
        writeFileSync(join(workspace, "readme"), "lower, edited\n");
      }),
    );
    const edited = await patchFor(snapshot, fine);
    assert.deepEqual(
      edited.changes.changed.map((change) => change.path),
      ["aux.c", "readme"],
    );
    assert.deepEqual(applyInClone(root, edited.bytes).changed, ["aux.c", "readme"]);

    const bad = collect(
      guestRun(snapshot, (workspace) => {
        put(workspace, "con.txt", "x\n");
        put(workspace, "PROGRA~1/x", "x\n");
        put(workspace, "Src/b.ts", "b\n");
        put(workspace, "what?.md", "x\n");
      }),
    );
    let message = "";
    await assert.rejects(patchFor(snapshot, bad), (error: unknown) => {
      assert.ok(error instanceof WorkspaceRefusal, String(error));
      message = error.message;
      return true;
    });
    assert.match(message, /the new path "PROGRA~1\/x" can't be written on every computer \("PROGRA~1" has the shape of a Windows short name\)/);
    assert.match(message, /the new path "con\.txt" can't be written on every computer \("con\.txt" is a name Windows reserves\)/);
    assert.match(message, /the new path "what\?\.md" can't be written on every computer \("what\?\.md" holds a character Windows forbids in a name\)/);
    assert.match(message, /"Src" and "src" differ only in case or Unicode form/);
  });

  it("refuses secrets by name and by content, git's own files, LFS pointer edits and anything under a submodule, and leaves new generated output out", async () => {
    const library = repoWith({ "lib.ts": "export const lib = 1;\n" });
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize 12\n`;
    const root = repoWith({ "src/a.ts": "a\n", ".gitattributes": "*.psd binary\n", "art.psd": pointer });
    git(root, ["submodule", "add", "-q", library, "vendored"]);
    git(root, ["commit", "-q", "-m", "submodule"]);
    const before = folderState(root);
    const snapshot = await snap(root);
    const token = `ghp_${"a".repeat(36)}`;
    const vaultValue = "nivra-vault-value-0123456789";
    const cases: Array<[string, (workspace: string) => void, RegExp]> = [
      ["a new .env with harmless contents", (workspace) => put(workspace, ".env", "HELLO=world\n"), /^Nivra won't propose this change: "\.env" has a name that suggests it holds credentials, so a change may not write it\.$/],
      ["a new credentials.json", (workspace) => put(workspace, "config/credentials.json", "{}\n"), /"config\/credentials\.json" has a name that suggests it holds credentials/],
      ["a token in new content", (workspace) => put(workspace, "src/config.ts", `export const t = "${token}";\n`), /"src\/config\.ts" holds what looks like a GitHub token/],
      ["a value from the vault", (workspace) => writeFileSync(join(workspace, "src/a.ts"), `a ${vaultValue}\n`), /"src\/a\.ts" holds what looks like a value Nivra keeps as a secret/],
      ["an edited .gitattributes", (workspace) => writeFileSync(join(workspace, ".gitattributes"), "*.psd -text\n"), /"\.gitattributes" is one of git's own files, which change how the repository is read/],
      ["a deleted .gitmodules", (workspace) => rmSync(join(workspace, ".gitmodules")), /"\.gitmodules" is one of git's own files/],
      ["an edited LFS pointer", (workspace) => writeFileSync(join(workspace, "art.psd"), "real pixels\n"), /"art\.psd" is a Git LFS pointer, which a change may not edit or delete/],
      ["a new LFS pointer", (workspace) => put(workspace, "more.psd", pointer), /"more\.psd" would be a Git LFS pointer, which Nivra can't add or edit/],
      ["a file under a submodule", (workspace) => put(workspace, "vendored/new.ts", "x\n"), /"vendored\/new\.ts" is at or under "vendored", which was left out of the snapshot/],
    ];
    for (const [what, edit, words] of cases) {
      const collected = collect(guestRun(snapshot, edit));
      await assert.rejects(
        patchFor(snapshot, collected, { knownValues: [vaultValue] }),
        (error: unknown) => {
          refusal(words)(error);
          assert.ok(!(error as Error).message.includes(token) && !(error as Error).message.includes(vaultValue), `${what}: the refusal quoted a secret`);
          return true;
        },
        what,
      );
    }
    const generated = collect(
      guestRun(snapshot, (workspace) => {
        put(workspace, "Dist/bundle.js", "x\n");
        put(workspace, "src/__pycache__/a.cpython-312.pyc", "x\n");
        put(workspace, ".DS_Store", "x\n");
        put(workspace, "src/b.ts", "b\n");
      }),
    );
    const result = await patchFor(snapshot, generated);
    assert.deepEqual(
      result.changes.added.map((change) => change.path),
      ["src/b.ts"],
    );
    assert.deepEqual([result.changes.generated.count, result.changes.generated.sample.sort()], [3, [".DS_Store", "Dist/bundle.js", "src/__pycache__/a.cpython-312.pyc"]]);
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
  });

  it("keeps line endings as the repository's .gitattributes says, without converting a byte", async () => {
    const root = repoWith({
      ".gitattributes": "*.txt text\n*.bat -text\n*.auto text=auto\n",
      "lf.md": "one\ntwo\n",
      "crlf.md": "one\r\ntwo\r\n",
      "notes.txt": "one\ntwo\n",
      "win.bat": "@echo off\r\n",
    });
    const snapshot = await snap(root);
    const refused: Array<[(workspace: string) => void, RegExp]> = [
      [(workspace) => writeFileSync(join(workspace, "notes.txt"), "one\r\ntwo\r\n"), /"notes\.txt" has CRLF line endings, which this repository's \.gitattributes keeps out of its commits/],
      [(workspace) => writeFileSync(join(workspace, "lf.md"), "one\r\ntwo\n"), /"lf\.md" now has CRLF line endings where the commit's copy had LF/],
      [(workspace) => writeFileSync(join(workspace, "crlf.md"), "one\ntwo\n"), /"crlf\.md" now has LF line endings where the commit's copy had CRLF/],
      [(workspace) => put(workspace, "new.md", "one\r\ntwo\n"), /"new\.md" mixes LF and CRLF line endings/],
      [(workspace) => put(workspace, "new.auto", "one\r\n"), /"new\.auto" has CRLF line endings, which this repository's \.gitattributes keeps out of its text files/],
    ];
    for (const [edit, words] of refused) await assert.rejects(patchFor(snapshot, collect(guestRun(snapshot, edit))), refusal(words));

    const kept = {
      "win.bat": "@echo off\r\nrem mixed\n",
      "crlf.md": "one\r\ntwo\r\nthree\r\n",
      "new-crlf.md": "one\r\ntwo\r\n",
      "binary.auto": "\0one\r\ntwo\n",
    };
    const allowed = collect(guestRun(snapshot, (workspace) => Object.entries(kept).forEach(([path, content]) => put(workspace, path, content))));
    const result = await patchFor(snapshot, allowed);
    const { clone } = applyInClone(root, result.bytes);
    for (const [path, content] of Object.entries(kept)) assert.equal(readFileSync(join(clone, path), "latin1"), content, path);
  });

  it("refuses over its limits, and when the baseline commit is gone", async () => {
    const root = repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    const snapshot = await snap(root);
    const big = collect(
      guestRun(snapshot, (workspace) => {
        writeFileSync(join(workspace, "a.txt"), "x".repeat(2_000));
        writeFileSync(join(workspace, "b.txt"), "changed\n");
        put(workspace, "c.txt", "new\n");
      }),
    );
    await assert.rejects(patchFor(snapshot, big, { policy: { maxChangedFiles: 2 } }), refusal(/it changes 3 files, over the 2 a change may hold/));
    await assert.rejects(patchFor(snapshot, big, { policy: { maxFileBytes: 1_000 } }), refusal(/"a\.txt" is 2000 bytes, over the 1000 a change may hold for one file/));
    await assert.rejects(patchFor(snapshot, big, { policy: { maxPatchBytes: 500 } }), refusal(/^The change's patch is over the 500 bytes Nivra proposes at once\. Make a smaller change, then try again\.$/));
    await assert.rejects(patchFor({ ...snapshot, baseline: "1".repeat(40) }, big), refusal(/^The commit this run started from \(111111111111\) is no longer in the repository, so no patch was made\.$/));
  });

  it("works from the commit, never the checkout: a checkout changed after the snapshot stays exactly as it is", async () => {
    const root = repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    const snapshot = await snap(root);
    writeFileSync(join(root, "a.txt"), "the person kept working\n");
    put(root, "scratch.txt", "untracked\n");
    git(root, ["commit", "-q", "-am", "moved on"]);
    writeFileSync(join(root, "b.txt"), "and is dirty now\n");
    const before = folderState(root);
    const result = await patchFor(snapshot, collect(guestRun(snapshot, (workspace) => writeFileSync(join(workspace, "a.txt"), "the sandbox's edit\n"))));
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
    assert.equal(result.baseTree, git(root, ["rev-parse", `${snapshot.baseline}^{tree}`]).trim());
    assert.match(decode(result.bytes), /^-a\n\+the sandbox's edit$/m);
  });

  it("handles names git quotes, and a file and a folder that swap places", async () => {
    const root = repoWith({ 'quote"d.txt': "q\n", "back\\slash.txt": "b\n", notes: "a file for now\n", "dir/old.txt": "going\n" });
    const snapshot = await snap(root);
    const files = guestRun(snapshot, (workspace) => {
      rmSync(join(workspace, 'quote"d.txt'));
      writeFileSync(join(workspace, "back\\slash.txt"), "b, edited\n");
      rmSync(join(workspace, "notes"));
      put(workspace, "notes/today.md", "now a folder\n");
      rmSync(join(workspace, "dir"), { recursive: true });
      put(workspace, "dir", "now a file\n");
    });
    const result = await patchFor(snapshot, collect(files));
    assert.deepEqual(result.changes.deleted, ["dir/old.txt", "notes", 'quote"d.txt']);
    assert.deepEqual(
      [...result.changes.added, ...result.changes.changed].map((change) => change.path),
      ["dir", "notes/today.md", "back\\slash.txt"],
    );
    const { clone, tree } = applyInClone(root, result.bytes);
    assert.equal(tree, result.resultTree);
    assert.deepEqual([readFileSync(join(clone, "notes/today.md"), "utf8"), readFileSync(join(clone, "dir"), "utf8"), readFileSync(join(clone, "back\\slash.txt"), "utf8")], ["now a folder\n", "now a file\n", "b, edited\n"]);
  });

  it("round-trips a SHA-256 repository", async () => {
    const root = repoWith({ "a.txt": "a\n" }, { objectFormat: "sha256" });
    const snapshot = await snap(root);
    const result = await patchFor(snapshot, collect(guestRun(snapshot, (workspace) => put(workspace, "b.txt", "b\n"))));
    assert.equal(result.resultTree.length, 64);
    assert.equal(applyInClone(root, result.bytes).tree, result.resultTree);
  });
});

describe("line endings", () => {
  const change = (bytes: string, before?: string): Change => ({
    path: "x",
    kind: before === undefined ? "added" : "changed",
    mode: "100644",
    bytes: new TextEncoder().encode(bytes),
    sha256: sha(bytes),
    ...(before === undefined ? {} : { before: { path: "x", kind: "file", mode: "100644", blob: "0".repeat(40), size: before.length, sha256: sha(before), bytes: new TextEncoder().encode(before) } }),
  });
  const unspecified = { text: "unspecified", eol: "unspecified" };

  it("names a file's style", () => {
    assert.deepEqual(
      ["", "a", "a\n", "a\r\n", "a\r\nb\n", "a\rb"].map((text) => lineStyle(new TextEncoder().encode(text))),
      ["none", "none", "lf", "crlf", "mixed", "none"],
    );
  });

  it("follows text, eol, text=auto and nothing said", () => {
    assert.match(lineEndingProblem(change("a\r\n"), { text: "set", eol: "unspecified" }) ?? "", /CRLF line endings/);
    assert.match(lineEndingProblem(change("a\r\n"), { text: "unspecified", eol: "crlf" }) ?? "", /CRLF line endings/, "eol sets text");
    assert.equal(lineEndingProblem(change("a\r\n"), { text: "unset", eol: "unspecified" }), null);
    assert.equal(lineEndingProblem(change("a\r\n", "b\r\n"), { text: "auto", eol: "unspecified" }), null, "auto leaves a file the commit held with CRLF alone");
    assert.match(lineEndingProblem(change("a\r\n", "b\n"), { text: "auto", eol: "unspecified" }) ?? "", /text files/);
    assert.equal(lineEndingProblem(change("\0a\r\n"), { text: "auto", eol: "unspecified" }), null, "auto leaves binary alone");
    assert.equal(lineEndingProblem(change("a\r\nb\r\n", "a\r\n"), unspecified), null);
    assert.equal(lineEndingProblem(change("a\nb\n", "a"), unspecified), null);
    assert.match(lineEndingProblem(change("a\nb\r\n", "a"), unspecified) ?? "", /mixes/);
  });

  it("holds only new bytes to the rules: a mode change, or CRLF the commit already held, never refuses", () => {
    const text = { text: "set", eol: "unspecified" };
    assert.equal(lineEndingProblem({ ...change("a\r\n", "a\r\n"), mode: "100755" }, text), null, "a mode change");
    assert.equal(lineEndingProblem(change("a\r\nb\r\n", "a\r\n"), text), null, "an edit keeping the commit's CRLF");
    assert.match(lineEndingProblem(change("a\r\nb\n", "a\r\n"), text) ?? "", /now has LF line endings where the commit's copy had CRLF/);
    assert.match(lineEndingProblem(change("a\r\nb\n", "a\n"), text) ?? "", /keeps out of its commits/);
  });
});
