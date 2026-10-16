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

- Capturing the login shell's PATH for tools the engine starts (mainly for macOS and the coding worker). Until then,
  tools are looked up in the engine's own PATH, with WSL's leaked Windows folders removed.
