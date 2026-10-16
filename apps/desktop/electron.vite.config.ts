import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  // A sandboxed preload must be CommonJS, while the package (and so main) is ES modules.
  preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: { plugins: [react()] },
});
