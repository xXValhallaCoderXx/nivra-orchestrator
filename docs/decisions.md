# Decision log

Decisions taken while building Nivra, newest last. Each says what was decided, why, and what follows from it. When a
decision changes, add a new entry that supersedes the old one rather than editing history. Decisions inherited from
Hird are cited as "Hird D<n>"; where code came from is in [provenance.md](provenance.md).

## D1. The window is native; the engine runs where the repository lives (2026-10-16)

**Decision.** The Electron host always runs natively on the person's OS. The engine runs on an *execution target*:
`Local` (the host's own OS) or `WSL:<distro>` (a WSL2 distribution, from a Windows host). A project is recorded in
main as `{targetId, nativePath}`, where the path is in the target's own form (POSIX inside WSL). The renderer only
ever sends a `projectId`. The target's label ("Ubuntu · WSL", "Windows · Local", "Linux · Local") is shown wherever
work starts.

**Why.** Microsoft recommends keeping project files on the same filesystem as the tools that use them; crossing the
Windows/Linux boundary for every git call and file read is slow and changes behaviour. Hird only supported WSL by
running the whole Linux app under WSLg, and its HTTP design breaks across the boundary in seven places (discovery
file home, pid checks, `node.exe`-only spawn, SIGKILL hitting the `wsl.exe` proxy, localhost forwarding, path
translation, engine state on `/mnt/c`).

**Consequences.** Paths are converted only at the folder picker in main (UNC `\\wsl.localhost\…` or `\\wsl$\…` to
POSIX after checking the distro; `C:\…` through `wslpath -u` inside the distro, with a slow-filesystem warning). A
command never runs somewhere the person did not choose.

## D2. Host and engine speak NDJSON JSON-RPC 2.0 over stdio, and stdout carries nothing else (2026-10-16)

**Decision.** Main spawns the engine as a child process and speaks JSON-RPC 2.0, one JSON object per line, over its
stdin and stdout. Main validates both directions with zod. The renderer never talks to the engine. The engine's
`main.mjs` is a small *unbundled* launcher: it keeps the real stdout writer for the protocol, sends `console.*` and
`process.stdout.write` to stderr, and only then imports the bundled `engine.mjs`. Mastra is built with
`logger: false`. A source scan forbids `stdio: 'inherit'`, and a purity test asserts that every stdout line is
JSON-RPC.

**Why.** The same transport works for a native spawn and for `wsl.exe`, which relays stdin, stdout and EOF and is
binary-safe (measured 2026-10-16: 64 MB of CR/LF/^Z/NUL bytes matched by sha256, about 209 MB/s). There are no ports,
firewall prompts, tokens or discovery files, and nothing depends on WSL's NAT or mirrored networking (the developer
machine runs mirrored mode, which would hide the NAT-mode bugs others hit). The launcher exists because in an ESM
bundle every external import runs before the bundle body, and pino-pretty writes to fd 1 directly.

**Consequences.** One stray `console.log` in a dependency cannot corrupt the protocol. Engine stderr goes to a log
file. Mastra Studio is not part of the product; if needed it gets a separate dev-only entry.

## D3. Configuration crosses boundaries as arguments or RPC, never as environment (2026-10-16)

**Decision.** The engine takes `--stdio --home <abs> --instance <uuid> --heartbeat-ms <n>`; everything else arrives
in `initialize` or later calls. The launcher sets `MASTRA_TELEMETRY_DISABLED` itself. Every `wsl.exe` spawn sets
`WSL_UTF8=1` and still decodes UTF-16LE when NUL bytes appear.

**Why.** Environment variables do not cross `wsl.exe` unless listed in `WSLENV`, and `wsl.exe` writes its own
messages in UTF-16LE by default (verified 2026-10-16). Hird configured its engine and tests through environment
variables, which would silently not apply to a WSL engine.

