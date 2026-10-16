# Development

## Requirements

- Node 24.21.0 (`nvm use` reads `.nvmrc`) and pnpm 10.4.1 (`corepack enable`).
- git.
- For live checks: a Nebius Token Factory API key in `NEBIUS_API_KEY` (never committed, never written to a file in the
  repository).

## Commands

```bash
pnpm install --frozen-lockfile
pnpm verify                 # typecheck + all tests (what CI runs)
pnpm typecheck
pnpm test
pnpm probe:tokenfactory     # live: list Token Factory models, then one Nemotron tool call
pnpm rpc doctor             # start a real engine on ~/.nivra-dev, send one request, print the answer
pnpm rpc runs.start '{"workflowId":"hello","input":{"repoPath":"/path/to/repo","holdMs":0}}' --follow
```

The desktop app:

```bash
pnpm dev                    # Linux Electron under WSLg, hot reload; the local engine runs from source on ~/.nivra-dev
pnpm dev:win                # from WSL: build the real Windows app and start it on Windows (WSL and Windows folders)
pnpm --filter @nivra/desktop test:e2e        # build, then drive the app through its UI (Playwright, needs a display or xvfb-run -a)
pnpm --filter @nivra/desktop test:packaged   # the same against the electron-builder --dir output (package it first)
pnpm --filter @nivra/desktop test:windows    # from WSL: drive the Windows build `pnpm dev:win --no-launch` copied
pnpm package:linux          # deb (primary) and AppImage
pnpm package:win            # Windows zip, from WSL (an NSIS installer needs Windows)
```

Main is an ES module and the preload is CommonJS (a sandboxed preload must be). Two command-line switches isolate a
run: Chromium's `--user-data-dir=<dir>` for the host's records, and `--nivra-engine-home=<dir>` for the local engine's
data. Tests always pass both.

Cross-platform checks (D14; there is no CI):

```bash
pnpm stage:runtime all      # stage linux-x64 (+ WSL tarball, smoke-tested) and win-x64 into apps/desktop/build/stage
pnpm verify:windows         # from WSL: run the target harness as a Windows process (native + WSL engines)
```

`verify:windows` takes `--distro <name>` and `--skip-stage`. It works in `%LOCALAPPDATA%\nivra-dev\verify`; the WSL
engine uses `~/.nivra` inside the distribution, as the installed app will.

`pnpm rpc` takes `--home <dir>` to use another engine home. It passes `NEBIUS_API_KEY`, when set, in `initialize`, as
the app will.

`probe:tokenfactory` options (passed after `--`): `--model <id>` to pick the Nemotron model, `--list-only` to skip the
model call.

## Where things will live

| What | Where |
|---|---|
| Engine home (installed app) | `~/.nivra` on Linux and inside WSL; `%LOCALAPPDATA%\Nivra\engine` on Windows |
| Engine home (development) | `~/.nivra-dev`, or any folder passed with `--home` |
| Profile, preferences, project registry | Electron's user-data folder (`%APPDATA%\Nivra`, `~/.config/Nivra`) |
| Engine logs | Electron's logs folder, one file per target |
| WSL runtime | `<home>/.nivra/runtime/<contentHash>/` inside the distribution |

## Working on WSL

The developer machine runs WSL2 with mirrored networking. Nivra does not depend on networking between Windows and
WSL (D2), so the same code works under the default NAT mode.

A Node installed with nvm is invisible to `wsl.exe --exec`; that is expected, and it is why Nivra ships its own Node
(D5).

## Not built yet

- Capturing the login shell's PATH for tools the engine starts. Until then, tools are looked up in the engine's own
  PATH, with WSL's leaked Windows folders removed. **Required before agents run builds (D15)**: nvm and similar are
  invisible to `wsl.exe --exec`.
- Workspaces, patch checks and approved apply for agent writes (D15).
