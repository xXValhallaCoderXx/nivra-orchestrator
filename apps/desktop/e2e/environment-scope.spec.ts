import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { EnvironmentChoices, EnvironmentPreviewV2, InstallScope } from "@nivra/domain";
import { INSPECT_SCRIPT, READINESS_SCRIPT } from "../../engine/src/environment/scripts.ts";
import { ENV_PREPARE_SCRIPT } from "../../engine/src/exec/nebius/sandbox.ts";
import { readTar } from "../../engine/src/exec/tar.ts";
import { succeed, type Behaviour } from "../../engine/test/fake-sandboxes.ts";
import { RealGuest } from "../../engine/test/real-guest.ts";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { addProject, prepareOnce, previewEnvironment } from "../scripts/task-journey.ts";
import { goTo } from "./places.ts";

/**
 * What a project's environment installs, chosen in the window (NIV-55, option a1), through the real host and engine,
 * offline: the built app against a stand-in for Nebius Sandboxes on this machine, reached through the unpackaged-only
 * switch. The engine resolves each project's own setup; the stand-in answers the inspect, preparation and readiness steps
 * as an image would, never installs anything, and fails any other step, so nothing runs here. It shows that the packages
 * typed in the window are the ones the preparation requests: the preview's install command is the one the sandbox is
 * given, and the prepared recipe records the scope; that a start previewed for another scope is refused; and that an npm
 * project, and a pnpm project that isn't a workspace, refuse chosen packages in the engine's words, with the selectors
 * kept and Prepare off. A packaged app ignores the switch, so this skips there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const PROJECT_ID = "project-e00e2eenvscope";
const CHANGED = "What preparing this environment would send has changed since you previewed it. Check the new preview, then prepare it again.";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const arg = (value: unknown) => JSON.stringify(value);
const REPOS: Record<string, Record<string, string>> = {
  mono: {
    "package.json": json({ name: "scope-mono", private: true, packageManager: "pnpm@11.5.3" }),
    ".nvmrc": "24.21.0\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/data/package.json": json({ name: "@mono/data", private: true }),
    "packages/web/package.json": json({ name: "@mono/web", private: true }),
  },
  site: {
    "package.json": json({ name: "site", version: "1.0.0", private: true }),
    ".nvmrc": "24.21.0\n",
    "package-lock.json": json({ name: "site", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "site", version: "1.0.0" } } }),
  },
  single: {
    "package.json": json({ name: "single", private: true, packageManager: "pnpm@11.5.3" }),
    ".nvmrc": "24.21.0\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  },
};
const SCOPE: InstallScope = { kind: "selected", selectors: ["@mono/data", "./packages/web"] };
const COMMAND = "pnpm install --frozen-lockfile --fail-if-no-match --filter @mono/data --filter ./packages/web";

let root: string;
let sandbox: SandboxStub<RealGuest>;
let app: ElectronApplication;
let page: Page;
let packaged = false;
/** Each preparation's arguments, as the stand-in was given them. */
const installs: string[][] = [];

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e environment scope "));
  for (const [name, files] of Object.entries(REPOS)) {
    const repo = join(root, name);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
  }
  const guest = new RealGuest();
  guest.images.set("img-imported", mkdtempSync(join(root, "imported image ")));
  // The setup files the preparation was sent, which readiness lists back as the step does.
  const sent: string[] = [];
  guest.intercept = ({ args: given, body }, folder): Behaviour => {
    // Each ends at its first read, as the engine's own recipe test answers them: a preparation polls every few seconds.
    const done = (stdout: string): Behaviour => ({ ...succeed({ stdout }), statuses: ["SUCCESS"] });
    if (given[1] === INSPECT_SCRIPT) return done("node v24.21.0\nnpm 11.19.0\ncorepack 0.34.0\narch x86_64\nos Alpine Linux v3.22\nlibc musl\n");
    if (given[1] === READINESS_SCRIPT) return done(`node v24.21.0\nnpm 11.19.0\npnpm 11.5.3\n${["sh", "tar", "find", "sha256sum", "gzip", "sort"].map((tool) => `tool ${tool} ok`).join("\n")}\nsetting verify-deps-before-run false\nsetting pm-on-fail ignore\n${sent.map((path) => `file ./${path}`).join("\n")}\nlisted\n`);
    if (given[1] === ENV_PREPARE_SCRIPT) {
      installs.push([...given]);
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
    }
    // Nothing else is stood in for, and nothing runs on this machine: any other step fails.
    return { statuses: ["FAILED"], exitCode: 1, stdout: "", stderr: "This step isn't stood in for here." };
  };
  sandbox = await startSandboxStub({ guest });
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-sandboxes-url=${sandbox.url}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await sandbox?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The Nebius key and project id saved, as Settings saves them: Prepare needs both. */
const saveKeys = () => page.evaluate(`window.nivra.setNebiusKey(${arg(KEY)}).then(() => window.nivra.setNebiusProjectId(${arg(PROJECT_ID)}))`);
const resolveIn = (projectId: string, choices: EnvironmentChoices) => page.evaluate(`window.nivra.resolveEnvironment(${arg(projectId)}, ${arg(choices)})`) as Promise<EnvironmentPreviewV2>;
const startWith = (projectId: string, choices: EnvironmentChoices, fingerprint: string) =>
  page.evaluate(`window.nivra.prepareEnvironment(${arg(projectId)}, ${arg(choices)}, ${arg(fingerprint)}).then(() => "started", (error) => String(error))`) as Promise<string>;