**Consequences.** Tests isolate themselves with `--home`, never with the environment. Package scripts carry no POSIX
`VAR=value` prefixes either, since pnpm runs scripts through cmd.exe on Windows.

## D4. One way to stop the engine, and a fixed quit order (2026-10-16)

**Decision.** The engine has one shutdown path with four triggers: the `shutdown` RPC, stdin `end`, stdout `EPIPE`,
and N consecutive watchdog ticks with no message (`--heartbeat-ms`, 0 in development; the host also pings when
`powerMonitor` reports a resume). It cancels its runs, kills their process groups, waits until every answer has been
handed to the OS (each protocol write has a completion callback), and only then does the launcher exit, so the last
reply is never lost. Main quits a target in this order: `shutdown` and 5 s,
`stdin.end()` and 2 s, then force — `taskkill /T /F` for a native Windows engine, only while the child's `exitCode`
and `signalCode` are both null; for WSL, kill `wsl.exe`, then `pkill -f -- '--instance <uuid>'` inside the distro.

**Why.** Windows has no signals, and a SIGKILL from Windows hits `wsl.exe`, not the engine. Ending stdin was verified
to stop a Node process inside WSL (2026-10-16). Counting silent ticks rather than elapsed time survives sleep and a
stalled main thread. libuv puts every non-detached Windows child in a kill-on-close job object, so a native engine
and `wsl.exe` die with Electron even when `before-quit` never runs (logoff, shutdown).

**Consequences.** Children are spawned with `detached: process.platform !== 'win32'`. The engine's own children use
process groups on POSIX and the job object plus `taskkill /T` on Windows. A run still marked running when an engine
starts is failed with a `run.interrupted` event and never replayed.

## D5. Nivra ships its own Node and engine for every target (2026-10-16)

**Decision.** Installers carry Node 24.21.0 (SHA-checked against `SHASUMS256.txt`) and the engine — our code bundled
with esbuild plus a pruned production `node_modules` — for each target. `linux-x64` is always staged on Linux, as a
deterministic tarball (`--sort=name --mtime=@0 --owner=0 --group=0`, gzip without a timestamp); `win-x64` may be staged
from Linux, since nothing in it depends on file modes (see D14). The Windows installer embeds the Linux tarball. A WSL target is provisioned by streaming that tarball
through `wsl.exe` stdin into `<home>/.nivra/runtime/<contentHash>/`: extract into a temporary folder, `chmod 0755`
the Node binary, load `node:sqlite` and libsql inside the distro, then rename. An existing hash means the runtime is
already there. The engine is spawned with absolute paths built from the distro's `$HOME`.

**Why.** A Node installed with nvm is not on the PATH that `wsl.exe --exec` or `bash -lc` sees (verified 2026-10-16),
so depending on the person's Node would fail for most WSL users. `--exec` does not expand `~`, and a relative entry
resolves against the working directory. A tarball made on Windows loses the executable bit and folds names that
differ only in case.

**Consequences.** An exec failure (exit 1 with `execvpe … failed`) means the runtime is missing: provision once more,
then report. The distro needs glibc 2.28 or newer (the official Node 24.21.0 binary references `GLIBC_2.28` and
`GLIBCXX_3.4.21`); the probe checks it before provisioning.

## D6. No native addons in Electron; the engine's one addon ships with its runtime (2026-10-16)

**Decision.** Electron's main process loads no native modules. The engine's only addon is libsql, used by Mastra's
storage, installed as the target's prebuilt package (pnpm `supportedArchitectures`, as Hird D20 does). Nivra's own
data uses Node's built-in `node:sqlite`. libsql's Windows build imports `VCRUNTIME140.dll`, so the Visual C++ runtime
DLLs it needs are shipped next to `node.exe`, and staging checks the addon's imports.

**Why.** Nothing then needs rebuilding for Electron. GitHub's Windows images have the Visual C++ redistributable
installed; a clean machine may not, and the libsql addon would fail to load there with no error from CI.

