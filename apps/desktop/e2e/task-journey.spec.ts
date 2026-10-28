import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { CHECK_IMAGE } from "../../engine/src/exec/check.ts";
import { INSPECT_SCRIPT, READINESS_SCRIPT } from "../../engine/src/environment/scripts.ts";
import { ENV_PREPARE_SCRIPT } from "../../engine/src/exec/nebius/sandbox.ts";
import { readTar } from "../../engine/src/exec/tar.ts";
import { succeed, type Behaviour } from "../../engine/test/fake-sandboxes.ts";
import { RealGuest } from "../../engine/test/real-guest.ts";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startStub, toolCall, type Stub } from "../../engine/test/stub-token-factory.ts";
import { addProject, attemptOf, createTask, followRun, openTask, prepareOnce, previewEnvironment, previewRun, startOnce } from "../scripts/task-journey.ts";
import type { BriefFields } from "../src/shared/ipc.ts";
import { seedProjectPlan, type ProjectSeed } from "./seed-workspace.ts";

/**
 * A task's whole journey through the real UI, host and engine (NIV-35, D41, NIV-55), offline: the built app against
 * stand-ins on this machine for Nebius Sandboxes and Token Factory, reached through the unpackaged-only switches. The
 * steps are the live run's own (scripts/task-journey.ts):
 * - the project's environment previewed from its own recipe and prepared in the window, uploads allowed in their own
 *   dialog;
 * - a task made from a saved plan, with baseline checks that reproduce the bug and a frozen check script;
 * - its run previewed (from the environment, the baseline before the worker, the frozen file) and started once;
 * - the change judged, approved by its hash, applied to the checkout and accepted.
 * The stand-in never runs an install: it answers the image's inspect and readiness steps as an image would, extracts
 * the setup files it was sent and adds node_modules. A packaged app ignores the switches, so this skips there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const PROJECT_ID = "project-e00e2etaskjourney";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const GREET = "greet() {\n  printf 'Hello, %s\\n' \"$1\"\n}\n";
const FIXED = "greet() {\n  printf 'Hello, %s\\n' \"${1:-world}\"\n}\n";
const CHECK = '. packages/greet/greet.sh\ngot=$(greet Ada; greet)\nwant=$(printf \'Hello, Ada\\nHello, world\')\nif [ "$got" = "$want" ]; then echo ok; else printf \'got: %s\\n\' "$got"; exit 1; fi\n';
const FILES: Record<string, string> = {
  "package.json": json({ name: "greet-mono", private: true, packageManager: "pnpm@11.5.3", engines: { node: ">=22" } }),
  ".nvmrc": "24.21.0\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  ".npmrc": "node-linker=hoisted\n",
  "packages/greet/package.json": json({ name: "@demo/greet", private: true }),
  "packages/greet/greet.sh": GREET,
  "packages/greet/check.sh": CHECK,
};
const CASE = ". packages/greet/greet.sh; greet Ada; greet";
const FIELDS: BriefFields = {
  goal: "greet with no name says Hello, world",
  acceptanceCriteria: ["check.sh passes"],
  scope: "packages/greet/greet.sh",
  exclusions: "",
  context: "",
  assumptions: [],
  checks: ["/bin/sh packages/greet/check.sh"],
  acceptanceCases: [{ name: "greet with and without a name", command: CASE, expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 }],
  baseline: [
    { name: "the bug, reproduced", command: CASE, expectedExitCode: 0, expectedOutput: "Hello, Ada\nHello, \n" },
    { name: "check.sh fails for the bug", command: "/bin/sh packages/greet/check.sh", expectedExitCode: 1, outputPattern: "got: Hello, Ada\\nHello, \\n" },
  ],
  frozen: ["packages/greet/check.sh"],
};
const SEED: ProjectSeed = {
  projectLabel: "mono",
  question: "How should greet behave with no name?",
  answer: "Plan: default greet's name to world, and keep check.sh as it is.",
  assumptions: ["check.sh is the repository's own check"],
  ids: { conversationId: "8b1f1e9e-3f43-4b6e-9a36-2a6a5bfa0001", turnId: "8b1f1e9e-3f43-4b6e-9a36-2a6a5bfa0002", messageId: "8b1f1e9e-3f43-4b6e-9a36-2a6a5bfa0003", planId: "8b1f1e9e-3f43-4b6e-9a36-2a6a5bfa0004", lineageId: "8b1f1e9e-3f43-4b6e-9a36-2a6a5bfa0005" },
};

let root: string;
let repo: string;
let sandbox: SandboxStub<RealGuest>;
let model: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
let args: string[] = [];
let executable: string | undefined;

const git = (...given: string[]) => {
  const result = spawnSync("git", given, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${given.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const launch = async () => {
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
};

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e journey ü%# "));
  repo = join(root, "mono");
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init");
  const guest = new RealGuest(CHECK_IMAGE.uuid);
  guest.busybox = true;
  const imported = mkdtempSync(join(root, "imported image "));
  guest.images.set("img-imported", imported);
  // The preparation, stood in for: the image's inspect and readiness steps, as an image would answer them, the setup
  // files it was sent, extracted, and node_modules as an install would leave it.
  const sent: string[] = [];
  guest.intercept = ({ args: given, body }, folder): Behaviour | undefined => {
    // Each ends at its first read, as the engine's own recipe test answers them: a preparation polls every few seconds.
    const done = (stdout: string): Behaviour => ({ ...succeed({ stdout }), statuses: ["SUCCESS"] });
    if (given[1] === INSPECT_SCRIPT) return done("node v24.21.0\nnpm 11.19.0\ncorepack 0.34.0\narch x86_64\nos Alpine Linux v3.22\nlibc musl\n");
    // Readiness lists the workspace as the step does: the setup files the preparation was sent, and nothing else.
    if (given[1] === READINESS_SCRIPT) return done(`node v24.21.0\nnpm 11.19.0\npnpm 11.5.3\n${["sh", "tar", "find", "sha256sum", "gzip", "sort"].map((tool) => `tool ${tool} ok`).join("\n")}\nsetting verify-deps-before-run false\nsetting pm-on-fail ignore\n${sent.map((path) => `file ./${path}`).join("\n")}\nlisted\n`);
    if (given[1] !== ENV_PREPARE_SCRIPT) return undefined;
    const reference = (body["files"] as Record<string, { uuid: string }>)["/nivra/env-inputs.tar.gz"]!;
    for (const entry of readTar(new Uint8Array(gunzipSync(guest.service.uploadsById.get(reference.uuid)!)), { maxEntries: 100, maxBytes: 1 << 22, maxEntryBytes: 1 << 22, maxPathBytes: 1024 })) {
      if (entry.kind !== "file") continue;
      sent.push(entry.path);
      mkdirSync(dirname(join(folder, "workspace", entry.path)), { recursive: true });
      writeFileSync(join(folder, "workspace", entry.path), entry.bytes);
    }
    mkdirSync(join(folder, "workspace", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    return done("via corepack\nnode v24.21.0\nnpm 11.19.0\npnpm 11.5.3\narch x86_64\nDone in 1.2s using pnpm v11.5.3\ninstalled\nbuilds-begin\nAutomatically ignored builds during installation:\n  None\nbuilds-end\n");
  };
  sandbox = await startSandboxStub({ guest });
  const calls: Array<[string, Record<string, unknown>]> = [
    ["read_file", { path: "packages/greet/greet.sh" }],
    ["edit_file", { path: "packages/greet/greet.sh", old_text: '"$1"', new_text: '"${1:-world}"' }],
    ["run_case", { number: 1 }],
    ["submit", { summary: "Defaulted the name to world." }],
  ];
  model = await startStub({
    models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }],
    chat: (request) => {
      const step = (request.body?.messages ?? []).filter((message) => (message as { role?: string }).role === "tool").length;
      const [tool, input] = calls[Math.min(step, calls.length - 1)]!;
      return toolCall(tool, input, { id: `call_${step}` });
    },
  });
  executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-sandboxes-url=${sandbox.url}`, `--nivra-token-factory-url=${model.url}`];
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await sandbox?.close();
  await model?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("prepares a project's environment, runs a task made from a saved plan from it, and applies and accepts its verified change", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  // The project, added; then its plan, saved in its conversation, with the app closed (D7).
  await launch();
  const projectId = await addProject(app, page, repo);
  await app.close();
  const { planId } = seedProjectPlan(join(root, "user data"), SEED);
  await launch();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 60_000 });
  await page.evaluate(`window.nivra.setNebiusKey(${JSON.stringify(KEY)}).then(() => window.nivra.setNebiusProjectId(${JSON.stringify(PROJECT_ID)}))`);

  // The environment: previewed from the project's own setup, .npmrc never read or sent, prepared once with uploads
  // allowed in their dialog.
  const log: string[] = [];
  const shown = await previewEnvironment(page, projectId);
  expect([shown.leftOut, shown.recipe.install.args, shown.recipe.image.tag]).toEqual([[".npmrc"], ["install", "--frozen-lockfile"], "node:24.21.0-alpine"]);
  await expect(page.getByTestId("environment").getByTestId("environment-row").first()).toContainText("24.21.0");
  expect(sandbox.requests).toHaveLength(0);
  const prepared = await prepareOnce(page, projectId, 120_000, (line) => log.push(line));
  expect([prepared.preparation?.status, prepared.ready, prepared.prepared?.recipeDigest]).toEqual(["answered", true, shown.recipeDigest]);
  const VERSIONS = "node 24.21.0, npm 11.19.0, pnpm 11.5.3, corepack 0.34.0";
  await expect(page.getByTestId("environment").getByTestId("environment-prepared")).toContainText(`${VERSIONS}, on Alpine Linux v3.22 (x86_64, musl)`);

  // The task, from the saved plan, with its baseline checks and its frozen check script.
  const taskId = await createTask(page, { title: "Greet the world", fields: FIELDS, projectId, planId });
  const run = await previewRun(page);
  expect(run.environment).toContain(`Starts from the prepared environment: ${VERSIONS}, prepared `);
  expect(run.baseline).toContain("2 baseline checks run once on the commit as it is, with networking off.");
  expect(run.frozen.map((line) => line.split(",")[0])).toEqual(["packages/greet/check.sh"]);
  const spawnsBefore = sandbox.requests.filter((request) => request.path === "/v1/instances").length;
  const attemptId = await startOnce(page, taskId);
  const ended = await followRun(page, taskId, attemptId, 120_000, (line) => log.push(line));
  expect(ended.status, log.join("\n")).toBe("answered");
  const card = page.getByTestId("task-attempt");
  await expect(card.getByTestId("task-attempt-environment")).toContainText(`Started from the prepared environment: ${VERSIONS}, x86_64`);
  await expect(card.getByTestId("task-attempt-baseline-check")).toHaveCount(2);
  for (const row of await card.getByTestId("task-attempt-baseline-check").all()) await expect(row).toHaveAttribute("data-match", "matched");
  await expect(card.getByTestId("task-attempt-frozen-file")).toHaveAttribute("data-state", "unchanged");
  await expect(card.getByTestId("task-attempt-verdict")).toContainText("Every acceptance case passed, and every frozen file is unchanged: the change is verified.");
  // Every operation of the run with networking off, its session from the prepared image.
  const spawned = sandbox.requests.filter((request) => request.path === "/v1/instances").slice(spawnsBefore).map((request) => JSON.parse(request.body) as { networking: { enabled: boolean }; image: string });
  expect([spawned.every((spawn) => !spawn.networking.enabled), spawned[0]?.image]).toEqual([true, prepared.prepared?.verified.images.prepared]);

  // Approved by its hash, applied to the checkout unstaged, and accepted.
  const view = await attemptOf(page, taskId, attemptId);
  await expect(card.getByTestId("task-attempt-approve-what")).toContainText(`Change ${view.proposal!.hash.slice(0, 12)}`);
  await card.getByTestId("task-attempt-approve").click();
  await page.getByTestId("task-apply-confirm-go").click();
  const apply = card.getByTestId("task-apply");
  await expect(apply).toHaveAttribute("data-status", "applied", { timeout: 30_000 });
  expect([readFileSync(join(repo, "packages/greet/greet.sh"), "utf8"), readFileSync(join(repo, "packages/greet/check.sh"), "utf8"), git("status", "--porcelain")]).toEqual([FIXED, CHECK, " M packages/greet/greet.sh\n"]);
  await apply.getByTestId("task-apply-accept").click();
  await expect(page.getByTestId("task-state")).toHaveText("Completed");
  await openTask(page, taskId);
  await expect(page.getByTestId("task-state")).toHaveText("Completed");
});
