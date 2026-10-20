import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { findGit } from "../src/exec/find-executable.ts";
import { WorkspaceRefusal } from "../src/exec/git-tool.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { PREPARE_SCRIPT } from "../src/exec/nebius/session.ts";
import { takeSnapshot, type SnapshotOptions } from "../src/exec/snapshot.ts";
import { readTar } from "../src/exec/tar.ts";
import { removeDir, tempDir } from "./helpers.ts";

/**
 * Commit snapshots (NIV-42, D34) against real repositories made here: exact bytes from the commit, never the working
 * tree; what is left out and why; refusals for uncommitted work, unsafe content, partial clones and crafted paths;
 * and a checkout that is byte-identical afterwards, `.git` included. Nothing here reaches the network.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeDir(dir);
});

const GIT = findGit({ env: process.env })!;
function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], { cwd, input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

type Content = string | Uint8Array | { link: string } | { executable: string };
function put(root: string, path: string, content: Content): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  if (typeof content === "object" && "link" in content) symlinkSync(content.link, full);
  else if (typeof content === "object" && "executable" in content) {
    writeFileSync(full, content.executable);
    chmodSync(full, 0o755);
  } else writeFileSync(full, content);
}

/** A repository whose one commit holds `files`, in a folder whose name holds awkward characters. */
function repoWith(files: Record<string, Content>, options: { objectFormat?: "sha256" } = {}): string {
  const parent = tempDir();
  dirs.push(parent);
  const root = join(parent, "repo ü%#");
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main", ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : [])]);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  git(root, ["add", "-A", "-f"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

/** Every name, kind, mode, size, time and byte under a folder, `.git` included: an equal hash means nothing changed. */
function folderState(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path, { bigint: true });
      hash.update(`${relative(root, path)}\0${info.mode}\0${info.size}\0${info.mtimeNs}\0`);
      if (info.isDirectory()) walk(path);
      else hash.update(info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    }
  };
  hash.update(String(lstatSync(root, { bigint: true }).mtimeNs));
  walk(root);
  return hash.digest("hex");
}

async function snap(folder: string, extra: Partial<SnapshotOptions> = {}) {
  const session = await createLocalBackend({ baseEnv: process.env }).open({ workspace: folder });
  try {
    return await takeSnapshot({ folder, session, git: GIT, ...extra });
  } finally {
    await session.close();
  }
}

/** A refusal whose words match `pattern`. */
const refusal = (pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof WorkspaceRefusal, `expected a refusal, got ${String(error)}`);
  assert.match(error.message, pattern);
  return true;
};
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
    const guest = mkdtempSync(join(tmpdir(), "nivra snapshot guest "));
    dirs.push(guest);
    const archive = join(guest, "snapshot.tar");
    writeFileSync(archive, snapshot.archive.archive);
    const ran = spawnSync("/bin/sh", ["-c", PREPARE_SCRIPT, "nivra-prepare", join(guest, "workspace"), archive, "", join(guest, "listing")], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, `entries ${snapshot.files.length}\ndigest ${snapshot.archive.listingDigest}\n`);
    assert.equal(readFileSync(join(guest, "workspace", "crlf.txt"), "utf8"), CRLF);

    assert.equal(folderState(root), before, "the checkout changed");
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
    assert.equal(folderState(root), before, "the checkout changed");

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
    assert.equal(folderState(root), before, "the checkout changed");
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
    assert.equal(folderState(root), before, "the checkout changed");

    const refused = async (pattern: RegExp) => {
      before = folderState(root);
      await assert.rejects(snap(root), refusal(pattern));
      assert.equal(folderState(root), before, "the checkout changed");
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
    const markerDir = mkdtempSync(join(tmpdir(), "nivra-markers-"));
    dirs.push(markerDir);
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
      assert.equal(folderState(root), before, `${state}: the checkout changed`);
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
    assert.equal(folderState(clone), before, "the checkout changed");
  });

  it("refuses a repository with no commits, and a baseline that isn't HEAD", async () => {
    const parent = tempDir();
    dirs.push(parent);
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
    assert.equal(folderState(root), before, "the checkout changed");
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
