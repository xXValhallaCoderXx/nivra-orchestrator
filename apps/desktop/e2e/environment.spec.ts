import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { EnvironmentChoices, InstallScope } from "@nivra/domain";
import type { BriefFields } from "../src/shared/ipc";

/**
 * A project's environment through the window (D41, NIV-55). The local engine is the gated stand-in
 * (`--nivra-test-engine=gated`, honoured only when unpackaged): it resolves a pnpm workspace's own recipe, asks for a
 * choice or prepares it, fails its install, or leaves builds missing, as its flags say, and answers a task run with a
 * verified change made from the environment its input named. The window shows the setup it found, each value with where
 * it came from, puts the project's conflict to the person, asks for uploads with what is sent in front of them, follows
 * the preparation, keeps what it verified, shows a failed install's log as text, and takes the person's acceptance of
 * builds that didn't run. A brief's baseline checks and frozen files are written in the brief's form; the run preview
 * and the run's card show them with the environment's verified versions. What to install is the whole project unless
 * the person names packages, which are sent as typed: the host's refusal is shown with them kept, a change of them
 * clears the preview, and a preview that installs something else is never prepared. A packaged app ignores the switch,
 * so this skips there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIELDS: BriefFields = {
  goal: "greet with no name says Hello, world",
  acceptanceCriteria: ["check.sh passes"],
  scope: "",
  exclusions: "",
  context: "",
  assumptions: [],
  checks: [],
  acceptanceCases: [{ name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 }],
};

let root: string;
let app: ElectronApplication;
let page: Page;
let packaged = false;

const home = () => join(root, "engine home");
const lines = (file: string) => (existsSync(join(home(), file)) ? readFileSync(join(home(), file), "utf8").split("\n").filter(Boolean) : []);

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e environment "));
  mkdirSync(join(root, "user data"), { recursive: true });
  mkdirSync(home(), { recursive: true });
  for (const name of ["accept", "release", "task-report"]) writeFileSync(join(home(), name), "");
  const repo = join(root, "mono");
  mkdirSync(repo);
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${home()}`, "--nivra-test-engine=gated"];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("prepares a project's environment from the window: its own setup shown, its conflict put to the person, uploads asked for with what is sent, and what was verified kept", async () => {
  test.skip(packaged, "a packaged app ignores the test engine switch");
  await page.evaluate(async () => {
    await window.nivra.setNebiusKey("test-key-0123456789");
    await window.nivra.setNebiusProjectId("project-e00e2eenvironment");
  });
  const section = page.getByTestId("environment");
  await expect(section.getByTestId("environment-none")).toContainText("No environment is prepared for this project yet");
  // The project pins two Nodes: the person chooses, and nothing can be prepared until they do.
  writeFileSync(join(home(), "env-needs-choice"), "");
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-needs-choice")).toContainText(".nvmrc pins Node 24.21.0, and .node-version pins 22.23.4");
  await expect(section.getByTestId("environment-prepare")).toBeDisabled();
  await section.getByTestId("environment-choice-runtime").getByRole("radio", { name: /^Node 22\.23\.4/ }).check();
  await expect(section.getByTestId("environment-preview")).toHaveText("Preview this choice");
  await section.getByTestId("environment-preview").click();
  rmSync(join(home(), "env-needs-choice"));
  // Each value with where it came from; the image, the install and what is never sent.
  await expect(section.getByTestId("environment-row").first()).toContainText("Node: 22.23.4");
  await expect(section.getByTestId("environment-row").first()).toHaveAttribute("data-source", "choice");
  await expect(section.getByTestId("environment-sends")).toContainText("Starts from node:22.23.4-alpine (x86_64, musl)");
  await expect(section.getByTestId("environment-install")).toContainText("pnpm install --frozen-lockfile");
  await expect(section.getByTestId("environment-left-out")).toContainText(".npmrc is never read or sent.");
  await expect(section.getByTestId("environment-network")).toHaveText("Networking is on for the preparation only, to reach registry.npmjs.org and to bring the base image from docker.io. Every check and task run is offline.");
  await expect(section.getByTestId("environment-uploads-off")).toContainText("Uploads to Nebius Sandboxes are off for this project.");
  // Uploads are off: Prepare asks for them, saying what is sent and what isn't.
  await section.getByTestId("environment-prepare").click();
  await expect(page.getByTestId("environment-consent-allow")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("never sent: .npmrc");
  await page.getByTestId("environment-consent-allow").click();
  await expect(section.getByTestId("environment-prepared")).toContainText("node 22.23.4, npm 11.19.0, pnpm 11.5.3, on Alpine Linux v3.22 (x86_64, musl)", { timeout: 30_000 });
  await expect(section.getByTestId("environment-builds")).toHaveText("Every dependency build ran.");
  await expect(section.getByTestId("environment-status")).toHaveText("Ended");
  const sent = JSON.parse(lines("environments.log")[0]!.split(" ").slice(1).join(" ")) as { context: { choices: unknown; previous: unknown; sharing: unknown } };
  expect(sent.context).toEqual({ sharing: { cloudExecution: true }, choices: { runtime: "22.23.4" }, previous: null });

  // An install that fails: Nivra's words, and the end of its log as text, never as markup; what was prepared stays.
  writeFileSync(join(home(), "environment-outcome"), "failed");
  await section.getByTestId("environment-prepare").click();
  await expect(section.getByTestId("environment-status")).toHaveText("Failed", { timeout: 30_000 });
  await expect(section.getByTestId("environment-stopped")).toHaveText("The install in the sandbox didn't finish, so no environment was made.");
  await expect(section.getByTestId("environment-log")).toContainText("ERR_PNPM_OUTDATED_LOCKFILE <b>Cannot install</b> with frozen-lockfile");
  await expect(section.getByTestId("environment-log").locator("b")).toHaveCount(0);
  await expect(section.getByTestId("environment-prepared")).toBeVisible();
  rmSync(join(home(), "environment-outcome"));

  // Prepared again, with a build the policy didn't run: no task run starts from it until the person accepts it.
  writeFileSync(join(home(), "environment-builds-missing"), "");
  await section.getByTestId("environment-prepare").click();
  await expect(section.getByTestId("environment-status")).toHaveText("Ended", { timeout: 30_000 });
  await expect(section.getByTestId("environment-prepared")).toHaveAttribute("data-ready", "false");
  await expect(section.getByTestId("environment-builds")).toContainText("These dependency builds didn't run: esbuild.");
  await expect(section.getByTestId("environment-notice")).toContainText("Some dependency builds didn't run when this environment was prepared, so task runs won't start from it yet.");
  await section.getByTestId("environment-accept-builds").click();
  await expect(section.getByTestId("environment-prepared")).toHaveAttribute("data-ready", "true");
  await expect(section.getByTestId("environment-builds")).toContainText("You accepted the environment without them.");
  rmSync(join(home(), "environment-builds-missing"));
  expect(lines("calls.log").filter((call) => call === "runs.start").length).toBe(3);
});

test("writes a brief's baseline checks and frozen files, previews a run from the prepared environment, and its card says how each went", async () => {
  test.skip(packaged, "a packaged app ignores the test engine switch");
  const taskId = await page.evaluate(async (fields) => {
    const projectId = (await window.nivra.listProjects())[0]!.id;
    await window.nivra.setSharing(projectId, true);
    const created = await window.nivra.createTask({ title: "Greet the world", fields, projectId, planId: null });
    return created.summary.id;
  }, FIELDS);
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  // The brief's form: a baseline check with a pattern, which fails as the bug does, and a frozen file.
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-baseline-add").click();
  await page.getByTestId("brief-baseline-name").fill("check.sh fails for the bug");
  await page.getByTestId("brief-baseline-command").fill("/bin/sh check.sh");
  await page.getByTestId("brief-baseline-mode").getByText("Pattern").click();
  await page.getByTestId("brief-baseline-pattern").fill("got: Hello, Ada.*");
  await page.getByTestId("brief-baseline-exit").fill("1");
  await page.getByTestId("brief-frozen").fill("check.sh");
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await expect(page.getByTestId("task-brief-baseline")).toContainText("check.sh fails for the bug");
  await expect(page.getByTestId("task-brief-baseline")).toContainText("Its whole output must match this pattern, and it must exit 1");
  await expect(page.getByTestId("task-brief-frozen")).toContainText("check.sh");
  await page.getByTestId("task-mark-ready").click();

  // The run's preview: from the prepared environment, with the baseline check before the worker and the frozen file.
  await page.getByTestId("task-run").click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled({ timeout: 30_000 });
  const preview = page.getByTestId("task-run-preview-body");
  await expect(preview.getByTestId("task-run-preview-environment")).toContainText("Starts from the prepared environment: node 22.23.4, npm 11.19.0, pnpm 11.5.3, prepared ");
  await expect(preview.getByTestId("task-run-preview-baseline")).toContainText("1 baseline check runs once on the commit as it is, with networking off.");
  await expect(preview.getByTestId("task-run-preview-frozen-file")).toContainText("check.sh, ");
  await expect(preview.getByTestId("task-run-preview-limits")).toContainText("1 baseline check before the worker");
  await page.getByTestId("task-run-start").click();

  // The card: started from the environment, the baseline check matched, the frozen file unchanged, and so verified.
  const card = page.getByTestId("task-attempt");
  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  await expect(card.getByTestId("task-attempt-environment")).toContainText("Started from the prepared environment: node 22.23.4, npm 11.19.0, pnpm 11.5.3, x86_64, image image-");
  await expect(card.getByTestId("task-attempt-baseline-check")).toHaveAttribute("data-match", "matched");
  await expect(card.getByTestId("task-attempt-frozen-file")).toHaveAttribute("data-state", "unchanged");
  await expect(card.getByTestId("task-attempt-verdict")).toContainText("Every acceptance case passed, and every frozen file is unchanged: the change is verified.");
  await expect(page.getByTestId("task-engine-failed")).toHaveCount(0);
  const run = JSON.parse(lines("tasks.log")[0]!.split(" ").slice(1).join(" ")) as { input: { environment?: { format: string; tools: Array<{ name: string; version: string }>; builds: { missing: string[] } | null } }; brief: { baseline?: unknown[]; frozen?: string[] } };
  expect([run.input.environment?.format, run.input.environment?.tools[0]?.version, run.input.environment?.builds?.missing, run.brief.baseline?.length, run.brief.frozen]).toEqual(["nivra.environment-ref.v1", "22.23.4", ["esbuild"], 1, ["check.sh"]]);
});

test("chooses what to install: the whole project unless packages are named, each sent as typed and refused in the host's words with the selectors kept, and a change cleared until it is previewed", async () => {
  test.skip(packaged, "a packaged app ignores the test engine switch");
  await page.getByTestId("nav-projects").click();
  const section = page.getByTestId("environment");
  const selectors = section.getByTestId("environment-scope-selector");
  const prepare = section.getByTestId("environment-prepare");
  const resolved = () => lines("env-resolves.log").map((line) => JSON.parse(line) as { choices: EnvironmentChoices });
  const starts = () => lines("calls.log").filter((call) => call === "runs.start").length;
  const CHOSEN: InstallScope = { kind: "selected", selectors: ["@mono/data...", "./packages/web"] };

  // The whole project is the default: what was prepared, and what a preview installs, with no filter.
  await expect(section.getByTestId("environment-scope-whole")).toBeChecked();
  await expect(selectors).toHaveCount(0);
  await expect(section.getByTestId("environment-prepared-scope")).toHaveText("Installed with pnpm install --frozen-lockfile: the whole project.");
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: the whole project.");
  await expect(section.getByTestId("environment-install")).toHaveText("Then, in the sandbox: pnpm install --frozen-lockfile");
  await expect(prepare).toBeEnabled();
  expect(resolved().at(-1)?.choices).toEqual({ runtime: "22.23.4" });

  // Choosing packages clears the preview shown: nothing can be prepared until the choice is previewed.
  await section.getByTestId("environment-scope-selected").check();
  await expect(section.getByTestId("environment-scope")).toHaveAttribute("data-kind", "selected");
  await expect(section.getByTestId("environment-preview-panel")).toHaveCount(0);
  await expect(prepare).toBeDisabled();
  await expect(section.getByTestId("environment-preview")).toHaveText("Preview this choice");
  await expect(section.getByTestId("environment-scope-changed")).toHaveText("This choice isn't previewed yet. Preview it to see what it installs, then prepare.");
  await expect(section.getByTestId("environment-scope-hint")).toHaveText("Type a selector here, such as @scope/app..., or remove this row.");

  // A selector the domain's rule doesn't take is sent as typed and refused in the host's words, before the engine sees
  // it; the hint says why, the selector stays as typed, and Prepare stays off.
  const asked = resolved().length;
  await selectors.first().fill("web app");
  await expect(section.getByTestId("environment-scope-hint")).toHaveText("A selector holds only letters, digits and @ . _ / ^ ~ * ! -. Take the space out of it.");
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-action-error")).toHaveText("Those choices can't be sent as they are: a version is exact, such as 24.21.0, and an option is one the preview offers. Preview the environment again.");
  await expect(selectors.first()).toHaveValue("web app");
  await expect(section.getByTestId("environment-scope-selected")).toBeChecked();
  await expect(prepare).toBeDisabled();
  expect(resolved().length).toBe(asked);

  // Typed again: the refusal goes, and the packages are previewed with one --filter each, as the preview's recipe says.
  // The engine is given the selectors as typed.
  await selectors.first().fill("@mono/data...");
  await expect(section.getByTestId("environment-action-error")).toHaveCount(0);
  await expect(section.getByTestId("environment-scope-hint")).toHaveCount(0);
  await section.getByTestId("environment-scope-add").click();
  await selectors.nth(1).fill("./packages/web");
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-scope-resolved")).toHaveText("What it installs: only the workspace packages that @mono/data... and ./packages/web select.");
  await expect(section.getByTestId("environment-install")).toHaveText("Then, in the sandbox: pnpm install --frozen-lockfile --filter @mono/data... --filter ./packages/web");
  await expect(prepare).toBeEnabled();
  expect(resolved().at(-1)?.choices).toEqual({ runtime: "22.23.4", scope: CHOSEN });

  // A start bound to the whole project's preview is refused, and nothing is started.
  const projectId = await page.evaluate(async () => (await window.nivra.listProjects())[0]!.id);
  const before = starts();
  const refused = await page.evaluate(async ({ id, scope }) => {
    const whole = await window.nivra.resolveEnvironment(id, { runtime: "22.23.4" });
    if (whole.status !== "ready") return `the whole project's preview is ${whole.status}`;
    return window.nivra.prepareEnvironment(id, { runtime: "22.23.4", scope }, whole.fingerprint).then(() => "started", (error: unknown) => String(error));
  }, { id: projectId, scope: CHOSEN });
  expect(refused).toContain("What preparing this environment would send has changed since you previewed it. Check the new preview, then prepare it again.");
  expect(starts()).toBe(before);

  // Another selector clears the preview again, and typing the previewed one back doesn't bring it back: only a new
  // preview turns Prepare on.
  await selectors.nth(1).fill("./packages/api");
  await expect(section.getByTestId("environment-preview-panel")).toHaveCount(0);
  await expect(prepare).toBeDisabled();
  await selectors.nth(1).fill("./packages/web");
  await expect(prepare).toBeDisabled();
  await section.getByTestId("environment-preview").click();
  await expect(prepare).toBeEnabled();

  // An engine that would install the whole project instead is never prepared from: the window says so.
  writeFileSync(join(home(), "env-ignores-scope"), "");
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-scope-mismatch")).toHaveText(
    "This preview doesn't install what you chose: it installs the whole project, not only the workspace packages that @mono/data... and ./packages/web select. Nivra won't prepare it. Preview again, and if it still differs, report it.",
  );
  await expect(prepare).toBeDisabled();
  rmSync(join(home(), "env-ignores-scope"));
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-scope-resolved")).toHaveAttribute("data-selectors", "@mono/data... ./packages/web");
  await expect(section.getByTestId("environment-scope-mismatch")).toHaveCount(0);
  await expect(prepare).toBeEnabled();

  // Prepared with the packages chosen: the preparation is started with them, and the environment's recipe records them,
  // with the same filters.
  await prepare.click();
  await expect(section.getByTestId("environment-prepared-scope")).toHaveText(
    "Installed with pnpm install --frozen-lockfile --filter @mono/data... --filter ./packages/web: only the workspace packages that @mono/data... and ./packages/web select.",
    { timeout: 30_000 },
  );
  await expect(section.getByTestId("environment-preparation")).toContainText("with your choices: Node 22.23.4, installing @mono/data... and ./packages/web");
  const sent = JSON.parse(lines("environments.log").at(-1)!.split(" ").slice(1).join(" ")) as { context: { choices: unknown } };
  expect(sent.context.choices).toEqual({ runtime: "22.23.4", scope: CHOSEN });
  const view = await page.evaluate((id) => window.nivra.getEnvironment(id), projectId);
  expect([view.prepared?.recipe.scope, view.prepared?.recipe.install.args, view.choices?.scope]).toEqual([CHOSEN, ["install", "--frozen-lockfile", "--filter", "@mono/data...", "--filter", "./packages/web"], CHOSEN]);

  // The whole project again: the selectors are put away, kept for later, and nothing is prepared until it is previewed.
  await section.getByTestId("environment-scope-whole").check();
  await expect(selectors).toHaveCount(0);
  await expect(prepare).toBeDisabled();
  await section.getByTestId("environment-scope-selected").check();
  await expect(selectors).toHaveCount(2);
  await expect(selectors.nth(1)).toHaveValue("./packages/web");
});
