import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SessionOpenError, type ExecutionSession, type SessionSpec } from "../src/exec/backend.ts";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { collectResult, findChanges } from "../src/exec/patch.ts";
import type { Snapshot } from "../src/exec/snapshot.ts";
import { WorkspaceCopy } from "../src/task/copy.ts";
import { clock } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { attempt, FIX, KEY, labels, PROJECT, verdicts } from "./task-fixtures.ts";
import { cleanUp, put, repoWith, scratch, snap, type Content } from "./workspace-fixtures.ts";

/**
 * Sessions started from a prepared image (NIV-49, NIV-55): its workspace already holds dependency folders, as a frozen
 * install leaves them, at the root and in packages, and the snapshot is extracted over it. The prepare and collect steps
 * leave out the folders the session is given (a recipe's dependency folders, node_modules here), so everything else
 * must still be exactly the commit, and nothing under them is ever collected or proposed. A tracked file is source
 * wherever it is, a folder named like build output included. The guest really runs the engine's scripts, with this
 * machine's tools.
 */
after(cleanUp);

const WORKSPACE = "/workspace";

/** A pnpm-like repository, with a file and a link named like output folders (neither is a folder, so both are source), and a file tracked under a folder named like build output, which is source too. */
const REPO: Record<string, Content> = {
  "package.json": '{ "name": "root", "private": true }\n',
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/a/package.json": '{ "name": "a" }\n',
  "packages/a/src/index.js": "export const a = 1;\n",
  build: { executable: "#!/bin/sh\necho build\n" },
  "lib/node_modules": { link: "../packages/a" },
  "vendor/tool.js": "export const tool = 1;\n",
};

/** A prepared image's folder: its workspace holds what an install leaves, and `extra` besides. */
function preparedImage(extra: Record<string, Content> = {}): string {
  const folder = scratch("prepared image");
  const files: Record<string, Content> = {
    "node_modules/dep/index.js": "module.exports = 'dep';\n",
    "node_modules/.bin/dep": { link: "../dep/index.js" },
    "node_modules/.pnpm/lock.yaml": "lockfileVersion: '9.0'\n",
    "packages/a/node_modules/dep/index.js": "module.exports = 'dep, in a';\n",
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) put(join(folder, "workspace"), path, content);
  return folder;
}

/** The folders a recipe's install writes, which its sessions leave out. */
const DEPENDENCY = ["node_modules"];

/** The production backend on a guest whose base image is `prepared`, leaving out the recipe's dependency folders. */
function sessionOn(prepared: string) {
  const guest = new RealGuest();
  guest.quick = true;
  guest.images.set(guest.baseImage, prepared);
  const time = clock();
  const backend = createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: guest.baseImage, dependencyFolders: DEPENDENCY, journalDir: scratch("journals"), transport: () => guest.service.transport, applets: "", limits: { prepareTimeoutSeconds: 60, pollMs: 10 }, now: time.now, sleep: time.sleep });
  return { guest, backend };
}

const spec = (snapshot: Snapshot): SessionSpec => ({ workspace: WORKSPACE, network: "deny", requires: { isolatesFilesystem: true }, snapshot: snapshot.archive });

/** A persisted command in the workspace, as a check that changes files would be. */
async function run(session: ExecutionSession, script: string): Promise<void> {
  const ran = await session.exec({ argv: ["/bin/sh", "-c", script], cwd: WORKSPACE, timeoutMs: 30_000, maxOutputBytes: 4_096, persist: true });
  assert.deepEqual([ran.exitCode, ran.persisted], [0, true], ran.stderr);
}

/** Paths under a dependency folder, as find's `-name` matches one: by its exact name, at any depth. */
const underDependency = (path: string) => path.split("/").slice(0, -1).some((segment) => DEPENDENCY.includes(segment));