**Consequences.** The packaged smoke test opens both databases on every target. The installer is tried once on a
clean Windows VM or Windows Sandbox.

## D7. One owner per database (2026-10-16)

**Decision.** The host owns the engineer's profile, preferences, project registry and target choice, as JSON in
Electron's `userData` folder with atomic writes (rename retried on Windows sharing errors). Each engine owns
`nivra.db` (`node:sqlite`) and `mastra.db` (libsql) under its `--home`: `~/.nivra` on POSIX, `%LOCALAPPDATA%\Nivra\engine`
on Windows, `~/.nivra-dev` for development engines. The engine holds SQLite's own exclusive lock on `nivra.db`
(`locking_mode=EXCLUSIVE`, `timeout: 0`); a second engine on the same home is refused.

**Why.** Global preferences need one canonical copy, not one per engine. SQLite's WAL mode relies on shared memory
and does not work over network filesystems, so no database is ever opened across the Windows/WSL boundary. An
OS-held lock disappears with the process; a pid file can outlive it.

**Consequences.** The host sends the relevant preference records to the engine with each request. No icacls:
`%LOCALAPPDATA%` is already private to the user.

## D8. Secrets live in the host and in engine memory only (2026-10-16)

**Decision.** API keys are stored by the host with Electron's `safeStorage` async APIs, re-encrypted when
`shouldReEncrypt` says so. A decrypt failure means "enter the key again". On Linux, the `basic_text` and `unknown`
backends count as unencrypted and are shown as such (WSLg and Xvfb report `basic_text`). The engine receives keys in
`initialize` and `secrets.update` and keeps them in an in-memory map that steps read through a closure — never in
workflow input, `requestContext`, run input or run events. The engine deletes provider variables from `process.env`
at start and always passes `apiKey` explicitly. The masker learns every value.

**Why.** Mastra persists workflow input, step results and `requestContext` in its snapshots, and a queued run starts
after the call that carried its key has finished. Mastra falls back to environment keys, which would bill a key the
person did not choose (Hird D3).

**Consequences.** A canary test checks that a fake key never appears in `nivra.db*`, `mastra.db*` or the logs. Keys
are never written into a WSL distribution.

## D9. Execution boundaries are pluggable sessions that say what they enforce (2026-10-16)

**Decision.** Mastra orchestrates; a boundary only constrains what an executing worker can do. The engine's
`ExecutionBackend.open({snapshot, image?, network, grants, limits})` returns an `ExecutionSession` with `exec`
(streaming, cancellable), `runMain` (a worker running inside the boundary), `download` (a patch) and `close`. Each
backend declares its capabilities: `isolatesFilesystem`, `networkPolicy` (`none`, `onOff`, `allowList`),
`injectsCredentials`, `persistsBetweenExecs`. A run that needs a boundary its target lacks is refused with a message
naming what is missing; it never falls back to running unconfined. Backends: `Local` (no isolation, labelled so),
`NebiusSandbox` (Token Factory Sandboxes: a remote VM, network on or off, every target) and `OpenShell` (NVIDIA
OpenShell: Landlock filesystem rules, default-deny network rules, credentials injected as placeholders; Linux, WSL2
experimental, macOS; not native Windows), driven through its CLI.

**Why.** An approval dialogue is not a security boundary unless the executor enforces it. The two sandboxes
complement each other: a worker inside a boundary needs the model's endpoint while its key stays hidden (OpenShell
can allow only `api.tokenfactory.nebius.com` and inject the key), while untrusted scaffolding and installs fit a
throwaway remote VM (Nebius). OpenShell's TypeScript SDK is published only on GitHub Packages, which needs a token to
install, so the CLI is the integration point.

**Consequences.** A backend-agnostic contract suite checks every backend: whenever a capability is claimed, a
prohibited operation must fail. Snapshots never include the engine home, the preferences store or files on the
secrets deny list; an allowed endpoint can still carry data out, so context stays minimal. Child processes get
`childEnv()`: one PATH key, plus `SystemRoot`, `windir`, `TEMP`/`TMP`, `USERPROFILE`, `LOCALAPPDATA` and `APPDATA`.
The WSL engine strips `/mnt/*` from the PATH it uses for tools.

