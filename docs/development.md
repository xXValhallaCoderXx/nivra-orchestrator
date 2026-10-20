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
pnpm probe:tokenfactory     # live: list Token Factory models, one Nemotron tool call, then the tool-choice probes
pnpm probe:sandbox --plan   # the Nebius Sandboxes probe (NIV-29): its plan, limits and thresholds; no network
pnpm rpc doctor             # start a real engine on ~/.nivra-dev, send one request, print the answer
pnpm rpc runs.start '{"workflowId":"hello","input":{"repoPath":"/path/to/repo","holdMs":0}}' --follow
pnpm rpc runs.start '{"workflowId":"explain","input":{"repoPath":"/path/to/repo","question":""},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":true}}}' --follow
pnpm rpc runs.result '{"runId":"<id>"}'
pnpm rpc runs.start '{"workflowId":"chat","input":{"message":"How should I stage this?","scope":{"kind":"general"}}}' --follow
```

The explain example sends the repository's excerpts to Token Factory when `NEBIUS_API_KEY` is set, and uses tokens.
Without a key it is refused before any request.

The desktop app:

```bash
pnpm dev                    # Linux Electron under WSLg, hot reload; the local engine runs from source on ~/.nivra-dev
pnpm dev:win                # from WSL: build the real Windows app, for development, and start it on Windows (WSL and Windows folders)
pnpm --filter @nivra/desktop test:e2e        # build, then drive the app through its UI (Playwright, needs a display or xvfb-run -a)
pnpm --filter @nivra/desktop test:packaged   # the same against the electron-builder --dir output (package it first)
pnpm --filter @nivra/desktop test:windows    # from WSL: drive the Windows build `pnpm dev:win --no-launch` copied
pnpm package:linux          # deb (primary) and AppImage
pnpm package:win            # Windows zip, from WSL (an NSIS installer needs Windows)
pnpm release:candidate      # from a clean tree: verify, stage once, build the deb and the zip, write build-info.json and SHA256SUMS
```

Live acceptance on packaged builds (NIV-14). It is an explicit script, never part of `verify`; a live session uses
tokens:

```bash
pnpm accept:live --platform linux --session rehearsal --fixture-a <path>       # token-free: no key, no model
pnpm accept:live --platform windows --session rehearsal --fixture-a <path> --move-wsl-home
pnpm accept:live --platform linux --session live --fixture-a <path> --fixture-b-file <file> [--network]
pnpm accept:live --recover [<record>] [--dry-run]                              # after a session that died
```

It exits:
- 0 when every criterion the session must establish passed: every criterion for a live session, and the token-free
  ones for a rehearsal;
- 1 when a criterion failed, or the session stopped early;
- 2 when none failed, but one it must establish is incomplete or wasn't run.

- **Builds.** It drives the installed deb (`/opt/Nivra/nivra`) or the release zip, extracted on Windows. It checks both
  against `release/build-info.json` and `SHA256SUMS`.
- **Profiles.** It uses profiles and engine homes of its own.
- **The WSL home.** A Windows session moves `~/.nivra` aside, because every Windows profile's WSL engine uses it, then
  puts it back. The recovery record (`~/.nivra-acceptance-recovery.json`) is written before anything moves.
- **The key.** You type it into the window. The script only waits until Settings says one is saved.
- **Fixture B.** Its path is read from a file only you can read.
- **Evidence.** It goes to `~/nivra-acceptance/<run>/`.
  - `private/` holds everything, and is yours alone.
  - `public-summary.*` is built from listed fields only, so it gives B's numbers and nothing else.

Main is an ES module and the preload is CommonJS (a sandboxed preload must be). Two command-line switches isolate a
run: Chromium's `--user-data-dir=<dir>` for the host's records, and `--nivra-engine-home=<dir>` for the local engine's
data. Tests always pass both.

A third switch, `--nivra-token-factory-url=<loopback url>`, points the local engine at a stub instead of Token Factory
(D22). `test:e2e` uses it with the stub in `apps/engine/test/stub-token-factory.ts`, so no real model is called.
- Only an unpackaged app honours it; a packaged app ignores it.
- The engine accepts only `127.0.0.1`, `[::1]` or `localhost`.
- Doctor then reports a test endpoint, and each run records its route as `loopback-test`.

Cross-platform checks (D14; there is no CI):

```bash
pnpm stage:runtime all      # stage linux-x64 (+ WSL tarball, smoke-tested) and win-x64 into apps/desktop/build/stage
pnpm verify:windows         # from WSL: run the target harness as a Windows process (native + WSL engines)
```

`verify:windows` takes `--distro <name>` and `--skip-stage`. It works in `%LOCALAPPDATA%\nivra-dev\verify`.
- **Its WSL engine runs in a home of the run's own** (D27): `~/.nivra-test/verify-<UTC>-<id>` inside the distribution,
  removed at the end. `test:windows` does the same with `e2e-…`, and `verify:interrupt` with `interrupt-…`. A home an
  interrupted run left is removed by a later run once it is a day old.
- **The release's home is checked.** `~/.nivra` is what the installed app uses in every distribution. Each run records
  its database files (size, time and hash) and its runtime folders (with their times) before it starts, and fails if
  any of them changed. Close the installed Nivra first: its own engine writes there too. A read-only query of
  `~/.nivra/nivra.db` during a run also changes the time of its `-shm` file, so leave it alone until the run ends.
- **A candidate's runtimes:** `--zip <path>` takes both runtimes from a release candidate's Windows zip, exactly as
  packaged, instead of staging.
- **The Visual C++ runtime (D25):** it checks that the native engine loads only the copy shipped beside its addon. It
  also runs a controlled check in a copy of the runtime. There, the addon's import is renamed so that no installed
  runtime can stand in, and the engine must still start and run hello. Without the renamed DLL, it must refuse.
- **`test:windows` on a candidate:** extract its zip into `%LOCALAPPDATA%\nivra-dev\app` with Windows' `tar.exe`, in
  place of `pnpm dev:win --no-launch`.

Terminating a whole distribution while the app runs needs a distribution made for the purpose. **The check terminates
it, with everything running in it**, and it refuses the distribution it runs in:

```bash
pnpm stage:runtime all && pnpm dev:win --no-launch   # the Windows build it drives (the distribution needs no ~/.nivra)
pnpm --filter @nivra/desktop verify:interrupt --distro NivraTest
```

It works in `%LOCALAPPDATA%\nivra-dev\interrupt`:
- the packaged app and an observer (Playwright on the staged `node.exe`) both run on Windows;
- the observer writes `trace.log` there, and the app's logs go under `user data\logs`.

One way to make a throwaway distribution, from the development distribution:

```bash
# Ubuntu's base image (about 30 MB); check it against SHA256SUMS in the same folder
#   https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/
wsl.exe --import NivraTest 'C:\…\nivratest\disk' 'C:\…\nivratest\ubuntu-base-24.04.5-base-amd64.tar.gz' --version 2
wsl.exe -d NivraTest -u root --exec /bin/sh -c 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates && useradd -m -s /bin/bash -u 1000 nivra'
wsl.exe --manage NivraTest --set-default-user nivra
# afterwards
wsl.exe --unregister NivraTest   # deletes the distribution and its disk
```

`pnpm rpc` options:
- `--home <dir>` uses another engine home.
- `--token-factory-url <loopback url>` passes the engine its test endpoint.
- It passes `NEBIUS_API_KEY`, when set, in `initialize`, as the app does.
- A `runs.start` without a `context` gets an empty preference snapshot, with sharing off. An explain run sent that way
  is refused before any request; pass `"sharing":{"modelContext":true}` to allow it. The app always sends its own
  context (D21, D22).
- A chat turn without a `context` also gets an empty history (D26). After `--follow`, its stored reply is printed. A
  repository turn needs consent, like explain:
  `{"workflowId":"chat","input":{"message":"…","scope":{"kind":"repository","repoPath":"/path/to/repo"}},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":true},"history":{"exchanges":[],"omitted":{"overLimit":0,"unanswered":0,"preferencesChanged":0}}}}`.

`probe:tokenfactory` takes `--model <id>`, passed after `--`, to pick the Nemotron model.

The Nebius Sandboxes probe (NIV-29) is an explicit live check, never part of `verify`. Each stage runs only after Nate
approves it, with its data and budget:

```bash
pnpm probe:sandbox --plan                 # every step, the data it carries, the limits and the thresholds; no network
NEBIUS_API_KEY=… NEBIUS_PROJECT_ID=… pnpm probe:sandbox --stage 0       # read-only: the account and the public images
NEBIUS_API_KEY=… NEBIUS_PROJECT_ID=… pnpm probe:sandbox --stage 1 --image <uuid|tag:name> --deny <url> [--deny <url>] [--network-control <url>]
NEBIUS_API_KEY=… NEBIUS_PROJECT_ID=… pnpm probe:sandbox --recover <evidence folder>
```

- **Credentials.** Set the variables in your own terminal, never in a chat. The script removes them when it reads them,
  and never prints or writes them.
- **What stage 1 runs:**
  - at most twelve operations, one at a time, on the synthetic fixture in `apps/engine/test/fixtures/sandbox-probe/`;
  - networking off, except the one approved control;
  - no model calls and no installs.
- **Evidence** goes to `~/nivra-acceptance/sandbox-probe-<UTC>/` (0700): the journal, each step's outcome, the
  verdicts and a summary.
- **Interruption.** The first Ctrl+C settles every operation the probe started. `--recover` finishes that later from the
  journal.

## Where things will live

| What | Where |
|---|---|
| Engine home (installed app, release builds) | `~/.nivra` on Linux and inside WSL; `%LOCALAPPDATA%\Nivra\engine` on Windows |
| Engine home (development builds: `pnpm dev`, `pnpm dev:win`, `pnpm rpc`) | `~/.nivra-dev` on Linux and inside WSL; `%LOCALAPPDATA%\nivra-dev\engine` on Windows; or any folder passed with `--home` or `--nivra-engine-home` |
| Engine home (a Windows check's run) | `~/.nivra-test/<kind>-<UTC>-<id>` inside WSL (`--nivra-wsl-home`), removed when the run ends |
| Preferences, project registry | `nivra.json` in Electron's user-data folder (`%APPDATA%\Nivra`, `~/.config/Nivra`) |
| Engine logs | Electron's logs folder, one file per target |
| WSL runtime | `$HOME/<engine home>/runtime/<contentHash>/` inside the distribution; the newest two are kept in each home |

## Working on WSL

The developer machine runs WSL2 with mirrored networking. Nivra does not depend on networking between Windows and
WSL (D2), so the same code works under the default NAT mode.

A Node installed with nvm is invisible to `wsl.exe --exec`; that is expected, and it is why Nivra ships its own Node
(D5).

Development builds never use the installed app's engine homes (D27). One development home is shared, though: `pnpm
dev` under WSLg, `pnpm rpc` and the WSL engine of `pnpm dev:win`'s build all use `~/.nivra-dev` in the development
distribution. One engine holds a home at a time (D7), so the second to start is refused until the first stops.

## Not built yet

- Capturing the login shell's PATH for tools the engine starts. Until then, tools are looked up in the engine's own
  PATH, with WSL's leaked Windows folders removed. **Required before agents run builds (D15)**: nvm and similar are
  invisible to `wsl.exe --exec`.
- Workspaces, patch checks and approved apply for agent writes (D15).
