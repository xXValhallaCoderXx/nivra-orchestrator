import { defineConfig } from "@playwright/test";

/** Where `electron-builder --dir` leaves the app on each OS; the packaged project drives that build. */
const PACKAGED: Partial<Record<NodeJS.Platform, string>> = {
  linux: "release/linux-unpacked/nivra",
  win32: "release/win-unpacked/Nivra.exe",
  darwin: `release/mac${process.arch === "arm64" ? "-arm64" : ""}/Nivra.app/Contents/MacOS/Nivra`,
};

// Playwright's trace and screenshot options do not apply to Electron, so none are set (from Hird).
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: "line",
  projects: [
    { name: "built", metadata: {}, testIgnore: /windows\.spec\.ts/ },
    { name: "development", testMatch: /task-preferences\.spec\.ts/ },
    { name: "packaged", metadata: { executable: PACKAGED[process.platform] ?? PACKAGED.linux }, testIgnore: /windows\.spec\.ts/ },
    // From WSL: the Windows build that `pnpm dev:win --no-launch` copied to %LOCALAPPDATA%\nivra-dev\app (D14).
    { name: "windows", testMatch: /windows\.spec\.ts/ },
  ],
});