## D10. Supported platforms for the proof of concept (2026-10-16)

**Decision.** Windows 10/11 x64 with Store WSL2 (glibc distributions, glibc 2.28 or newer) and native Windows; Linux
x64, with the deb as the primary Linux artifact. macOS shares the POSIX code paths, but its packaging, signing and CI
are deferred and must never block. Clear refusals for WSL1, musl distributions, ARM64, `docker-desktop*`
distributions, a distribution never opened (`DefaultUid` 0), WSL missing or inbox-only, and no distributions.

**Why.** These are the platforms that can be built and tested by the developer and by CI in the time available. The
AppImage fails on a stock Ubuntu 24.04 because of AppArmor's user-namespace restriction and the missing libfuse2.

**Consequences.** WSL discovery does not depend on the display language: presence is `%ProgramFiles%\WSL\wsl.exe`
plus a working `wsl --version`, names come from `wsl --list --quiet`, and version, default and `DefaultUid` come from
the `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` registry key (`--list --verbose` is localised).

## D11. Toolchain pinned to Hird's (2026-10-16)

**Decision.** Node 24.21.0, pnpm 10.4.1, Electron 44.7.0, electron-vite 5.0.0 on Vite 7.3.7, React 19.3.0,
Mantine 9.7.1, TypeScript 5.9.3, zod 4.6.5, Playwright 1.64.0, electron-builder 26.15.3, `@mastra/core` 1.75.0,
`@mastra/libsql` 1.25.1, tests on `node --test`. Exact pins, LF line endings everywhere.

**Why.** These versions have been run together in Hird; reusing them removes a compatibility investigation.

**Consequences.** Mastra upgrades re-run the scheduler tests, because `run.watch` is internal API. Adding or removing a
dependency needs approval.

## D12. Targets and the engine supervisor do not import Electron (2026-10-16)

**Decision.** `targets/` and `supervisor.ts` in the desktop app are plain Node modules. Electron-specific inputs are
injected: `resourcesPath`, the userData and logs paths, `isPackaged`, the version, a credentials provider, a
`powerMonitor` resume hook, `spawn` and a clock. A source scan enforces it.

**Why.** `node --test` can then drive the real WSL and native-Windows paths on a Windows CI runner before any user
interface exists, and the cross-platform foundation is proven first.

**Consequences.** The Electron main process is a thin shell over these modules.

## D13. Entered in the Coding and Agentic Engineering track (2026-10-16)

**Decision.** Nivra is entered in the Nebius × NVIDIA Global AI Hackathon's Coding and Agentic Engineering track
(submissions close 2026-10-30 10:00 PT). Model calls use NVIDIA Nemotron models through Nebius Token Factory, and the
coding workflow operates within Token Factory Sandboxes. The repository is public under the MIT licence, and code
taken from Hird is listed with its source commit in [provenance.md](provenance.md).

**Why.** The track asks for coding agents and developer tools that operate within Token Factory Sandboxes, which fits
Nivra. The rules ask for an open-source licence, disclosure of pre-existing components and dated history.

**Consequences.** Token Factory Sandboxes is in beta and access has to be requested. If it has not arrived by
2026-10-21, decide whether to stay in the track or make OpenShell the boundary and enter Best Apps and Agents instead; the session seam (D9) makes
either a change of backend. The default install and demo must not require Docker Desktop.

## D14. Cross-platform checks run on this machine, not in CI (2026-10-16)

**Decision.** There is no CI or CD. The checks a CI matrix would have run happen locally:
- `pnpm verify` on Linux (WSL): typecheck and every test, including the supervisor driving a real engine.
- `pnpm stage:runtime all`: stages `linux-x64` (smoke-tested: self-check, then initialize and shutdown over stdio) and
  `win-x64`, with a content-hashed manifest and the WSL tarball. Staging twice gives identical hashes.
