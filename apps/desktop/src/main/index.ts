import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, safeStorage, screen, session, type IpcMainInvokeEvent } from "electron";
import { readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CoachField, MAX_PREFERENCES, PreferenceIntent, PreferenceScope, requestMsFor, TASK_RUN_BOUNDS, type EnvironmentChoices } from "@nivra/domain";
import { BudgetMonthLabel, BudgetPolicyDraft, BudgetRemaining } from "@nivra/domain";
import { z } from "zod";
import { containsSavedKey, DRAFT_CHECK_FAILED, DRAFT_KEY_NAMES } from "./draft-keys.ts";
import { COPY_TEXT_CHARS, DRAFT_CHECK_CHARS, IPC, REVIEW_PANELS, TASK_STATES, type AppInfo, type ExportResult, type ImportPreviewResult, type RunLimitsView, type SettingsView } from "../shared/ipc.ts";
import { Host } from "./host.ts";
import { HostStore, readSmallFile, writePrivateFile } from "./host-store.ts";
import { SecretStore, type KeyCrypto } from "./secret-store.ts";
import { channelOf, WSL_HOMES, wslHomeFrom, type Channel } from "./targets/homes.ts";
import { runtimeIn, type RuntimeLayout } from "./targets/local.ts";
import { targetFactory } from "./targets/registry.ts";
import { testEngineArgs } from "./test-switches.ts";
import type { EnginePlatform } from "./targets/types.ts";
import type { WslRuntime } from "./targets/wsl.ts";
import { defaultZoom, restoreBounds, stepZoom } from "./window-state.ts";

/**
 * Electron's main process: a thin shell over `Host` (D12). It owns the window, the security guards (from Hird,
 * provenance.md), dialogs and IPC; everything about targets and engines lives in plain modules.
 */

