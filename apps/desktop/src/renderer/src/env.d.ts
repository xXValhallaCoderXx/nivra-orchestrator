import type { NivraApi } from "../../shared/ipc";

declare global {
  interface Window {
    /** The app's typed bridge (src/preload/index.ts); the renderer's only way to the main process. */
    nivra: NivraApi;
  }
}
