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

## D16. What the first code review changed (2026-10-17)

**Decision.** Five findings from the first review were confirmed against the code and fixed:
1. **Session cleanup (D4, D9).** A local session keeps every process group it started for its whole life, and
   closing it stops them all, including groups whose leader already exited (SIGTERM, then SIGKILL). Before, a
   command that left a background child (`sleep 60 &`, an unref'd child) dropped out of tracking, and its child
   outlived the session; this was reproduced on Linux.
2. **Target-scoped UI state (D1).** The run, Doctor and provider sections are keyed by the selected target, so a
   switch starts them fresh. Before, a run still going during a switch kept its id: polling and Cancel went to the
   new engine, which never had it, and "Run hello" stayed disabled.
3. **Key storage is reported as it is (D8).** Settings show how the saved key is actually kept: encrypted,
   unencrypted, or unreadable here. An unencrypted key is re-encrypted as soon as a keychain protects new data (at
   start and on every read). Before, the warning followed whether a keychain was available now, so it could vanish
   while the key stayed in plaintext.
4. **Missing Visual C++ DLLs fail staging (D6).** Staging used to warn and continue. `--allow-missing-vc-runtime`
   exists for development only, and the manifest records which DLLs shipped.
5. **WSL listing failures stay visible (D10).** A failed `wsl --list` is reported as broken, with WSL's code and a
   recovery step (`wsl --shutdown`, then `wsl --update`). It is "no distributions" only when the registry confirms
   that none are registered. Before, every failure, timeouts included, looked like an empty WSL.

**Why.** Each was a way for Nivra to show something other than the true state, which the acceptance suite forbids.

**Consequences.**
- New tests cover each finding: the session contract, the secret store with a stand-in for safeStorage, WSL
  discovery, and a Windows UI test that switches targets mid-run.
- Still open: on native Windows, the background descendants of a finished command cannot be found from its process
  id once it has exited. They die with the engine through libuv's job object (D4), which is one more reason agents'
  commands do not run unconfined on native Windows (D15).

## D17. The folder decides where work runs; one engine per target for the session (2026-10-17)

**Decision.** There is no target selector.
- **The target is set once, when a folder is added**, by the operating system that owns the folder's filesystem:
  - a folder on a Windows drive runs on the Windows engine (`local`);
  - a folder inside a WSL distribution (`\\wsl.localhost\<distro>\…` or `\\wsl$\…`) runs on that distribution's engine;
  - a Windows drive seen through WSL (`\\wsl.localhost\<distro>\mnt\c\…`) is still a Windows folder;
  - on Linux and macOS, every folder runs locally.
- **There are no automatic choices.** WSL is never chosen just because it is installed, and a project never falls back
  to another target. A folder whose distribution is missing or unusable says why and what to do.
- **The host keeps one engine per target.**
  - An engine starts the first time a project on its target is opened, and runs until quit.
  - Project calls go to the engine of the project's folder.
  - Run calls go to the engine that started the run. Main keeps a map from run to target, so the renderer never decides
    where a call goes.
  - Quitting closes every engine in parallel, each in the D4 order. A closed supervisor never starts again.
- **On Windows the app always says what WSL can offer**, with the command that fixes it and a Check again button:
  - WSL missing;
  - WSL outdated;
  - WSL not answering;
  - WSL with no distribution Nivra can use (none, only Docker Desktop's, or only WSL 1 ones).

**Why.**
- **The race.** The bootstrap's runtime switch existed to prove that both engines work, and it caused a race (external
  review, 2026-10-17). A switch sent calls to the new engine before the old one had stopped, so a run's polling and its
  Cancel could reach the wrong engine.
- **One rule.** D1 and D15 already say a repository is worked on by the OS that owns its filesystem. Binding the target
  when a folder is added makes that the only rule.
- **Missing guidance.** A WSL with no usable distribution used to look like no WSL at all, with no guidance.

**Consequences.**
- **Supersedes:**
  - D1's target choice and its picker conversion (`C:\…` through `wslpath -u` for a WSL target). A drive folder belongs
    to the Windows engine, so Linux tools are no longer run on Windows drives.
  - D7's stored target choice. Older files are still read, the key is dropped, and `/mnt/<x>` projects move to the
    Windows engine, with a notice.
  - D15's open item about running one engine at a time. Engines now stay up, so a long run survives looking at another
    project.
  - D16 #2. UI state follows the project, and run calls are routed in main.
- **Cost:** several engines can run at once, each a Node and Mastra process. Stopping an idle engine is a possible
  follow-up.
- **Tests:**
  - `host.test.ts`:
    - routing by folder;
    - a run kept on its own engine while another engine restarts slowly;
    - no fallback for a missing distribution;
    - every engine stopped on quit.
  - `paths.test.ts`, the store migration and the WSL guidance.
  - A Windows UI test that uses a WSL folder and a Windows folder in one session.

## D18. An engine that stops answering is reported and stopped (2026-10-17)

**Decision.** The host treats an engine that is alive but silent as failed.
- **Detection.** The host pings each engine six times per heartbeat (30 s by default). If no ping has been answered
  for longer than the heartbeat, the engine is marked failed with code `unresponsive`. Its reason says what to do:
  restart the engine; if this keeps happening, its log may say why.
- **Recovery.**
  - The engine is then stopped in the D4 order, which releases its lock and processes.
  - The failure stays on screen while it stops.
  - Restart starts a fresh engine, and runs the old one left running end as `run.interrupted` (D4).
- **After sleep.** After the machine wakes (Electron's `powerMonitor` resume), silence isn't counted for one heartbeat,
  and the time spent asleep never counts.
- **Unexpected exits** are reported as before, as "The engine stopped unexpectedly (exit code …)", with a Restart
  control. The host doesn't guess at a cause: an exit it can't explain is never called a WSL shutdown.

**Why.** External review, 2026-10-17. An engine that stayed alive but stopped answering only produced ping errors in
the log, while the window kept showing it as online. Unexpected exits were already handled.

**Consequences.**
- Extends D4.
- Tests:
  - a fixture engine that answers `initialize` and then nothing: it is reported within bounds, stopped, and starts
    afresh on Restart;
  - after a resume, silence isn't counted until the grace period ends.
- The Windows harness checks that a native engine killed from outside, and a WSL engine killed inside its
  distribution, are both reported as stopped and start again on Restart.
- Terminating a whole distribution (`wsl --terminate`) is not checked automatically, because the checks run from
  inside that distribution.

## D19. Hackathon requirements, as published (2026-10-17)

**Decision.** This supersedes D13's statement that the coding workflow operates within Token Factory Sandboxes, and the
reason D13 gave for it.
- **What every entry needs.** The official rules' general platform requirement is runtime use of Nebius Token Factory
  inference with an NVIDIA model. Nivra meets it through its model calls: `providers.check` today, and the planned
  workflows. This is as checked by the 17 October review; Devpost blocks automated fetching, so the rules were not
  re-read for this entry.
- **What is still open.** The Coding and Agentic Engineering track's wording about operating within Token Factory
  Sandboxes needs clarification from the organisers. That clarification has not been obtained. Until it is, no Nivra
  document says Sandboxes is mandatory.
- **No OpenShell bonus.** The rules publish no scoring bonus for NVIDIA OpenShell.
- **Sandboxes isn't available yet.** Token Factory Sandboxes is a beta product that needs an access request. Access has
  been requested and is not active, so it is not an available, zero-setup way to run code today.
- **The architecture doesn't depend on the answer.** The execution design (D9, D15, D17) stands either way: the answer
  only decides which sandbox the demonstration uses.

**Why.** The external review of 17 October found the docs stated the Sandboxes requirement as settled.

**Consequences.**
- The track question is tracked in NIV-15, and kept out of the architecture description.
- D13's 21 October gate becomes: ask the organisers, then choose the demonstration's way of running code from their
  answer and the state of Sandboxes access.

## D20. The immediate milestone: explain with evidence and confirmed preferences; new-app creation deferred (2026-10-17)

**Decision.** Nate confirmed this scope in NIV-2. It supersedes:
- the new-app parts of the plan;
- the demonstration and acceptance suite in `docs/acceptance.md`;
- NIV-2's scaffold and empty-destination items.

**What the milestone delivers**
- Repository explanation with source evidence. It is read-only: bounded reads, no writes, no code execution.
- Engineering preferences that the person explicitly confirms, which persist and are reused with the correct project
  scope.
- Repository observations (frequently used stacks, say) may suggest a preference. They never silently become a
  confirmed personal default.
- **Precedence:** explicit task choices come first, then the repository's own conventions, then confirmed personal
  defaults.

**Acceptance sequence**
1. Inspect and explain repository A, with source evidence.
2. Explicitly confirm a portable preference.
3. Inspect repository B, whose conventions contrast with A's.
4. Show correct scope and precedence: B's conventions win over the personal default, and A's project-only records
   never reach B.
5. Edit, then delete, the preference, and show that later requests get fresh context.

No scaffold generation and no repository writes are needed. Cancellation, restart, target ownership (D17), context
isolation and accurate failure reporting stay in the contract unchanged.

**Data sharing** (confirmed)
- **Two separate opt-ins per project, both off at first:** `modelContext` and `cloudExecution`.
- **`modelContext`** controls whether repository-derived material is sent to Token Factory. The consent covers the
  whole workflow, including read-tool results and later requests.
- **`cloudExecution`** controls uploading a workspace.
  - It stays off and unused while cloud execution isn't built.
  - Turning on `modelContext` never turns it on.
- **Always excluded:** secrets, and dependency and build output.
- **Limits on every read:** it stays inside the repository and is bounded, and output is capped.
- **Text has no authority.** Repository or model text can never grant consent, and can never promote private project
  information into the global profile.
- **A third control.** A sandbox's network policy (later milestone) is separate from both opt-ins.

**Preferences.** A minimal canonical store owned by the host, and a scoped handoff to engines, are built now with NIV-5.
NIV-10 reuses them. There is no second, temporary store.

**Fixtures:** user-supplied repository A/B, references pending.
- Nate supplies the two repositories during development.
- When they arrive, their identities, revisions and contrasting conventions are recorded.
- Choosing a repository grants none of these: model-context consent, cloud-upload consent, or permission to publish its
  contents.
- Private material stays out of checked-in or public samples. Any public demonstration sample is resolved in NIV-16.
- Acceptance that depends on the fixtures stays pending until they are supplied and tested.

**Outside this milestone**, unless separately promoted:
- new-app creation (scaffold and empty destination);
- automatic editing of repositories;
- voice input (NIV-19) and local acceleration (NIV-18);
- more providers and workers (NIV-21);
- councils (NIV-22);
- profile synchronisation (NIV-23);
- in-product Linear integration (NIV-24).

The coding-work design (D9, D15, `system-architecture.md` §11) is kept for a later milestone, and none of it is
claimed as done.

**Why.** Nate's scope decision of 17 October 2026 concentrates the remaining time on the read-only workflow and on
confirmed memory.

**Consequences.**
- The criteria in NIV-6, NIV-8, NIV-10, NIV-11, NIV-12, NIV-14, NIV-15, NIV-16 and NIV-17 are reconciled with this
  scope. Deferred work stays visible.
- Track fit is reassessed in NIV-15. Meeting the general platform requirement doesn't by itself show that a read-only
  workflow fits the Coding track's "write, run, and test code" wording.
- Judge access remains undecided (NIV-16).

## D21. Preferences: one store owned by the host, and a snapshot with every run (2026-10-17)

**Decision.** This builds D20's minimal canonical store and scoped handoff, for NIV-5 now and for NIV-10 to reuse.
- **One canonical store.** The host keeps preferences in its own records file (`nivra.json` in Electron's user-data
  folder, D7), beside the project registry. Each record holds:
  - an id and the statement, in the person's words (at most 500 characters);
  - a scope: `personal` applies to every project, `project` to one project, named by its id;
  - a status: `confirmed`, or `suggested` for NIV-10's suggestions (none are made yet);
  - an origin: `entered`, typed by the person;
  - a revision, which is 1 when the record is created and rises with every edit, and its dates, including when it was
    confirmed.

  The store has its own revision too, raised by every change to any preference. It keeps at most 50 preferences.
- **Confirming is explicit.** A preference exists only once the person types it and presses Confirm. Nothing else
  creates one.
- **A snapshot with every run.** `runs.start` now requires a `context`. Main takes it from the canonical store when the
  run is requested: the confirmed personal preferences and the project's own, with the store's revision. Both sides
  validate it. No engine receives the whole profile at `initialize`, or a path to the store.
- **In the engine, memory only.** The scheduler holds a run's context from submission until the run ends. Steps read it
  by run id, so it never enters workflow input, step output or the run's record. A run records only what it received:
  - the count;
  - each preference's id, scope and revision;
  - the store's revision;
  - a SHA-256 fingerprint of the records (`preferencesDigest` in `packages/domain`).
- **A run starts only in the engine instance that accepted it.** At startup, queued runs that another instance accepted
  now fail as `run.interrupted` without starting, as running ones already did. A queued run can therefore move to
  `failed`.
- **Protocol 2.** `PROTOCOL_VERSION` is now 2, since `runs.start` needs `context`. `initialize` refuses a mismatch, so
  an engine on protocol 1 is installed again.
- **Removing a project removes its own preferences.** Personal ones stay, and the window says how many went.

**Why.**
- NIV-5 and NIV-10 ask for one canonical store on this installation, with scoped snapshots for engines.
  - Engines must not share a live database across operating systems (D7).
  - Engines must not keep their own profiles, which would diverge.
- Mastra stores step input and output unmasked. Keeping the context out of Mastra keeps preference text out of
  `mastra.db`.
- A fresh snapshot for every run makes an edit or a deletion reach the next run, with no cache to invalidate.
- Main chooses the records, so project isolation rests on one tested function (`snapshotFor`).
- Each side works out the fingerprint from what it holds, so a match shows the exact values arrived, with nothing
  stored.

**Consequences.**
- A run already going keeps the snapshot it was given. An edit or a deletion reaches the next run.
- Queued runs no longer survive an engine restart.
- The hello run's `context` step proves the handoff until a workflow uses preferences (NIV-6, NIV-11).
- NIV-10 builds on this store, with suggestions, supersession, export and import. NIV-11 orders precedence by scope.
  There is no second store.

## D22. Explain with evidence: the model client, repository reading, consent and checked citations (2026-10-17)

**Decision.** NIV-6 and NIV-9 ship one read-only workflow, `explain`, on NVIDIA Nemotron through Nebius Token Factory.
It builds on D20's scope and D21's snapshot, and amends D21 for text the model writes (below).

**The model client** (`providers/model.ts`, the only place a source rule allows `new Agent(`)
- **A standalone Mastra `Agent`**, never registered with Mastra, so nothing about a call is written to `mastra.db`.
  Mastra's default error logger prints the prompt, so it is silenced through `__registerPrimitives({ logger })`: internal
  API, watched by a stderr canary.
- **Nothing is sent twice:** `maxRetries: 0`, `errorProcessorDefaults: false`, `maxProcessorRetries: 0`, and no
  fallback models. Only `generate()` is used: it sends non-streaming requests, so usage is reported. Tools run one call
  at a time (`toolCallConcurrency: 1`).
- **Deadlines.** Each model call has one, and so does the whole run (`modelSettings.timeout`). Either ends the run as
  `timeout`, never as a quiet stop.
  - Explain: 150 s per call, 480 s for the run, at most 16 steps. Live answers ran at about 30 tokens a second, so a
    long one needs more than 90 s.
  - `providers.check`: 150 s in all, inside the host's 180 s limit for that request, with 60 s for the first call.
  - Listing models: 30 s.
  - Mastra sets no limit on agent calls. Its 180 s `server.timeout` belongs to its HTTP server, which Nivra doesn't run.
- **Two ways to stop.** Cancel comes from the person. Anything that fails inside, such as a tool or a callback, is
  recorded as an internal failure before the internal abort, so the run ends `failed`, never `cancelled`.
- **Failures are named by class and status**, walking `cause`, never by their words:
  - `auth`, `rate-limit`, `model-unavailable`, `provider`, `bad-request`;
  - `bad-response`: a reply that couldn't be read, a 200 included;
  - `network`, `timeout`, `cancelled`, `internal`;
  - `malformed`: no accepted answer;
  - `sharing-refused` and `no-key`, before any request.

  Each message says what happened and what to do. A 429 says when to try again, from `Retry-After` or the token limit's
  reset. Nothing retries by itself.

  Messages are Nivra's own words, with the kind, the HTTP status and when to retry. A failure's message is persisted,
  in Mastra's records too, and the provider's text can echo the key, the question or the repository. So that text
  never enters one, from a model call or from the model list. An error Nivra doesn't expect is named by its class
  only.
- **Every model call is recorded**, failed ones too, as a `model.call` event: the elapsed time, tokens or `null`, the
  finish reason, and the kind when it failed. The kind is also in the `run.failed` data. Each request is recorded
  once: a request that fails is one event, with its own step number and its own time. A failure inside Nivra made no
  request, so it is the run's failure alone.
- **Requests are counted as the provider is called.** The model is resolved with Mastra's own `resolveModelConfig`
  and watched through a proxy, which sees each request start and end. A cancel before the first request, or between
  two, records none. A request that was answered before a cancel cut off its tools is recorded once, with the usage
  it reported.
- **A tool call whose input fails the tool's schema** never runs: Mastra tells the model what to fix. The run records
  it as a refused `tool.called` event, with each field path and rule, never the input. Live, Nemotron 3 Super sent a
  forced answer's lists as strings. With a single answer step the run failed; with three, the next attempt was
  accepted.
- **Usage** is the provider's counts. A run's totals are `null` unless every call reported them, and `reportedCalls`
  says how many did. Never 0, never an estimate.
- **The route** records the endpoint, `token-factory` or `loopback-test`, so a stub run can never pass as live evidence.

**Tool choice** (`providers/policy.ts`), from checkpoint 1: Settings → Check Token Factory, with Nate's key, 17 October.
The key saw 28 models, five of them NVIDIA's.
- Nemotron 3 Super honoured `toolChoice: "required"`, and a forced tool when it was the only one offered. So exploring
  steps use `required`, and the answer tool is forced when the answer is due.
- `providers.check` now also forces one tool out of two, then calls the real answer schema. Those stronger probes
  haven't been run with a real key yet.
- Any other model gets `auto`, with no forcing.
- There is no plain-text fallback: a run with no accepted answer fails `malformed`.
- Each model's `context_length` is read from `/models?verbose=true` when it is reported. Otherwise the app's cap applies.

**Reading the repository (NIV-9)**, ported from Hird and adapted (`docs/provenance.md`)
- **The root is the folder the person picked**, by real path, not the repository's top level. Paths are compared with
  `relative()`.
- **Tracked files only** (`git ls-files`), read as they are on disk. An edit to a tracked file is seen; an untracked
  file never is. Every read and every search hit is hashed from the bytes it came from.
- **Hidden, each for a stated reason.** One list drives both the code's own check and git's pathspecs.
  - Files that may hold secrets: Hird's list, plus SSH and GPG material, keystores, `.htpasswd`, kube configs,
    service-account JSON and `.mcp.json`. `.env.example` stays readable.
  - Dependency and build output at any depth: `node_modules`, `dist`, `build`, `out`, `.next`, `.expo`, `.turbo`,
    `coverage`, `vendor`, `target`.
- **Limits.**
  - A listing returns at most 300 paths.
  - A search returns at most 50 lines, 5 per file, and skips files over 200 KB.
  - A read takes at most 200 KB, 400 lines and 400 characters per line.
  - No tool result is longer than 16,000 characters.
  - A read refuses binary files, links that lead out of the root, and a mask that would change the line count.
- **Git** runs through the run's `ExecutionSession`, which is closed when the run ends. The run's cancel reaches every
  git command.
  - Every call pins `color.ui=never`, `core.quotePath=false`, `core.fsmonitor=false`, `grep.fallbackToNoIndex=false`,
    `grep.fullName=false` and `submodule.recurse=false`. A repository's own settings can't change the paths reported,
    or reach into submodules.
  - Child processes no longer inherit `GIT_*` variables.
  - There is no `git status`, which can run filters a repository configures.
- **Masking** covers Hird's secret patterns, private-key blocks and the values of the keys Nivra holds, and keeps the
  line count. The map's folder and file names are masked too, before the first request. It is pattern-based, so it can't recognise every secret, and the consent dialog says so.
- **The map** is the model's starting point, at most 16 KB:
  - HEAD at run start;
  - file counts by folder and by extension, and hidden counts by reason;
  - up to 12 manifests and the workspace files;
  - the convention files that exist.
- **No cache.** Every run reads afresh.

**The explain run** (`workflows/explain.ts`)
- **Only ids pass through Mastra.** Mastra gets `{ repoPath }`. The question is stored masked in `nivra.db`, and the
  step reads it from there. Step outputs are HEAD, the model id and counts.
- **Three steps.**
  1. `context` records the preferences the run was given, as hello does (D21): the count, their ids and revisions, the
     store's revision and a fingerprint. It runs first, so a refused run records them too.
  2. `prepare` refuses without consent or a key, before any request. Then it reads HEAD and picks the model.
  3. `explain` builds the map and runs the model with four fixed tools: `list_files`, `search_code`, `read_file` and
     `submit_answer`. Then it checks the citations and stores the result.
- **Each tool enforces the budget.**
  - The whole request counts: the instructions, the map, the preferences, the question, the tool definitions, every
    result so far and the model's own arguments.
  - Characters are counted at 3 per token, corrected by the input tokens each call reports.
  - The budget is 64,000 tokens, or the model's context length if smaller, minus 4,000 held for the answer.
  - A result that won't fit is cut to what does. Once the budget is spent, the tools say so and only `submit_answer`
    is offered.
- **Time is held back for the answer.** The next step is an answer step:
  - once less than two per-call deadlines are left;
  - in the last three of the 16 steps, so an answer that is turned down can be given again;
  - once the budget is spent.

  The prompt tells the model how many tool calls it has and that the last ones are kept for the answer.
- **The answer is structured:**
  - a summary;
  - findings, each citing an exact path and lines;
  - differences from the engineer's preferences, by id;
  - gaps.

  The first accepted answer is frozen. One that names a preference the run wasn't given is turned down.
- **An answer citing lines the model wasn't shown is turned down** while there is time to read them. The refusal names
  each citation, to be read or dropped. When the answer is due, or after two such refusals, the answer is accepted as
  it is, and those citations stay labelled. Live, before this rule, the model cited files it had only seen named in
  the map: 15 of 21 citations on fixture A.
- **A citation says "shown to the model", never more.**
  - It is checked only when every cited line was delivered, by a read or a search hit, in a step before the answer.
  - Only lines actually delivered after truncation count.
  - A file seen with two different hashes is reported as changed during the run.
- **The result** is stored masked, at most 256 KB, in `artifacts`. It is labelled **HEAD at run start** and says
  whether HEAD moved. It lists what was delivered (the map's sources, the search hits and the reads) by path, lines and
  hash, never content.
- **Preferences rank below the repository.** The prompt lists the run's confirmed preferences and asks where the
  repository differs, citing its convention: the repository wins (D20). Overrides and full context assembly stay with
  NIV-11.

**Consent (D20), checked by the host and by the engine**
- Each project has `sharing: { modelContext, cloudExecution }`, both off at first. `cloudExecution` is stored but
  unused.
- The first explanation asks in a dialog. It says what is sent, what is never sent, and that pattern-based masking
  can't recognise every secret.
- **The host refuses** without consent. Each project has a revocation epoch, raised when sharing is turned off.
  - `startExplain` waits for any engine start already in progress. Then, immediately before `runs.start`, it checks
    consent and the epoch again.
  - A run is cancelled at once if the epoch moved while its `runs.start` request was out.
- Turning sharing off cancels the project's queued and running explain runs. A run that can't be stopped is reported,
  never passed over.
- **Removing a project withdraws its consent first,** the same way. Its epoch moves and stays moved, so a submission
  in flight stops itself, and its runs are cancelled. When one can't be stopped, the project stays in the list, and the
  person is told why.
  - No explanation can start while a project is being removed.
  - A late answer to `runs.start` is accepted only while the project still exists, still has consent, and isn't being
    removed.
- **The engine refuses** with `sharing-refused` or `no-key` before any request, judging from the run's own context.

**Preference text in what the model writes (amends D21)**
- The engine still never writes a statement it was given anywhere: not in Mastra's records, not in the events it
  composes, not in the stored preference differences (ids and revisions only), not in the logs.
- Text the model generates may paraphrase or quote a preference, or the repository. That covers the answer and the
  search queries in `tool.called` events.
  - It is stored only in the owning engine's `nivra.db`, masked for detected secrets and known keys.
  - It is never stored in `mastra.db` or the logs.
  - There is no exact-string scrubbing: it would imply a guarantee it can't give.
- An old result shows a preference's current wording only while its revision still matches. Otherwise it says the
  preference changed or was deleted since the run, and gives its id and revision.

**Protocol and storage**
- **Protocol 3.**
  - `runs.start` is a union on `workflowId` (`hello`, `explain`), and the context carries `sharing`.
  - `runs.result` is new.
  - Events gain `model.call` and `tool.called`.
  - `RunSummary` gains `durationMs`, `usage` and `route`, all nullable.
  - `providers.check` reports the probes, the rate-limit values and the context length.
- **Migration v2** is additive: run columns `duration_ms`, `usage` and `route`, and an `artifacts` table. Duration is
  measured with `performance.now()`.
- **The test endpoint.** The engine accepts `--token-factory-url` only for a loopback host, and Doctor names it as a
  test endpoint. The app passes it only from `--nivra-token-factory-url`, and only when unpackaged.
- **Downgrades.**
  - An older engine refuses a v2 home, saying why: it already refused any newer schema.
  - An older app can't read the newer `nivra.json`: its project records are strict, so `sharing` fails validation. It
    keeps the file aside as `nivra.json.unreadable-<time>` and starts with no projects and no preferences, so it never
    runs a project with consent on. The original stays in that file; nothing restores it automatically.

**Why.**
- The hackathon requires a runtime Token Factory call on an NVIDIA open model (D19). Explaining with evidence is D20's
  first step.
- Mastra persists workflow input and step output unmasked, and its default logger prints prompts. Standalone agents,
  steps that pass only ids and a silenced logger keep repository content and preference text out of `mastra.db` and the
  logs.
- One large result can overrun a budget that only a planning hook enforces. So each tool enforces it, one call at a
  time.
- A citation checked against what was delivered shows that the model saw those lines, not that the claim is right. The
  result says only the former.
- Working-tree edits are read, so the label is "HEAD at run start", never "describes commit X".
- Consent checked once is a race: an engine can take a while to start, and a run can wait in the queue. The epoch and
  cancel-on-revoke close the windows the host can see. The engine's own check covers a context that arrives without
  consent.
- Masking exact strings can't stop a model paraphrasing a preference, so the guarantee is stated as what is enforced.

**Consequences.**
- Every model call goes through `ModelClient`.
- `__registerPrimitives` and `watch` are Mastra internals, and so is the way Mastra calls its models, which the request
  count relies on. The stderr canaries and the stub tests catch an upgrade that changes them. Mastra's models keep
  private fields, so the proxy runs every method on the model itself.
- Mastra pauses 10 s after a step when `x-ratelimit-remaining-tokens` is below 2,000. The provider check reports when a
  key is that close.
- Adding a plain-text fallback, or forcing on another model, needs a new policy entry backed by a check.
- Folders on Windows drives and in WSL are read the same way, by git on their own target (D17). Hello still runs
  `git status`, unchanged here.
- An older Nivra on the same home or records degrades as described above, and never silently with consent on.
- AGENTS.md's "Mastra's 180-second limit" is corrected: each call has its own deadline.
- **Not handled yet:** a model that advertises a small context. The budget assumes at least 8,000 tokens for the
  request, plus 4,000 for the answer, so a model with an 8,192-token context would be overrun. Nemotron 3 Super's
  context is far larger. Respecting small contexts, or refusing them before any request, is a follow-up from the
  review.

## D23. Context assembly: task choices, five-rank precedence, a context view, and the preference lifecycle (2026-10-18)

**Decision.** NIV-11, with the parts of NIV-10 it needs. Nate set the precedence and the scope on 18 October.
- **Task choices.** An explain run carries up to five choices: each is trimmed, 1–300 characters, and unique. They rank
  first, apply to that run only, and are never saved to the profile. They are stored masked with the run's input, like
  the question, and never handed to Mastra.
- **Intent.** A project's own preference is a `default` or an `override`, a decision to change the project's existing
  conventions. A personal preference is always a default, and scope alone never makes an override. Snapshots carry
  intent, and the fingerprint covers it: `[id, scope, intent, revision, statement]`.
- **Precedence, highest first:**
  1. this task's choices;
  2. a project's decisions;
  3. the repository's existing conventions;
  4. a project's defaults;
  5. personal defaults.

  How it is applied:
  - **The model reports, and the engine ranks.** The model reports each conflict by topic and names its sources: the
    repository's convention with the lines that show it, preference ids, and choice ids. The engine ranks them
    (`explain/precedence.ts`), telling sources apart by kind and id, never by their words.
  - **Evidence first.** The repository counts only when at least one of its lines was shown to the model; otherwise its
    claim is reported as "not established".
  - **Ties.** Two different sources at the top rank are `unresolved`: shown, with nothing picked.
  - **Current versus intended.** What governs decides the task's intended work. "Currently" always shows what the code
    does: a choice or a decision is shown as intended, never as current behaviour.
  - **Repository text has no authority.** It can't add a choice, change an intent or name a winner.
  - **Permissions stay put.** Preferences never override permissions or data-sharing restrictions: a hidden file stays
    hidden, whoever asks for it.
  - **What the outcome claims, and no more:** it is deterministic given the conflicts the model reported. "None
    reported" doesn't mean none exist, and the model can split one topic in two.
- **The answer.** It replaces `preferenceDifferences` with `conflicts` and `suggestions`.
  - Both are flat and lenient: ids are plain strings, and citations default to none. Nivra refuses what can't be used,
    not the schema.
  - While the answer isn't due, an answer with unusable conflicts (ids the run doesn't have, or fewer than two sides) is
    turned down, at most twice. After that, or once it is due, those conflicts are dropped and counted.
  - A repository convention or a suggestion citing no lines at all is turned down like a citation of unshown lines,
    within the same two refusals, so an uncited convention can't quietly lose to a default. After that, or once the
    answer is due, the convention decides nothing and the suggestion is dropped.
  - Suggestions keep only the lines the model was shown, and one with none left is dropped.
  - The prompt asks for a suggestion for each convention the findings establish. Asked only to "propose" them, Nemotron 3
    Super gave none in live runs.
- **Stored input is read leniently.**
  - The store masks a run's input as one text, so a private-key block split across fields is masked too; the other
    patterns can't span fields. Masking can lengthen text or make two choices identical, so the read-back checks only
    the input's shape. A block spanning choices can leave fewer choices that still read; the result shows the choices
    as the run read them.
  - A mask that leaves the stored input unreadable makes it read as null. The run then fails before its workflow
    starts, so before any request and with no preference handoff recorded, with Nivra's own message, never a parser's.
    Every other run still lists.
- **The context view.**
  - **What each result records**, beside the sources:
    - the preferences received: kinds, revisions and the fingerprint;
    - the map's size;
    - hidden files by reason, as a lower bound past 20,000 files;
    - the request budget, and Nivra's estimate of what was in use by the end of the run;
    - results limited by the budget, and results replaced because they were too large;
    - whether the budget ran out, and why the answer was due;
    - refusals by cause, and what was dropped.
  - **Unknown, never zero:** each part is null in a result stored before it was recorded.
  - **The window** shows them in a panel that opens from "Context used".
- **The budget.**
  - Tool definitions are measured as Mastra sends them (zod's JSON Schema: draft 7, input side, closed objects). They
    measure 6,659 characters, against the 4,000 previously assumed.
  - `requestBudget` has no floor. A model whose context can't hold the instructions and the map, with room to read, is
    refused as `context-too-small` before any chat request.
  - Each list, search and read result says how many turns are left, and in the last two, to answer now.
- **Truthfulness fixes.**
  - The map's sources follow what was actually sent after it shrinks; a manifest that fails to parse isn't one.
  - A result too large to send is described as such, and delivers nothing.
  - A budget run-out is recorded however it happens.
- **Supersession.**
  - **Replace** makes a new decision: a new record (revision 1, the same scope and project, `supersedes`). The old one
    becomes `superseded`, kept as history that no run gets.
  - **Edit** fixes wording or intent, and is refused for a record that isn't in use.
  - **Deleting** a replacement leaves its history.
  - History counts towards the 50.
- **Keeping a suggestion.**
  - The person confirms wording for a suggestion from one of the project's explanations this session. It is saved as that
    project's own default, with `origin: suggested` and evidence: the run, the suggestion's place in its result, HEAD at
    run start, when the run finished, and only the lines shown to the model.
  - **Checks.** The host checks that the run belongs to the project, never by path, and checks again after reading the
    result.
  - **Saved once.** It saves once while the kept preference is in use, even on a double click. Once that preference is
    replaced or deleted, keeping it again saves it again.
  - **Deferred:** promotion to a personal preference ("Use in every project") stays pending in NIV-10.
- **This amends D21's "Nothing else creates one":** a preference is created only by the person confirming wording,
  whether typed, kept or imported.
- **Export and import.**
  - **An export** holds the confirmed preferences in the scopes the person chooses, by wording, scope and intent. Each
    source project appears once, under a key local to the file (`p1`, `p2`, …) with its label, so two projects with the
    same name stay two. There are no ids, folders, revisions, evidence or history, and never a statement holding the
    saved key; while a saved key can't be read, nothing is exported. Main writes it with mode `0600`, even over an
    existing file (on Windows the folder's permissions decide who can read it), and never leaves a temporary copy
    behind, even when the write fails part way. The format is version 2; the unreleased version 1 named projects by
    label alone.
  - **An import** is read only from a regular file of at most 256 KB, opened once and read at most one byte past that,
    then checked and previewed.
    - The file's personal preferences come in only if the person keeps them in.
    - Each source project's preferences go to the local project the person chooses, or are left out. A destination is
      suggested only when the label is unambiguous: one local project has it, and no other project in the file does.
      The person can change it. Otherwise the source starts left out, and the window says why.
    - The preview marks what would be skipped: what is already here, and what an earlier entry of the file already
      brings to the same place.
  - **Applying it** needs a choice for every source project in the file. It rechecks each destination, skips what is
    already here, applies the limit to the whole import, and adds the rest as confirmed, with `origin: imported`. What
    is left out reaches no project.
  - No message quotes the file or a path.
- **Compatibility and protocol 4.**
  - Every field added to a result or a preference record has a default. So results stored under protocol 3, and a
    `nivra.json` written by the previous version, still read.
  - An older app sets a newer `nivra.json` aside as `nivra.json.unreadable-<ms>`, never overwriting it.
  - The preload is now typechecked. The IPC handler requires the choices argument, so a caller that drops them fails
    instead of explaining without them.

**Why.**
- **D20 and NIV-11.** D20's demonstration needs an explicit override that changes nothing stored. NIV-11 needs
  precedence that comes out the same way every time, and a view of what a run was given and what was left out.
- **The engine applies the rule, not the model.** The model finds conflicts, but its words can't be trusted to apply a
  rule. The engine ranks from ids, so the outcome can't be argued by the model or the repository, and a mistake in
  attribution is visible in the window rather than silent.
- **Only shown lines count.** An unsupported claim about the code should decide nothing, so only lines the model was
  shown count as evidence.
- **Lenient schema, strict engine.** Whatever a schema refuses never reaches Nivra and costs an answer step. Checking in
  the engine lets an answer that is due keep what it can.
- **A label isn't an identity.** Two checkouts called `app` are common, so an export keeps its source projects apart,
  and an import never guesses where an ambiguous one goes. Personal preferences reach every project, so bringing them in
  is a choice of its own.
- **Live evidence.**
  - Checkpoint 1, on B: the decision governed, then the task choice did, while "Currently" kept B's convention and
    `nivra.json` stayed unchanged.
  - Checkpoint 2, on A: suggestions appeared only once they were asked for. A replaced preference stopped reaching
    later runs.
- **Nate's precedence.** Project scope alone isn't an override. Repository observations and suggestions never become
  decisions by themselves. Conflicts are visible, and explanations describe what the code does.

**Consequences.**
- Every caller of `runs.start` sends each snapshot record's intent; `rpc.ts` shows how.
- `submit_answer`'s schema and description changed, so the provider check probes the new schema. It was valid live on 18
  October.
- **Not handled yet:**
  - A suggestion from an earlier session can't be kept, because runs are remembered for the session only; the window
    says so.
  - A suggestion matching a preference already kept isn't marked.
  - When the answer is due, an unusable conflict is dropped whole, even if two of its sides were valid.
- D22's open consequence about small contexts is resolved.
- NIV-10 keeps promotion and its evidence rule open. Context packages for coding workers stay with the later milestone
  (D20).

## D24. Packaged acceptance, release candidates, judge access and the track (2026-10-19)

**Decision.**
- **Acceptance runs live, on the packaged builds of one candidate,** through an explicit script (`pnpm accept:live`),
  never part of `pnpm verify`.
  - It drives the installed deb, or the release zip extracted on Windows, through the UI, in profiles of its own.
  - The person types the key into the window; the script only waits until Settings says one is saved.
  - Each platform rehearses first without a key or a model.
- **Strict checks and required demonstrations.**
  - Strict checks cover what Nivra itself does: identity, the snapshot each run receives, isolation, ranking, final
    states and cleanup. Any failure fails acceptance.
  - What depends on the model is a required demonstration, with one targeted retry: a usable answer, citations shown to
    the model, the repository governing, a task choice governing. One still missing is incomplete, never a pass.
- **The person's data.**
  - Every Windows profile's WSL engine uses `~/.nivra` (D17), so a Windows→WSL session moves it aside with a recovery
    record, and puts it back.
  - Cleanup is always last. A restore never overwrites what it can't recognise.
  - An engine's store is read from a copy that includes its WAL.
- **Evidence.** A private record stays with the person. The public summary is built from listed fields only (B gives
  numbers), and checked for B's identifiers.
- **Release candidates.**
  - `pnpm release:candidate` builds from a clean tree after `pnpm verify`, staging once and building once. It writes
    `build-info.json` (commit, toolchain, runtimes and hashes) and `SHA256SUMS`.
  - A candidate is identified by its commit and hashes, and the version stays as it is.
  - The release publishes the accepted files unchanged. An app fix means a new candidate, and renewed evidence for what
    it touches.
- **Judge access:** Nate's existing Token Factory key, given only in the submission's private testing instructions.
  Nate chose this on 19 October over a second key.
  - It is kept working until judging ends (16 December, 04:00 SGT). Judges' use shares its quota and cost.
  - If it is exposed, it is replaced and the instructions are updated at once. Replacing it also changes Nate's own
    setup. The rules require free access, not one particular key.
  - This supersedes D20's "Judge access remains undecided".
- **The track:** Best Apps and Agents, chosen by Nate on 18 October from the official rules. The Coding track's "write,
  run, and test code" describes work D20 defers.
- **Keys are printable ASCII.** Settings refuses a key holding a space, a line break or any other character outside
  printable ASCII, saying why, and saves nothing.

**Why.**
- **Offline tests can't stand in.** The packaged checks never reach a model, and the dev build isn't what judges run.
  NIV-14 needs the journey live on what will ship.
- **Model variance.** It explains a missing result; it doesn't pass one. The runs showed both sides of this:
  - a first answer on A arrived without `findings`, and failed `malformed`;
  - on B, a convention cited a file the model hadn't read, so the personal default truthfully governed until the retry.
- **The key.** A key pasted with an invisible character inside can't go in a request header. Before the fix, the
  request failed before it was sent, and Nivra could only say something had failed.
- **Live evidence (18–19 October)**, from candidate `ead56e8`: every criterion passed on the Linux deb (16 runs) and on
  the Windows zip driving WSL (15 runs). The details are in `docs/acceptance.md`.

**Consequences.**
- `docs/acceptance.md` records the candidate, the machine, the fixtures, each platform's results, the earlier attempts
  and the commands. NIV-14's evidence comment links to them.
- **Native Windows** is outside the harness: checking its processes and reading its store would need Windows tools. It
  keeps its existing offline evidence, and a live native explanation is still to run.
- **Not handled yet:**
  - Quitting the Linux app while a held hello run is going takes about a minute; the final state is right.
  - A model's three forced answers without `findings` end the run `malformed`.
  - The engine doesn't log the detail of internal failures.

  Each is proposed as a follow-up.
- Clean-setup checks of the judge's path, and publishing the release, follow under NIV-16.