/** Which channel this app was built for (D27): set by the build, `development` for `pnpm dev:win`. */
declare const __NIVRA_CHANNEL__: Channel;

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
    workspacePath: join(app.getPath("userData"), "workspace.db"),
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
    return {
      nebiusKey: state,
      keychain: secrets.keychain(),
      note: secrets.note(state),
      nebiusProjectId: (await secrets.get("NEBIUS_PROJECT_ID")) ? "set" : "none",
      tavilyKey: (await secrets.get("TAVILY_API_KEY")) ? "set" : "none",
      webResearch: host.webResearch(),
    };
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
  // Copy buttons (NIV-56): only text a person asked to copy, and only so much of it; the window never reaches the clipboard.
  handle(IPC.copyText, z.tuple([z.unknown()]), (_event, text) => {
    if (typeof text !== "string") throw new Error("Nivra copies only text, so nothing was copied.");
    if (text.length > COPY_TEXT_CHARS) throw new Error(`That is ${text.length.toLocaleString("en-GB")} characters, more than the ${COPY_TEXT_CHARS.toLocaleString("en-GB")} Nivra copies at once, so nothing was copied.`);
    clipboard.writeText(text);
  });
  // Drafts (NIV-56): whether typed text holds a whole saved API key. Only the answer goes back, and nothing is logged: a
  // failure, such as a key that can't be read, gets fixed words, never the draft or a key, and the window counts the
  // draft as unchecked.
  handle(IPC.draftHasSavedKey, z.tuple([z.unknown()]), async (_event, text) => {
    if (typeof text !== "string" || text.length > DRAFT_CHECK_CHARS) throw new Error(`Nivra checks a draft of at most ${DRAFT_CHECK_CHARS.toLocaleString("en-GB")} characters of text, so this one wasn't checked.`);
    // The strict read: a file or a key that can't be read throws, so it is never taken as no keys.
    let values: string[];
    try {
      values = await secrets.draftCheckValues(DRAFT_KEY_NAMES);
    } catch {
      throw new Error(DRAFT_CHECK_FAILED);
    }
    return containsSavedKey(text, values);
  });
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
  // is written with mode 0600; an import file is read only up to a size no export of 50 preferences reaches.
  const MAX_IMPORT_BYTES = 256 * 1024;
  const preferenceFiles = [{ name: "Nivra preferences", extensions: ["json"] }];
  /** A file error in Nivra's words: its code, never the path or the system's text. */
  const fileProblem = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : "an unknown error");
  handle(IPC.exportPreferences, z.tuple([z.strictObject({ personal: z.boolean(), projectIds: z.array(z.uuid()).max(500) })]), async (event, scopes): Promise<ExportResult> => {
    // A saved key that can't be read here can't be looked for in the preferences, so nothing leaves until it can be.
    if ((await secrets.state("NEBIUS_API_KEY")) === "unreadable") {
      throw new Error("Your saved Nebius key can't be read here, so Nivra can't check that no preference holds it, and nothing was exported. Enter the key again under Settings, then export again.");
    }
    const { text, count } = await host.exportPreferences(scopes);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Export preferences", defaultPath: "nivra-preferences.json", filters: preferenceFiles };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { status: "cancelled" };
    try {
      writePrivateFile(result.filePath, text);
    } catch (error) {
      throw new Error(`Nivra couldn't write the file there (${fileProblem(error)}), so nothing was exported. Choose another folder, then export again.`);
    }
    return { status: "saved", count, fileName: basename(result.filePath) };
  });
  handle(IPC.previewImport, none, async (event): Promise<ImportPreviewResult> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Import preferences", properties: ["openFile" as const], filters: preferenceFiles };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { status: "cancelled" };
    let text: string;
    try {
      // A device or a pipe is never read: it could block main, and it isn't an export.
      const read = readSmallFile(picked, MAX_IMPORT_BYTES);
      if ("refused" in read) {
        throw new Error(
          read.refused === "not-a-file"
            ? "That isn't a file Nivra can read, so nothing was imported. Choose a file Nivra exported."
            : "That file is too large to be a Nivra preferences export, so nothing was imported. Choose a file Nivra exported.",
        );
      }
      text = read.text;
    } catch (error) {
      if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
      throw new Error(`Nivra couldn't read that file (${fileProblem(error)}), so nothing was imported. Choose a file Nivra exported.`);
    }
    return { status: "preview", ...host.previewImport(text) };
  });
  handle(
    IPC.importPreferences,
    z.tuple([z.uuid(), z.strictObject({ personal: z.boolean(), projects: z.array(z.strictObject({ source: z.string().max(8), project: z.uuid().nullable() })).max(MAX_PREFERENCES) })]),
    (_event, previewId, choice) => host.importPreferences(previewId, choice),
  );
  handle(IPC.startHello, z.tuple([z.uuid(), z.number().int().min(0).max(600_000)]), (_event, id, holdMs) => host.startHello(id, holdMs));
  // Tests only, when unpackaged: hold a permission before it is saved, so a test can edit the research dialog
  // meanwhile.
  const permissionDelayMs = app.isPackaged ? 0 : Number(app.commandLine.getSwitchValue("nivra-test-permission-delay-ms") || 0);
  const permissionHeld = () => (permissionDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, permissionDelayMs)) : Promise.resolve());
  handle(IPC.setSharing, z.tuple([z.uuid(), z.boolean()]), async (_event, id, modelContext) => {
    await permissionHeld();
    return host.setSharing(id, modelContext);
  });
  // Sandbox checks (D36): upload consent of its own, and a check bound to its preview's fingerprint (SHA-256 in hex).
  handle(IPC.setCloudExecution, z.tuple([z.uuid(), z.boolean()]), (_event, id, cloudExecution) => host.setCloudExecution(id, cloudExecution));
  handle(IPC.previewSandboxCheck, project, (_event, id) => host.previewSandboxCheck(id));
  handle(IPC.startSandboxCheck, z.tuple([z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)]), (_event, id, expected) => host.startSandboxCheck(id, expected));
  handle(IPC.cancelSandboxCheck, project, (_event, id) => host.cancelSandboxCheck(id));
  handle(IPC.getSandboxCheck, project, (_event, id) => host.sandboxCheck(id));
  handle(IPC.getSandboxStatus, project, (_event, id) => host.sandboxStatus(id));
  // A project's environment (D41, NIV-55): the person's choices, an object of a bounded size here, which the host checks
  // with the domain's own schema, saying in words what to change; a preparation bound to its preview's fingerprint, and
  // an acceptance of missing builds to the verified record's digest (each SHA-256 in hex).
  const Choices = z.custom<EnvironmentChoices>((value) => typeof value === "object" && value !== null && !Array.isArray(value) && JSON.stringify(value).length <= 8_000);
  const Digest = z.string().regex(/^[0-9a-f]{64}$/);
  handle(IPC.getEnvironment, project, (_event, id) => host.environment(id));
  handle(IPC.resolveEnvironment, z.tuple([z.uuid(), Choices]), (_event, id, choices) => host.resolveEnvironment(id, choices));
  handle(IPC.prepareEnvironment, z.tuple([z.uuid(), Choices, Digest]), (_event, id, choices, expected) => host.prepareEnvironment(id, choices, expected));
  handle(IPC.acceptMissingBuilds, z.tuple([z.uuid(), Digest]), (_event, id, verified) => host.acceptMissingBuilds(id, verified));
  handle(IPC.cancelPreparation, project, (_event, id) => host.cancelPreparation(id));
  // The choices are required, so a caller that drops them fails here rather than explaining without them. The host
  // checks them again, with messages a person can act on (D23).
  handle(IPC.startExplain, z.tuple([z.uuid(), z.string().max(2_000), z.array(z.string().max(2_000)).max(20)]), (_event, id, question, choices) =>
    host.startExplain(id, question, choices),
  );
  handle(IPC.runResult, z.tuple([RunId]), (_event, id) => host.runResult(id));
  handle(IPC.runEvents, z.tuple([RunId, z.number().int().nonnegative()]), (_event, id, after) => host.runEvents(id, after));
  handle(IPC.cancelRun, z.tuple([RunId]), (_event, id) => host.cancelRun(id));
  handle(IPC.listConversations, none, () => host.conversations());
  handle(
    IPC.createConversation,
    z.tuple([z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("general") }), z.strictObject({ kind: z.literal("project"), projectId: z.uuid() })])]),
    (_event, scope) => host.createConversation(scope),
  );
  // Conversations, plans and tasks (D26). The caps here are loose on purpose: the host refuses what's too long in words
  // the person can act on, and every id is one the host made (randomUUID).
  const Id = z.uuid();
  const Revision = z.number().int().positive();
  const LongText = z.string().max(100_000);
  const Rows = z.array(z.string().max(10_000)).max(200);
  const Case = z.strictObject({ name: z.string().max(10_000), command: z.string().max(10_000), expectedOutput: z.string().max(100_000), expectedExitCode: z.number() });
  // A baseline check gives its exact output or a pattern (D41): which one, and whether it is valid, the host says in words.
  const Baseline = z.strictObject({ name: z.string().max(10_000), command: z.string().max(10_000), expectedExitCode: z.number(), expectedOutput: z.string().max(100_000).optional(), outputPattern: z.string().max(10_000).optional() });
  const Fields = z.strictObject({
    goal: LongText,
    acceptanceCriteria: Rows,
    scope: LongText,
    exclusions: LongText,
    context: LongText,
    assumptions: Rows,
    checks: Rows,
    acceptanceCases: z.array(Case).max(20),
    baseline: z.array(Baseline).max(20).optional(),
    frozen: Rows.optional(),
  });
  const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
  handle(IPC.getConversation, z.tuple([Id]), (_event, id) => host.conversation(id));
  handle(IPC.openConversation, z.tuple([Id]), (_event, id) => host.openConversation(id));
  handle(IPC.sendMessage, z.tuple([Id, LongText]), (_event, id, text) => host.sendMessage(id, text));
  handle(IPC.cancelTurn, z.tuple([Id, Id]), (_event, id, turnId) => host.cancelTurn(id, turnId));
  handle(IPC.deleteConversation, z.tuple([Id]), (_event, id) => host.deleteConversation(id));
  handle(IPC.restartConversationEngine, z.tuple([Id]), (_event, id) => host.restartConversationEngine(id));
  handle(IPC.savePlan, z.tuple([Id, Id, LongText.nullable()]), (_event, id, messageId, text) => host.savePlan(id, messageId, text ?? undefined));
  handle(IPC.revisePlan, z.tuple([Id, LongText]), (_event, id, text) => host.revisePlan(id, text));
  handle(IPC.listPlans, z.tuple([Id]), (_event, id) => host.plans(id));
  // Reviews of plan versions (D31). A fingerprint is the preview's own: SHA-256 in hex.
  const Panel = z.enum(REVIEW_PANELS);
  handle(IPC.prepareReview, z.tuple([Id, Panel]), (_event, planId, panel) => host.prepareReview(planId, panel));
  handle(IPC.startReview, z.tuple([Id, Panel, z.string().regex(/^[0-9a-f]{64}$/)]), (_event, planId, panel, expected) => host.startReview(planId, panel, expected));
  handle(IPC.listReviews, z.tuple([Id]), (_event, id) => host.reviews(id));
  handle(IPC.cancelReview, z.tuple([Id, Id]), (_event, id, reviewId) => host.cancelReview(id, reviewId));
  // Research of plan versions' assumptions (D37). A selection is checked for its shape only: the host refuses what is
  // too long or can't be sent, in words the person can act on.
  const Pick = z.strictObject({
    from: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("plan"), index: z.number().int().nonnegative().max(99) }), z.strictObject({ kind: z.literal("typed"), text: LongText })]),
    query: LongText,
  });
  const Selection = z.strictObject({ assumptions: z.array(Pick).max(10), sites: z.strictObject({ mode: z.enum(["prefer", "restrict"]), hosts: Rows }).nullable() });
  // Tests only, when unpackaged: hold a preview's answer, so a test can change the selection before it arrives.
  const previewDelayMs = app.isPackaged ? 0 : Number(app.commandLine.getSwitchValue("nivra-test-preview-delay-ms") || 0);
  handle(IPC.prepareResearch, z.tuple([Id, Selection]), async (_event, planId, selection) => {
    const preview = await host.prepareResearch(planId, selection);
    if (previewDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, previewDelayMs));
    return preview;
  });
  handle(IPC.startResearch, z.tuple([Id, Selection, z.string().regex(/^[0-9a-f]{64}$/)]), (_event, planId, selection, expected) => host.startResearch(planId, selection, expected));
  handle(IPC.listResearch, z.tuple([Id]), (_event, id) => host.research(id));
  handle(IPC.cancelResearch, z.tuple([Id, Id]), (_event, id, researchId) => host.cancelResearch(id, researchId));
  handle(IPC.saveAmendedPlan, z.tuple([Id, LongText, Rows]), (_event, researchId, text, assumptions) => host.saveAmendedPlan(researchId, text, assumptions));
  handle(IPC.listTasks, none, () => host.tasks());
  handle(IPC.getTask, z.tuple([Id]), (_event, id) => host.task(id));
  handle(IPC.createTask, z.tuple([z.strictObject({ title: LongText, fields: Fields, projectId: Id.nullable(), planId: Id.nullable() })]), (_event, input) => host.createTask(input));
  handle(IPC.reviseBrief, z.tuple([Id, Revision, Fields]), (_event, id, revision, fields) => host.reviseBrief(id, revision, fields));
  handle(IPC.refreshBriefFromPlan, z.tuple([Id, Revision, Id]), (_event, id, revision, planId) => host.refreshBriefFromPlan(id, revision, planId));
  handle(IPC.setTaskProject, z.tuple([Id, Revision, Id.nullable()]), (_event, id, revision, projectId) => host.setTaskProject(id, revision, projectId));
  handle(IPC.setTaskState, z.tuple([Id, Revision, z.enum(TASK_STATES)]), (_event, id, revision, state) => host.setTaskState(id, revision, state));
  handle(IPC.renameTask, z.tuple([Id, Revision, LongText]), (_event, id, revision, title) => host.renameTask(id, revision, title));
  handle(IPC.deleteTask, z.tuple([Id]), (_event, id) => host.deleteTask(id));
  // The bounds no brief changes (Settings › Budget and usage): the domain's own values and derivations, as the engine
  // reads them; none is copied or worked out again here, and the engine stays the one that enforces them.
  handle(IPC.getRunLimits, none, (): RunLimitsView => ({
    modelRequests: TASK_RUN_BOUNDS.modelRequests,
    requestSeconds: requestMsFor(TASK_RUN_BOUNDS.outputTokensPerRequest) / 1000,
    outputTokensPerRequest: TASK_RUN_BOUNDS.outputTokensPerRequest,
    estimatedInputTokens: TASK_RUN_BOUNDS.estimatedInputTokens,
    toolCalls: TASK_RUN_BOUNDS.toolCalls,
    writes: TASK_RUN_BOUNDS.writes,
    runs: TASK_RUN_BOUNDS.runs,
    checkSeconds: TASK_RUN_BOUNDS.checkSeconds,
    sessionMinutes: TASK_RUN_BOUNDS.sessionMinutes,
    runMinutes: TASK_RUN_BOUNDS.runMinutes,
  }));
  handle(IPC.previewTaskRun, z.tuple([Id]), (_event, id) => host.previewTaskRun(id));
  handle(IPC.startTaskRun, z.tuple([Id, Fingerprint, Fingerprint]), (_event, id, expected, snapshot) => host.startTaskRun(id, expected, snapshot));
  handle(IPC.cancelTaskRun, z.tuple([Id, Id]), (_event, id, attemptId) => host.cancelTaskRun(id, attemptId));
  handle(IPC.getTaskAttempt, z.tuple([Id, Id]), (_event, id, attemptId) => host.taskAttempt(id, attemptId));
  // A run's change (D40): approved by the hash the person saw, rejected, revised, settled or restored.
  handle(IPC.approveTaskChange, z.tuple([Id, Id, Fingerprint]), (_event, id, attemptId, approvedHash) => host.approveTaskChange(id, attemptId, approvedHash));
  handle(IPC.rejectTaskChange, z.tuple([Id, Id]), (_event, id, attemptId) => host.rejectTaskChange(id, attemptId));
  handle(IPC.requestTaskRevision, z.tuple([Id, Id, z.string().max(4_000)]), (_event, id, attemptId, note) => host.requestTaskRevision(id, attemptId, note));
  handle(IPC.settleTaskChange, z.tuple([Id, Id, z.enum(["accepted", "dismissed", "kept"])]), (_event, id, attemptId, as) => host.settleTaskChange(id, attemptId, as));
  handle(IPC.restoreTaskChange, z.tuple([Id, Id]), (_event, id, attemptId) => host.restoreTaskChange(id, attemptId));
  // Missions (NIV-52). The host checks a mission's words and limits, and says what's wrong in words the person can act on.
  const Mission = z.strictObject({ name: LongText, intendedUsers: LongText, outcome: LongText, successCriteria: Rows, constraints: Rows, nonGoals: Rows });
  const Picked = z.array(Id).max(20);
  handle(IPC.listMissions, none, () => host.missions());
  handle(IPC.getMission, z.tuple([Id]), (_event, id) => host.mission(id));
  handle(IPC.openMission, z.tuple([Id]), (_event, id) => host.openMission(id));
  handle(IPC.createMission, z.tuple([Mission]), (_event, content) => host.createMission(content));
  handle(IPC.reviseMission, z.tuple([Id, Revision, Mission]), (_event, id, version, content) => host.reviseMission(id, version, content));
  handle(IPC.deleteMission, z.tuple([Id]), (_event, id) => host.deleteMission(id));
  handle(IPC.createMissionTask, z.tuple([Id, LongText]), (_event, id, title) => host.createMissionTask(id, title));
  handle(IPC.addMissionTask, z.tuple([Id, Id]), (_event, id, taskId) => host.addMissionTask(id, taskId));
  handle(IPC.removeMissionTask, z.tuple([Id, Id]), (_event, id, taskId) => host.removeMissionTask(id, taskId));
  handle(IPC.prepareMissionReview, z.tuple([Id, Picked]), (_event, id, taskIds) => host.prepareMissionReview(id, taskIds));
  handle(IPC.startMissionReview, z.tuple([Id, Picked, Fingerprint]), (_event, id, taskIds, expected) => host.startMissionReview(id, taskIds, expected));
  handle(IPC.cancelMissionReview, z.tuple([Id, Id]), (_event, id, reviewId) => host.cancelMissionReview(id, reviewId));
  // The task readiness coach (NIV-53). A selection is checked for its shape only: the host refuses a mission or finding
  // that isn't the task's, and what can't be sent, in words the person can act on.
  const CoachSelection = z.strictObject({ mission: z.boolean(), findings: z.array(z.strictObject({ reviewId: Id, findingId: z.string().max(64) })).max(20) });
  handle(IPC.prepareCoach, z.tuple([Id, CoachSelection]), (_event, id, selection) => host.prepareCoach(id, selection));
  handle(IPC.startCoach, z.tuple([Id, CoachSelection, Fingerprint]), (_event, id, selection, expected) => host.startCoach(id, selection, expected));
  handle(IPC.listCoachings, z.tuple([Id]), (_event, id) => host.coachings(id));
  handle(IPC.cancelCoach, z.tuple([Id, Id]), (_event, id, coachingId) => host.cancelCoach(id, coachingId));
  handle(IPC.acceptCoachChanges, z.tuple([Id, Revision, Id, z.array(CoachField).max(CoachField.options.length)]), (_event, id, revision, coachingId, fields) => host.acceptCoachChanges(id, revision, coachingId, fields));
  // The shared monthly budget (NIV-66).
  handle(IPC.getCompanionUsage, none, () => host.getCompanionUsage());
  handle(IPC.setCompanionLimit, z.tuple([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()]), (_event, limit) => host.setCompanionLimit(limit));
  handle(IPC.getBudgetPolicy, none, () => host.getBudgetPolicy());
  handle(IPC.setBudgetPolicy, z.tuple([BudgetPolicyDraft.nullable()]), (_event, draft) => host.setBudgetPolicy(draft));
  handle(IPC.budgetSummary, none, () => host.budgetSummary());
  handle(IPC.budgetPrices, none, () => host.budgetPrices());
  handle(IPC.confirmBudgetMonth, z.tuple([BudgetMonthLabel]), (_event, month) => host.confirmBudgetMonth(month));
  handle(IPC.startNewBudgetHistory, z.tuple([BudgetRemaining.nullable()]), (_event, remaining) => host.startNewBudgetHistory(remaining));
  handle(IPC.getSettings, none, () => settings());
  handle(IPC.checkTokenFactory, project, (_event, id) => host.checkTokenFactory(id));
  handle(IPC.setNebiusKey, z.tuple([z.string().trim().min(8).max(4_096).nullable()]), async (_event, key) => {
    // A Nebius key is printable ASCII. One pasted with a line break or an invisible character inside can't go in a
    // request header: the request would fail before it was sent, and the person would learn only that something failed.
    if (key !== null && !/^[\x21-\x7E]+$/.test(key)) {
      throw new Error("That key holds a space, a line break or a character no Nebius key has, often copied along with it, so it wasn't saved. Copy the key again, then save it.");
    }
    await secrets.set("NEBIUS_API_KEY", key);
    await host.secretsChanged().catch((error: unknown) => console.error("Could not hand the engine the new key", error));
    return settings();
  });
  // The project id Nebius Sandboxes needs with the key (D36): kept and handed to the engines the way the key is (D8).
  handle(IPC.setNebiusProjectId, z.tuple([z.string().trim().min(8).max(200).nullable()]), async (_event, value) => {
    if (value !== null && !/^[\x21-\x7E]+$/.test(value)) {
      throw new Error("That project id holds a space, a line break or a character no Nebius project id has, often copied along with it, so it wasn't saved. Copy it again, then save it.");
    }
    await secrets.set("NEBIUS_PROJECT_ID", value);
    await host.secretsChanged().catch((error: unknown) => console.error("Could not hand the engine the new project id", error));
    return settings();
  });
  // The Tavily key research needs (D37): kept and handed to the engines the way the Nebius key is (D8).
  handle(IPC.setTavilyKey, z.tuple([z.string().trim().min(8).max(4_096).nullable()]), async (_event, key) => {
    if (key !== null && !/^[\x21-\x7E]+$/.test(key)) {
      throw new Error("That key holds a space, a line break or a character no Tavily key has, often copied along with it, so it wasn't saved. Copy the key again, then save it.");
    }
    await secrets.set("TAVILY_API_KEY", key);
    await host.secretsChanged().catch((error: unknown) => console.error("Could not hand the engine the new key", error));
    return settings();
  });
  // Research's permission (D37): off until the person turns it on. Turning it off stops research under way, and says so
  // when a run can't be stopped; it stays off either way.
  handle(IPC.setWebResearch, z.tuple([z.boolean()]), async (_event, on) => {
    await permissionHeld();
    await host.setWebResearch(on);
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
 * Where this app's engine runtimes are (D5), and the engine homes they use (D7, D27). Packaged:
 * `resources/runtime/<os-arch>` for the host and, on Windows, the Linux tarball streamed into WSL. Development: the
 * engine from source on the Node that started pnpm, and a staged tarball for WSL when there is one
 * (`pnpm stage:runtime linux-x64`). The homes follow the channel, so a development build, packaged or not, never uses
 * the release's: `~/.nivra-dev` in WSL and on Linux, `%LOCALAPPDATA%\nivra-dev\engine` for a packaged one on Windows.
 */
function runtimeSources(platform: EnginePlatform): { local: { runtime: RuntimeLayout; home: string; extraArgs?: string[] }; wslRuntime: WslRuntime | null; wslHome: string } {
  const channel = channelOf(app.isPackaged, __NIVRA_CHANNEL__);
  // Tests and side-by-side development give the local engine its own home; userData follows Chromium's --user-data-dir.
  const homeSwitch = app.commandLine.getSwitchValue("nivra-engine-home") || null;
  // Tests give each run a WSL home of its own too, below the distribution's $HOME.
  const wslSwitch = app.commandLine.getSwitchValue("nivra-wsl-home") || null;
  const wslHome = wslSwitch ? wslHomeFrom(wslSwitch) : WSL_HOMES[channel];
  // Tests only, honoured only when unpackaged: loopback stubs of Token Factory, Nebius Sandboxes and Tavily, which the
  // engine refuses unless they are on this machine (D22, D36, D37), and a file that holds an apply before a named writer
  // step (D40). They go to the local engine alone.
  const stubArgs = testEngineArgs(app.isPackaged, (name) => app.commandLine.getSwitchValue(name));
  const extraArgs = stubArgs.length ? { extraArgs: stubArgs } : {};
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
    const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    const home =
      platform === "win32"
        ? join(localAppData, ...(channel === "release" ? ["Nivra", "engine"] : ["nivra-dev", "engine"]))
        : join(homedir(), channel === "release" ? ".nivra" : ".nivra-dev");
    return {
      local: { runtime: runtimeIn(join(root, hostTarget), platform), home: homeSwitch ?? home, ...extraArgs },
      wslRuntime: hash ? { tarball: join(root, "runtime-linux-x64.tar.gz"), contentHash: hash } : null,
      wslHome,
    };
  }
  const appPath = app.getAppPath();
  const stage = join(appPath, "build", "stage");
  const hash = platform === "win32" ? readHash(join(stage, "runtime-linux-x64.json")) : null;
  // Tests only, unpackaged: a stand-in engine from the app's own test fixtures, named, never a path ("gated" is
  // test/fixtures/gated-engine.mjs), for what a real engine never does, such as losing a start's answer.
  const fixture = app.commandLine.getSwitchValue("nivra-test-engine") || null;
  if (fixture !== null && !/^[a-z]+$/.test(fixture)) throw new Error(`--nivra-test-engine takes a fixture's name, such as gated, not "${fixture}".`);
  const entry = fixture ? join(appPath, "test", "fixtures", `${fixture}-engine.mjs`) : join(appPath, "..", "engine", "src", "main.mjs");
  return {
    local: {
      runtime: { node: process.env["npm_node_execpath"] ?? process.env["NODE"] ?? "node", entry, runtimeHash: null },
      home: homeSwitch ?? join(homedir(), ".nivra-dev"),
      ...extraArgs,
    },
    wslRuntime: hash ? { tarball: join(stage, "runtime-linux-x64.tar.gz"), contentHash: hash } : null,
    wslHome,
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
