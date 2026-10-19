import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * The workspace (D26) in the packaged Windows app, run on Windows from WSL (D14), as `pnpm dev:win --no-launch` copied
 * it: `node:sqlite` opens in Electron's main process on Windows, a conversation survives a relaunch, starting one starts
 * no engine, and a file that isn't a database is kept aside with its journal files (renamed on NTFS) while the app still
 * starts. The same check as workspace-store.spec.ts.
 */
test.skip(process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe"), "runs from WSL on a Windows machine");

const windows = (exe: string, args: string[]) => {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const wslpath = (flag: "-u" | "-w", path: string) => windows("/usr/bin/wslpath", [flag, path]);

test("the workspace opens in the Windows app, keeps a conversation across a relaunch, and keeps a damaged file aside", async () => {
  const devWin = `${windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"])}\\nivra-dev`;
  const exe = `${wslpath("-u", devWin)}/app/Nivra.exe`;
  if (!existsSync(exe)) throw new Error(`No Windows build at ${exe}: run pnpm dev:win --no-launch first.`);
  const rootWin = `${devWin}\\e2e-workspace`;
  const root = wslpath("-u", rootWin);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const userData = `${root}/user data`;
  const launch = async () => {
    const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${rootWin}\\user data`, `--nivra-engine-home=${rootWin}\\engine`], chromiumSandbox: true, timeout: 120_000 });
    return { app, page: await app.firstWindow() };
  };

  let { app, page } = await launch();
  const fresh = await page.evaluate(() => window.nivra.listConversations());
  expect(fresh.workspace).toMatchObject({ state: "ready", schemaVersion: 1, notice: null });
  const created = await page.evaluate(() => window.nivra.createConversation({ kind: "general" }));
  expect([created.kind, created.projectId, created.targetId]).toEqual(["general", null, "local"]);
  expect(await page.evaluate(() => window.nivra.listEngines())).toEqual([]);
  await app.close();

  ({ app, page } = await launch());
  const relaunched = await page.evaluate(() => window.nivra.listConversations());
  expect(relaunched.conversations.map((c) => c.id)).toEqual([created.id]);
  await app.close();

  writeFileSync(`${userData}/workspace.db`, "this is not a database ".repeat(40));
  writeFileSync(`${userData}/workspace.db-wal`, "its write-ahead log");
  ({ app, page } = await launch());
  const recovered = await page.evaluate(() => window.nivra.listConversations());
  expect(recovered.workspace.state).toBe("ready");
  expect(recovered.workspace.state === "ready" ? recovered.workspace.notice : null).toMatch(/kept it aside as workspace\.db\.unreadable-\d+, with its journal files, and started a new one/);
  expect(recovered.conversations).toEqual([]);
  expect(readdirSync(userData).filter((name) => name.includes("unreadable")).length).toBe(2);
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
