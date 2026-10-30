import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig(({ mode }) => ({
  // The channel decides the engine homes (D27). `pnpm dev:win` builds with --mode development; every other build, the
  // release candidate's included, is a release one.
  main: { build: { rollupOptions: { input: { index: "src/main/index.ts", "pdf-worker": "src/main/pdf-worker.ts" } } }, define: { __NIVRA_CHANNEL__: JSON.stringify(mode === "development" ? "development" : "release") } },
  // A sandboxed preload must be CommonJS, while the package (and so main) is ES modules.
  preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: { plugins: [react()] },
}));
