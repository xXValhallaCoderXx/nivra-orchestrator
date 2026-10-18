import { contextBridge, ipcRenderer } from "electron";
import { IPC, type NivraApi } from "../shared/ipc.ts";

/**
 * The renderer's only door to the app: named, typed functions, each an `invoke` of one channel. No `ipcRenderer`, no
 * `require`, no "send any channel" helper (AGENTS.md, Electron security rules).
 */
const api = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  listEngines: () => ipcRenderer.invoke(IPC.listEngines),
  openProject: (projectId) => ipcRenderer.invoke(IPC.openProject, projectId),
  restartEngine: (projectId) => ipcRenderer.invoke(IPC.restartEngine, projectId),
  runDoctor: (projectId) => ipcRenderer.invoke(IPC.runDoctor, projectId),
  getWsl: () => ipcRenderer.invoke(IPC.getWsl),
  checkWsl: () => ipcRenderer.invoke(IPC.checkWsl),
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  addProject: () => ipcRenderer.invoke(IPC.addProject),
  removeProject: (projectId) => ipcRenderer.invoke(IPC.removeProject, projectId),
  setSharing: (projectId, modelContext) => ipcRenderer.invoke(IPC.setSharing, projectId, modelContext),
  listPreferences: () => ipcRenderer.invoke(IPC.listPreferences),
  addPreference: (statement, scope, projectId, intent) => ipcRenderer.invoke(IPC.addPreference, statement, scope, projectId, intent),
  editPreference: (id, statement, intent) => ipcRenderer.invoke(IPC.editPreference, id, statement, intent),
  deletePreference: (id) => ipcRenderer.invoke(IPC.deletePreference, id),
  supersedePreference: (id, statement, intent) => ipcRenderer.invoke(IPC.supersedePreference, id, statement, intent),
  keepSuggestion: (projectId, runId, index, statement) => ipcRenderer.invoke(IPC.keepSuggestion, projectId, runId, index, statement),
  exportPreferences: (scopes) => ipcRenderer.invoke(IPC.exportPreferences, scopes),
  previewImport: () => ipcRenderer.invoke(IPC.previewImport),
  importPreferences: (previewId, mapping) => ipcRenderer.invoke(IPC.importPreferences, previewId, mapping),
  startHello: (projectId, holdMs) => ipcRenderer.invoke(IPC.startHello, projectId, holdMs),
  startExplain: (projectId, question, choices) => ipcRenderer.invoke(IPC.startExplain, projectId, question, choices),
  runResult: (runId) => ipcRenderer.invoke(IPC.runResult, runId),
  runEvents: (runId, after) => ipcRenderer.invoke(IPC.runEvents, runId, after),
  cancelRun: (runId) => ipcRenderer.invoke(IPC.cancelRun, runId),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setNebiusKey: (key) => ipcRenderer.invoke(IPC.setNebiusKey, key),
  checkTokenFactory: (projectId) => ipcRenderer.invoke(IPC.checkTokenFactory, projectId),
} satisfies NivraApi;

contextBridge.exposeInMainWorld("nivra", api);
