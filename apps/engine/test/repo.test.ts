import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { createLocalBackend } from "../src/exec/local.ts";
import { findGit } from "../src/exec/find-executable.ts";
import { hiddenReason, outputRoot } from "../src/repo/deny.ts";
import { LIMITS, RepoReader } from "../src/repo/files.ts";
import { checkRelativePath, RepoError } from "../src/repo/paths.ts";
import { combinedMask } from "../src/secrets/patterns.ts";
import { removeDir, tempDir } from "./helpers.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeDir(dir);
});

const GIT = findGit({ env: process.env })!;
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const write = (root: string, path: string, content: string | Buffer) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const SECRET_SHAPED = `sk-proj-${"a1B2c3D4e5".repeat(3)}`;

/** A repository with something of everything the reader must handle, all committed. */
function makeFixture(): string {
  const root = join(tempDir(), "repo ü%#");
  dirs.push(dirname(root));
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "# Demo\nBuild with `pnpm build`.\nTest with `pnpm test`.\n");
  write(root, "src/app.ts", Array.from({ length: 600 }, (_, i) => `export const line${i + 1} = "needle-${i + 1}";`).join("\n") + "\n");
  write(root, "src/config.ts", `export const token = "${SECRET_SHAPED}";\nexport const after = "needle-after-secret";\n`);
  write(root, ".env", "API_KEY=needle-in-env\n");
  write(root, ".env.example", "API_KEY=needle-example\n");
  write(root, "node_modules/lib/index.js", "module.exports = 'needle-in-deps';\n");
  write(root, "apps/web/dist/bundle.js", "var a='needle-in-dist';\n");
  write(root, "keys/id_rsa", "needle-in-key\n");
  write(root, "big.html", `<p>${"x".repeat(LIMITS.readBytes + 10)} needle-in-big</p>\n`);
  write(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  write(root, "sub/inner.ts", "export const inner = 'needle-in-sub';\n");
  symlinkSync(".env", join(root, "env-link"));
  git(root, "add", "-A", "-f");
  git(root, "commit", "-q", "-m", "fixture");
  write(root, "untracked.ts", "export const u = 'needle-untracked';\n");
  return root;
}

async function reader(root: string, signal?: AbortSignal) {
  const session = await createLocalBackend({ baseEnv: process.env }).open({ workspace: root });
  return RepoReader.open({ root, session, git: GIT, mask: combinedMask((text) => text), signal });
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "not refused";
  } catch (error) {
    return error instanceof RepoError ? error.message : `not a RepoError: ${String(error)}`;
  }
};

describe("deny rules (D20, D22)", () => {
  it("hides secret-bearing files and dependency or build output, each with its own reason; .env.example stays readable", () => {
    const cases: Array<[string, string | null]> = [
      [".env", "secret"],
      ["apps/api/.env.local", "secret"],
      [".env.example", null],
      ["deploy/key.PEM", "secret"],
      ["home/.ssh/config", "secret"],
      [".mcp.json", "secret"],
      ["service-account-prod.json", "secret"],
      ["node_modules/react/index.js", "output"],
      ["apps/web/dist/main.js", "output"],
      ["packages/x/coverage/lcov.info", "output"],
      ["src/build.ts", null],
      ["src/outbox/index.ts", null],
    ];
    assert.deepEqual(cases.map(([path]) => hiddenReason(path)), cases.map(([, reason]) => reason));
    assert.equal(outputRoot("apps/web/dist/a/b.js"), "apps/web/dist");
  });

  it("refuses paths that leave the repository or aren't relative", () => {
    for (const path of ["/etc/passwd", "\\\\server\\share\\x", "C:\\x", "../outside", "a/../../b"]) assert.throws(() => checkRelativePath(path), RepoError, path);
    assert.equal(checkRelativePath("./src/../src/app.ts"), "src/app.ts");
  });
});

