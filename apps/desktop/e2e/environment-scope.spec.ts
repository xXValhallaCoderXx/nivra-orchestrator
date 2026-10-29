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
 * What a project's environment installs, chosen in the window (NIV-55, D52), through the real host and engine, offline:
 * the built app against a stand-in for Nebius Sandboxes on this machine, reached through the unpackaged-only switch. The
 * engine resolves each project's own setup; the stand-in answers the inspect, preparation and readiness steps as an image
 * would, never installs anything, and fails any other step, so nothing runs here. It shows that what is chosen in the
 * window is what the preparation requests: workspace packages ticked in the list, for pnpm and for npm, installed with
 * every package their links (and the root's) reach, and pnpm selectors typed under Advanced; that the preview's install
 * command is the one the sandbox is given and the prepared recipe records the scope and the selection; that a start
 * previewed for another scope is refused; that a package a later commit removes is refused by name and flagged; and that
 * a project with one package offers only the whole project, with the engine's reasons. It shows command construction and
 * refusals, not a real filtered install. A packaged app ignores the switch, so this skips there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const PROJECT_ID = "project-e00e2eenvscope";
const CHANGED = "What preparing this environment would send has changed since you previewed it. Check the new preview, then prepare it again.";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const arg = (value: unknown) => JSON.stringify(value);
/** pnpm's lockfile importers for a workspace whose web links data, and whose root links lint. */
const LINKED_LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      '@linked/lint':",
  "        specifier: workspace:*",
  "        version: link:packages/lint",
  "",
  "  packages/data: {}",
  "",
  "  packages/lint: {}",
  "",
  "  packages/web:",
  "    dependencies:",
  "      '@linked/data':",
  "        specifier: workspace:*",
  "        version: link:../data",
  "",
].join("\n");
const SITES_LOCK = {
  name: "sites",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "sites", version: "1.0.0", workspaces: ["packages/*"], devDependencies: { "@sites/lint": "*" } },
    "packages/data": { name: "@sites/data", version: "1.0.0" },
    "packages/lint": { name: "@sites/lint", version: "1.0.0" },
    "packages/web": { name: "@sites/web", version: "1.0.0", dependencies: { "@sites/data": "*" } },
    "node_modules/@sites/data": { resolved: "packages/data", link: true },
    "node_modules/@sites/lint": { resolved: "packages/lint", link: true },
    "node_modules/@sites/web": { resolved: "packages/web", link: true },
  },
};
const REPOS: Record<string, Record<string, string>> = {
  linked: {
    "package.json": json({ name: "linked", private: true, packageManager: "pnpm@11.28.9", devDependencies: { "@linked/lint": "workspace:*" } }),
    ".nvmrc": "24.21.0\n",
    "pnpm-lock.yaml": LINKED_LOCK,
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/data/package.json": json({ name: "@linked/data", private: true }),
    "packages/lint/package.json": json({ name: "@linked/lint", private: true }),
    "packages/web/package.json": json({ name: "@linked/web", private: true, dependencies: { "@linked/data": "workspace:*" } }),
  },
  sites: {
    "package.json": json({ name: "sites", version: "1.0.0", private: true, workspaces: ["packages/*"], devDependencies: { "@sites/lint": "*" } }),
    ".nvmrc": "24.21.0\n",
    "package-lock.json": json(SITES_LOCK),
    "packages/data/package.json": json({ name: "@sites/data", version: "1.0.0" }),
    "packages/lint/package.json": json({ name: "@sites/lint", version: "1.0.0" }),
    "packages/web/package.json": json({ name: "@sites/web", version: "1.0.0", dependencies: { "@sites/data": "*" } }),
  },
  mono: {
    "package.json": json({ name: "scope-mono", private: true, packageManager: "pnpm@11.28.9" }),
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
    "package.json": json({ name: "single", private: true, packageManager: "pnpm@11.28.9" }),
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
    if (given[1] === READINESS_SCRIPT) return done(`node v24.21.0\nnpm 11.19.0\npnpm 11.28.9\n${["sh", "tar", "find", "sha256sum", "gzip", "sort"].map((tool) => `tool ${tool} ok`).join("\n")}\nsetting verify-deps-before-run false\nsetting pm-on-fail ignore\n${sent.map((path) => `file ./${path}`).join("\n")}\nlisted\n`);
    if (given[1] === ENV_PREPARE_SCRIPT) {
      installs.push([...given]);
      // Each preparation's own setup files: readiness lists back only what this one was sent.
      sent.length = 0;
      const reference = (body["files"] as Record<string, { uuid: string }>)["/nivra/env-inputs.tar.gz"]!;
      for (const entry of readTar(new Uint8Array(gunzipSync(guest.service.uploadsById.get(reference.uuid)!)), { maxEntries: 100, maxBytes: 1 << 22, maxEntryBytes: 1 << 22, maxPathBytes: 1024 })) {
        if (entry.kind !== "file") continue;
        sent.push(entry.path);
        mkdirSync(dirname(join(folder, "workspace", entry.path)), { recursive: true });
        writeFileSync(join(folder, "workspace", entry.path), entry.bytes);
      }
      mkdirSync(join(folder, "workspace", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
      return done("via corepack\nnode v24.21.0\nnpm 11.19.0\npnpm 11.28.9\narch x86_64\nDone in 1.2s using pnpm v11.28.9\ninstalled\nbuilds-begin\nAutomatically ignored builds during installation:\n  None\nbuilds-end\n");
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

test("sends the pnpm selectors typed under Advanced: the install the preview shows is the one the sandbox is given, and the prepared recipe records them", async () => {
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
  await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: only the workspace packages that @mono/data and ./packages/web select, and the workspace root, which pnpm always installs.");
  await expect(row("workspace")).toContainText("Installing what @mono/data, ./packages/web select, and the workspace root, which pnpm always installs.");
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
  const installed = installs.length;
  const log: string[] = [];
  const prepared = await prepareOnce(page, projectId, 120_000, (line) => log.push(line));
  expect([prepared.preparation?.status, prepared.ready], log.join("\n")).toEqual(["answered", true]);
  expect(installs.length).toBe(installed + 1);
  expect(installs.at(-1)!.slice(5)).toEqual(["pnpm", "11.28.9", "corepack-else-npm-global", "none", ...COMMAND.split(" ").slice(1)]);
  expect([prepared.prepared?.recipe.scope, prepared.prepared?.recipe.install.args, prepared.prepared?.recipeDigest, prepared.choices?.scope]).toEqual([SCOPE, shown.recipe.install.args, shown.recipeDigest, SCOPE]);
  await expect(section.getByTestId("environment-prepared-scope")).toHaveText(`Installed with ${COMMAND}: only the workspace packages that @mono/data and ./packages/web select, and the workspace root, which pnpm always installs.`);
});

test("offers only the whole project for an npm project and a pnpm project that are one package each, with the engine's reasons, and refuses a scope sent anyway in its words", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await saveKeys();
  const requests = sandbox.requests.length;
  for (const [folder, words] of [
    ["site", "pnpm selectors are pnpm's own syntax, and this project installs with npm. Choose the whole project, then preview again."],
    ["single", "This project isn't a pnpm workspace, so there are no packages to choose. Choose the whole project, then preview again."],
  ] as const) {
    const projectId = await addProject(app, page, join(root, folder));
    await expect(page.getByTestId("project-select")).toHaveValue(folder);
    await goTo(page, "environment");
    const section = page.getByTestId("environment");
    await section.getByTestId("environment-preview").click();
    await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: the whole project.");
    await expect(section.getByTestId("environment-scope-packages")).toBeDisabled();
    await expect(section.getByTestId("environment-scope")).toContainText("This project is one package, so installing it is installing the whole project.");
    await expect(section.getByTestId("environment-scope-advanced")).toHaveCount(0);
    await expect(section.getByTestId("environment-prepare")).toBeEnabled();
    // A scope the window doesn't offer, sent anyway, is refused in the engine's words, and nothing reaches the sandbox.
    const refused = await resolveIn(projectId, { scope: { kind: "selected", selectors: [folder] } });
    expect(refused.status === "refused" ? refused.message : refused.status).toBe(words);
    const chosen = await resolveIn(projectId, { scope: { kind: "packages", packages: ["packages/web"], root: true } });
    expect(chosen.status === "refused" ? [chosen.code, chosen.message] : chosen.status).toEqual(["scope", "This project is one package, so installing it is installing the whole project. Choose the whole project, then preview again."]);
  }
  expect(sandbox.requests.length).toBe(requests);
});

test("installs chosen pnpm packages with every package their links and the root's reach, by exact name, and refuses one a later commit removes by name", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await saveKeys();
  const projectId = await addProject(app, page, join(root, "linked"));
  await page.evaluate(`window.nivra.setCloudExecution(${arg(projectId)}, true)`);
  const section = page.getByTestId("environment");
  const shown = await previewEnvironment(page, projectId, { scope: { kind: "packages", packages: ["packages/web"], root: true } });
  const command = "pnpm install --frozen-lockfile --fail-if-no-match --filter @linked/data --filter @linked/lint --filter @linked/web";
  await expect(section.getByTestId("environment-install")).toHaveText(`Then, in the sandbox: ${command}`);
  await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: @linked/web (packages/web), with @linked/data (packages/data) and @linked/lint (packages/lint), linked from it or from the workspace root, and the workspace root's own dependencies.");
  await expect(section.getByTestId("environment-package-root")).toBeDisabled();
  const before = installs.length;
  const prepared = await prepareOnce(page, projectId, 120_000, () => undefined);
  expect([prepared.preparation?.status, prepared.ready]).toEqual(["answered", true]);
  expect(installs.length).toBe(before + 1);
  expect(installs.at(-1)!.slice(5)).toEqual(["pnpm", "11.28.9", "corepack-else-npm-global", "none", ...command.split(" ").slice(1)]);
  expect([prepared.prepared?.recipe.scope, prepared.prepared?.recipe.selection, prepared.prepared?.recipeDigest]).toEqual([shown.recipe.scope, shown.recipe.selection, shown.recipeDigest]);

  // A later commit removes web: its preview is refused naming it, and web stays ticked, flagged, until unticked.
  const repo = join(root, "linked");
  rmSync(join(repo, "packages", "web"), { recursive: true, force: true });
  writeFileSync(join(repo, "pnpm-lock.yaml"), LINKED_LOCK.replace(/\n  packages\/web:[\s\S]*$/, "\n"));
  for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "drop web"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-preview-refused")).toContainText('"packages/web" isn\'t one of this workspace\'s packages at this commit');
  const web = section.locator('[data-testid="environment-package"][data-folder="packages/web"]');
  await expect(web).toHaveAttribute("data-flagged", "true");
  await expect(web).toBeChecked();
  await expect(section.getByTestId("environment-prepare")).toBeDisabled();
});

test("installs a chosen npm workspace with ./FOLDER for each package it reaches, and the root's dependencies only with its switch on", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await saveKeys();
  const projectId = await addProject(app, page, join(root, "sites"));
  await page.evaluate(`window.nivra.setCloudExecution(${arg(projectId)}, true)`);
  const section = page.getByTestId("environment");
  for (const [rootOn, command] of [
    [false, "npm ci --no-audit --no-fund --workspace=./packages/data --workspace=./packages/web --include-workspace-root=false"],
    [true, "npm ci --no-audit --no-fund --workspace=./packages/data --workspace=./packages/lint --workspace=./packages/web --include-workspace-root"],
  ] as const) {
    const shown = await previewEnvironment(page, projectId, { scope: { kind: "packages", packages: ["packages/web"], root: rootOn } });
    await expect(section.getByTestId("environment-install")).toHaveText(`Then, in the sandbox: ${command}`);
    await expect(section.getByTestId("environment-scope-resolved")).toHaveAttribute("data-root", String(rootOn));
    const before = installs.length;
    const prepared = await prepareOnce(page, projectId, 120_000, () => undefined);
    expect([prepared.preparation?.status, prepared.ready]).toEqual(["answered", true]);
    expect(installs.length).toBe(before + 1);
    expect(installs.at(-1)!.slice(5)).toEqual(["npm", "bundled", "none", "none", ...command.split(" ").slice(1)]);
    expect([prepared.prepared?.recipe.selection?.root, prepared.prepared?.recipeDigest]).toEqual([rootOn, shown.recipeDigest]);
  }
});