- `pnpm verify:windows`, from WSL: copies the Windows runtime and a bundled harness to
  `%LOCALAPPDATA%\nivra-dev\verify` and runs the harness with the staged `node.exe`. That is a real Windows parent
  driving the native engine and a WSL engine through the same target and supervisor modules Electron uses: start,
  `hello` on paths with "ü", "%" and "#", cancel, a clean stop, and the engine dying with a parent that was killed.
- Installers and the test build are built on this machine and uploaded by hand.

**Why.** The person building Nivra works on Windows with WSL2 and wants nothing downloaded from a cloud build. A
harness run as a Windows process proves the same Windows-parent behaviour a hosted Windows runner would.

**Consequences.** Run `pnpm verify:windows` whenever targets, the supervisor or staging change. The packaged Windows
app is also driven through its real UI from WSL: `pnpm dev:win --no-launch` copies the build to
`%LOCALAPPDATA%\nivra-dev\app`, and `pnpm --filter @nivra/desktop test:windows` runs Playwright against it through
interop (it reaches the app's debugging port over localhost, which works here because this machine uses WSL's mirrored
networking; the product itself never depends on that, D2). First run, 2026-10-16:
15 of 15 checks passed (native engine start 0.8 s; WSL provisioning 3.0 s; a second WSL start 0.75 s). A Windows NSIS
installer cannot be built from Linux (Wine fails on Ubuntu 24.04), so the Windows test build is a zip until there is a
Windows-side build step.

## D15. Agents write in a workspace the engine owns; changes reach a checkout only as an approved patch (2026-10-17)

**Decision.** When a coding agent changes code:
- It runs on the target that owns the repository's filesystem, inside an execution boundary (D9) that declares what it
  enforces. Native Windows has no local boundary Nivra can enforce and test yet, so agent writes there go to a remote
  sandbox or are refused, never run unconfined.
- It writes only into a workspace the engine makes for the run: a copy of one commit, in the engine's home on the
  target or inside a sandbox. Never the person's checkout, never a git worktree (Hird D39, D43).
- What it changed comes back as a patch. The engine checks it before anyone sees it:
  - every path stays inside the repository;
  - no two paths differ only in case where the checkout's filesystem ignores case;
  - line endings follow `.gitattributes`;
  - no symlink or mode change the target cannot hold;
  - nothing on the secrets deny list.
- The person approves that exact patch, identified by its hash. Then the engine applies it in the checkout with git,
  recording the intent first so that a retry never applies it twice.
- Checks (tests, builds) run inside the boundary against the workspace, never against the checkout. Dependency installs
  run only inside a boundary that enforces network rules, or in a disposable sandbox.
- A checkout is written by the engine on the OS that owns its filesystem: a repository on a Windows drive by the
  Windows engine, one inside WSL by the WSL engine. Neither the host nor the renderer ever writes repository files.
- Only intent crosses environments (patches, reports), never built artefacts (`node_modules`, binaries), which belong
  to one OS.

**Why.** An approval dialogue is not a boundary (D9), and Hird's change runs proved the copy, judge, patch shape (Hird
D44). The cross-environment hazards silently break files unless the one writer checks for them:
- Windows filesystems that ignore case;
- CRLF line endings;
- executable bits and symlinks;
- dependencies built for another OS.

**Consequences.**
- The engine gets workspace, patch-check and apply modules. Runs use `waiting_for_approval`, with approve and reject
  calls bound to the patch hash.
- Before agents run builds, the engine must capture the login shell's PATH: nvm and similar are invisible to
  `wsl.exe --exec` (development.md, "Not built yet").
- Open: the host runs one engine at a time, and switching targets stops the other. Long agent runs need one engine per
  target kept running, with a warning before stopping one that has work in progress.