describe("RepoReader (NIV-9, D22)", () => {
  it("lists tracked files only, naming hidden ones without reading them", async () => {
    const repo = await reader(makeFixture());
    const listed = repo.list({});
    assert.ok(listed.files.includes("src/app.ts") && listed.files.includes(".env.example"));
    assert.deepEqual(listed.files.filter((f) => f === ".env" || f.startsWith("node_modules/") || f === "untracked.ts"), []);
    assert.deepEqual([...listed.hidden].sort(), [".env", "apps/web/dist/bundle.js", "keys/id_rsa", "node_modules/lib/index.js"]);
    assert.deepEqual(repo.list({ glob: "src/**" }).files, ["src/app.ts", "src/config.ts"]);
  });

  it("searches without reading hidden, oversized, binary or untracked files, and hashes each hit's file", async () => {
    const root = makeFixture();
    const repo = await reader(root);
    const { result, delivered } = await repo.search({ query: "needle-" });
    const paths = [...new Set(result.matches.map((m) => m.path))].sort();
    assert.deepEqual(paths, [".env.example", "README.md", "src/app.ts", "src/config.ts", "sub/inner.ts"].filter((p) => p !== "README.md"));
    assert.ok(result.filesWithMore.includes("src/app.ts"), "five lines a file, the rest named");
    const appHash = createHash("sha256").update(spawnSync("cat", [join(root, "src/app.ts")]).stdout).digest("hex");
    assert.equal(delivered.find((d) => d.path === "src/app.ts")?.sha256, appHash);
    assert.deepEqual(delivered.map((d) => d.startLine === d.endLine), delivered.map(() => true));
  });

  it("reads pages of whole numbered lines, says exactly which it delivered, and masks secret shapes keeping line numbers", async () => {
    const repo = await reader(makeFixture());
    const first = await repo.read({ path: "src/app.ts" });
    assert.deepEqual([first.result.startLine, first.result.endLine, first.result.nextStartLine, first.delivered.endLine], [1, first.result.endLine, first.result.endLine + 1, first.result.endLine]);
    assert.ok(first.result.endLine < LIMITS.readLines + 1 && first.result.content.startsWith("    1| export const line1"));
    const clipped = await repo.read({ path: "src/app.ts", startLine: 10, endLine: 600 }, 2_000);
    assert.ok(clipped.result.endLine < 600, "a smaller cap delivers fewer lines");
    assert.equal(clipped.delivered.endLine, clipped.result.endLine);
    const secret = await repo.read({ path: "src/config.ts" });
    assert.equal(secret.result.content.includes(SECRET_SHAPED), false);
    assert.match(secret.result.content, /    2\| export const after/);
  });

  it("refuses hidden, untracked, oversized, binary and linked-to-hidden files, saying why", async () => {
    const repo = await reader(makeFixture());
    assert.match(await refusal(repo.read({ path: ".env" })), /may hold credentials/);
    assert.match(await refusal(repo.read({ path: "node_modules/lib/index.js" })), /dependency or build output/);
    assert.match(await refusal(repo.read({ path: "untracked.ts" })), /isn't a tracked file/);
    assert.match(await refusal(repo.read({ path: "big.html" })), /larger than the 200 KB/);
    assert.match(await refusal(repo.read({ path: "logo.png" })), /binary file/);
    assert.match(await refusal(repo.read({ path: "env-link" })), /points to \.env, which is hidden/);
  });

  it("scopes a project that is a subfolder of a repository to that folder", async () => {
    const root = makeFixture();
    const repo = await reader(join(root, "sub"));
    assert.deepEqual(repo.list({}).files, ["inner.ts"]);
    const { result } = await repo.search({ query: "needle-" });
    assert.deepEqual(result.matches.map((m) => m.path), ["inner.ts"]);
  });

  it("keeps listed and searched paths relative to the picked folder and out of submodules, whatever git is configured to do", async () => {
    const root = makeFixture();
    const library = join(dirname(root), "library");
    mkdirSync(library);
    git(library, "init", "-q", "-b", "main");
    write(library, "lib.ts", "export const lib = 'needle-in-submodule';\n");
    git(library, "add", "-A");
    git(library, "commit", "-q", "-m", "lib");
    git(join(root, "sub"), "submodule", "add", "-q", library, "vendored-lib");
    git(root, "commit", "-q", "-m", "submodule");
    git(root, "config", "grep.fullName", "true");
    git(root, "config", "submodule.recurse", "true");
    const repo = await reader(join(root, "sub"));
    const { result } = await repo.search({ query: "needle-" });
    assert.deepEqual(result.matches.map((m) => m.path), ["inner.ts"]);
    const listed = repo.list({}).files;
    assert.deepEqual([listed.includes("inner.ts"), listed.filter((path) => path.startsWith("vendored-lib/"))], [true, []]);
  });

  it("stops a search when the run is cancelled", async () => {
    const cancel = new AbortController();
    const repo = await reader(makeFixture(), cancel.signal);
    cancel.abort();
    await assert.rejects(repo.search({ query: "needle-" }), (error: unknown) => error instanceof Error && /Cancelled|aborted/i.test(error.message));
  });
});