describe("a session from a prepared image (NIV-49)", () => {
  it("extracts the snapshot over a workspace already holding dependency folders, and its listing still matches", async () => {
    const snapshot = await snap(repoWith(REPO));
    // The file tracked under a folder named like build output is sent like any other (NIV-55): nothing is left out.
    assert.deepEqual([snapshot.leftOut.output.count, snapshot.leftOutPaths], [0, []]);
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["build", "lib/node_modules", "package.json", "packages/a/package.json", "packages/a/src/index.js", "pnpm-workspace.yaml", "vendor/tool.js"],
    );
    // The image holds an older copy of two files the snapshot holds.
    const { guest, backend } = sessionOn(preparedImage({ "vendor/tool.js": "the image's own copy\n", "package.json": "{}\n" }));
    const session = await backend.open(spec(snapshot));
    await session.close();
    assert.deepEqual(labels(guest), ["nivra-prepare"]);
    // Nothing was emptied: the image's dependencies are where its preparation left them, beside the commit's files,
    // and where both have a file, the commit's is the one there.
    const image = "img-real-1";
    assert.deepEqual(
      ["node_modules/dep/index.js", "packages/a/node_modules/dep/index.js", "vendor/tool.js", "package.json", "packages/a/src/index.js"].map((path) => guest.read(image, `workspace/${path}`)?.toString()),
      ["module.exports = 'dep';\n", "module.exports = 'dep, in a';\n", "export const tool = 1;\n", '{ "name": "root", "private": true }\n', "export const a = 1;\n"],
    );
  });

  it("refuses an image whose workspace holds anything else: a stray file, a name only like a dependency folder's, build output, or a file the snapshot leaves out", async () => {
    const snapshot = await snap(repoWith(REPO));
    const extras: Array<Record<string, Content>> = [{ "stray.js": "x\n" }, { "packages/a/src/extra.js": "x\n" }, { "Node_Modules/dep.js": "x\n" }, { "node_modules.js": "x\n" }, { ".npmrc": "store-dir=/store\n" }, { "packages/a/.turbo/turbo-build.log": "built\n" }];
    for (const extra of extras) {
      const { guest, backend } = sessionOn(preparedImage(extra));
      await assert.rejects(backend.open(spec(snapshot)), (error: Error) => error instanceof SessionOpenError && /its listing differs/.test(error.message), Object.keys(extra)[0]);
      assert.deepEqual(labels(guest), ["nivra-prepare"]);
    }
  });

  it("leaves changes under dependency folders out of the result, and still refuses any other change Nivra didn't write, build output included", async () => {
    const snapshot = await snap(repoWith(REPO));
    const { backend } = sessionOn(preparedImage());
    const session = await backend.open(spec(snapshot));
    try {
      assert.deepEqual(session.leftOut, DEPENDENCY);
      await run(session, "echo changed > node_modules/dep/index.js && echo new > packages/a/node_modules/dep/new.js");
      const { collected } = await collectResult(session, { workspace: WORKSPACE, applets: "" });
      // The entries are the archive's, checked against the listing: no dependency output is in either.
      assert.deepEqual(collected.entries.filter((entry) => underDependency(entry.path)).map((entry) => entry.path), []);
      assert.deepEqual(
        collected.entries.map((entry) => entry.path),
        snapshot.files.map((file) => file.path),
      );
      const copy = new WorkspaceCopy(snapshot, session.leftOut);
      copy.checkIntegrity(collected);
      const changes = findChanges(snapshot, collected);
      assert.deepEqual([changes.added.length, changes.changed.length, changes.deleted.length, changes.generated.count], [0, 0, 0, 0]);

      // Build output is no longer left out by its folder's name (NIV-55): collect brings it back, so what Nivra didn't
      // write is seen, and a change leaves it out as generated.
      await run(session, "mkdir -p packages/a/dist && echo out > packages/a/dist/index.js");
      const built = await collectResult(session, { workspace: WORKSPACE, applets: "" });
      assert.ok(built.collected.entries.some((entry) => entry.path === "packages/a/dist/index.js"), "collect left build output out");
      assert.throws(() => copy.checkIntegrity(built.collected), /"packages\/a\/dist\/index\.js" is in it, and Nivra didn't write it/);
      assert.deepEqual([findChanges(snapshot, built.collected).generated.sample, findChanges(snapshot, built.collected).added.length], [["packages/a/dist/index.js"], 0]);
      await run(session, "rm -r packages/a/dist");

      await run(session, "echo 'export const a = 2;' > packages/a/src/index.js");
      const again = await collectResult(session, { workspace: WORKSPACE, applets: "" });
      assert.throws(() => copy.checkIntegrity(again.collected), /^WorkspaceRefusal: The sandbox's result isn't the commit plus the worker's checked writes: "packages\/a\/src\/index\.js" differs from what Nivra wrote\. No change was proposed\.$/);
    } finally {
      await session.close();
    }
  });

  it("refuses a worker's write into a dependency folder or untracked build output at any depth, and lets it edit and add to a tracked one", async () => {
    const copy = new WorkspaceCopy(await snap(repoWith(REPO)), DEPENDENCY);
    const bytes = new TextEncoder().encode("x\n");
    for (const path of ["node_modules/dep/index.js", "packages/a/node_modules/dep/index.js"]) {
      assert.match(copy.writeProblem(path, bytes) ?? "", /is in a folder the project's environment installs into, which a change leaves out$/, path);
    }
    assert.match(copy.writeProblem("packages/a/.turbo/turbo-build.log", bytes) ?? "", /is dependency, cache or build output \(in a folder the commit doesn't track\), which a change leaves out$/);
    // A folder named like build output that the commit tracks is source (NIV-55): its file can be edited, and added to.
    assert.deepEqual([copy.writeProblem("vendor/tool.js", bytes), copy.writeProblem("vendor/more.js", bytes)], [null, null]);
    assert.match(copy.writeProblem("vendor", bytes) ?? "", /"vendor" is a folder/);
    // The file and the link named like output folders are the commit's own, and stay writable or refused as such.
    assert.equal(copy.writeProblem("build", bytes), null);
    assert.match(copy.writeProblem("lib/node_modules", bytes) ?? "", /is a link, which this task can't write/);
  });
});

describe("a task's worker on a prepared image (NIV-49)", () => {
  const withImage = (guest: RealGuest) => guest.images.set(guest.baseImage, preparedImage());
  const leftOut = DEPENDENCY;

  it("proposes the verified fix, with nothing under the dependency folders in it, and refuses writes into them", async () => {
    const run = await attempt({
      setup: withImage,
      leftOut,
      calls: [["create_file", { path: "node_modules/dep/index.js", content: "x\n" }], ["create_file", { path: "packages/a/node_modules/x.js", content: "x\n" }], ["edit_file", FIX], ["run_case", { number: 1 }]],
    });
    assert.deepEqual([run.result.outcome, run.result.stopped], ["proposed", null]);
    assert.deepEqual(verdicts(run.core), ["case 1 passed", "check 1 passed"]);
    assert.deepEqual([run.core!.worker.tools.refused, run.core!.worker.written, run.core!.verified], [2, ["greet.sh"], true]);
    assert.deepEqual(
      run.result.proposal!.binding.paths.map((path) => [path.path, path.change]),
      [["greet.sh", "changed"]],
    );
  });

  it("ignores a dependency changed in the sandbox, and still stops when a source file changes that Nivra didn't write", async () => {
    const changed = await attempt({
      leftOut,
      setup: (guest) => {
        withImage(guest);
        guest.alter = ({ label }, folder) => label === "nivra-write" && writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "changed by a check\n");
      },
    });
    assert.deepEqual([changed.result.outcome, changed.core?.verified], ["proposed", true]);
    assert.deepEqual(
      changed.result.proposal!.binding.paths.map((path) => path.path),
      ["greet.sh"],
    );

    const stray = await attempt({
      leftOut,
      setup: (guest) => {
        withImage(guest);
        guest.alter = ({ label }, folder) => label === "nivra-write" && writeFileSync(join(folder, "workspace", "check.sh"), "exit 0\n");
      },
    });
    assert.deepEqual([stray.result.outcome, stray.result.stopped?.code, stray.result.proposal], ["refused", "result", null]);
    assert.match(stray.result.stopped!.message, /"check\.sh" differs from what Nivra wrote/);
  });
});
