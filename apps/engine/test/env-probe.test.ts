import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { SandboxApi } from "../src/exec/nebius/api.ts";
import { ENV_PREPARE_SCRIPT, Journal } from "../src/exec/nebius/sandbox.ts";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { OUTPUT_DIRS } from "../src/repo/deny.ts";
import { readTar, writeTar } from "../src/exec/tar.ts";
import { matches, runEnvProbe, type EnvProbeInput, type Selection } from "../scripts/env-probe-run.ts";
import { clock, spawned, succeed, type Behaviour } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { cleanUp, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * The environment feasibility probe's steps (NIV-49), rehearsed against the fake service with a guest that really
 * runs Nivra's own scripts. The preparation never runs here: it stands in for an install, extracting the inputs it
 * was sent and adding dependency folders, so nothing is installed on this machine. The toolchain's versions are given
 * the same way; the selections are the fixture's own shell commands. The live run is approved separately.
 */
after(cleanUp);

const PIN = { tag: "node:22.23.4-alpine3.24", tagPrefix: "node:22", registryUrl: "docker://docker.io/library/node:22.23.4-alpine3.24", node: "v22.23.4", packageManager: "pnpm@11.5.3", installArgs: ["--frozen-lockfile", "--filter", "a..."] };
const MANIFESTS: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@11.5.3" })}\n`,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/a/package.json": `${JSON.stringify({ name: "a", private: true, scripts: { test: "echo ok" } })}\n`,
};
const FAILING = "failed\tAssertionError\tthe regression\ntests 1 passed 0 failed 1 skipped 0 todo 0\n";
const SELECTIONS: Selection[] = [
  { name: "A, the regression alone", command: `printf '${FAILING.replace(/\t/g, "\\t").replace(/\n/g, "\\n")}'`, exitCode: 0, output: FAILING },
  { name: "B, the other tests", command: "printf 'skipped\\tan integration suite\\ntests 3 passed 2 failed 0 skipped 1 todo 0\\n'", exitCode: 0, pattern: "^(?:(?:skipped|pending)\\t[^\\n]*\\n)*tests \\d+ passed \\d+ failed 0 skipped \\d+ todo 0\\n$" },
];
const LIMITS = { importSeconds: 900, prepareSeconds: 600, toolchainSeconds: 60, selectionSeconds: 300, collectSeconds: 180, sessionMs: 30 * 60_000, closeMs: 7 * 60_000, pollMs: 10 };

/** What the preparation printed, as Nivra's script prints it. */
const printed = (node = PIN.node, pnpm = "11.5.3") => `node ${node}\npnpm ${pnpm}\narch x86_64\ninstalled\n`;

async function rehearsal(options: { publicImages?: Array<{ uuid: string; tag: string }>; prepared?: { stdout?: string; stray?: string }; selections?: Selection[] } = {}) {
  const repo = repoWith({ ...MANIFESTS, "packages/a/src/index.ts": "export const a = 1;\n", "packages/a/tests/a.test.ts": "import { a } from '../src/index.ts';\n" });
  const snapshot = await snap(repo);
  const inputs = new Uint8Array(gzipSync(writeTar(Object.entries(MANIFESTS).map(([path, text]) => ({ path, kind: "file" as const, executable: false, bytes: new TextEncoder().encode(text) }))), { level: 9 }));
  const guest = new RealGuest();
  guest.quick = true;
  guest.service.publicImages = options.publicImages ?? [{ uuid: "img-node-20", tag: "node:20-alpine" }];
  guest.images.set("img-imported", scratch("imported image"));
  for (const image of guest.service.publicImages) guest.images.set(image.uuid, scratch("public image"));
  const received: { inputs: Record<string, string> | null } = { inputs: null };
  guest.intercept = ({ args, body }, folder): Behaviour | undefined => {
    if (args[1] === ENV_PREPARE_SCRIPT) {
      // The install, stood in for: the inputs it was sent, extracted, and dependency folders, at the top and in a package.
      const reference = (body["files"] as Record<string, { uuid: string }>)["/nivra/env-inputs.tar.gz"]!;
      const entries = readTar(new Uint8Array(gunzipSync(guest.service.uploadsById.get(reference.uuid)!)), { maxEntries: 100, maxBytes: 1 << 20, maxEntryBytes: 1 << 20, maxPathBytes: 1024 });
      received.inputs = Object.fromEntries(entries.flatMap((entry) => (entry.kind === "file" ? [[entry.path, new TextDecoder().decode(entry.bytes)]] : [])));
      const files: Record<string, string> = { ...received.inputs, "node_modules/dep/index.js": "module.exports = 1;\n", "packages/a/node_modules/.bin/tool": "#!/bin/sh\n", ...(options.prepared?.stray ? { [options.prepared.stray]: "made by the install\n" } : {}) };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(folder, "workspace", path)), { recursive: true });
        writeFileSync(join(folder, "workspace", path), text);
      }
      return succeed({ stdout: options.prepared?.stdout ?? printed() });
    }
    if (args[1] === "node --version && pnpm --version") return succeed({ stdout: `${PIN.node}\n11.5.3\n` });
    return undefined;
  };
  const time = clock();
  const credentials = () => ({ key: "nebius-test-key-0123456789", project: "project-e00test" });
  const input: EnvProbeInput = {
    api: new SandboxApi(guest.service.transport, { requestTimeoutMs: 30_000, now: time.now, sleep: time.sleep }),
    journal: new Journal(),
    backendFor: (image) => createNebiusBackend({ credentials, baseImage: image, dependencyFolders: OUTPUT_DIRS, journalDir: scratch("journals"), transport: () => guest.service.transport, applets: "", limits: { maxOperations: 5, maxTimeoutSeconds: 300, prepareTimeoutSeconds: 180, pollMs: 10 }, now: time.now, sleep: time.sleep }),
    snapshot,
    inputs,
    pin: PIN,
    selections: options.selections ?? SELECTIONS,
    dependencyFolders: ["node_modules"],
    limits: LIMITS,
    signal: new AbortController().signal,
    closeSignal: new AbortController().signal,
    log: () => {},
    applets: "",
    now: time.now,
    sleep: time.sleep,
  };
  return { outcome: await runEnvProbe(input), guest, received };
}

