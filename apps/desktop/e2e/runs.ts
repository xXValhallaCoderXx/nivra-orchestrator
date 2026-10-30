import { expect, type Page } from "@playwright/test";
import { openSwitcher } from "./places.ts";

/** The project's real id, even when two folders have the same label. Opening this list changes no scope. */
export async function selectedProjectId(page: Page): Promise<string> {
  await openSwitcher(page);
  const id = await page.locator('[data-testid="switcher-project"][aria-selected="true"]').getAttribute("data-project-id");
  await page.keyboard.press("Escape");
  if (!id) throw new Error("Choose a project before starting the diagnostic run.");
  return id;
}

/** Internal lifecycle checks use the existing typed bridge; no development controls belong in the product UI. */
export async function startHello(page: Page, holdMs = 0): Promise<string> {
  const projectId = await selectedProjectId(page);
  const run = await page.evaluate(({ projectId, holdMs }) => window.nivra.startHello(projectId, holdMs), { projectId, holdMs });
  if (holdMs > 0) {
    await expect.poll(async () => (await page.evaluate((id) => window.nivra.runEvents(id, 0), run.id)).events.some((event) => event.message.startsWith("Holding a child process")), { timeout: 60_000 }).toBe(true);
  }
  return run.id;
}

export async function runStatus(page: Page, runId: string) {
  return (await page.evaluate((id) => window.nivra.runEvents(id, 0), runId)).status;
}

export async function cancelRun(page: Page, runId: string) {
  await page.evaluate((id) => window.nivra.cancelRun(id), runId);
  await expect.poll(() => runStatus(page, runId)).toBe("cancelled");
}
