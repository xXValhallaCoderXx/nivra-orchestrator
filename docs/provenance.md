# Provenance

Nivra was started on 2026-10-16, inside the hackathon's submission period (2026-08-26 to 2026-10-30). It reuses
concepts and some code from **Hird** (`github.com/xXValhallaCoderXx/hird-orchestration`), an earlier desktop app by
the same author whose first commit is dated 2026-10-08, also inside the submission period. This file lists every
piece of Nivra that came from Hird, with the Hird commit it was taken from, so the history stays honest.

## Hird source pin

Unless a row says otherwise, code was taken from Hird's `feature/change-run` branch at commit
`45c0057ba6e608ee86ac7c31be9d87aa6cc0213c` (2026-10-15). Hird's `origin/main` (`b7d84bb`) is not an ancestor of
that commit, and four of the files listed below differ between the two, so each row names its commit.

## Taken from Hird

Status is `planned` until the file exists in Nivra; then it is `ported` (largely the same code) or `rewritten`
(the idea kept, the code new).

| Nivra | Hird file @ commit | Status | What changed |
|---|---|---|---|
| `packages/tsconfig/base.json` | `packages/tsconfig/base.json` @ 45c0057 | ported | none |
| `AGENTS.md` (security rules, engineering rules, safety, Definition of Done) | `AGENTS.md` @ 45c0057 | rewritten | adapted to stdio, targets and execution boundaries |
| `docs/decisions.md` format | `docs/decisions.md` @ 45c0057 | rewritten | Nivra's own decisions |
| Electron security guards, quit flow, single instance | `apps/desktop/src/main/index.ts` @ 45c0057 | planned | RPC supervisor in place of the HTTP client |
| IPC contract and preload pattern | `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/preload/index.ts` @ 45c0057 | planned | `window.nivra`; no discovery, token or retry |
| Supervisor state, coalescing start, log rotation, env sanitising | `apps/desktop/src/main/engine-process.ts` @ 45c0057 | planned | Electron-free; no port, pid file or adoption |
| Atomic JSON writes, WSLg zoom and window placement | `apps/desktop/src/main/preferences.ts`, `apps/desktop/src/main/window-state.ts` @ 45c0057 | planned | — |
| Runtime staging, Node download and SHA check, prebuilds | `apps/desktop/scripts/stage-engine.ts` @ 45c0057 | planned | esbuild, staging per OS, WSL tarball, MAX_PATH guard, VC++ DLLs |
| Packaging fuses and `extraResources` | `apps/desktop/electron-builder.yml` @ 45c0057 | planned | icon, deb first, Windows built on Windows |
| `apps/engine/src/exec/find-executable.ts` (`findOnPath`, `findGit`) | `apps/engine/src/projects/repo.ts` (`findGit`) @ 45c0057 | ported | generalised to any program; `.exe` only on Windows |
| `isInside`, hardened git runner | `apps/engine/src/projects/repo.ts` @ 45c0057 | planned | — |
| `apps/engine/src/db/database.ts` | `apps/engine/src/db/database.ts` @ 45c0057 | ported | exclusive lock (D7); refuses a newer schema |
| `apps/engine/src/runs/scheduler.ts` | `apps/engine/src/runs/scheduler.ts` @ 45c0057 | ported | workflows map instead of registry; `stop()` for shutdown; recovery gated on the lock |
| `apps/engine/src/runs/store.ts` | `apps/engine/src/runs/store.ts` @ 45c0057 | rewritten | no artifacts, spend or call pairing yet; same transitions, caps and masking |
| `apps/engine/src/workflows/hello.ts`, `packages/domain/src/runs.ts`, `apps/engine/src/db/migrations.ts` | `apps/engine/src/workflows/hello.ts`, `packages/domain/src/runs.ts`, `apps/engine/src/db/migrations.ts` @ 45c0057 | rewritten | hello reports engine, repository and git instead of calling a model; migrations from v1 |
| Playwright Electron fixtures, preload smoke test | `apps/desktop/e2e/fixtures.ts`, `apps/desktop/e2e/smoke.spec.ts` @ 45c0057 | planned | real engine; `--home` instead of environment |
| Theme, fonts, app shell, engine badge and banner | `apps/desktop/src/renderer/src/app/`, `apps/desktop/src/renderer/src/features/engine/` @ 45c0057 | planned | — |

## Third-party components

| Component | Licence | Use |
|---|---|---|
| Electron | MIT | desktop host |
| React, Mantine | MIT | user interface |
| Mastra (`@mastra/core`, `@mastra/libsql`) | Apache-2.0 | workflows, agents, storage |
| libsql, `@libsql/client` | MIT | Mastra's storage driver |
| zod | MIT | contracts and validation |
| Node.js | MIT (with bundled third-party licences) | shipped engine runtime |
| IBM Plex fonts | SIL OFL 1.1 | typography (when vendored) |
| NVIDIA OpenShell | Apache-2.0 | optional execution boundary, driven through its CLI and not bundled |