describe("the environment feasibility probe, rehearsed (NIV-49)", () => {
  it("imports the pinned image, prepares it with networking on for that alone, and runs the baselines from it through Nivra's session", async () => {
    const { outcome, guest, received } = await rehearsal();
    assert.equal(outcome.stopped, null);
    assert.deepEqual([outcome.base?.from, outcome.base?.image, outcome.base?.status], ["import", "img-imported", "SUCCESS"]);
    assert.deepEqual(Object.keys(received.inputs ?? {}).sort(), Object.keys(MANIFESTS).sort(), "the preparation wasn't sent exactly the inputs");
    const spawns = spawned(guest.service);
    assert.deepEqual(spawns.map((spawn) => spawn.networking.enabled), [true, false, false, false, false, false], "networking was on for something other than the preparation");
    assert.equal(outcome.opened, true);
    const images = (spawns as unknown as Array<{ image: string }>).map((spawn) => spawn.image);
    assert.deepEqual([images[0], images[1]], ["img-imported", outcome.prepared?.image], "the session didn't start from the prepared image");
    assert.notEqual(outcome.prepared?.image, "img-imported");
    assert.deepEqual([outcome.toolchain?.matches, ...outcome.selections.map((result) => result.matches)], [true, true, true]);
    assert.deepEqual([outcome.collect?.integrity, outcome.collect?.dependencyEntries], [null, 0]);
    assert.equal(outcome.cleanup?.unresolved.length, 0);
  });

  it("uses a public image with exactly the pinned tag, and imports nothing", async () => {
    const { outcome, guest } = await rehearsal({ publicImages: [{ uuid: "img-node-22-public", tag: PIN.tag }, { uuid: "img-node-22", tag: "node:22-alpine" }] });
    assert.equal(outcome.stopped, null);
    assert.deepEqual([outcome.base?.from, outcome.base?.image], ["public", "img-node-22-public"]);
    assert.equal(guest.service.requests.filter((request) => request.path === "/v1/images/import").length, 0);
  });

  it("stops before any session when the prepared versions aren't the pinned ones", async () => {
    const { outcome, guest } = await rehearsal({ prepared: { stdout: printed("v22.0.0") } });
    assert.match(outcome.stopped ?? "", /aren't the pinned ones/);
    assert.equal(outcome.opened, false);
    assert.equal(spawned(guest.service).length, 1, "something ran after the preparation");
  });

  it("refuses the session when the install left a source file the commit doesn't have", async () => {
    const { outcome } = await rehearsal({ prepared: { stray: "packages/a/generated.ts" } });
    assert.equal(outcome.opened, false);
    assert.match(outcome.stopped ?? "", /didn't open from the prepared image/);
  });

  it("reports a selection whose output isn't the expected one, without passing it", async () => {
    const wrong: Selection = { ...SELECTIONS[1]!, command: "printf 'failed\\tAssertionError\\tan old test\\ntests 3 passed 2 failed 1 skipped 0 todo 0\\n'" };
    const { outcome } = await rehearsal({ selections: [SELECTIONS[0]!, wrong] });
    assert.equal(outcome.stopped, null);
    assert.deepEqual(outcome.selections.map((result) => result.matches), [true, false]);
  });
});

describe("a selection's expectation", () => {
  it("needs the exit code and the exact output, or the pattern over the whole output", () => {
    assert.equal(matches({ exitCode: 0, output: "a\n" }, { exitCode: 0, stdout: "a\n" }), true);
    assert.equal(matches({ exitCode: 0, output: "a\n" }, { exitCode: 0, stdout: "a\nb\n" }), false);
    assert.equal(matches({ exitCode: 0, output: "a\n" }, { exitCode: 1, stdout: "a\n" }), false);
    assert.equal(matches({ exitCode: 0, pattern: "^tests \\d+ failed 0\\n$" }, { exitCode: 0, stdout: "tests 4 failed 0\n" }), true);
    assert.equal(matches({ exitCode: 0, pattern: "^tests \\d+ failed 0\\n$" }, { exitCode: 0, stdout: "failed\tx\ntests 4 failed 0\n" }), false);
    assert.equal(matches({ exitCode: 0 }, { exitCode: 0, stdout: "" }), false, "an expectation with neither is never met");
  });
});
