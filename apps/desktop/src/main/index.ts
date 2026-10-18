import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, safeStorage, screen, session, type IpcMainInvokeEvent } from "electron";
import { readFileSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_PREFERENCES, PreferenceIntent, PreferenceScope } from "@nivra/domain";
import { z } from "zod";
import { IPC, type AppInfo, type ExportResult, type ImportPreviewResult, type SettingsView } from "../shared/ipc.ts";
import { Host } from "./host.ts";
import { HostStore, writePrivateFile } from "./host-store.ts";
import { SecretStore, type KeyCrypto } from "./secret-store.ts";
import { runtimeIn, type RuntimeLayout } from "./targets/local.ts";
import { targetFactory } from "./targets/registry.ts";
import type { EnginePlatform } from "./targets/types.ts";
import type { WslRuntime } from "./targets/wsl.ts";
import { defaultZoom, restoreBounds, stepZoom } from "./window-state.ts";

/**
 * Electron's main process: a thin shell over `Host` (D12). It owns the window, the security guards (from Hird,
 * provenance.md), dialogs and IPC; everything about targets and engines lives in plain modules.
 */

const here = dirname(fileURLToPath(import.meta.url));
app.enableSandbox();

// One app per user-data folder: a second launch focuses the first window instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  start();
}

function start(): void {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  const platform = process.platform as EnginePlatform;
  const store = new HostStore(join(app.getPath("userData"), "nivra.json"));
  const secrets = new SecretStore(join(app.getPath("userData"), "secrets.json"), electronKeyCrypto());
  const host = new Host({
    targets: targetFactory({ platform, ...runtimeSources(platform) }),
    store,
    logsDir: app.getPath("logs"),
    client: { name: "Nivra", version: app.getVersion() },
    credentials: () => secrets.all(),
    platform: process.platform,
    // The Linux app under WSLg, where a /mnt/<drive> folder is slow (as the engine's own insideWsl reads it).
    insideWsl: process.platform === "linux" && (Boolean(process.env["WSL_DISTRO_NAME"] || process.env["WSL_INTEROP"]) || /microsoft/i.test(release())),
    log: (line) => console.error(line),
  });
  let ready: Promise<void> | null = null;
  let quitting: "no" | "stopping" | "done" = "no";

  const indexHtml = join(here, "../renderer/index.html");
  // electron-vite sets this in development; a packaged app ignores it, so nothing can point the window elsewhere.
  const devServerUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
  const appUrl = withoutHash(devServerUrl ?? pathToFileURL(indexHtml).href);
  const isAppUrl = (url: string): boolean => {
    try {
      return withoutHash(url) === appUrl;
    } catch {
      return false;
    }
  };

  /** Only the app page itself, in the top frame of one of our windows, may call the main process. */
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const frame = event.senderFrame;
    const trusted = frame !== null && frame.parent === null && BrowserWindow.fromWebContents(event.sender) !== null && isAppUrl(frame.url);
    if (!trusted) throw new Error(`Rejected IPC from an untrusted sender (${frame?.url ?? "unknown frame"})`);
  };

  /** Registers a handler that checks its sender and its arguments (zod) before `Host` sees them. */
  const handle = <A extends unknown[]>(channel: string, schema: z.ZodType<A>, body: (event: IpcMainInvokeEvent, ...args: A) => unknown): void => {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      assertTrustedSender(event);
      const args = schema.safeParse(raw);
      if (!args.success) throw new Error(`Invalid arguments for ${channel}.`);
      await ready;
      return body(event, ...args.data);
    });
  };

  const none = z.tuple([]);
  const RunId = z.uuid();
  const project = z.tuple([z.uuid()]);
  const settings = async (): Promise<SettingsView> => {
    const state = await secrets.state("NEBIUS_API_KEY");
    return { nebiusKey: state, keychain: secrets.keychain(), note: secrets.note(state) };
  };

  handle(IPC.getAppInfo, none, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    packaged: app.isPackaged,
  }));
  handle(IPC.listEngines, none, () => host.engines());
  handle(IPC.openProject, project, (_event, id) => host.open(id));
  handle(IPC.restartEngine, project, (_event, id) => host.restart(id));
  handle(IPC.runDoctor, project, (_event, id) => host.doctor(id));
  handle(IPC.getWsl, none, () => host.wsl());
  handle(IPC.checkWsl, none, () => host.checkWsl());
  handle(IPC.listProjects, none, () => host.projects());
  handle(IPC.addProject, none, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Choose a repository folder", properties: ["openDirectory" as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    return result.canceled || !picked ? { status: "cancelled" as const } : host.addPicked(picked);
  });
  handle(IPC.removeProject, project, (_event, id) => host.removeProject(id));
  handle(IPC.listPreferences, none, () => host.preferences());
  // Statements are checked again, with a message a person can act on, when they are saved.
  handle(IPC.addPreference, z.tuple([z.string().max(2_000), PreferenceScope, z.uuid().nullable(), PreferenceIntent]), (_event, statement, scope, projectId, intent) =>
    host.addPreference({ statement, scope, projectId, intent }),
  );
  handle(IPC.editPreference, z.tuple([z.uuid(), z.string().max(2_000), PreferenceIntent]), (_event, id, statement, intent) => host.editPreference(id, { statement, intent }));
  handle(IPC.deletePreference, z.tuple([z.uuid()]), (_event, id) => host.deletePreference(id));
  handle(IPC.supersedePreference, z.tuple([z.uuid(), z.string().max(2_000), PreferenceIntent]), (_event, id, statement, intent) => host.supersedePreference(id, { statement, intent }));
  handle(IPC.keepSuggestion, z.tuple([z.uuid(), RunId, z.number().int().nonnegative().max(100), z.string().max(2_000)]), (_event, projectId, runId, index, statement) =>
    host.keepSuggestion(projectId, runId, index, statement),
  );
  // Export and import (D23): the files are chosen in main's own dialogs, and the renderer never sends a path. An export
  // is written only its owner can read; an import file is read only up to a size no export of 50 preferences reaches.
  const MAX_IMPORT_BYTES = 256 * 1024;
  const preferenceFiles = [{ name: "Nivra preferences", extensions: ["json"] }];
  handle(IPC.exportPreferences, z.tuple([z.strictObject({ personal: z.boolean(), projectIds: z.array(z.uuid()).max(500) })]), async (event, scopes): Promise<ExportResult> => {
    const { text, count } = await host.exportPreferences(scopes);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Export preferences", defaultPath: "nivra-preferences.json", filters: preferenceFiles };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { status: "cancelled" };
    writePrivateFile(result.filePath, text);
    return { status: "saved", count, fileName: basename(result.filePath) };
  });
  handle(IPC.previewImport, none, async (event): Promise<ImportPreviewResult> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Import preferences", properties: ["openFile" as const], filters: preferenceFiles };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { status: "cancelled" };
    if (statSync(picked).size > MAX_IMPORT_BYTES) throw new Error("That file is too large to be a Nivra preferences export, so nothing was imported. Choose a file Nivra exported.");
    return { status: "preview", ...host.previewImport(readFileSync(picked, "utf8")) };
  });
  handle(IPC.importPreferences, z.tuple([z.uuid(), z.array(z.uuid().nullable()).max(MAX_PREFERENCES)]), (_event, previewId, mapping) => host.importPreferences(previewId, mapping));
  handle(IPC.startHello, z.tuple([z.uuid(), z.number().int().min(0).max(600_000)]), (_event, id, holdMs) => host.startHello(id, holdMs));
  handle(IPC.setSharing, z.tuple([z.uuid(), z.boolean()]), (_event, id, modelContext) => host.setSharing(id, modelContext));
  // The choices are required, so a caller that drops them fails here rather than explaining without them. The host
  // checks them again, with messages a person can act on (D23).
  handle(IPC.startExplain, z.tuple([z.uuid(), z.string().max(2_000), z.array(z.string().max(2_000)).max(20)]), (_event, id, question, choices) =>
    host.startExplain(id, question, choices),
  );
  handle(IPC.runResult, z.tuple([RunId]), (_event, id) => host.runResult(id));
  handle(IPC.runEvents, z.tuple([RunId, z.number().int().nonnegative()]), (_event, id, after) => host.runEvents(id, after));
  handle(IPC.cancelRun, z.tuple([RunId]), (_event, id) => host.cancelRun(id));
  handle(IPC.getSettings, none, () => settings());
  handle(IPC.checkTokenFactory, project, (_event, id) => host.checkTokenFactory(id));
  handle(IPC.setNebiusKey, z.tuple([z.string().trim().min(8).max(4_096).nullable()]), async (_event, key) => {
    await secrets.set("NEBIUS_API_KEY", key);
    await host.secretsChanged().catch((error: unknown) => console.error("Could not hand the engine the new key", error));
    return settings();
  });

  // No pop-ups, webviews or navigation away from the app page, for every web contents ever created.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => {
      if (!isAppUrl(event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!isAppUrl(event.url)) event.preventDefault();
    });
  });

  const createWindow = (): void => {
    const display = screen.getPrimaryDisplay();
    const displayDefault = defaultZoom(process.platform, display);
    const zoom = store.data.zoom ?? displayDefault;
    const bounds = restoreBounds(store.data.window?.bounds, screen.getAllDisplays().map((d) => d.workArea), display.workArea);
    const window = new BrowserWindow({
      ...bounds,
      minWidth: 820,
      minHeight: 560,
      title: "Nivra",
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0A0A0A" : "#FFFFFF",
      webPreferences: {
        preload: join(here, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        zoomFactor: zoom,
      },
    });
    if (store.data.window?.maximized) window.maximize();
    attachZoomControls(window, zoom, displayDefault, (next) => store.update((data) => ({ ...data, zoom: next })));
    window.on("close", () => store.update((data) => ({ ...data, window: { bounds: window.getNormalBounds(), maximized: window.isMaximized() } })));
    window.once("ready-to-show", () => window.show());
    const load = devServerUrl ? window.loadURL(devServerUrl) : window.loadFile(indexHtml);
    load.catch((error: unknown) => console.error("Failed to load the renderer", error));
  };

  app.whenReady().then(() => {
    // The app needs no browser permissions yet: camera, notifications and the rest are refused.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // A packaged app has no developer tools; macOS keeps its app, Edit and Window menus.
    if (app.isPackaged) Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null);
    // The engine's watchdog counts silent ticks; a ping on wake shows it the host is still here (D4).
    powerMonitor.on("resume", () => host.resumed());
    // A key saved while no keychain was available is re-encrypted as soon as one is (D8).
    ready = secrets
      .migrate()
      .catch((error: unknown) => console.error("Could not re-encrypt a saved key", error))
      .then(() => host.init());
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Quitting stops every engine, each in the D4 order, first; then the quit goes on.
  app.on("before-quit", (event) => {
    if (quitting === "done") return;
    event.preventDefault();
    if (quitting === "stopping") return;
    quitting = "stopping";
    void host
      .shutdown()
      .catch((error: unknown) => console.error("Stopping the engines failed", error))
      .finally(() => {
        quitting = "done";
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

/** Electron's safeStorage as the secret store needs it. Linux's basic_text and unknown backends protect nothing (D8). */
function electronKeyCrypto(): KeyCrypto {
  return {
    protects: () => {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform !== "linux") return true;
      const backend = safeStorage.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    },
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: (data) => safeStorage.decryptStringAsync(data),
  };
}

function withoutHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

/**
 * Where this app's engine runtimes are (D5). Packaged: `resources/runtime/<os-arch>` for the host and, on Windows, the
 * Linux tarball streamed into WSL. Development: the engine from source on the Node that started pnpm, and a staged
 * tarball for WSL when there is one (`pnpm stage:runtime linux-x64`).
 */
function runtimeSources(platform: EnginePlatform): { local: { runtime: RuntimeLayout; home: string; extraArgs?: string[] }; wslRuntime: WslRuntime | null } {
  // Tests and side-by-side development give the local engine its own home; userData follows Chromium's --user-data-dir.
  const homeSwitch = app.commandLine.getSwitchValue("nivra-engine-home") || null;
  // Tests only: a loopback stub of Token Factory, honoured only when unpackaged (D22); the engine refuses non-loopback.
  const stubSwitch = app.isPackaged ? null : app.commandLine.getSwitchValue("nivra-token-factory-url") || null;
  const extraArgs = stubSwitch ? { extraArgs: ["--token-factory-url", stubSwitch] } : {};
  const hostTarget = `${platform === "win32" ? "win" : platform === "darwin" ? "mac" : "linux"}-${process.arch}`;
  const readHash = (path: string): string | null => {
    try {
      const value = (JSON.parse(readFileSync(path, "utf8")) as { contentHash?: unknown }).contentHash;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };
  if (app.isPackaged) {
    const root = join(process.resourcesPath, "runtime");
    const hash = platform === "win32" ? readHash(join(root, "runtime-linux-x64.json")) : null;
    const home = platform === "win32" ? join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Nivra", "engine") : join(homedir(), ".nivra");
    return { local: { runtime: runtimeIn(join(root, hostTarget), platform), home: homeSwitch ?? home, ...extraArgs }, wslRuntime: hash ? { tarball: join(root, "runtime-linux-x64.tar.gz"), contentHash: hash } : null };
  }
  const appPath = app.getAppPath();
  const stage = join(appPath, "build", "stage");
  const hash = platform === "win32" ? readHash(join(stage, "runtime-linux-x64.json")) : null;
  return {
    local: {
      runtime: { node: process.env["npm_node_execpath"] ?? process.env["NODE"] ?? "node", entry: join(appPath, "..", "engine", "src", "main.mjs"), runtimeHash: null },
      home: homeSwitch ?? join(homedir(), ".nivra-dev"),
      ...extraArgs,
    },
    wslRuntime: hash ? { tarball: join(stage, "runtime-linux-x64.tar.gz"), contentHash: hash } : null,
  };
}

/**
 * Zoom shortcuts (Ctrl/Cmd with =, - and 0, plus Ctrl+wheel) that persist across launches (from Hird). Chromium
 * re-renders at the new zoom, so text stays sharp. Ctrl/Cmd+0 returns to the display's default.
 */
function attachZoomControls(window: BrowserWindow, initial: number, displayDefault: number, save: (zoom: number | undefined) => void): void {
  const contents = window.webContents;
  let zoom = initial;
  const apply = (next: number, remember: boolean) => {
    zoom = next;
    contents.setZoomFactor(zoom);
    save(remember ? zoom : undefined);
  };
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    if (input.key === "=" || input.key === "+") apply(stepZoom(zoom, "in"), true);
    else if (input.key === "-" || input.key === "_") apply(stepZoom(zoom, "out"), true);
    else if (input.key === "0") apply(displayDefault, false);
    else return;
    event.preventDefault();
  });
  contents.on("zoom-changed", (_event, direction) => apply(stepZoom(zoom, direction), true));
  contents.on("did-finish-load", () => contents.setZoomFactor(zoom));
}
