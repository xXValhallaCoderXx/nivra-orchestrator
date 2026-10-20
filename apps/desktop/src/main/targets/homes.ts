/**
 * Which engine homes a build uses (D7, D27). A development build never shares a home with the release that may be
 * installed beside it: on one home, the newer engine migrates the database the older one then refuses (D26), and
 * provisioning prunes runtimes the other is running from. `app.isPackaged` can't tell them apart, since `pnpm dev:win`
 * packages the app, so the channel is set when the app is built. Tests give each run a WSL home of its own.
 */
export type Channel = "release" | "development";

/** The WSL engine home of each channel, a folder below the distribution's `$HOME` (D5). */
export const WSL_HOMES: Readonly<Record<Channel, string>> = { release: ".nivra", development: ".nivra-dev" };

/** This app's channel: an unpackaged app is always development; a packaged one is what it was built as. */
export function channelOf(packaged: boolean, built: Channel): Channel {
  return packaged ? built : "development";
}

/**
 * A WSL home named on the command line (`--nivra-wsl-home`, for a test run), checked: plain folder names below
 * `$HOME`, since it is joined to the distribution's `$HOME` and passed to `wsl.exe --exec`, which runs no shell.
 */
export function wslHomeFrom(value: string): string {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`--nivra-wsl-home takes a folder below your home in WSL, such as .nivra-test/run-1, not ${JSON.stringify(value)}.`);
  }
  return value;
}
