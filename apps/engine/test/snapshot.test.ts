import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { WorkspaceRefusal } from "../src/exec/git-tool.ts";
import { PREPARE_SCRIPT } from "../src/exec/nebius/session.ts";
import { credentialKinds } from "../src/exec/snapshot.ts";
import { readTar } from "../src/exec/tar.ts";
import { tempDir } from "./helpers.ts";
import { changedSince, cleanUp, folderState, GIT, git, put, refusal, repoWith, scratch, snap, track } from "./workspace-fixtures.ts";

/**
 * Commit snapshots (NIV-42, D34) against real repositories made here: exact bytes from the commit, never the working
 * tree; what is left out and why; refusals for uncommitted work, unsafe content, partial clones and crafted paths;
 * and a checkout that is byte-identical afterwards, `.git` included. Nothing here reaches the network.
 */
after(cleanUp);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const CRLF = "one\r\ntwo\r\n";
const LONG = `deep/${"a-folder-with-a-long-name/".repeat(4)}and-a-file-name-past-100-bytes.txt`;
const BINARY = new Uint8Array([0, 1, 2, 0, 255, 0, 10, 13]);

describe("commit snapshots", () => {
  it("takes the commit's exact bytes, modes and links, never the working tree's, in an archive the prepare step lists to the same digest", async () => {
    const root = repoWith({
      ".gitattributes": "crlf.txt -text\n",
      "README.md": "# Demo\n",
      "crlf.txt": CRLF,
      "lf.txt": "one\ntwo\n",
      "no-final-newline.txt": "last line",
      empty: "",
      "bin/run.sh": { executable: "#!/bin/sh\necho run\n" },
      "data.bin": BINARY,
      "docs/ü.md": "unicode\n",
      [LONG]: "long\n",
      link: { link: "README.md" },
    });
    // The working tree now holds lf.txt with CRLF while its blob keeps LF: the snapshot must give the blob.
    git(root, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(root, ".gitattributes"), "crlf.txt -text\nlf.txt text eol=crlf\n");
    git(root, ["commit", "-q", "-am", "eol"]);
    rmSync(join(root, "lf.txt"));
    git(root, ["checkout", "--", "lf.txt"]);
    assert.equal(readFileSync(join(root, "lf.txt"), "utf8"), "one\r\ntwo\r\n");
    const before = folderState(root);

    const snapshot = await snap(root);
    assert.equal(snapshot.baseline, git(root, ["rev-parse", "HEAD"]).trim());
    assert.equal(snapshot.objectFormat, "sha1");
    assert.equal(snapshot.prefix, "");
    assert.equal(snapshot.topLevel, realpathSync.native(root));
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      [".gitattributes", "README.md", "bin/run.sh", "crlf.txt", "data.bin", LONG, "docs/ü.md", "empty", "lf.txt", "link", "no-final-newline.txt"],
    );
    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
    assert.equal(text(byPath.get("crlf.txt")!.bytes), CRLF);
    assert.equal(text(byPath.get("lf.txt")!.bytes), "one\ntwo\n");
    assert.equal(text(byPath.get("no-final-newline.txt")!.bytes), "last line");
    assert.deepEqual([...byPath.get("data.bin")!.bytes], [...BINARY]);
    assert.equal(byPath.get("bin/run.sh")!.mode, "100755");
    assert.equal(byPath.get("README.md")!.mode, "100644");
    assert.deepEqual([byPath.get("link")!.kind, byPath.get("link")!.mode, text(byPath.get("link")!.bytes)], ["link", "120000", "README.md"]);
    assert.deepEqual([snapshot.untracked.count, snapshot.leftOut.secret.count, snapshot.leftOut.output.count, snapshot.lfsPointers.count], [0, 0, 0, 0]);
    assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.archive.sha256, createHash("sha256").update(snapshot.archive.archive).digest("hex"));

    // Our reader gives back exactly the files and links, and the prepare step's listing has the snapshot's digest.
    const read = readTar(snapshot.archive.archive, { maxEntries: 100, maxBytes: 1 << 20, maxEntryBytes: 1 << 20, maxPathBytes: 1_024 });
    const kept = read.filter((entry) => entry.kind !== "dir");
    assert.equal(kept.length, snapshot.files.length);
    for (const entry of kept) {
      const file = byPath.get(entry.path)!;
      if (entry.kind === "link") assert.equal(entry.target, text(file.bytes));
      else if (entry.kind === "file") assert.deepEqual([entry.path, entry.executable, Buffer.from(entry.bytes).equals(Buffer.from(file.bytes))], [file.path, file.mode === "100755", true]);
    }
    const guest = scratch("snapshot guest");
    const archive = join(guest, "snapshot.tar");
    writeFileSync(archive, snapshot.archive.archive);
    const ran = spawnSync("/bin/sh", ["-c", PREPARE_SCRIPT, "nivra-prepare", join(guest, "workspace"), archive, "", join(guest, "listing")], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, `entries ${snapshot.files.length}\ndigest ${snapshot.archive.listingDigest}\n`);
    assert.equal(readFileSync(join(guest, "workspace", "crlf.txt"), "utf8"), CRLF);

    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
  });

  it("leaves out secret-named files, dependency and build output, submodules and the engine home, and counts each", async () => {
    const library = repoWith({ "lib.ts": "export const lib = 1;\n" });
    const root = repoWith({
      "src/app.ts": "export const app = 1;\n",
      ".env": "API_KEY=harmless\n",
      ".env.example": "API_KEY=\n",
      "config/credentials.json": "{}\n",
      "keys/deploy.pem": "not a key at all\n",
      "node_modules/lib/index.js": "module.exports = 1;\n",
      "apps/web/dist/bundle.js": "var a;\n",
      ".nivra-home/nivra.db": "a pretend database\n",
    });
    git(root, ["submodule", "add", "-q", library, "vendored"]);
    git(root, ["commit", "-q", "-m", "submodule"]);
    const before = folderState(root);

    const snapshot = await snap(root, { exclude: [join(root, ".nivra-home")] });
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      [".env.example", ".gitmodules", "src/app.ts"],
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(snapshot.leftOut).map(([reason, counted]) => [reason, counted.count])),
      { secret: 3, output: 2, submodule: 1, excluded: 1 },
    );
    assert.deepEqual(snapshot.leftOut.secret.sample.sort(), [".env", "config/credentials.json", "keys/deploy.pem"]);
    assert.deepEqual(snapshot.leftOut.excluded.sample, [".nivra-home/nivra.db"]);
    const sent = readTar(snapshot.archive.archive, { maxEntries: 100, maxBytes: 1 << 20, maxEntryBytes: 1 << 20, maxPathBytes: 1_024 }).filter((entry) => entry.kind !== "dir");
    assert.deepEqual(
      sent.map((entry) => entry.path),
      [".env.example", ".gitmodules", "src/app.ts"],
    );
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");

    // A folder inside the engine home, or a home that holds the repository, is refused: there is nothing safe to send.
    await assert.rejects(snap(join(root, ".nivra-home"), { exclude: [join(root, ".nivra-home")] }), refusal(/inside Nivra's own data folder/));
    await assert.rejects(snap(root, { exclude: [dirname(root)] }), refusal(/inside Nivra's own data folder/));
    // The deny rules hold for the path in the repository too: picking `.ssh` doesn't make its files sendable.
    const ssh = repoWith({ ".ssh/config": "Host example\n", "README.md": "# r\n" });
    await assert.rejects(snap(join(ssh, ".ssh")), refusal(/nothing in this folder to send: every committed file in it is left out \(1 file\)/));
  });

  it("refuses a commit holding a private key, a token Nivra was never given, or a value from its vault, naming the path and kind but never the value", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const awsKey = `AKIA${"QWERTYUI".repeat(2)}`;
    const vaultValue = "nivra-vault-value-0123456789";
    const keyBody = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7";
    const root = repoWith({
      "src/config.ts": `export const key = \`-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\`;\nexport const token = "${token}";\n`,
      "assets/blob.bin": new Uint8Array([0, 0, ...new TextEncoder().encode(awsKey), 0, 255]),
      "notes.md": `the deploy value is ${vaultValue}\n`,
      "README.md": "# Fine\n",
    });
    const before = folderState(root);
    let message = "";
    await assert.rejects(snap(root, { knownValues: [vaultValue] }), (error: unknown) => {
      assert.ok(error instanceof WorkspaceRefusal, String(error));
      message = error.message;
      return true;
    });
    assert.match(message, /assets\/blob\.bin in this commit holds what looks like an AWS access key/);
    assert.match(message, /notes\.md in this commit holds what looks like a value Nivra keeps as a secret/);
    assert.match(message, /src\/config\.ts in this commit holds what looks like a private key and a GitHub token/);
    assert.match(message, /so Nivra won't upload it\. Remove it from the commit \(and replace the key if it's real\), then try again\.$/);
    for (const value of [token, awsKey, vaultValue, keyBody]) assert.ok(!message.includes(value), "the refusal quoted a credential");
    // Without the vault's values, the shapes alone still refuse it: the key and the token were never given to Nivra.
    await assert.rejects(snap(root), refusal(/src\/config\.ts in this commit holds what looks like a private key and a GitHub token/));
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
  });

  it("refuses tracked changes, staged or not, and leaves untracked and ignored files out, changing nothing", async () => {
    const root = repoWith({ "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "ignored.log\n" });
    put(root, "untracked.txt", "u\n");
    put(root, "new-folder/inside.txt", "u\n");
    put(root, "ignored.log", "i\n");
    let before = folderState(root);
    const clean = await snap(root);
    assert.deepEqual([clean.untracked.count, clean.untracked.sample.sort()], [2, ["new-folder/", "untracked.txt"]]);
    assert.deepEqual(
      clean.files.map((file) => file.path),
      [".gitignore", "a.txt", "b.txt"],
    );
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");

    const refused = async (pattern: RegExp) => {
      before = folderState(root);
      await assert.rejects(snap(root), refusal(pattern));
      assert.deepEqual(changedSince(before, root), [], "the checkout changed");
    };
    const WORDS = /Nivra works from a commit\. Commit or stash them, then try again\.$/;
    writeFileSync(join(root, "a.txt"), "edited\n");
    await refused(/^Your checkout has uncommitted changes in 1 file\. /);
    await refused(WORDS);
    git(root, ["add", "a.txt"]);
    await refused(/uncommitted changes in 1 file\./);
    rmSync(join(root, "b.txt"));
    await refused(/uncommitted changes in 2 files\./);
    git(root, ["reset", "-q", "--hard"]);
    git(root, ["rm", "-q", "--cached", "b.txt"]);
    await refused(/uncommitted changes in 1 file\./);
  });

  it("runs no filter, fsmonitor, hook or pager the repository configures and writes nothing to .git, where plain git status does", async () => {
    const root = repoWith({ "a.txt": "a\n", "b.dat": "b\n", ".gitattributes": "*.txt filter=mark diff=mark\n*.dat filter=proc\n" });
    // No space in its name: git runs filter commands through a shell.
    const markerDir = track(mkdtempSync(join(tmpdir(), "nivra-markers-")));
    const markers = join(markerDir, "markers");
    const script = (kind: string, passThrough = false) => {
      const path = join(markerDir, `mark-${kind}`);
      writeFileSync(path, `#!/bin/sh\necho ${kind} >> '${markers}'\n${passThrough ? "exec cat" : "exit 0"}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const hooks = join(markerDir, "hooks");
    mkdirSync(hooks);
    for (const hook of ["post-index-change", "reference-transaction", "post-checkout", "pre-auto-gc"]) writeFileSync(join(hooks, hook), `#!/bin/sh\necho hook-${hook} >> '${markers}'\n`, { mode: 0o755 });
    git(root, ["config", "filter.mark.clean", `${script("clean", true)} %f`]);
    git(root, ["config", "filter.mark.smudge", script("smudge", true)]);
    git(root, ["config", "filter.mark.required", "true"]);
    git(root, ["config", "filter.proc.process", script("process")]);
    git(root, ["config", "diff.mark.textconv", script("textconv", true)]);
    git(root, ["config", "diff.external", script("external")]);
    git(root, ["config", "core.fsmonitor", script("fsmonitor")]);
    git(root, ["config", "core.hooksPath", hooks]);
    git(root, ["config", "core.pager", script("pager", true)]);
    git(root, ["config", "gpg.program", script("gpg")]);
    const past = new Date(Date.now() - 60_000);

    const unchanged = async (state: string, expected: "taken" | RegExp) => {
      rmSync(markers, { force: true });
      const before = folderState(root);
      if (expected === "taken") assert.equal((await snap(root)).files.length, 3, state);
      else await assert.rejects(snap(root), refusal(expected));
      assert.equal(existsSync(markers) ? readFileSync(markers, "utf8") : "", "", `${state}: something the repository configures ran`);
      assert.deepEqual(changedSince(before, root), [], `${state}: the checkout changed`);
    };
    // A touched file: its times changed and its content didn't, so git looks at the content again.
    utimesSync(join(root, "a.txt"), new Date(), new Date(Date.now() + 5_000));
    utimesSync(join(root, "b.dat"), new Date(), new Date(Date.now() + 5_000));
    await unchanged("touched", "taken");
    // Racily clean: the index is older than the files, so git must read them all.
    utimesSync(join(root, ".git", "index"), past, past);
    await unchanged("racily clean", "taken");
    // An edited file is refused, and still nothing runs.
    writeFileSync(join(root, "a.txt"), "edited\n");
    await unchanged("edited", /uncommitted changes in 1 file/);

    // The control: plain git status, in the racily clean state, runs what the repository configures.
    writeFileSync(join(root, "a.txt"), "a\n");
    utimesSync(join(root, ".git", "index"), past, past);
    rmSync(markers, { force: true });
    // It fails too (exit 128): the process filter here doesn't speak git's protocol. What matters is what it ran.
    const plain = spawnSync(GIT, ["status", "--porcelain=v2"], { cwd: root, encoding: "utf8" });
    const ran = existsSync(markers) ? readFileSync(markers, "utf8").split("\n").filter(Boolean) : [];
    for (const kind of ["fsmonitor", "clean", "process"]) assert.ok(ran.includes(kind), `plain git status (exit ${plain.status}) ran: ${ran.join(", ") || "nothing"}`);
  });

  it("refuses a partial clone, which would fetch what it lacks", async () => {
    const source = repoWith({ "a.txt": "a\n" });
    git(source, ["config", "uploadpack.allowFilter", "true"]);
    const clone = join(dirname(source), "partial clone");
    git(dirname(source), ["clone", "-q", "--filter=blob:none", "--no-local", `file://${source}`, clone]);
    assert.equal(git(clone, ["config", "--get", "remote.origin.promisor"]).trim(), "true");
    const before = folderState(clone);
    await assert.rejects(snap(clone), refusal(/^This repository is a partial clone: .* Clone it in full, then try again\.$/));
    assert.deepEqual(changedSince(before, clone), [], "the checkout changed");
  });

  it("refuses a repository with no commits, and a baseline that isn't HEAD", async () => {
    const parent = track(tempDir());
    const unborn = join(parent, "unborn");
    mkdirSync(unborn);
    git(unborn, ["init", "-q", "-b", "main"]);
    put(unborn, "a.txt", "a\n");
    await assert.rejects(snap(unborn), refusal(/^This repository has no commits yet, so there is nothing to work from\. Commit your files, then try again\.$/));

    const root = repoWith({ "a.txt": "a\n" });
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    await assert.rejects(snap(root, { baseline: "0".repeat(40) }), refusal(new RegExp(`^Your checkout has moved to another commit \\(HEAD is ${head.slice(0, 12)}, not 000000000000\\)\\. Start again from the commit it is on now\\.$`)));
    assert.equal((await snap(root, { baseline: head })).baseline, head);
  });

  it("takes only the picked folder of a larger repository, with paths relative to it, and checks only that folder for changes", async () => {
    const root = repoWith({
      "README.md": "# Monorepo\n",
      "apps/web/package.json": "{}\n",
      "apps/web/src/a.ts": "export const a = 1;\n",
      "apps/web-other/b.ts": "export const b = 1;\n",
      "apps/api/c.ts": "export const c = 1;\n",
    });
    put(root, "apps/web/u.ts", "u\n");
    put(root, "apps/api/v.ts", "v\n");
    writeFileSync(join(root, "apps/api/c.ts"), "export const c = 2;\n");
    const before = folderState(root);
    const snapshot = await snap(join(root, "apps", "web"));
    assert.deepEqual([snapshot.prefix, snapshot.folder, snapshot.topLevel], ["apps/web", realpathSync.native(join(root, "apps", "web")), realpathSync.native(root)]);
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["package.json", "src/a.ts"],
    );
    assert.deepEqual([snapshot.untracked.count, snapshot.untracked.sample], [1, ["u.ts"]]);
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
    // A change inside the picked folder still refuses.
    writeFileSync(join(root, "apps/web/src/a.ts"), "export const a = 2;\n");
    await assert.rejects(snap(join(root, "apps", "web")), refusal(/uncommitted changes in 1 file\./));
  });

  it("refuses over its limits rather than truncating", async () => {
    const root = repoWith({ "a.txt": "aaaaa\n", "b.txt": "b\n", "c.txt": "c\n" });
    await assert.rejects(snap(root, { limits: { maxFiles: 2 } }), refusal(/^The folder's commit holds 3 files to send, over the 2 a sandbox run takes\. Pick a smaller folder, then try again\.$/));
    await assert.rejects(snap(root, { limits: { maxFileBytes: 5 } }), refusal(/^a\.txt is 6 bytes, over the 5 Nivra sends for one file\. /));
    await assert.rejects(snap(root, { limits: { maxBytes: 9 } }), refusal(/^The folder's files come to 10 bytes, over the 9 a sandbox run takes\. /));
    await assert.rejects(snap(root, { limits: { maxArchiveBytes: 2_048 } }), refusal(/^The folder's snapshot comes to \d+ bytes, over the 2048 a sandbox run takes\. /));
  });

  it("refuses crafted paths a commit can hold: a .git short name and a newline", async () => {
    for (const [name, words] of [
      ["GIT~1", /it has a \.git component/],
      ["new\nline", /it holds a control or invisible character/],
    ] as const) {
      const root = repoWith({ "a.txt": "a\n" });
      const blob = git(root, ["hash-object", "-w", "--stdin"], "crafted\n").trim();
      const inner = git(root, ["mktree", "-z"], `100644 blob ${blob}\tconfig\0`).trim();
      const kept = git(root, ["rev-parse", "HEAD:a.txt"]).trim();
      const tree = git(root, ["mktree", "-z"], `100644 blob ${kept}\ta.txt\x00040000 tree ${inner}\t${name}\x00`).trim();
      const commit = git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "crafted"]).trim();
      git(root, ["update-ref", "refs/heads/main", commit]);
      // The index and the working tree follow the crafted commit, so only the path rules can refuse it.
      git(root, ["-c", "core.protectNTFS=false", "read-tree", "HEAD"]);
      git(root, ["-c", "core.protectNTFS=false", "checkout-index", "-a", "-f"]);
      await assert.rejects(snap(root), refusal(new RegExp(`^The commit holds a path Nivra won't send \\(.*: ${words.source}\\)\\. Rename it in a new commit, then try again\\.$`)));
    }
  });

  it("refuses a git older than the one whose commands it uses, saying what it found", async () => {
    const root = repoWith({ "a.txt": "a\n" });
    const old = join(scratch("old git"), "git");
    writeFileSync(old, "#!/bin/sh\necho 'git version 2.17.1'\n", { mode: 0o755 });
    await assert.rejects(snap(root, { git: old }), refusal(/^Snapshots need git 2\.18 or newer, and this target has git version 2\.17\.1\. Update git, then try again\.$/));
  });

  it("reads a SHA-256 repository and reports Git LFS pointers", async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize 12\n`;
    const root = repoWith({ "a.txt": "a\n", "big.psd": pointer }, { objectFormat: "sha256" });
    const snapshot = await snap(root);
    assert.deepEqual([snapshot.objectFormat, snapshot.baseline.length], ["sha256", 64]);
    assert.equal(snapshot.baseline, git(root, ["rev-parse", "HEAD"]).trim());
    assert.deepEqual([snapshot.lfsPointers.count, snapshot.lfsPointers.sample], [1, ["big.psd"]]);
  });

  it("gives the same fingerprint for the same commit and folder, and another when either changes", async () => {
    const root = repoWith({ "a.txt": "a\n", "sub/b.txt": "b\n" });
    const first = await snap(root);
    assert.equal((await snap(root)).fingerprint, first.fingerprint);
    assert.notEqual((await snap(join(root, "sub"))).fingerprint, first.fingerprint);
    writeFileSync(join(root, "a.txt"), "changed\n");
    git(root, ["commit", "-q", "-am", "next"]);
    assert.notEqual((await snap(root)).fingerprint, first.fingerprint);
  });
});

/** The independent review of the first draft (`f027403`): each case here was reproduced against that commit. */
describe("commit snapshots, after the review", () => {
  it("refuses a split index before git reads it, where plain git status changes .git, and checks the checkout once its index is whole", async () => {
    const root = repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    git(root, ["config", "core.splitIndex", "true"]);
    git(root, ["update-index", "--split-index"]);
    const shared = readdirSync(join(root, ".git")).filter((name) => name.startsWith("sharedindex."));
    assert.equal(shared.length, 1);
    // Set back, so a refresh of its time would show.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(root, ".git", shared[0]!), past, past);
    let before = folderState(root);
    await assert.rejects(snap(root), refusal(/^This checkout uses a split index, and git changes a file in \.git whenever it reads one, so Nivra won't check it\. Run `git update-index --no-split-index` there, then try again\.$/, "repository"));
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
    // The control: git status, even with optional locks off, refreshes the shared file's time.
    spawnSync(GIT, ["status", "--porcelain"], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    assert.deepEqual(changedSince(before, root), [`.git/${shared[0]}`]);

    git(root, ["config", "core.splitIndex", "false"]);
    git(root, ["update-index", "--no-split-index"]);
    before = folderState(root);
    assert.equal((await snap(root)).files.length, 2);
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
  });

  it("refuses files git is told not to look at, whose edits git status can't see", async () => {
    const root = repoWith({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    git(root, ["update-index", "--assume-unchanged", "a.txt"]);
    writeFileSync(join(root, "a.txt"), "the person's own work\n");
    const before = folderState(root);
    await assert.rejects(snap(root), refusal(/^1 file in this folder is marked for git not to look at \(assume-unchanged or skip-worktree, as a sparse checkout does\), so Nivra can't tell whether it changed\. Clear the marks with `git update-index --no-assume-unchanged` or `--no-skip-worktree`, then try again\.$/, "uncommitted"));
    git(root, ["update-index", "--skip-worktree", "b.txt"]);
    writeFileSync(join(root, "b.txt"), "more of it\n");
    await assert.rejects(snap(root), refusal(/^2 files in this folder are marked for git not to look at/, "uncommitted"));
    assert.deepEqual(changedSince(before, root).filter((path) => !path.startsWith(".git/index") && path !== "b.txt" && path !== ".git"), [], "the checkout changed");
  });

  it("refuses a picked folder whose path holds a newline, rather than sending a sibling folder", async () => {
    const root = repoWith({ "a/one.txt": "the sibling\n", "a\nb/two.txt": "the picked folder\n" });
    await assert.rejects(snap(join(root, "a\nb")), refusal(/^The picked folder's path in the repository can't be sent \(it holds a control or invisible character\)\. Rename it, or pick a folder whose path is plain, then try again\.$/, "path"));
    assert.deepEqual(
      (await snap(join(root, "a"))).files.map((file) => file.path),
      ["one.txt"],
    );
  });

  it("refuses a committed path that isn't UTF-8, which would otherwise be renamed on its way", async () => {
    const root = repoWith({ "readme.md": "r\n" });
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])]), "a Latin-1 name\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "latin-1"]);
    await assert.rejects(snap(root), refusal(/^The commit holds a path that isn't valid UTF-8 \("caf�\.txt"\), so Nivra won't send this folder\. Rename it in a new commit, then try again\.$/, "path"));
  });

  it("refuses a filter driver whose name isn't UTF-8, which it couldn't switch off, and so never runs it", async () => {
    const root = repoWith({ "a.txt": "a\n" });
    const markerDir = track(mkdtempSync(join(tmpdir(), "nivra-markers-")));
    const markers = join(markerDir, "markers");
    writeFileSync(join(markerDir, "mark-clean"), `#!/bin/sh\necho clean >> '${markers}'\nexec cat\n`, { mode: 0o755 });
    const name = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    writeFileSync(join(root, ".gitattributes"), Buffer.concat([Buffer.from("*.txt filter="), name, Buffer.from("\n")]));
    git(root, ["add", ".gitattributes"]);
    git(root, ["commit", "-q", "-m", "attributes"]);
    writeFileSync(join(root, ".git", "config"), Buffer.concat([readFileSync(join(root, ".git", "config")), Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = ${join(markerDir, "mark-clean")} %f\n`)]));
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(root, ".git", "index"), past, past);
    await assert.rejects(snap(root), refusal(/^A filter driver in this repository's git configuration has a name that isn't valid UTF-8, so Nivra can't switch it off safely and won't check the checkout\. Rename it, then try again\.$/, "repository"));
    assert.equal(existsSync(markers), false, "the repository's filter ran");
    // The control: plain git status runs it.
    spawnSync(GIT, ["status", "--porcelain"], { cwd: root });
    assert.equal(existsSync(markers), true, "plain git status didn't run the filter");
  });

  it("keeps git's own words out of a refusal's message, in its detail", async () => {
    const root = repoWith({ "a.txt": "a\n" });
    const failing = join(scratch("failing git"), "git");
    writeFileSync(failing, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--version" ] && { echo 'git version 2.43.0'; exit 0; }; done\necho "fatal: private-plain-text-from-stderr" >&2\nexit 128\n`, { mode: 0o755 });
    await assert.rejects(snap(root, { git: failing }), (error: unknown) => {
      refusal(/^git rev-parse failed \(exit 128\)\.$/, "git")(error);
      assert.equal((error as WorkspaceRefusal).detail, "fatal: private-plain-text-from-stderr");
      return true;
    });
  });

  it("finds keys and tokens in UTF-16, inside base64, as PGP blocks, and from a key's first line alone, and leaves public material alone", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7\n-----END PRIVATE KEY-----\n";
    const cases: Array<[string, Uint8Array, string[]]> = [
      ["UTF-16LE, no byte-order mark", Buffer.from(`token = ${token}\n`, "utf16le"), ["a GitHub token"]],
      ["UTF-16LE with its mark", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(token, "utf16le")]), ["a GitHub token"]],
      ["UTF-16BE, no mark", Buffer.from(`token = ${token}\n`, "utf16le").swap16(), ["a GitHub token"]],
      ["a key in a Kubernetes secret", Buffer.from(`data:\n  tls.key: ${Buffer.from(pem).toString("base64")}\n`), ["a private key"]],
      ["a token in base64", Buffer.from(`auth: ${Buffer.from(`user:${token}`).toString("base64")}\n`), ["a GitHub token"]],
      ["a token in wrapped base64, split inside its encoding", Buffer.from(`blob: |\n${Buffer.from(`header line\nTOKEN=${token}\n`).toString("base64").replace(/.{1,20}/g, (line) => `  ${line}\n`)}`), ["a GitHub token"]],
      ["words that, joined up, would read as a key", Buffer.from("REGION: ASIA\nPACIFICGROUPINGS.\n"), []],
      ["a PGP private key", Buffer.from("-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\n"), ["a private key"]],
      ["a key's first line, its last missing", Buffer.from("const key = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA`;\n"), ["a private key"]],
      ["a public certificate", Buffer.from("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"), []],
      ["an image in base64", Buffer.from(`url(data:image/png;base64,${Buffer.from(new Uint8Array(600).map((_, i) => (i * 7) % 256)).toString("base64")})`), []],
    ];
    for (const [what, bytes, kinds] of cases) assert.deepEqual(credentialKinds(bytes, []), kinds, what);
    const root = repoWith({ "k8s/secret.yaml": `data:\n  tls.key: ${Buffer.from(pem).toString("base64")}\n`, "README.md": "# r\n" });
    await assert.rejects(snap(root), refusal(/^k8s\/secret\.yaml in this commit holds what looks like a private key, so Nivra won't upload it\./, "content"));
  });

  it("finds a vault value inside base64, though it has no shape of its own, wherever it sits in what was encoded and however the encoding was broken up", () => {
    // Values no pattern knows: only the vault does. The short one encodes to a run under base64's 40 characters, and
    // the marked one's encoding holds `+` and `/`, which the URL-safe form writes as `-` and `_`.
    const value = "plain-words-no-known-prefix-4821";
    const short = "sixteen-bytes-ok";
    const marked = "url-safe?>?>?>?>?>?>?>~~0451";
    const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
    const lines = (encoded: string, width: number) => encoded.match(new RegExp(`.{1,${width}}`, "g")) ?? [];
    const jwtPart = Buffer.from(`{"k":"${marked}"}`).toString("base64url");
    assert.match(jwtPart, /[-_]/, "the URL-safe case holds URL-safe characters");
    // As PHP's json_encode writes it, every `/` escaped.
    const escapedSlashes = JSON.stringify({ k: b64(`x${marked}`) }).replaceAll("/", "\\/");
    assert.match(escapedSlashes, /\\\//, "the escaped case holds an escaped slash");
    const cases: Array<[string, Buffer]> = [
      ["a Kubernetes secret", Buffer.from(`data:\n  token: ${b64(value)}\n`)],
      ["one byte into what was encoded", Buffer.from(`auth: ${b64(`:${value}`)}\n`)],
      ["two bytes in", Buffer.from(`auth: ${b64(`u:${value}`)}\n`)],
      ["mid-way through a long text, wrapped and indented", Buffer.from(`blob: |\n${lines(b64(`${"lorem ipsum ".repeat(9)}${value} and the rest`), 20).map((line) => `    ${line}\n`).join("")}`)],
      ["wrapped by escaped line breaks in JSON", Buffer.from(JSON.stringify({ env: lines(b64(`REGION=eu-north1\nNEBIUS_API_KEY=${value}\n`), 76).join("\n") }))],
      ["broken by a shell's line continuations", Buffer.from(`TOKEN=${lines(b64(`key=${value}`), 12).join("\\\n")}\n`)],
      ["split across string literals joined with +", Buffer.from(`const k = ${lines(b64(`x${value}`), 16).map((part) => `"${part}"`).join(" +\n  ")};\n`)],
      ["with JSON's escaped slashes", Buffer.from(escapedSlashes)],
      ["inside two layers, as a dockerconfigjson secret keeps a registry's auth", Buffer.from(`data:\n  .dockerconfigjson: ${b64(JSON.stringify({ auths: { "registry.example": { auth: b64(`user:${value}`) } } }))}\n`)],
      ["URL-safe and unpadded, as a JWT carries it", Buffer.from(`jwt: x.${jwtPart}.y\n`)],
      ["UTF-16LE, as PowerShell encodes a command", Buffer.from(`powershell -EncodedCommand ${b64(Buffer.from(`echo ${value}`, "utf16le"))}\n`)],
      ["a run too short to be decoded", Buffer.from(`k: ${b64(short)}\n`)],
    ];
    for (const [what, bytes] of cases) {
      assert.deepEqual(credentialKinds(bytes, [value, short, marked]), ["a value Nivra keeps as a secret"], what);
      assert.deepEqual(credentialKinds(bytes, []), [], `${what}: without the vault, nothing recognises it`);
    }
    assert.deepEqual(credentialKinds(Buffer.from(`data:\n  token: ${b64(value)}\n`), ["a-different-vault-value-0451"]), [], "another value isn't found");
  });

  it("refuses a commit holding a vault value in base64, as a Kubernetes secret keeps one, naming the path but never the value or its encoding", async () => {
    const value = "plain-words-no-known-prefix-4821";
    const encoded = Buffer.from(value).toString("base64");
    const root = repoWith({ "deploy/deployment.yaml": `apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\ndata:\n  token: ${encoded}\n`, "README.md": "# r\n" });
    const before = folderState(root);
    await assert.rejects(snap(root, { knownValues: [value] }), (error: unknown) => {
      refusal(/^deploy\/deployment\.yaml in this commit holds what looks like a value Nivra keeps as a secret, so Nivra won't upload it\./, "content")(error);
      assert.ok(![value, encoded].some((secret) => (error as Error).message.includes(secret)), "the refusal quoted the secret");
      return true;
    });
    // Without the vault's values nothing recognises it, and it would go: the vault is what keeps it back.
    assert.deepEqual((await snap(root)).files.map((file) => file.path), ["README.md", "deploy/deployment.yaml"]);
    assert.deepEqual(changedSince(before, root), [], "the checkout changed");
  });
});
