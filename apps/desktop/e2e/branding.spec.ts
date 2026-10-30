import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { goTo, openSwitcher } from "./places.ts";

/** Fresh-profile presentation, through the same built or packaged app as the existing journeys. No model calls. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
let root: string;
let app: ElectronApplication;
let page: Page;
test.describe.configure({ mode: "serial" });

function contrastRatio(first: string, second: string): number {
  const luminance = (colour: string) => {
    const rgb = colour.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

test.beforeAll(async ({}, info) => {
  root = mkdtempSync(join(tmpdir(), "nivra branding "));
  const executable = info.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "profile")}`, `--nivra-engine-home=${join(root, "engine")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await expect(page.getByTestId("home-title")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("fresh profiles contain no seeded work or internal Hello controls, including Advanced diagnostics", async () => {
  const counts = await page.evaluate(async () => ({ projects: (await window.nivra.listProjects()).length, tasks: (await window.nivra.listTasks()).tasks.length }));
  expect(counts).toEqual({ projects: 0, tasks: 0 });
  await goTo(page, "settings-diagnostics");
  await expect(page.getByTestId("hello-start")).toHaveCount(0);
  await expect(page.getByText("Hello run", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Hold a process for", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("diagnostics-app")).toBeVisible();
  await expect(page.getByTestId("app-details")).toContainText("Electron");
});

test("primary actions, ordinary text, disabled controls and keyboard focus remain readable in both schemes", async () => {
  for (const mode of ["light", "dark"]) {
    await goTo(page, "settings-preferences");
    await page.getByTestId(`appearance-${mode}`).click();
    await goTo(page, "home");
    const colours = await page.evaluate(() => {
      const action = getComputedStyle(document.querySelector('[data-testid="home-new-mission"]')!);
      const body = getComputedStyle(document.body);
      const muted = getComputedStyle(document.querySelector(".nivra-nav-label")!);
      const sidebar = getComputedStyle(document.querySelector('[data-testid="nav"]')!);
      return { action: action.backgroundColor, foreground: action.color, edge: action.borderTopColor, text: body.color, canvas: body.backgroundColor, muted: muted.color, sidebar: sidebar.backgroundColor };
    });
    expect(contrastRatio(colours.foreground, colours.action)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colours.text, colours.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colours.edge, colours.canvas)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colours.muted, colours.sidebar)).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("Tab");
    await page.getByTestId("nav-tasks").focus();
    expect(await page.getByTestId("nav-tasks").evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(2);
    await goTo(page, "settings-preferences");
    const input = page.getByTestId("preference-input");
    await input.focus();
    await expect(input).toBeFocused();
    await expect(page.getByTestId("preference-confirm")).toBeDisabled();
    const disabled = await page.getByTestId("preference-confirm").evaluate((element) => { const style = getComputedStyle(element); return { foreground: style.color, background: style.backgroundColor }; });
    expect(contrastRatio(disabled.foreground, disabled.background)).toBeGreaterThanOrEqual(4.5);
    const focused = await input.evaluate((element) => { const style = getComputedStyle(element); return { edge: style.borderTopColor, background: style.backgroundColor }; });
    expect(contrastRatio(focused.edge, focused.background)).toBeGreaterThanOrEqual(3);
  }
});

test("Home exposes readiness while Advanced diagnostics retain runtime details", async () => {
  const repo = join(root, "billing-service");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [repo] })) as typeof dialog.showOpenDialog; }, repo);
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
  await page.getByTestId("engine-badge").hover();
  await expect(page.getByRole("tooltip")).toHaveText("The engine for this project is ready.");
  await goTo(page, "settings-diagnostics");
  await expect(page.getByTestId("engine-details")).toContainText("Node");
  await expect(page.getByTestId("engine-details")).toContainText(join(root, "engine"));
});

test("the companion leaves project actions reachable at medium and narrow widths", async () => {
  await goTo(page, "home");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 900));
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-panel")).toBeVisible();
  // AppShell animates its reserved padding: assert the settled layout rather than an intermediate frame.
  await expect.poll(async () => {
    const create = await page.getByTestId("home-create-task").boundingBox();
    const companion = await page.getByTestId("companion-panel").boundingBox();
    return create !== null && companion !== null && create.x + create.width <= companion.x;
  }).toBe(true);
  await page.getByTestId("companion-minimise").click();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(820, 900); window.webContents.setZoomFactor(1.5); });
  await expect(page.getByTestId("top-bar")).toBeVisible();
  await page.getByTestId("companion-launcher").click();
  const overflow = await page.getByTestId("companion-panel").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.getByTestId("companion-minimise").click();
  await expect(page.getByTestId("companion-launcher")).toBeFocused();
});
