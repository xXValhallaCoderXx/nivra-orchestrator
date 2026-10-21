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

## D25. The Visual C++ runtime beside the addon that imports it, and candidate 0.1.1 (2026-10-19)

**Decision.**
- **Where the DLLs go.** Staging copies each Visual C++ runtime DLL a native addon names into that addon's own folder,
  with the DLLs those name in turn, byte for byte from System32 (or `--vc-runtime-from`). Nothing goes next to
  `node.exe`, which links its C runtime statically. This supersedes D6's "shipped next to `node.exe`".
- **How it's checked.**
  - Staging fails if a DLL an addon names isn't in that addon's folder. The release candidate re-hashes every packaged
    runtime file and checks the placement again.
  - `verify:windows` checks that the native engine has loaded only the copy beside its addon, never an installed one.
  - It also runs a controlled check. In a copy of the runtime, the addon's import and the DLL beside it are renamed to a
    name no installation has. The engine must still start, run hello and write both stores. With the renamed DLL
    removed, it must refuse to start.
  - `verify:windows --zip` runs these on a candidate's packaged runtimes.
- **A new version.** A published version's files are never replaced, so the fixed candidate is 0.1.1. The engine stays
  at 0.1.0, since it didn't change. This amends D24's "the version stays as it is": the version changes when a
  candidate follows a published release.

**Why.**
- **Where Windows looks.** libsql's Windows addon imports `VCRUNTIME140.dll`. Node loads an addon with
  `LOAD_WITH_ALTERED_SEARCH_PATH`, which searches:
  1. the addon's folder;
  2. the system folders;
  3. the working directory;
  4. `Path`.

  It never searches `node.exe`'s folder, and the native engine runs in its home. So on a PC without the Redistributable,
  v0.1.0's native engine would stop at start.
- **Why no check caught it.** Every PC that ran the checks has the DLL in System32, which satisfied the import. A check
  that the DLL is somewhere in the runtime, or a run on such a PC, passes whatever the layout.
