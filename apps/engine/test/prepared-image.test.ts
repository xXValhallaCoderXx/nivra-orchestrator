import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SessionOpenError, type ExecutionSession, type SessionSpec } from "../src/exec/backend.ts";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { collectResult, findChanges } from "../src/exec/patch.ts";
import type { Snapshot } from "../src/exec/snapshot.ts";
import { OUTPUT_DIRS } from "../src/repo/deny.ts";
import { WorkspaceCopy } from "../src/task/copy.ts";
import { clock } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { attempt, FIX, KEY, labels, PROJECT, verdicts } from "./task-fixtures.ts";
import { cleanUp, put, repoWith, scratch, snap, type Content } from "./workspace-fixtures.ts";

/**
 * Sessions started from a prepared image (NIV-49): its workspace already holds dependency folders, as a frozen install
 * leaves them, at the root and in packages, and the snapshot is extracted over it. The prepare and collect steps leave
 * the output folders (`OUTPUT_DIRS`) out, so everything else must still be exactly the commit, and nothing under them
 * is ever collected or proposed. The guest really runs the engine's scripts, with this machine's tools.
 */
after(cleanUp);

const WORKSPACE = "/workspace";

/** A pnpm-like repository, with a file and a link named like output folders (neither is a folder, so both are source), and a file tracked under one. */
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
    "packages/a/.turbo/turbo-build.log": "built\n",
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) put(join(folder, "workspace"), path, content);
  return folder;
}

/** The production backend on a guest whose base image is `prepared`. */
function sessionOn(prepared: string) {
  const guest = new RealGuest();
  guest.quick = true;
  guest.images.set(guest.baseImage, prepared);
  const time = clock();
  const backend = createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: guest.baseImage, journalDir: scratch("journals"), transport: () => guest.service.transport, applets: "", limits: { prepareTimeoutSeconds: 60, pollMs: 10 }, now: time.now, sleep: time.sleep });
  return { guest, backend };
}

const spec = (snapshot: Snapshot): SessionSpec => ({ workspace: WORKSPACE, network: "deny", requires: { isolatesFilesystem: true }, snapshot: snapshot.archive });

/** A persisted command in the workspace, as a check that changes files would be. */
async function run(session: ExecutionSession, script: string): Promise<void> {
  const ran = await session.exec({ argv: ["/bin/sh", "-c", script], cwd: WORKSPACE, timeoutMs: 30_000, maxOutputBytes: 4_096, persist: true });
  assert.deepEqual([ran.exitCode, ran.persisted], [0, true], ran.stderr);
}

/** Paths under an output folder, as find's `-name` matches one: by its exact name, at any depth. */
const underOutput = (path: string) => path.split("/").slice(0, -1).some((segment) => OUTPUT_DIRS.includes(segment));

