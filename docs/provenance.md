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
| `apps/desktop/src/main/index.ts` | `apps/desktop/src/main/index.ts` @ 45c0057 | rewritten | same guards (trusted sender, navigation, pop-ups, permissions, single instance, zoom); a thin shell over `host.ts`; zod-checked IPC |
| `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/preload/index.ts` | same files @ 45c0057 | rewritten | the pattern kept (named invoke-only calls, `satisfies` the API); Nivra's own calls |
| `apps/desktop/src/main/supervisor.ts` | `apps/desktop/src/main/engine-process.ts` @ 45c0057 | rewritten | stdio JSON-RPC instead of HTTP; Electron-free; no port, pid file or adoption; D4 quit order |
| `apps/desktop/src/main/host-store.ts`, `apps/desktop/src/main/window-state.ts` | `apps/desktop/src/main/preferences.ts`, `apps/desktop/src/main/window-state.ts` @ 45c0057 | ported | atomic writes with Windows rename retries; zoom and placement rules (swarm defaults dropped) |
| `apps/desktop/scripts/stage-runtime.ts` | `apps/desktop/scripts/stage-engine.ts` @ 45c0057 | ported | esbuild instead of `mastra build`; pnpm metadata pruned; content hash; WSL tarball; MAX_PATH guard; VC++ DLLs; stdio smoke test |
| `apps/desktop/electron-builder.yml` | `apps/desktop/electron-builder.yml` @ 45c0057 | ported | runtimes under `resources/runtime`; deb first; Windows zip from Linux; git instead of bubblewrap |
| `apps/engine/src/exec/find-executable.ts` (`findOnPath`, `findGit`) | `apps/engine/src/projects/repo.ts` (`findGit`) @ 45c0057 | ported | generalised to any program; `.exe` only on Windows |
| `apps/engine/src/repo/paths.ts` (`isInside`, `checkRelativePath`) | `apps/engine/src/projects/repo.ts` @ 45c0057 | ported | also refuses a leading `/` or `\`; a variant for Windows paths |
| `apps/engine/src/repo/files.ts` | `apps/engine/src/projects/repo.ts` @ 45c0057 | ported | the read checks kept in order; the picked folder as the root; tracked files only; git through the run's execution session; a hash for every read and search hit; the exact lines each result delivered; no `grep -m`, which needs git 2.38; files over 200 KB kept out of search |
| `apps/engine/src/repo/deny.ts` | `apps/engine/src/projects/repo.ts` (deny list) @ 45c0057 | rewritten | more secret-bearing files; dependency and build output at any depth, with its own reason; git's search excludes built from the same rules |
| `apps/engine/src/repo/git.ts` | `apps/engine/src/projects/repo.ts` (git runner) @ 45c0057 | rewritten | runs through the run's execution session instead of spawning git; configuration pinned on every call; output caps; the run's cancel stops it |
| `apps/engine/src/explain/tools.ts` | `apps/engine/src/projects/tools.ts` @ 45c0057 | rewritten | the budget enforced inside each tool, one call at a time; a ledger of what each step delivered; tools never throw; a structured `submit_answer` whose first accepted answer is frozen |
| `apps/engine/src/explain/citations.ts` | `apps/engine/src/projects/citations.ts` @ 45c0057 | rewritten | structured citations instead of prose; exact paths instead of suffix matching; checked only against lines delivered before the answer; files that changed during the run flagged |
| `packages/domain/src/credentials.ts` (was `apps/engine/src/secrets/patterns.ts`; moved so the host and the engine share it, D26) | `apps/engine/src/config/secrets.ts` (lines 81–168) @ 45c0057 | ported | combined with the values of the keys Nivra holds; masking keeps the line count; Hird's file-based secret store is not taken (D8) |
| `apps/engine/src/db/database.ts` | `apps/engine/src/db/database.ts` @ 45c0057 | ported | exclusive lock (D7); refuses a newer schema |
| `apps/engine/src/runs/scheduler.ts` | `apps/engine/src/runs/scheduler.ts` @ 45c0057 | ported | workflows map instead of registry; `stop()` for shutdown; recovery gated on the lock |
| `apps/engine/src/runs/store.ts` | `apps/engine/src/runs/store.ts` @ 45c0057 | rewritten | no artifacts, spend or call pairing yet; same transitions, caps and masking |
| `apps/engine/src/workflows/hello.ts`, `packages/domain/src/runs.ts`, `apps/engine/src/db/migrations.ts` | `apps/engine/src/workflows/hello.ts`, `packages/domain/src/runs.ts`, `apps/engine/src/db/migrations.ts` @ 45c0057 | rewritten | hello reports engine, repository and git instead of calling a model; migrations from v1 |
| `apps/desktop/e2e/*.spec.ts`, `apps/desktop/playwright.config.ts` | `apps/desktop/e2e/smoke.spec.ts`, `apps/desktop/playwright.config.ts` @ 45c0057 | rewritten | real engine; isolation by switches; a Windows project driven from WSL |
| `apps/desktop/src/renderer/src/app/theme.ts`, `fonts.css`, `assets/fonts/*` | `apps/desktop/src/renderer/src/app/theme.ts`, `fonts.css`, `assets/fonts/*` @ 45c0057 | ported | `--nivra-*` variables, privacy colours dropped; IBM Plex (OFL) vendored as in Hird |
| Engine badge and banner | `apps/desktop/src/renderer/src/features/engine/` @ 45c0057 | rewritten | the project's target label beside the badge (D1, D17); no selector |

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