- **Shown by experiment, on this PC.** With the import renamed in a copy, v0.1.0's layout couldn't load the addon ("The
  specified module could not be found"), and the fixed layout loaded it. No PC without the Redistributable has run
  either yet.

**Consequences.**
- **What changed between the candidates:**
  - only the Windows runtime, `e47d01e4a355740f` → `d7b773e6d952ca65`;
  - the Linux runtime (`f0f3baa2aafb1925`) and the WSL tarball are byte-identical;
  - `app.asar` differs only in `package.json`'s version.
- **NIV-14's live evidence carries over** to 0.1.1's Linux deb and to its Windows zip driving WSL. No model was called
  again.
- **The affected checks ran again** on the packaged files of candidate 0.1.1 (`cad5eca`). The details are in
  `docs/acceptance.md`.
  - `verify:windows --zip`: 20/20. On v0.1.0's zip, the same checks give 18/20, failing exactly the two new ones.
  - `test:windows`: 6/6.
  - `test:packaged`: 16 passed. 5 were skipped, because they need the test endpoint switch, which a packaged app
    ignores.
- **v0.1.0 stays published, unchanged.** 0.1.1 goes beside it as a release of its own, never over it. It was published
  as a pre-release on 19 October, and v0.1.0's notes now say it is superseded.
- **The clean-machine test is still to run.** It needs a Windows PC or VM without the Redistributable, and this machine
  has neither Windows Sandbox nor Hyper-V.

## D26. The planning workspace: a workspace the host owns, conversation turns that are never resent, and native tasks with versioned briefs (2026-10-20)

**Decision.** This is checkpoint 1 of the stretch planned on 20 October. It covers NIV-30, and the engine and host
parts of NIV-31 and NIV-32. Nate set the scope and reviewed the plan twice. The window comes at checkpoint 2.

- **A workspace the host owns.**
  - **Where:** `workspace.db`, beside `nivra.json` in userData.
  - **What it holds:** conversations, with their messages and turns (run links); native tasks; and the versions of plans
    and briefs.
  - **How it's built:** with Node's own `node:sqlite`, so there is no addon (D6) and no new dependency.
  - **How it's opened:** like an engine's database.
    - WAL.
    - SQLite's exclusive lock, taken at once, so a second Nivra is refused rather than made to wait.
    - Foreign keys.
    - `secure_delete`.
  - **Opening never blocks startup.** A failure is held as state, and everything else keeps working. Failures are told
    apart by SQLite's primary result code or the errno code, never by their text.
    - **A damaged file** is the only thing ever moved. It is kept aside with its journal files, under one name.
    - **The header is checked before SQLite opens the file.** SQLite removes a stray WAL when it closes a connection to
      a file that isn't a database.
    - **A schema a newer Nivra wrote** is refused before anything is written, the journal mode included.
  - **This amends D7:** the host's records are no longer JSON only. `nivra.json` keeps the profile, the projects and the
    preferences. A transcript never goes there.
- **Conversations.**
  - **A general conversation** runs on `local`, this computer's own engine, and reaches no repository.
  - **A conversation about a project** keeps that project, its engine and its label, fixed when it starts. Choosing
    another project afterwards changes nothing about it.
  - **This amends D17:** the local engine also starts for a general conversation. There is still no target selector and
    no fallback between targets.
  - **What a turn is sent.** A general turn carries the confirmed personal preferences only (Nate's choice, 20 October).
    A turn about a project carries that project's snapshot, as before (D21). The engine refuses a general turn that was
    sent a project's own preference, before any request.
- **Protocol 5.**
  - **A `chat` workflow.**
    - A general turn makes one call, with no tools and no map.
    - A repository turn reads with explain's tools, under its consent, budget, citation checks and precedence (D22,
      D23). It replies through `submit_reply`, which keeps three things apart: evidence (lines read in this turn),
      proposals (never facts) and assumptions. Only the reply text is required; every list defaults to empty.
    - An empty reply fails as `malformed`, and one cut off by the length limit is labelled so.
  - **Each workflow has its own context.** Hello and explain keep `RunContext`. Chat carries `ChatContext`, which adds
    the history, held in the scheduler's memory only, like the snapshot (extending D21). A run records counts and a
    fingerprint of it, never its text.
  - **New methods and codes:**
    - `runs.find`, by request id;
    - `runs.reply`;
    - `RunNotFound`, a code of its own for a run that isn't in the store;
    - `EngineInfo.homeId`, an id stored once in each `nivra.db` by migration v3, which names the store as a path can't.
  - **Explain's tools are split** into shared read tools and one answer gate. Explain's behaviour is unchanged.
- **History, chosen by the host.**
  - **What can go:** answered exchanges only, and only those whose preferences are all unchanged. An answer given under
    a preference since edited, replaced or deleted could repeat what it said, so it stays out. That keeps D21's promise
    that an edit or a deletion reaches the next run.
  - **Limits:**
    - at most 10 exchanges and 24,000 characters;
    - a message over 6,000 characters keeps its first 4,500 and its last 1,000, with a marker saying how much was left
      out.
  - **Order:** the newest that fit are chosen, then sent oldest first. What was left out is counted, by reason.
  - **A repository answer** goes as "checked in that turn, not re-verified now", without its citations. In the prompt,
    the history is context, never evidence: lines seen only in an earlier turn don't count.
- **A turn is never resent.**
  - **Stored first.** The person's message and its turn are stored before anything is sent.
  - **The store is recorded before the request.** The engine's store (`homeId`) is recorded just before the request is
    written, so a turn without one was never sent.
  - **"Not sent" is claimed only when established:**
    - by an error known to come before writing (`EngineOfflineError`, or the client's own parameter check);
    - by the same store having no record of the request.
  - **Anything after writing is found by its request id.** That covers a timeout, a closed connection and an error
    answer, since the engine can start the run before its answer is validated. Whatever the search can't settle is
    unknown.
  - **How a turn ends:**
    - a graceful quit, a killed engine, or an engine's own cancellation: interrupted;
    - a cancel Nivra asked for: cancelled, keeping who asked (the person, sharing turned off, the project removed, the
      conversation deleted).
  - **Reading starts no engine.** Opening a conversation follows its open turns on their own engine.
  - **This amends D23's "runs are remembered for the session only"** for conversation turns. Explain-panel and hello
    runs stay session-only.
- **Model text in the host's workspace.** Answers are stored as the engine masked them, and masked again by the host.
  This amends D22's "stored only in the owning engine's `nivra.db`". They are still never stored in `mastra.db` or the
  logs.
- **One protection policy for everything stored (extends D8).**
  - **What the person types** is refused, never quietly changed, if it holds the saved key or a recognised credential.
    The message names the field and the kind of credential, never the value. The credential shapes are now shared by
    the host and the engine, in `packages/domain`.
  - **What engines and models produced** is masked again before it is stored.
- **Deletion.**
  1. Deleting a conversation stops its open turn first. When that fails, the conversation stays, and the person is told
     why.
  2. Then its messages, turns and plans are removed, overwritten in place, and the WAL is written back.
  - **What stays:** text copied into a task's brief stays with the task, and each engine keeps its own record of the
    runs.
- **Native tasks (NIV-32).**
  - **One structure.** A task written directly and one made from a plan version have the same brief:
    - goal and acceptance criteria;
    - scope and exclusions;
    - context, assumptions and checks;
    - a fixed execution policy: one at a time, network off, approval required;
    - sources;
    - what to write again.
  - **Versions are immutable.** A trigger refuses changes to a stored version. Each change is made only from the revision
    the person read.
  - **A newer plan version** is shown on the task, and taken into the brief only when asked.
  - **Moving a task to another repository** clears what came from another project's conversation, in a new version.
  - **States:**
    - `ready` needs a goal and an acceptance criterion;
    - `completed` is the person's acceptance of a ready task;
    - `active` and `review` come only from attempts, which can't start. The window says so in plain words, with no
      ticket numbers.
  - **Attempts.** An attempt is a run link bound to one brief version.

**Why.**
- **NIV-30's requirements.**
  - Conversations, tasks and run links must be durable.
  - `nivra.json` must not grow.
  - Routing must survive a restart, and no paid call may be replayed.

  A SQLite file the host owns does that with no dependency. Since only the host's own OS opens it, D7's cross-OS rule
  holds.
- **The plan's two reviews (20 October).**
  - Planning needs evidence, proposals and assumptions kept apart.
  - An error answer, a missing record or a search that finds nothing doesn't prove nothing ran.
  - Every stored field needs one policy.
  - A promise about deletion must match what stays.
  - The database had to be proven in packaged builds first.
- **General chat's target.** A general conversation has no folder to decide where it runs. The app's own OS is the only
  rule that needs no choice and no fallback.

**Consequences.**
- **Protocol 5.**
  - An app and its engines must match, and `initialize` refuses a mismatch.
  - The WSL runtime is staged afresh.
  - Older engines refuse a home that has reached schema v3.
- **The shared WSL home.** Every Windows profile's WSL engine uses `~/.nivra`. So a Windows check of this branch
  migrates the home the installed v0.1.1 also uses, and that version then refuses it until a release with schema v3
  ships.
  - This happened on 20 October. Migration v3 only adds the `meta` table, so dropping that table and setting
    `user_version` back to 2 restores the home for v0.1.1.
- **Evidence:** `docs/acceptance.md`, *Planning workspace, checkpoint 1*.
- **Deferred:** NIV-30's explicit source attachments go to NIV-33.
- **Coming at checkpoint 2:**
  - the window: side navigation, conversations, plans and tasks;
  - the rest of the IPC;
  - the end-to-end tests;
  - the live checks.
- **The Nebius Sandboxes probe** exists offline, in `apps/engine/src/exec/nebius/` with `pnpm probe:sandbox`. It isn't
  wired into the engine, and no backend claims anything from it. Its live run waits for approval. Its adopt-or-defer
  decision will be D28, superseding D19's "Sandboxes isn't available yet".

## D27. What the review of checkpoint 1 changed: seven corrections, and engine homes of their own for development and tests (2026-10-20)

**Decision.** A review of PR 4 (checkpoint 1, D26) found seven gaps. Each was reproduced against the code, fixed, and
given a test that fails without the fix.
1. **Sandbox recovery forgets nothing it may have started.** Every spawn whose intent is journaled and that isn't
   settled (by its answer, by being found, or by the service turning it down) is uncertain. Before, only an intent with
   a later "uncertain" entry was. So a probe that died between sending a spawn and its answer left compute running
   while cleanup reported nothing. A 4xx is journaled as refused: it created nothing.
2. **A deleted conversation's turn still has its run stopped.** Deleting stays immediate. A turn whose run isn't known
   yet keeps its request id in this session until its run is found and cancelled: one still being sent, or one whose
   answer was lost. Before, if the engine made the run and then answered `runs.start` with an error, nothing looked for
   the run any more. Memory is enough: only this session's engines can be running it, since an engine that stops ends
   its runs, and one that starts fails them as interrupted (D4).
3. **Each sandbox pattern is judged on its own evidence.** A pattern is adopted only if its own checks pass, and the
   two that hold for both: reattaching, and telling a timeout apart. Its own median step must also be within the
   threshold. Before, pattern A's checks and pattern B's timings were combined, so a quick, broken B and a slow A that
   passed gave "adopt". The decision now names the pattern.
4. **A damaged workspace a crashed session left is kept aside as it was found.** When a journal is beside
   `workspace.db`, it is read first through a read-only connection, which can't fold the journal in or remove it.
   Before, the writing connection found the damage, and closing it checkpointed the WAL into the damaged file and
   deleted it, while the notice said the journal files were kept.
5. **A task made from another project's plan takes none of that project's material.** Creating a task applies the
   rule for moving one: the sources, context and assumptions from another project's conversation are cleared and
   marked to be written again.
6. **A repository reply of spaces is turned down**, like an empty one. Text in `submit_reply` is trimmed before it is
   checked.
7. **A subprocess that isn't ready yet is polled, not failed.** HTTP 425 from the subprocess endpoint is "pending",
   and the client waits as long as `Retry-After` says, as the documentation asks. Once its own deadline is reached it
   makes no request and takes no answer, so a result shows the child ended within the limit. A second review, at
   `7155917`, found it still made one read at the deadline and took the answer.

And the WSL home is no longer shared:
- **A build has a channel**, set when it is built: development for `pnpm dev:win` (`electron-vite build --mode
  development`), release otherwise. An unpackaged app is always development. `app.isPackaged` can't tell them apart,
  since `pnpm dev:win` packages the app.
- **Each channel has its own engine homes.**
  - Release: `~/.nivra` in WSL and on Linux, and `%LOCALAPPDATA%\Nivra\engine` on Windows, as before.
  - Development: `~/.nivra-dev` in WSL and on Linux, and `%LOCALAPPDATA%\nivra-dev\engine` on Windows, however the
    build is started.
- **The home is passed through** probing (is this home's runtime there), provisioning (`<home>/runtime/<hash>`,
  pruned only there) and launching (`--home`).
- **A test run gets a WSL home of its own**, `~/.nivra-test/<kind>-<UTC>-<id>`: `--nivra-wsl-home` for the app,
  `--wsl-home` for the harness. Each run removes its own home at the end. One left by an interrupted run is removed
  once it is a day old.
- **The Windows checks prove it.** `verify:windows` and `test:windows` record what `~/.nivra` holds before they start:
  each database file's size, time and hash, and each runtime folder with its time. They fail if any of it changed.

**Why.**
- **The review's findings.** Each was a way to report something other than the true state, or to leave something
  running unseen. The acceptance suite forbids both.
- **The shared home.** On 20 October the branch's Windows checks migrated `~/.nivra/nivra.db` to schema v3, and the
  installed v0.1.1 refused its home (D26). Provisioning into that home could also prune the runtime the release runs
  from. The review asked for a permanent fix, with release, development and test homes, and a test that development
  and verification leave the release's database and runtime folder unchanged.

**Consequences.**
- **Supersedes** D26's consequence "the shared WSL home", and its restore procedure as a way of working: development
  and tests no longer touch the release's home.
- **Amends** D5 (a WSL runtime lives in its channel's home, `$HOME/<home>/runtime/<contentHash>/`) and D7 (development
  engines use `~/.nivra-dev` in WSL too).
- **Unchanged:** `accept:live` runs a release candidate, so it still uses `~/.nivra`, which it moves aside and puts
  back (D24).
- **Not covered:** a development build started without `--user-data-dir` still uses the release's user-data folder.
  `pnpm dev:win` always passes one.
- **Next:** the Nebius adopt-or-defer decision will be D28. D26, not merged yet, was corrected to say so.
- **Follow-up:** explain's own `submit_answer` still accepts a summary of spaces. Explain's behaviour stays unchanged in
  this stretch, so it is proposed separately.
- **Evidence:** `docs/acceptance.md`, *Planning workspace: the review of checkpoint 1*.

## D28. Nebius Sandboxes: one operation per step proved live and adopted for the adapter; a parent with subprocesses not yet (2026-10-20)

**Decision.** NIV-29's live probe ran on 20 October, in stages Nate approved one at a time, each with its data and
budget. It used a synthetic fixture, and made no model calls and no installs. Each pattern was judged on its own
evidence (D27), against thresholds agreed before it ran.
- **Pattern A, one operation per step, is adopted.** State moves between steps through the image each operation
  leaves. In the second stage 1 run, every critical check passed, and the median step took 2.9 s (adopting needs 10 s
  or less):
  - **Network denial, shown by behaviour.** Only `lo` existed. With networking off, `wget` of `http://example.com/`
    failed with "bad address", and of its IP with "Network unreachable". The positive control, the same URL with
    networking on, connected.
  - **Continuation.** A step saw the previous step's edit through its image.
  - **Cancel.** The operation reached `CANCELLED` 0.4 s after the cancel.
  - **Exit codes.** A failing test came back as `SUCCESS` with exit 1, and was told apart. So was a timeout: exit -1,
    signal 9, `timed_out`.
  - **The patch and the report** (105 and 19 bytes) came back from the image with the hashes the operation printed,
    holding the edit and the passing test.
  - **Reattaching.** A fresh client reattached from the journal to the same operation, with one spawn.
  - **A lost answer.** A spawn whose answer was thrown away on purpose was found by its correlation id, with one spawn.
- **Pattern B, a parent with subprocesses, is not adopted: inconclusive.** Its continuation, exit codes and patch
  passed, at 0.4 s a step. Two of its own critical checks showed nothing:
  - its network attempt ended with exit -1 after printing only its first line, so no attempt was seen refused;
  - after its parent was cancelled (in 0.4 s), the read of its running child failed, so the child wasn't seen to end.

  The probe kept neither the signal nor the read's error. It does now (`3e8bd4e`), so a later approved run can settle
  B.
- **Sandboxes access is active.** This supersedes D19's "Sandboxes isn't available yet". Stage 0 showed:
  - the key's permissions: `spawn`, `spawn_disposable`, `list`, `cancel`, `import` and `set_image_tag`;
  - its limits: a 3,600 s maximum timeout, and 50 instances at once;
  - public images, among them `alpine:3.20`, which stage 1 used.
- **Nothing is wired in yet.** The client stays in `apps/engine/src/exec/nebius/`, outside the engine's RPC, and no
  backend claims anything from it (D9).

**Why.**
- **The thresholds came first.** A pattern qualifies only on its own critical checks and its own median step.
- **The first stage 1 run found two client bugs, and stopped safely** (04:34 UTC, at `c3da9d4`).
  - The service reports `signal: -1` when no signal ended a command. The client read it as a signal, so every outcome
    was "signalled".
  - The time left before a deadline could be a fractional number of milliseconds, and Node's `AbortSignal.timeout`
    refuses one with a RangeError. Every read in step 7 failed, so the step stopped before its cancel. Steps 8 to 11
    were refused before spawning, since one operation runs at a time. Cleanup cancelled the open operation and saw it
    end; nothing was left unresolved.

  Both were fixed, with tests, in `8334299`. Read again with the fix, that run's stored outcomes pass pattern A's
  network, continuation, exit, patch and timeout checks. Cancel and reattaching didn't run, so it stays inconclusive.
- **The token check.** The service renews the token with each request: `token_expiration` sits about 5 minutes after
  each answer. The first guard read it once, and at 04:28 UTC refused stage 1 before any operation. It now takes two
  readings 15 s apart, and a token renewed between them is taken to last as long as the key (`c3da9d4`).
- **The budget, as approved.**
  - Stage 0: two reads, `whoami` and `images`.
  - Stage 1: at most 12 operations, one at a time. The first run made 7 and the second 11.
  - 642 bytes of synthetic files uploaded in each run, and at most 64 KB downloaded: 124 bytes in the first run, and
    248 in the second.
  - Stage 1 is stopped at 20 minutes, a hard limit, and cleanup then takes at most 7. The second run took about a
    minute.
- **Cost.** The service gave a cost for 9 of the second run's operations: from 0.0000465 to 0.0000828 each, 0.00059 in
  all. It doesn't say in what unit, so Nivra doesn't turn it into money.

**Consequences.**
- **NIV-34** (the workspace-to-patch adapter) can be planned on pattern A after the checkpoint review: each step its
  own operation, networking off, state carried by the image it leaves. Its backend claims only what its contract tests
  show (D9).
- **Local containers (NIV-37)** aren't needed as this adapter's alternative. They stay a later option.
- **Pattern B isn't used.** A later approved run of the probe, as it is now, can settle its two gaps.
- **The submission doesn't change** (D24): coding work is still deferred there.
- **The review of PR 5** found two gaps in the probe itself, fixed before it merged (`d3a0c62`). Neither touches the
  measurements, and pattern A's adoption stands.
  1. **An interruption didn't stop the work under way.** Ctrl+C only moved the deadline, which the polling loops had
     already taken. Requests went on after it, the remaining fixture files were still uploaded, and cleanup waited for
     all of it. Now one signal reaches every request, the reading of every answer, every retry's wait and every poll,
     and the loops read their cap afresh. A spawn cut off in flight stays uncertain, for cleanup to find. Cleanup has
     its own signal and budget.
  2. **The credentials check could pass a file inside the repository.** `repo/..private/key.env` passed as outside,
     by its prefix, and so did a link from outside to a file inside. Now both paths are compared as they really are,
     links followed, by whole components.
- **What stays on Nebius** from the two runs:
  - six uploads of the three fixture files;
  - the result images the steps left;
  - the operation records.

  Images are kept for 180 days, after which untagged ones may be deleted. No API deletes uploads or records.
- **Evidence:** `docs/acceptance.md`, *Nebius Sandboxes, live (D28, NIV-29)*. The evidence folders under
  `~/nivra-acceptance/` hold the journals, results and reports, with the key and project id replaced.

## D29. An answer without findings is asked for them once and labelled; only Nivra's own words leave the engine, with one safe diagnostic per failure (2026-10-20)

**Decision.**
- **NIV-26: a missing `findings` costs at most one refusal.**
  - `findings` defaults to none. An answer that leaves it out now reaches the gate. Before, the schema refused it, and
    the whole answer was lost.
  - The gate asks for findings once, with the shape a finding takes. `MAX_FINDINGS_REFUSALS = 1` is the visible bound.
  - **It asks only while another answer fits** (`canAnswerAgain`):
    - a step is left;
    - the answer isn't due because of the time or the budget;
    - once the answer is due, the model is one known to honour a forced answer.

    A run allowed one call never makes a repair request.
  - This departs from D23's "refuse only when the answer isn't due". The answer steps are kept so that a turned-down
    answer can be given again, and an answer with nothing established is worth one of them.
  - The next answer is taken as it is. Nothing is made up to fill it.
- **An answer's standing is recorded and shown.**
  - The standings:
    - `established`: a finding cites lines the model was shown;
    - `unsupported`: there are findings, but none cites such lines;
    - `no-findings`.
  - The window never shows the last two as a green "succeeded". A yellow label says what they are, and the status
    badge says "no findings" or "not supported".
  - The run itself succeeds, so the standing is what a reader must check.
- **What refusals cost is recorded:** the steps of the answers turned down, their tokens as reported (null once one
  didn't say) and their time. A run that ends `malformed` names its refusals by cause.
- **The summary and each finding are trimmed,** which settles D27's follow-up.
- **Protocol 6.** The explain result gains fields with defaults, as at protocol 4, so a host and an engine that don't
  match are refused at `initialize`, never part-way through reading a result.
- **NIV-27: only Nivra's own words leave the engine.** That means RPC errors, stored failures, step events, logs and
  `mastra.db`.
  - **The words** come from Nivra's own messages, chosen by safe codes.
  - **They are filled only with safe values:** numbers, codes, platform names, the git subcommands Nivra runs, and a
    repository-relative path the model itself asked for.
  - **Never:** an error's own message, a command's stderr, a spawn error's text, or an absolute path.
  - **Allowlisting an error's class doesn't make its message safe.**
    - `RepoError` now has codes, and its messages carry neither git's stderr nor the project's path.
    - An execution boundary's errors (`ExecRefusedError`, `BoundaryUnavailableError`, which are Track B's) become
      fixed refusals at Track A's own boundary. A note on NIV-41 proposes codes for them.
  - **One guard on every workflow step.** Anything a step throws that isn't a failure Nivra wrote becomes `internal`,
    named at most by an allowlisted class, with its facts.
- **One diagnostic per failure.**
  - A failed run, a failed request or a crash writes one line to the engine's log: `diagnostic {json}`, at most 1,000
    characters.
  - The line holds:
    - a code from a closed list;
    - the stage;
    - the run, request, workflow, step or RPC id;
    - safe counts;
    - the error's facts: up to four allowlisted classes, a known errno, how deep its causes go, and its message's
      length, never its words.
  - The launcher replaces Node's own report of an uncaught error with a diagnostic, and an `engine.fatal` `crashed` in
    Nivra's words.
- **The contract for others.** `apps/engine/src/diagnostics.ts` imports neither Mastra nor the model client.
  - NIV-38 uses it for the review's failures.
  - Track B can use its codes with stages of its own.

**Why.**
- **NIV-26's two cases are different.**
  - D24's live run lost three forced answers (1.8k–2.8k output tokens each) to the schema, then ended `malformed`
    after 16 steps.
  - The rehearsal's first answer (20 October) had no findings at all, and showed as a plain success.
  - Defaulting the list fixes the first and lets the gate see the second. The label keeps both honest.
- **One refusal, not three.** A model that left `findings` out three times in a row wasn't going to give them on a
  fourth try. The bound turns a costly loop into one step, and the step's cost is recorded.
- **Masking known keys isn't enough.**
  - NIV-27's reproduction, a key holding a newline, is masked only because the key is known.
  - Git's stderr, a spawn error's path, or a provider's text can hold anything private, and nothing recognises it.
  - The only safe course is to never carry the words.
- **A diagnostic says enough to act on.** The provider check that once failed with "(TypeError)" and an empty log now
  leaves a line naming the stage (`models.list`), the request and the error's class.

**Consequences.**
- **Amends D22:** "named by its class only" now means an allowlisted class only. Any other reads as unknown.
- **Supersedes NIV-27's original proposal,** to log an error's name and message after `vault.mask`.
- **A repair costs one extra step at most,** against three refused answers before. In D24's run a step averaged about
  11,700 input tokens, and each refused answer had cost 1.8k–2.8k output tokens.
- **Still not covered: startup failures before `initialize`.**
  - Their text can carry an error's words: the `engine.fatal` text for a home that can't be opened, or a runtime that
    can't load, and the supervisor's log tail.
  - At that point no key or repository is held.
  - So can Mastra's own validation errors about step data, which is ids and counts only.
- **Every failed run now writes a diagnostic line,** expected kinds included.
- **Older engines.** An engine before protocol 6 can't read results stored after it, so development and test homes are
  per track (`~/.nivra-dev-track-a`, `~/.nivra-dev-track-b`).
- **`findings` is no longer required** in the schema the model sees. The description and the one refusal make up for
  it. A3's live runs will show how often an answer comes without findings.
- **Evidence:** `docs/acceptance.md`, *Answer reliability and safe diagnostics (D29, NIV-26, NIV-27)*.

## D30. Plan review: two independent reviewers and a chair within one reserved budget, bound to the plan version; and an estimated input budget for every run that reads a repository (2026-10-20)

**Decision.**
- **The review contract** (`packages/domain/src/review.ts`) was recorded before the runtime.
  - **What a review run takes:**
    - a saved plan's id and version;
    - a panel;
    - two fingerprints: the packet's and the preferences'.
  - **What travels in the run's context,** held in memory (D21):
    - the packet: the plan's text, its assumptions, its historical references and its scope;
    - the preferences.

    No path or project id is in it (D17).
  - **The packet's fingerprint.** `packetDigest` is a versioned, fixed-order SHA-256 that both sides work out, pinned
    by a test vector. The engine checks both fingerprints before any request.
  - **The panel** is `council`, which the window offers, or `single`: one reviewer covering both briefs, the baseline
    A3 compares the council with.
  - **The report is self-contained and bounded.** It holds:
    - what it was bound to;
    - findings with ids the engine gives;
    - each finding's basis: `plan` or `assumption`, read from its references. A historical reference is an address
      and never makes evidence;
    - the chair's agreements and dissent, by finding id and the reviewers behind them;
    - `unaddressed`: the findings the chair named nowhere;
    - each stage's own outcome;
    - usage as reported;
    - a budget record that keeps the hard limits apart from the estimate.

    Its outcome says how complete it is, never whether the plan is sound: there is no verdict field.
  - **Elsewhere in the protocol:** protocol 7; `runs.review`; the kind `budget-exhausted`; the due reason `run-budget`.
- **The run.**
  - **Two fixed roles:** architecture, feasibility and scope; and risks, failure behaviour and testability. Both read
    the same message, byte for byte, and neither sees the other's report. The chair gets the packet and both reports.
  - **At most three requests:** one per reviewer, one for the chair. No repair call, no retry, no tool loop.
  - **A reviewer whose answer can't be used** fails its stage as `malformed`: a reply in text, a schema refusal, an
    empty review, or an answer cut off. A review with no findings and a summary is a valid "no material issues"
    review. The chair runs only when both reports are in.
  - **The reviewers settle on their own** (`Promise.allSettled`): a fast failure neither ends the run nor stops the
    other.
  - **Saving.** The report is saved at the start, after every stage, and at the end. If a run ended while its report
    was mid-review, it reads as interrupted, and a request that was out "may have been sent".
  - **A review that doesn't complete** fails the run with the failing stage's kind and stage, and its report is kept.
  - **Refusals before any request keep no report:** no consent, no key, no model, a request window too small, or a
    budget too small.
  - **A review reaches no repository and changes nothing:** its workflow has no backend, no git and no path.
  - **A request id reused with other input is refused.** The same input returns the same run.
- **Hard limits and estimated budgets** (`providers/run-budget.ts`).

| | Council run | Single run | Explain, repository chat |
|---|---|---|---|
| **Hard:** requests | 3 (two reviewers together, then the chair) | 1 | 16, unchanged |
| **Hard:** time, monotonic; a request is aborted at its deadline | 150 s per request, 330 s per run | 150 s, 180 s | 150 s per request, 480 s per run, unchanged |
| **Hard:** output, sent with every request | 4,000 per request | 4,000 | 4,000 per request, unchanged |
| **Estimated admission budget:** input per run | 120,000 tokens | 60,000 | **160,000, new** |
| Estimated input per request, as before | at most 60,000 | at most 60,000 | unchanged |

  - **What is estimated is the whole request:** instructions, message, every tool definition, and an allowance per
    message, at characters ÷ 3.
  - **A tokenizer can count more,** so the budget decides what is admitted and promises no ceiling.
    - Reported counts replace estimates.
    - An overrun is recorded.
    - Unknown usage stays null.
    - No currency is computed.
  - **Reservations are all or nothing:** both reviewers, and the chair at its largest (the packet and two reports of
    the largest size the engine keeps). A held reservation is honoured.
  - **Explain and a repository turn.**
    - The answer comes due once another request, and a full-window answer after it, would no longer fit.
    - A request that can't be admitted is never sent, and the run ends `budget-exhausted`.
    - The window's context view says what was counted, what was reported, and that the estimate is no ceiling.

**Why.**
- **Nothing bounded a run's total.** A live repository turn sent 219,488 input tokens over 14 calls (checkpoint 2),
  because each call re-sends what was read so far.
- **An estimate can't be a ceiling.**
  - Characters ÷ 3 can undercount, and concurrent requests overrun before they report.
  - The honest form is to call it a budget and record its overruns. The hard limits stay hard.
- **A reviewer's failure must not cost the other's work,** nor leave it writing after the run has ended.
- **The chair is reserved at its largest,** so it still fits however long the reports are.
- **The single panel is in the contract from the start.** A3 must compare the same packet through the same runtime,
  and may not change shared code once A2 has merged.

**Consequences.**
- **The numbers:**
  - **The largest realistic packet** comes to about 31,900 tokens per reviewer and 45,500 for the chair: 109,300 of
    the council's 120,000. That is every packet limit filled, with 80-character paths and 50 preferences of 500
    characters.
  - **A typical small plan** comes to about 2,000 tokens per reviewer, with 15,700 reserved for the chair.
  - **A packet with absurdly long paths** is refused before any request.
- **Explain and repository chat:** the heaviest explain run seen (77,514 tokens) is unchanged. The 219,488-token turn
  would have answered at about 100,000.
- **A low-tier key** can draw a 429 on two requests at once. The review is then incomplete, and never retried.
- **Older engines** can't read reviews, so development homes are per track.
- **No reference is re-read** at the current HEAD: every reference stays historical.
- **The host's copy.** A2 keeps reports in the plan's conversation. The engine's copy stays in its store.
- **Evidence:** `docs/acceptance.md`, *Plan review runtime and run budgets (D30, NIV-38)*.

## D31. Reviews of saved plans in the window: run links with a frozen binding in workspace v2, started only as previewed, never read as approval (2026-10-21)

**Decision.**
- **Storage: workspace.db v2.** It is `WORKSPACE_MIGRATIONS[1]`, appended; v1's text is pinned by its hash.
  - **A review is a run link** with `workflow_id = 'review'`, plus a `reviews` row holding:
    - the plan version it names: artifact id, lineage, version and sha256;
    - the panel, and the packet's and the preferences' fingerprints;
    - the frozen scope: general, or the project's id, label and HEAD;
    - the report, once it ends.
  - **Plans stay in `artifacts`.** A review references a version and never copies it. The packet's text isn't kept;
    its fingerprint is.
  - **Triggers:**
    - `reviews_bound` refuses a review that isn't bound to a review run and to a plan version of its own conversation;
    - `reviews_frozen` refuses any change to what a review was bound to, and a second report;
    - `run_links_fixed` keeps a run link's workflow and owner.
  - **Every stop path sees reviews.** `turnsOf` reads chat links only, as before. `openTurns` sees reviews too, so a
    cancel, a deletion, sharing turned off and a project removed stop them as they stop turns.
  - **One open run per conversation,** turns and reviews together. This amends D26.
- **The preview is bound to what is sent.**
  - **`reviews:prepare`** builds what one plan version would send:
    - the packet: the text; the assumptions, masked again; each historical reference once, in the order cited;
    - the preference snapshot (D21): a general plan's gets the personal preferences only.

    It returns what is sent, and `expected`: a SHA-256 of the plan's id and version, both fingerprints, the project's
    sharing and the panel.
  - **`reviews:start`** works all of it out again. When the fingerprint differs, it refuses ("What this review would
    send has changed since you opened it. Check the new preview, then start again."), and the window shows the new
    preview.
  - **Consent is checked as for a turn:** shown at preview, checked at start, again after that wait against the
    consent epoch, and by `#submit`'s late check once the request is out. The fingerprint adds to these checks and
    replaces none.
  - **Refused before anything is stored:**
    - a version whose text holds the saved key or a recognised credential: "Edit the plan to remove it, then review
      the new version";
    - a version over a review's limits, in words that name the limit.
- **The lifecycle is a turn's** (D26). A review is stored first, sent through the same `#submit`, followed by the same
  `#follow`, and never resent. `#finish` hands a review's end to `#finishReview`:
  - **The report is kept only when it repeats the review's binding:** the plan's id and version, both fingerprints,
    the panel, the request id and the run id. Otherwise the review's end is `unknown`, and nothing of the report is
    kept.
  - **It is masked again and kept once.** A complete report ends the review as answered. A partial one is kept with
    how it ended: cancelled, interrupted, or failed with its kind.
- **The window** (`features/reviews.tsx`).
  - **Review…** on each plan card opens a dialog for any version. It shows what is sent and what isn't, each
    preference with its meaning (a default, or a project's decision), and the most model calls. A project that
    doesn't allow sharing asks for its consent there.
  - **Each review keeps a card under its plan:**
    - each stage's outcome;
    - each reviewer's findings, with their basis ("From the plan" or "Assumption"), and historical references marked
      as such;
    - the chair's agreements ("Agreement isn't proof"), dissent, gaps and unaddressed findings;
    - usage as reported, and the run budget;
    - "The plan is now at vN" once the plan moves on.
  - **Nothing reads as approval:**
    - "Complete" isn't green;
    - a reviewer who raised nothing says so: "That isn't an approval: it saw only the plan";
    - every card says the review doesn't change the plan, mark a task ready or approve anything.
  - **The window offers the council only.**
  - **A running review holds the composer** as an answer does.
- **Consent copy names reviews** wherever consent is asked: explanations, conversations and reviews.

**Why.**
- **`run_links` already owns an attempt's lifecycle:** its reconciliation and every stop path. A second lifecycle would
  need its own. A table beside it keeps the binding immutable, and nothing is rebuilt: `workflow_id` has no CHECK.
- **A preview that isn't bound can show one thing and send another.** A preference, the consent or the plan can change
  while the dialog is open (the review of this plan).
- **An engine's report belongs to the review only when it says so.** The binding check turns a foreign or mismatched
  report into an unknown end instead of a kept one.
- **A review reads like an approval all too easily.** The copy and the colours say how complete a review is, never
  whether the plan is sound.

**Consequences.**
- **Older builds refuse a v2 profile** ("saved by a newer version of Nivra"). A v1 profile moves to v2 row for row.
- **The next migration is `[2]`.**
- **When a conversation is deleted,** each engine keeps its own run records: ids, version and fingerprints, but no
  plan text; count-only events; and the masked report, which can quote the plan. The delete dialog says so.
- **Reviews never write** plans, tasks, briefs or preferences. A task can be ready without one.
- **Packaged and Windows checks seed a plan** through the workspace's own functions. On Windows the staged `node.exe`
  runs them bundled, so the file is only ever opened on Windows (D7).
- **Shared files.** Once this merges, the shared files Track A held pass to Track B, with a handoff on NIV-39.
- **Evidence:** `docs/acceptance.md`, *Plan reviews in the window (D31, NIV-39)*.

## D32. The council against one reviewer, on five synthetic plans: adopt by the frozen rule, at its edge (2026-10-21)

**Decision.**
- **The outcome is adopt.** The rule was frozen before any paid call, and every adopt rule held, so the window keeps
  the council of D30 and D31 (two independent reviewers, then a chair) as its review of a saved plan. The single
  panel stays the contract's baseline, and the window doesn't offer it.
- **It is evidence from five short synthetic plans,** with one run per arm. It is not a general claim that a council
  reviews better than one reviewer. It authorises no expansion: no more reviewers, rounds or roles, and no redesign.
- **The labels are v1.** They were proposed with AI assistance, then reviewed and approved by Nate before the arm
  mapping was revealed. A later correction keeps v1 and makes a documented v2 that says whether the decision changes.

**The batch** (approved digest `c3b9225a…`, revision `196cad1`, 21 October 2026).
- **Runs:** 10, all complete, with 20 requests. Nothing was retried or retaken, and no stop rule fired. The checks
  made before any inference request passed before every run.
- **Usage:** 31,771 input and 11,750 output tokens, all reported. The runs took about 1.6 minutes in all.

| | Single reviewer | Council |
|---|---|---|
| Known defects found, of 12 on F1–F4 | 9 | 11 |
| Useful novel findings, distinct | 8 | 9 |
| Unsupported findings | 0 | 1 (U1) |
| False alarms on the control | 0 | 0 |
| The control reviewed as sound, substantively | yes | yes |
| Complete runs | 5 of 5 | 5 of 5 |
| Findings raised | 17 | 35, of which 15 repeat another |
| Actionable findings | all | all |
| Median latency, against the single reviewer's | | 1.90× |
| Median tokens, against the single reviewer's | | 3.35× |

- **By fixture:**
  - **F1:** the council found all 3 known defects, the single reviewer 1.
  - **F2:** 2 each. Neither was credited with the provider-timeout defect.
  - **F3 and F4:** all 3 each.
  - **F5, the control:** neither raised a finding.

**Why.**
- **The rule decides, as frozen.** Every adopt rule held, and no defer rule did.
- **Three adopt rules held exactly at their edge:**
  - known defects, 2 above (adopt needs 2);
  - known defects plus useful novel findings, 3 above (needs 3);
  - unsupported findings, 1 above (allows 1).

  One label different on any of them would have made it simplify.
- **The known-defect margin comes from one fixture,** F1.

**Consequences.**
- **Nothing changes in the window,** which already offers the council. The council costs about 1.9 times the time and
  3.4 times the tokens of one reviewer here. It gives twice the findings to read, 15 of which repeat
  another, and agreement between reviewers earns nothing.
- **What the evidence doesn't show:**
  - **Variance:** one run per arm on five short plans (365–692 characters). Sampling is the provider's default, so a
    rerun can differ.
  - **Labels:** proposed with AI assistance, then reviewed by one person. The protocol named Nate as the labeller.
    There is no second labeller, so agreement between labellers is unmeasured, and what the assistant saw beyond the
    sheet isn't recorded. The arm mapping was never written down: it was rebuilt only at scoring, after v1's hash was
    recorded.
  - **The automatic pass:** it agreed with the labels on 40 of 52 findings. By the automatic reading alone, the
    known-defect margin is 1 (single 10, council 11). The single reviewer's F2 finding matched the provider-timeout
    stems, but was labelled as not naming that defect.
  - **Actionability** didn't discriminate: every finding was labelled actionable.
  - **The authoring:** the fixtures and the rubric were written by the agent that built the council, before any run.
  - **The chair's synthesis** isn't scored.
  - **The setting:** one model (Nemotron 3 Super), one provider, one day.
- **Hashes**, of files in the evidence folder:
  - the labelled sheet, v1: `a899ab9a…5c95`;
  - the sheet the batch wrote: `479d7f3f…eb8a`;
  - the scores: `f945c5e2…62d9`;
  - the decision: `c72c3bbe…b5f1`.
- **Evidence:** `docs/acceptance.md`, *Council evaluation (D32, NIV-40)*, and
  `~/nivra-acceptance/council-eval-20261020T202836Z-196cad1/`.

## D33. The Nebius execution session: one operation per step behind the execution contract, every request inside its deadline, and the state moving only on what was kept (2026-10-20)

**Decision.** This is B1 of Track B (NIV-41, part of NIV-34). It promotes D28's pattern A into the engine's execution
contract. Nothing is wired into the engine or the app yet: that is B4 (NIV-44).

- **The contract (D9), extended as little as B2 to B4 need.**
  - **Sessions.** `SessionSpec` gains four optional fields:
    - `requires.isolatesFilesystem`;
    - a `snapshot`: one tar, its sha256, and the digest of what it gives once extracted;
    - `budgetMs`;
    - a `signal`.

    `checkRequirements` refuses a boundary the backend doesn't claim before anything is sent. `Local` refuses
    isolation, a snapshot and a command thrown away, so coding work can never fall back to it. This replaces the
    separate `SandboxBackend` type that `system-architecture.md` §11.2 planned.
  - **Commands.** `ExecRequest` gains `persist`, an engine-chosen `label`, `stdin` and byte output. Only `Local` offers
    the last two, for the engine's own git, which AGENTS.md routes through a session.
  - **Results.** `ExecResult` gains `persisted`. It still carries no provider id, so routing can't reach a model prompt.
  - **Download and close.** `ExecutionSession` gains a bounded `download`. `close` takes an optional signal and budget,
    and resolves to a `CloseReport`:
    - each step's record;
    - what was stopped, and what had already ended;
    - what stays unresolved;
    - what the provider keeps.

    It never rejects, and a second call gives the same report.
  - **New errors:**
    - `ExecUncertainError`: it isn't known whether a command started, and it is never sent again;
    - `SessionOpenError`: an open that failed after something was sent; it carries its cleanup's report.
  - D9's `runMain` isn't added: the worker runs in the engine (§11.1).
- **Every request ends by its caller's deadline, writes included.** This answers the P3 the final review of PR 5
  accepted. At `dc48874`, with 1 ms left under the probe's cap, the spawn's POST and the cancel's DELETE were sent with
  30,000 ms each.
  - **The deadline.** Every public `SandboxApi` method requires `until`. A request's timeout is the smaller of its
    limit and the whole milliseconds left.
  - **"Not sent".** A write needs `minWriteMs` (2 s) left. With less, or once cancelled, nothing is handed to the
    transport, and `SandboxNotSentError` says so. That is the only case in which "not sent" is established.
  - **Late answers.** An answer that comes after the deadline or the cancellation is never taken as a result. A late
    spawn answer gets an error of its own (`SandboxLateSpawnError`), whatever the signal says. It is journaled, so
    cleanup can stop that operation, and it is never reported as "not started".
  - **Bounded answers.** Answers are bounded as they stream, and one over its cap isn't asked for again. A retry waits
    at least 250 ms.
  - **Supersedes D28's** "Stage 1 is stopped at 20 minutes, a hard limit". That held for reads and waits, but not for
    an upload, spawn or cancel begun just before the cap, which kept its own 30 s. It holds for them now. D28 isn't
    edited.
- **The journal.**
  - Each line is flushed before its request.
  - A last line torn by a crash is left out, and its spawn stays uncertain. The next entry cuts that line off first, so
    it never turns into damage.
  - A session that closes with nothing open moves its journal into `settled/`. It is kept, as the record of what was
    sent.
  - It also records:
    - a spawn its client refused to send, as not sent;
    - each cancel's answer;
    - every image an operation reports;
    - each upload.
- **The session** (`exec/nebius/session.ts`, `createNebiusBackend`).
  - **What it claims:**
    - `isolatesFilesystem`;
    - an on/off network;
    - no injected credentials;
    - files kept between persisted commands.

    CPU and memory limits aren't claimed. Every operation runs with networking off. A session that asks for network
    access is refused, never run with it.
  - **Open.**
    1. It journals the session, then uploads the snapshot once.
    2. It runs one prepare operation: a fixed script, given everything as arguments. The script extracts the archive
       outside the workspace and prints a digest of a canonical listing of what it holds (`listingDigest`).
    3. That digest must match the snapshot's.

    Once anything was sent, a failure closes the session.
  - **Commands.** One owned operation at a time, from the current image. Its environment is the command's own, plus a
    correlation id. Refused before dispatch:
    - a relative program, or a folder outside the workspace;
    - the key or project id anywhere in the request;
    - input or byte output;
    - a timeout over the cap or past the deadline;
    - more operations than a session may start.
  - **The state moves on only when a persisted command ended on its own,** with SUCCESS and an image Nivra can use.
    Otherwise the session is stale, and the next command and any download are refused. A 404 or 410 from a state image
    means the state is lost. Nothing is recreated from the snapshot.
  - **Lost answers.** A lost spawn answer is looked for by its correlation id. Not found, the session is unsettled
    until it is closed.
  - **Cancels.** An abort stops the operation on a client of its own, and `cancelled` is claimed only once CANCELLED
    is seen.
  - **Close** has one budget that includes stopping the command under way, however that stop began.
    - Its deadline and its signal each cut off a request still under way, a cancel sent before closing began
      included. What that leaves open stays journaled.
    - It reconciles, then cancels only the session's own operations, then searches again.
    - "Stopped" means CANCELLED after an accepted cancel.
  - **Recovery.**
    - `scanJournals` is local only. It reads the journals left in place, which are the few that may need something,
      and says how many it couldn't read.
    - `reconcileJournals` makes one bounded pass. A pass that runs out of time, or is stopped, leaves the rest for the
      next, and a journal it can't read never stops the others.
    - **Age never settles an operation.** One still queued long after its timeout stays unresolved until a terminal
      status, or a verified expiry guarantee from the provider, settles it.
  - **Retention** is counted from the journal: every image an operation reports is journaled where its end is seen.
  - **Limits** (defaults, all configurable):
    - 40 operations a session;
    - commands up to 600 s;
    - an 8 MiB upload, and 16 MiB downloads;
    - 64 KiB of output a stream;
    - a 30-minute session;
    - a 7-minute close.

**Why.**
- **NIV-41 and the review.** NIV-41 asks for these behaviours. The P3 showed the hard limit was weaker than its wording.
- **SUCCESS isn't enough.** Live, a timeout came back as SUCCESS, with exit -1 and signal 9 (D28). So SUCCESS alone
  doesn't say a command's changes are what it meant to leave.
- **Nate's review of the plan (20 October)** asked for:
  - a test of a persisted command with no usable image;
  - recovery that fits the engine's lifecycle;
  - no operation retired for its age.
- **An approval is not a boundary (D9).** Asking the one contract for isolation keeps `Local` out of coding work, without
  a second framework.
- **An independent review of the first draft (`fc82fa1`)** found six gaps. Each was reproduced against that commit,
  then fixed with a regression test in `0505da3`:
  1. a stop begun before closing ignored closing's budget and signal;
  2. a torn journal tail became damage once the next entry was written, and one damaged journal stopped the whole
     recovery pass;
  3. the scan's limit came before its filter, so open work could be missed;
  4. images first seen by cleanup weren't counted;
  5. a command made as its run was cancelled was reported "not started";
  6. a listener stayed on a long-lived run signal.
- **The review of PR 7 (21 October)** found one more. A stop's cancel request, sent before closing began, kept the time
  it was given then, up to 30 s: in its reproduction, a close given 50 ms took 424 ms. Closing's deadline now cuts that
  request off, as its signal did (`5597249`).

**Consequences.**
- **What comes next.**
  - **B2** builds the snapshot (the tar, its manifest and `listingDigest`), the collect step and the patch.
  - **B3** runs the prescribed path offline, then one approved live recipe.
  - **B4** wires it in:
    - journals under `<home>/sandbox/`;
    - `scanJournals` at engine start;
    - one background pass once credentials arrive;
    - the project id, as a secret.
- **Unverified until B3's live run:**
  - that busybox runs the prepare script as this machine's `sh` and GNU tools do;
  - the service's answer for an expired image (404 or 410 assumed);
  - the upload API's size limit.
- **Unchanged:** the probe's evidence and D28's measurements. The probe keeps its own steps and gains the same deadlines.
- **Evidence:** `docs/acceptance.md`, *Nebius execution session, B1 (D33, NIV-41)*.

## D34. Commit snapshots and validated patches: one commit's own bytes in, a checked patch out, bound to where it may go by one hash (2026-10-21)

**Decision.** This is B2 of Track B (NIV-42, part of NIV-34). It builds what goes into a sandbox and what comes back,
offline. Nothing is wired into the engine or the app yet (B4, NIV-44), and nothing writes a checkout: applying a patch
is NIV-8's.

- **The engine's own git** (`exec/git-tool.ts`) runs through a `Local` session on the target that owns the checkout,
  with input and byte output, D22's pins, and remotes, lazy fetches and replace refs switched off.
- **The snapshot** (`exec/snapshot.ts`).
  - **From the commit, never the working tree.** `ls-tree -r -z -l` lists the picked folder's subtree at HEAD, and
    `cat-file --batch` gives its exact bytes, with no filters and no line-ending conversion. The baseline is HEAD as a
    full id, SHA-1 or SHA-256. A baseline the caller gives must equal it.
  - **Refused:**
    - a repository with no commits;
    - a partial clone, since a missing object would be fetched;
    - git older than 2.18;
    - a crafted path among the files to send: `..`, `.git` in any case, short name or alias (trailing dots or spaces,
      a stream after a colon), a control or invisible character;
    - a path that isn't valid UTF-8, and a picked folder whose own path breaks the same rules. Paths are read as
      bytes: decoded any other way, they would be renamed on the way, or cut at a newline;
    - a folder with nothing to send;
    - anything over the limits, never truncated: 4,000 files, 2 MiB a file, 6 MiB in all, an 8 MiB archive.
  - **Uncommitted work.** Tracked changes in the picked folder, staged or not, refuse the snapshot: "Your checkout has
    uncommitted changes in N files. Nivra works from a commit. Commit or stash them, then try again." So do files git
    is told not to look at (assume-unchanged, skip-worktree), whose changes it can't see. Untracked files are counted
    and named, and never sent. Nothing is staged, stashed or discarded.
  - **The check is one `git status`,** with every filter driver the configuration names switched off (an empty
    `clean`, `smudge` and `process`, and `required=false`), and fsmonitor and optional locks off. **This supersedes
    D22's line "There is no `git status`, which can run filters a repository configures"** for this one check. D22
    isn't edited, and explaining still runs no `git status`.
    - A driver whose name isn't valid UTF-8 can't be named on git's command line, so it can't be switched off. It
      refuses the check.
    - **A split index is refused before git reads it.** git refreshes the shared index file's time whenever it reads a
      split index, even with optional locks off. Whether the index is split is read from its own bytes.
  - **Left out, and counted by reason:**
    - secret-named paths and dependency or build output, by the shared deny rules, applied to the path in the folder
      and in the repository;
    - submodules;
    - the engine home, when it sits inside the repository.

    A folder inside the engine home, or a home that holds the repository, is refused.
  - **Every file to be sent is scanned first,** text or binary, for credential shapes, private keys and the vault's
    own values. The scan reads each file as it is, as UTF-16 when it looks like UTF-16, and inside every long run of
    base64, the way Kubernetes secrets wrap keys. A PGP private key counts, and so does a private key's first line
    on its own. The vault's values are known exactly, so they are also looked for by their base64 encodings:
    wherever one sits in what was encoded, however the lines are wrapped, in UTF-8 or UTF-16LE, standard or URL-safe.
    **An unsafe snapshot is refused, never redacted.** The refusal names the path and the kind, never the value:
    "src/config.ts in this commit holds what looks like a private key, so Nivra won't upload it. Remove it from the
    commit (and replace the key if it's real), then try again."
  - **What it gives:**
    - one tar, its sha256, and the digest of the listing the prepare step prints (`listingDigest`, D33);
    - a manifest of every file, with Git LFS pointers named (they go as pointers);
    - a fingerprint over the baseline, the folder, every file and what was left out.
- **One tar format, both ways** (`exec/tar.ts`): GNU headers with `L` and `K` records past 100 bytes, exact bytes,
  links kept as links, a fixed owner and time. The reader is bounded and strict.
  - It takes files, folders, links and long names, and refuses every other kind by name, hard links, pipes and devices
    among them.
  - It refuses absolute paths, `..`, duplicates, and anything under a file or a link.
- **Collecting the result** (`exec/patch.ts`).
  - A fixed, persisted command (`COLLECT_SCRIPT`) archives the workspace, leaving dependency and build output folders
    out, and writes an independent listing of the same files. Both go outside the workspace, and are read back with
    digests that must match what the command printed.
  - **The archive must match the listing exactly,** so a file the archiver skipped can never be taken for a deletion.
    Anything that isn't a file, a folder or a link refuses the result.
  - Only manifest paths are ever deleted. New generated output is left out and listed: output folders in any case,
    caches and compiled files.
- **Validation,** of added and changed paths only, so a repository's own `aux.c`, or a `README` and `readme` pair,
  never refuses a run. Each problem is a refusal in plain words, up to five at once:
  - a new path that some target can't hold. Targets can't hold:
    - Windows' reserved names (`con.txt`, `con .txt`, `COM¹`, `CONIN$`) and its forbidden characters;
    - a trailing dot or space;
    - a short-name shape;
    - `.git` in any form;
    - a component over 255 bytes;
  - **a new path that clashes with what the snapshot left out,** which the sandbox never held, so the patch would pass
    its own check and still fail in the checkout:
    - a path at or under a submodule or the engine home;
    - a path under a file that was left out;
    - a file where left-out files, a submodule or the engine home make a folder;
  - git's own files (`.gitmodules`, `.gitattributes`, `.lfsconfig`), added, changed or deleted;
  - links: never added, retargeted, or turned into or from a file. A link may be deleted;
  - **secrets, by name and by content:**
    - the shared deny rules on every added or changed path, so a new `.env` or `credentials.json` is refused whatever
      it holds;
    - credential shapes or the vault's values in new content;
  - Git LFS pointers: never edited, deleted or added;
  - two names that a filesystem ignoring case or Unicode form would make one, folders included, when either is new;
  - **line endings, as the repository's `.gitattributes` says, for new bytes only.** Bytes are never converted.
    - With `text` or `eol`, no CRLF.
    - With `text=auto`, no CRLF in a text file.
    - With nothing said, an edit keeps the commit's style, and a new file uses one style.
    - A file the commit already held with CRLF keeps its style, whatever its attributes say.
  - the limits: 500 changed files, 2 MiB a file, an 8 MiB patch. The number of changes is checked first, and every
    check is linear in the paths' lengths, however deep they go, so a hostile result can't hold the engine up.
- **The patch** is built and checked in a bare object store the engine makes for it.
  - **The store:**
    - has the repository's object format and an empty template;
    - reads no system, global or user configuration (`GIT_CONFIG_NOSYSTEM`, an empty `HOME`, `GIT_ATTR_NOSYSTEM`, an
      empty `core.attributesFile`);
    - has `core.protectNTFS` and `core.protectHFS` on.
  - **It holds nothing of the repository,** which is only read, with `cat-file`. One `fast-import` stream makes two
    trees:
    - B: the snapshot's files at their paths in the repository, with the `.gitattributes` files above the picked
      folder;
    - R: B with the change.

    The patch touches only changed paths, so it is also the patch against the baseline commit.
  - `diff-tree -r -p --binary --full-index --no-renames --no-ext-diff --no-textconv` gives the patch, as bytes. B is
    read into a temporary index and the patch applied there (`apply --cached`). The tree written must be R.
- **The proposal** (`exec/proposal.ts`). One hash covers it: the sha256 of the canonical JSON of a binding that holds:
  - the project and the target;
  - the destination: the repository's top level as it really is, and the picked folder's path in it;
  - the object format, the baseline, B and R;
  - the snapshot's fingerprint;
  - the policy the patch was made under, its version and its limits, taken from the patch itself;
  - the digests of the patch and of the report made before the session closed.

  `verifyProposal` refuses a proposal that isn't intact or isn't the one approved, one checked under other rules than
  Nivra's current ones, and one for another project, target, folder or commit.
- **The report** (`buildReport`) is made before the session closes, and its digest is bound.
  - It lists deletions first, then additions and changes, with no file content.
  - It gives each step's outcome: its exit, signal, timeout, cancellation, truncation, and whether its changes were
    kept.
  - It gives each step's provider status and its usage as reported, null when none and never turned into money, with
    the end of its output.

  Cleanup is a record of its own, B1's `CloseReport`: what was stopped, what stays unresolved and what the provider
  keeps. It can't change what was approved.
- **Refusals carry a code** (`RefusalCode`): `uncommitted`, `content`, `change`, `proposal` and the rest. What leaves
  the engine is chosen by the code, from Nivra's own words, as Track A's safe-error rule asks; a refusal's message
  can name paths in the repository. git's and the sandbox's own words go in a `detail` that never leaves the engine.

**Why.**
- **NIV-42 asks** for a filtered copy of one commit going in and a bounded, validated patch coming out, bound to its
  baseline and destination, with the checkout never changing.
- **Nate's review of the plan (20 October)** asked for three things:
  - every included file's content scanned before upload, an unsafe snapshot refused rather than redacted, and a
    regression with a secret that isn't in the vault;
  - the deny rules applied again to returned changes, so a new `.env` is refused even when it holds no token;
  - a round trip of a subfolder in a larger repository.
- **`git status` is the one dependable dirty check.** Comparing the working tree with the index needs git's own stat
  and racy-entry rules. With every filter off, it runs nothing a repository configures. A test sets marker scripts for
  clean, smudge, process, textconv, an external diff, fsmonitor, hooks, a pager and gpg, then runs the check on a
  touched file, a racily clean file and an edited one. None of the markers ran, and `.git` kept its names, sizes,
  times and bytes. A plain `git status` on the same repository ran fsmonitor, clean and process.
- **No alternates.** The first draft's store read the repository's objects through `objects/info/alternates`. A test
  caught git refreshing the time of an object it found there, in the person's `.git`: `apply --cached` rewrote an
  existing blob for a mode change. Building B from the snapshot's own bytes needs nothing of the repository.
- **The archive must match the listing,** because an archiver that skips a file it can't read gives an archive without
  it, and that would read as a deletion.
- **An independent review of the first draft (`f027403`)** found eight gaps and two concerns. Each was reproduced
  against that commit, then fixed with a regression test in `3957da5`:
  1. a new path that clashed with a left-out file or folder passed every check. `git apply --check` passed in a fresh
     clone, then `git apply` failed partway, leaving an edited file deleted;
  2. a newline in the picked folder's path snapshotted a sibling folder;
  3. a committed path that wasn't UTF-8 was renamed on its way;
  4. Windows device names followed by spaces (`con .txt`) got through;
  5. a deep, hostile result held the event loop for 17 s;
  6. in a split-index repository, the dirty check refreshed a file's time in `.git`;
  7. assume-unchanged and skip-worktree files hid edits;
  8. the policy version was bound but never checked, and came from the caller;
  9. *(concern)* the upload scan missed keys in UTF-16, inside base64, as PGP blocks, or without their last line;
  10. *(concern)* refusals quoted git's own words and an absolute path, so none could leave the engine safely.

  Following the third, a filter driver whose name isn't UTF-8 turned out never to be switched off. The first draft's
  check ran it.
- **The review of PR 8 (21 October)** found one more. The vault's values were looked for in the raw bytes and in
  UTF-16, never inside base64. A synthetic value with no recognised shape, base64-encoded in a `deployment.yaml`, was
  archived, and a returned change holding one would have been proposed. Decoding runs would still miss a value under
  30 bytes, a run that starts with other characters, and a wrapped encoding, so the values are now looked for by
  their encodings (`4ec832f`).

**Consequences.**
- **What comes next.**
  - **B3** runs snapshot, session, steps, collect, patch, report and proposal as one prescribed path: offline with a
    fake guest, then in one approved live recipe on busybox. Each step's status and usage come from the session's
    own records, which B3 reads before closing.
  - **B4** wires it in behind separate upload consent, mapping refusal codes to Nivra's own words.
  - **NIV-8** applies an approved proposal after `verifyProposal`, recording the intent first. **`git apply` isn't
    atomic in a working tree:** when an added file's place holds a folder, it fails after deleting or rewriting
    earlier files (seen in the review). NIV-8 must check every added path's place in the checkout first, untracked
    files included, and apply so that a failure leaves the checkout as it was.
- **Recorded simplifications.**
  - **Case and Unicode collisions are refused on every target,** not only on those that fold case, because a
    repository can be cloned anywhere. D15 asks for the destination's rules.
  - **Attributes come from the committed `.gitattributes` files only.** The person's `info/attributes` and
    `core.autocrlf` aren't read.
  - **Filters off means Git LFS files look changed.** A checkout whose files Git LFS smudged is refused as having
    uncommitted changes. It refuses rather than misses.
  - **Content scanning refuses a repository that commits test keys,** by design. The refusal says what to do.
  - **Detection is by pattern** (D22), so it can't recognise every secret. A password in a URL is one it doesn't.
  - **Inside base64, a shape is found only in a run of 40 or more characters on one line.** A wrapped encoding can
    split a token's shape across lines. A vault value is found however it is wrapped, unless it is under 12 bytes,
    where so little of its encoding could match by chance.
  - **A split index, and files marked for git not to look at, are refused** with what to run, rather than checked
    some other way.
- **Not shown yet:**
  - busybox running the collect step, its `find -prune`, `tar -T` and padded `wc`. This machine's GNU tools ran it.
    B3's live run will show it;
  - git older than the 2.43 run here. The minimum, 2.18, is set from the flags used.
- **Evidence:** `docs/acceptance.md`, *Commit snapshots and validated patches, B2 (D34, NIV-42)*.