describe("a session from a prepared image (NIV-49)", () => {
  it("extracts the snapshot over a workspace already holding dependency folders, and its listing still matches", async () => {
    const snapshot = await snap(repoWith(REPO));
    // The file tracked under an output folder is left out, counted, and kept among the paths a change may not collide with.
    assert.deepEqual([snapshot.leftOut.output.count, snapshot.leftOutPaths], [1, ["vendor/tool.js"]]);
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["build", "lib/node_modules", "package.json", "packages/a/package.json", "packages/a/src/index.js", "pnpm-workspace.yaml"],
    );
    // The image holds its own copy of a file the snapshot leaves out, and an older copy of one the snapshot holds.
    const { guest, backend } = sessionOn(preparedImage({ "vendor/tool.js": "the image's own copy\n", "package.json": "{}\n" }));
    const session = await backend.open(spec(snapshot));
    await session.close();
    assert.deepEqual(labels(guest), ["nivra-prepare"]);
    // Nothing was emptied: the image's dependencies are where its preparation left them, beside the commit's files,
    // and where both have a file, the commit's is the one there.
    const image = "img-real-1";
    assert.deepEqual(
      ["node_modules/dep/index.js", "packages/a/node_modules/dep/index.js", "vendor/tool.js", "package.json", "packages/a/src/index.js"].map((path) => guest.read(image, `workspace/${path}`)?.toString()),
      ["module.exports = 'dep';\n", "module.exports = 'dep, in a';\n", "the image's own copy\n", '{ "name": "root", "private": true }\n', "export const a = 1;\n"],
    );
  });

  it("refuses an image whose workspace holds anything else: a stray file, a name only like a dependency folder's, or a file the snapshot leaves out", async () => {
    const snapshot = await snap(repoWith(REPO));
    const extras: Array<Record<string, Content>> = [{ "stray.js": "x\n" }, { "packages/a/src/extra.js": "x\n" }, { "Node_Modules/dep.js": "x\n" }, { "node_modules.js": "x\n" }, { ".npmrc": "store-dir=/store\n" }];
    for (const extra of extras) {
      const { guest, backend } = sessionOn(preparedImage(extra));
      await assert.rejects(backend.open(spec(snapshot)), (error: Error) => error instanceof SessionOpenError && /its listing differs/.test(error.message), Object.keys(extra)[0]);
      assert.deepEqual(labels(guest), ["nivra-prepare"]);
    }
  });

  it("leaves changes under dependency folders out of the result, and still refuses any other change Nivra didn't write", async () => {
    const snapshot = await snap(repoWith(REPO));
    const { backend } = sessionOn(preparedImage());
    const session = await backend.open(spec(snapshot));
    try {
      await run(session, "echo changed > node_modules/dep/index.js && echo new > packages/a/node_modules/dep/new.js && echo again > packages/a/.turbo/turbo-build.log && mkdir -p packages/a/dist && echo out > packages/a/dist/index.js");
      const { collected } = await collectResult(session, { workspace: WORKSPACE, applets: "" });
      // The entries are the archive's, checked against the listing: no dependency or build output is in either.
      assert.deepEqual(collected.entries.filter((entry) => underOutput(entry.path)).map((entry) => entry.path), []);
      assert.deepEqual(
        collected.entries.map((entry) => entry.path),
        snapshot.files.map((file) => file.path),
      );
      const copy = new WorkspaceCopy(snapshot);
      copy.checkIntegrity(collected);
      const changes = findChanges(snapshot, collected);
      assert.deepEqual([changes.added.length, changes.changed.length, changes.deleted.length, changes.generated.count], [0, 0, 0, 0]);

      await run(session, "echo 'export const a = 2;' > packages/a/src/index.js");
      const again = await collectResult(session, { workspace: WORKSPACE, applets: "" });
      assert.throws(() => copy.checkIntegrity(again.collected), /^WorkspaceRefusal: The sandbox's result isn't the commit plus the worker's checked writes: "packages\/a\/src\/index\.js" differs from what Nivra wrote\. No change was proposed\.$/);
    } finally {
      await session.close();
    }
  });

  it("refuses a worker's write under a dependency folder at any depth, and over the file tracked under one", async () => {
    const copy = new WorkspaceCopy(await snap(repoWith(REPO)));
    const bytes = new TextEncoder().encode("x\n");
    for (const path of ["node_modules/dep/index.js", "packages/a/node_modules/dep/index.js", "packages/a/.turbo/turbo-build.log", "vendor/tool.js"]) {
      assert.match(copy.writeProblem(path, bytes) ?? "", /is dependency, build or generated output, which a change leaves out$/, path);
    }
    assert.match(copy.writeProblem("vendor", bytes) ?? "", /the new file "vendor" would stand where a folder of files left out of the snapshot is/);
    // The file and the link named like output folders are the commit's own, and stay writable or refused as such.
    assert.equal(copy.writeProblem("build", bytes), null);
    assert.match(copy.writeProblem("lib/node_modules", bytes) ?? "", /is a link, which this task can't write/);
  });
});

describe("a task's worker on a prepared image (NIV-49)", () => {
  const withImage = (guest: RealGuest) => guest.images.set(guest.baseImage, preparedImage());

  it("proposes the verified fix, with nothing under the dependency folders in it, and refuses writes into them", async () => {
    const run = await attempt({
      setup: withImage,
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
      setup: (guest) => {
        withImage(guest);
        guest.alter = ({ label }, folder) => label === "nivra-write" && writeFileSync(join(folder, "workspace", "check.sh"), "exit 0\n");
      },
    });
    assert.deepEqual([stray.result.outcome, stray.result.stopped?.code, stray.result.proposal], ["refused", "result", null]);
    assert.match(stray.result.stopped!.message, /"check\.sh" differs from what Nivra wrote/);
  });
});
