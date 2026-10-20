import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type TestInfo } from "@playwright/test";

/**
 * The workspace (D26) in the app itself, built and packaged, before anything is built on it: `node:sqlite` opens in
 * Electron's main process, a conversation survives a relaunch, starting one starts no engine, and a file that isn't a
 * database is kept aside with its journal files while the app still starts. The Windows build gets the same check in
 * workspace-windows.spec.ts.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
let root: string;

test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function launch(testInfo: TestInfo, userData: string) {
  const isolation = [`--user-data-dir=${userData}`, `--nivra-engine-home=${join(root, "engine home")}`];
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  const app = await electron.launch(
    executable ? { executablePath: join(desktop, executable), args: isolation, chromiumSandbox: true } : { args: [desktop, ...isolation], chromiumSandbox: true },
  );
  return { app, page: await app.firstWindow() };
}

test("the workspace opens in the app, keeps a conversation across a relaunch, and keeps a damaged file aside", async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra workspace e2e ü%# "));
  const userData = join(root, "user data");

  let { app, page } = await launch(testInfo, userData);
  const fresh = await page.evaluate(() => window.nivra.listConversations());
  expect(fresh.workspace).toMatchObject({ state: "ready", schemaVersion: 1, notice: null });
  const created = await page.evaluate(() => window.nivra.createConversation({ kind: "general" }));
  expect([created.kind, created.projectId, created.targetId]).toEqual(["general", null, "local"]);
  expect(await page.evaluate(() => window.nivra.listEngines())).toEqual([]);
  await app.close();

  ({ app, page } = await launch(testInfo, userData));
  const relaunched = await page.evaluate(() => window.nivra.listConversations());
  expect(relaunched.conversations.map((c) => c.id)).toEqual([created.id]);
  await app.close();

  writeFileSync(join(userData, "workspace.db"), "this is not a database ".repeat(40));
  writeFileSync(join(userData, "workspace.db-wal"), "its write-ahead log");
  ({ app, page } = await launch(testInfo, userData));
  const recovered = await page.evaluate(() => window.nivra.listConversations());
  expect(recovered.workspace.state).toBe("ready");
  expect(recovered.workspace.state === "ready" ? recovered.workspace.notice : null).toMatch(/kept it aside as workspace\.db\.unreadable-\d+, with its journal files, and started a new one/);
  expect(recovered.conversations).toEqual([]);
  expect(readdirSync(userData).filter((name) => name.includes("unreadable")).length).toBe(2);
  await app.close();
});
