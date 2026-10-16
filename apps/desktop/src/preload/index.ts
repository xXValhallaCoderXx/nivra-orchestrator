import { contextBridge, ipcRenderer } from "electron";
import { IPC, type NivraApi } from "../shared/ipc.ts";

/**
 * The renderer's only door to the app: named, typed functions, each an `invoke` of one channel. No `ipcRenderer`, no
 * `require`, no "send any channel" helper (AGENTS.md, Electron security rules).
 */
const api = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  listTargets: () => ipcRenderer.invoke(IPC.listTargets),
  selectTarget: (targetId) => ipcRenderer.invoke(IPC.selectTarget, targetId),
  engineStatus: () => ipcRenderer.invoke(IPC.engineStatus),
  restartEngine: () => ipcRenderer.invoke(IPC.restartEngine),
  runDoctor: () => ipcRenderer.invoke(IPC.runDoctor),
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  addProject: () => ipcRenderer.invoke(IPC.addProject),
  removeProject: (projectId) => ipcRenderer.invoke(IPC.removeProject, projectId),
  startHello: (projectId, holdMs) => ipcRenderer.invoke(IPC.startHello, projectId, holdMs),
  listRuns: () => ipcRenderer.invoke(IPC.listRuns),
  runEvents: (runId, after) => ipcRenderer.invoke(IPC.runEvents, runId, after),
  cancelRun: (runId) => ipcRenderer.invoke(IPC.cancelRun, runId),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setNebiusKey: (key) => ipcRenderer.invoke(IPC.setNebiusKey, key),
  checkTokenFactory: () => ipcRenderer.invoke(IPC.checkTokenFactory),
} satisfies NivraApi;

contextBridge.exposeInMainWorld("nivra", api);