test("sends the packages chosen in the window: the install the preview shows is the one the sandbox is given, and the prepared recipe records them", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const projectId = await addProject(app, page, join(root, "mono"));
  await goTo(page, "environment");
  await saveKeys();
  const section = page.getByTestId("environment");
  const row = (fact: string) => section.locator(`[data-testid="environment-row"][data-fact="${fact}"]`);

  // The whole project unless packages are named: the project's own install, with no filter.
  await expect(section.getByTestId("environment-scope-whole")).toBeChecked();
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: the whole project.");
  await expect(section.getByTestId("environment-install")).toHaveText("Then, in the sandbox: pnpm install --frozen-lockfile");
  await expect(row("workspace")).toContainText("Workspace: pnpm workspace, 2 packages");

  // Two packages, typed as the live run's journey types a task file's: the engine's install has one --filter each, and
  // its own rows say so too.
  await previewEnvironment(page, projectId, { scope: SCOPE });
  // A later recipe may have fewer selectors: remove stale rows before entering the new selection.
  await previewEnvironment(page, projectId, { scope: { kind: "selected", selectors: ["@mono/data"] } });
  await expect(section.getByTestId("environment-scope-selector")).toHaveCount(1);
  await expect(section.getByTestId("environment-scope-selector")).toHaveValue("@mono/data");
  const shown = await previewEnvironment(page, projectId, { scope: SCOPE });
  await expect(section.getByTestId("environment-install")).toHaveText(`Then, in the sandbox: ${COMMAND}`);
  await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: only the workspace packages that @mono/data and ./packages/web select.");
  await expect(row("workspace")).toContainText("Installing @mono/data, ./packages/web.");
  await expect(row("install")).toContainText(COMMAND);
  await expect(section.getByTestId("environment-prepare")).toBeEnabled();
  const whole = await resolveIn(projectId, {});
  if (whole.status !== "ready") throw new Error(`The whole project's preview is ${whole.status}.`);
  expect([shown.recipe.scope, shown.recipe.install.args]).toEqual([SCOPE, COMMAND.split(" ").slice(1)]);

  // A start whose preview was of another scope is refused, either way round, and nothing reaches the sandbox.
  await page.evaluate(`window.nivra.setCloudExecution(${arg(projectId)}, true)`);
  expect(await startWith(projectId, { scope: SCOPE }, whole.fingerprint)).toContain(CHANGED);
  expect(await startWith(projectId, {}, shown.fingerprint)).toContain(CHANGED);
  expect(sandbox.requests.length).toBe(0);

  // Prepared from the window: the sandbox is given exactly the install shown, and the environment's recipe records it.
  const log: string[] = [];
  const prepared = await prepareOnce(page, projectId, 120_000, (line) => log.push(line));
  expect([prepared.preparation?.status, prepared.ready], log.join("\n")).toEqual(["answered", true]);
  expect(installs.length).toBe(1);
  expect(installs[0]!.slice(5)).toEqual(["pnpm", "11.5.3", "corepack-else-npm-global", "none", ...COMMAND.split(" ").slice(1)]);
  expect([prepared.prepared?.recipe.scope, prepared.prepared?.recipe.install.args, prepared.prepared?.recipeDigest, prepared.choices?.scope]).toEqual([SCOPE, shown.recipe.install.args, shown.recipeDigest, SCOPE]);
  await expect(section.getByTestId("environment-prepared-scope")).toHaveText(`Installed with ${COMMAND}: only the workspace packages that @mono/data and ./packages/web select.`);
});

test("refuses chosen packages for an npm project and for a pnpm project that isn't a workspace, in the engine's words, with the selectors kept and Prepare off", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await saveKeys();
  const requests = sandbox.requests.length;
  for (const [folder, words] of [
    ["site", "Choosing npm workspaces to install isn't available yet. Choose the whole project, then preview again."],
    ["single", "This project isn't a pnpm workspace, so there are no packages to choose. Choose the whole project, then preview again."],
  ] as const) {
    await addProject(app, page, join(root, folder));
    await expect(page.getByTestId("project-select")).toHaveValue(folder);
    await goTo(page, "environment");
    const section = page.getByTestId("environment");
    await section.getByTestId("environment-scope-selected").check();
    await section.getByTestId("environment-scope-selector").fill(folder);
    await section.getByTestId("environment-preview").click();
    await expect(section.getByTestId("environment-preview-refused")).toHaveText(words);
    // Nothing is swapped in: the packages stay chosen as typed, and nothing can be prepared from the refusal.
    await expect(section.getByTestId("environment-scope-selected")).toBeChecked();
    await expect(section.getByTestId("environment-scope-selector")).toHaveValue(folder);
    await expect(section.getByTestId("environment-prepare")).toBeDisabled();
    // The whole project, when the person chooses it, is previewed and can be prepared.
    await section.getByTestId("environment-scope-whole").check();
    await expect(section.getByTestId("environment-preview-refused")).toHaveCount(0);
    await section.getByTestId("environment-preview").click();
    await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: the whole project.");
    await expect(section.getByTestId("environment-prepare")).toBeEnabled();
  }
  expect(sandbox.requests.length).toBe(requests);
});
