# Nivra: system architecture

*Status as of 17 October 2026.*

This document describes what is **built**:
- the desktop host and its engines;
- the protocol between them;
- runs, packaging and local verification;
- decisions D17 and D18;
- the preference store owned by the host, and the snapshot each run receives (D21).

It also describes what is **planned**, in two parts. **None of it is working yet.**
- **The immediate milestone (D20):** explaining a repository with evidence, and using the preferences the person
  confirms. It is read-only.
- **A later milestone, deferred by D20:**
  - new-app creation;
  - the coding worker;
  - the sandboxes that would enforce limits on it;
  - patch approval.

Each section says which parts are built and which are planned. Decisions are cited as D1, D2, … and are written up in
[docs/decisions.md](docs/decisions.md). The questions about the hackathon's requirements are kept apart from the
architecture, in §17.

---

## 1. What Nivra is

Nivra is a desktop workspace for software engineers. It is being built for the Nebius × NVIDIA Global AI Hackathon
(submissions close 30 October 2026 at 10:00 PT). The immediate milestone (D20) aims at one read-only scenario, end to
end:

> "Explain this repository using evidence. Remember the preference I confirm. Show that it follows me to another
> project without overriding that project's own conventions, and that editing or deleting it changes what happens
> next."

New-app creation was part of the original scenario. It is deferred to a later milestone, with the coding work it needs
(§11).

Three design rules shape the architecture:

1. **The model reasons; Nivra executes.**
   - NVIDIA Nemotron, served by Nebius Token Factory, only ever takes text in and gives text back. That includes tool
     calls; it never runs code itself.
   - In the planned coding workflow, Nivra's engine on the person's machine carries out each tool call inside a sandbox
     and returns the result.
   - Today the engine runs only a built-in check (the hello run), Doctor and a Token Factory check.
2. **Work runs where the code lives.** A repository is read, built and changed by the operating system that owns its
   files:
   - a folder inside a WSL distribution by an engine in that distribution;
   - a folder on a Windows drive by a Windows engine;
   - a folder on Linux by a Linux engine.
3. **An approval is not a boundary.**
   - Consequential actions will be either enforced by a sandbox or refused. Nothing falls back silently to running
     unconfined, or somewhere else.
   - No such action exists yet. The only execution backend today, `Local`, provides no isolation, and it runs nothing
     but the hello check and git.

## 2. The system at a glance

```mermaid
flowchart LR
  subgraph Host["Desktop host: Electron, native on Windows or Linux"]
    R["Renderer<br/>React + Mantine<br/>sandboxed, no Node"]
    M["Main process<br/>project registry · preferences · secret store · engines"]
    R -- "window.nivra: 16 typed calls" --> M
  end
  subgraph W["Target: Windows (local)"]
    E1["Engine<br/>Node + Mastra<br/>own database"]
  end
  subgraph L["Target: a WSL distribution, e.g. Ubuntu"]
    E2["Engine<br/>Node + Mastra<br/>own database"]
  end
  M -- "JSON-RPC 2.0 over stdio" --> E1
  M -- "JSON-RPC 2.0 over stdio, through wsl.exe" --> E2
  E1 -. "HTTPS (a check today)" .-> TF["Nebius Token Factory<br/>NVIDIA Nemotron"]
  E2 -. "HTTPS (a check today)" .-> TF
  E2 -. "planned: tool calls" .-> SB["Planned sandbox<br/>local container, or Token Factory Sandboxes"]
```

| Layer | What it is | What it may do |
|---|---|---|
| **Renderer** | The window: React 19 + Mantine 9 | Call 20 named functions. It sees project ids and display paths. It holds a key only while the person types it into Settings, and it never reads a saved key back. It can't choose a path for a privileged operation: folders come from the native dialog in main. |
| **Main process** | Electron's main process, a thin shell over plain Node modules | Own the project list, the preferences, the secret store and the engines. Translate the window's calls into engine calls, each run carrying its project's preference snapshot. |
| **Engine** | One Node process per target in use, each with its own databases | Today: the hello run, Doctor, run records and a Token Factory check. Planned: model workflows and sandboxes. It speaks only JSON-RPC on stdin and stdout. |

The engine is never part of Electron. It runs on its own Node, shipped with the app (D5), which is what lets it run
inside a WSL distribution while the window stays native on Windows.

## 3. Repository layout

```
apps/desktop/        Electron host
  src/main/            index.ts (Electron shell) · host.ts (core) · supervisor.ts · host-store.ts · secret-store.ts
                       paths.ts · targets/ (local, wsl, wsl-discovery, registry, process)
  src/preload/         the typed bridge, window.nivra
  src/renderer/        React + Mantine UI: projects, engine, wsl, hello, doctor, settings
  src/shared/ipc.ts    the bridge contract (every call is added here first)
  scripts/             runtime staging, the Windows build loop, the Windows verification harness
  e2e/                 Playwright tests: built app, packaged app, packaged Windows app
apps/engine/         the engine
  src/main.mjs         unbundled launcher that keeps stdout for the protocol
  src/engine.ts        createEngine(): RPC router, run store, scheduler, Mastra, execution backend
  src/runs/ src/db/    run store and scheduler on node:sqlite, with migrations
  src/workflows/       Mastra workflows (hello only, today)
  src/exec/            the Local execution backend, child environment, process-tree kill
  src/providers/       Nebius Token Factory client and the Nemotron probe
  src/doctor/ src/secrets/   environment checks; the in-memory key vault
packages/domain/     zod contracts shared by host and engine: protocol, methods, runs, RpcClient
docs/                decisions (D1–D20), acceptance, submission checklist, provenance (code reused from Hird),
                     development
```

**Toolchain** (exact pins, D11): Node 24.21.0, pnpm 10.4.1, Electron 44.7.0, React 19.3.0, Mantine 9.7.1, Mastra
(`@mastra/core` 1.75.0, `@mastra/libsql` 1.25.1), zod 4.6.5, TypeScript 5.9.3, Playwright 1.64.0.

**Provenance.** Concepts and some code come from the author's earlier app, Hird. Every reused file is listed with its
source commit, marked ported or rewritten, in [docs/provenance.md](docs/provenance.md).

---

## 4. Desktop host *(built)*

### 4.1 Renderer
- **Locked down.**
  - It runs with `sandbox` and `contextIsolation`, and without `nodeIntegration`.
  - A strict Content Security Policy applies: `default-src 'self'; script-src 'self'; …; object-src 'none'`.
  - Navigation away from the app, pop-ups, webviews and permission requests are all denied.
  - It imports shared types only, never zod at runtime, because zod's runtime checks would trip the CSP.
- **Ids, not paths.**
  - It sends project ids, never paths.
  - It shows each project's path for display only.
  - Folders come from the native dialog, which runs in main.
- **Keys.** A key typed into Settings sits in the renderer until it is saved. After that, the renderer sees only how the
  key is stored (encrypted, unencrypted, unreadable), never the key.
- **What it shows:**
  - every repository with its target label ("Ubuntu · WSL", "Windows · Local"), and Add/Remove;
  - the engine badge and notices for the chosen project;
  - WSL guidance (Windows only);
  - Preferences: confirm a new one (for every project, or for the chosen project only), edit or delete one, and see
    which ones the chosen project's runs get (D21);
  - a hello run with a live timeline and Cancel;
  - Doctor;
  - Settings: the Nebius key, and a Token Factory check.

### 4.2 The bridge
`window.nivra` exposes 20 named functions, each invoking exactly one IPC channel. There is no generic "send any channel"
helper. Every handler in main checks two things before acting:
- the sender is the top frame of one of Nivra's windows, at the exact app URL;
- the arguments pass zod validation.

| Call | Purpose |
|---|---|
| `listProjects`, `addProject`, `removeProject` | The project registry. `addProject` opens the native folder dialog in main. `removeProject` also removes the project's own preferences, and says how many. |
| `listPreferences`, `addPreference`, `editPreference`, `deletePreference` | The preference store (D21). A new preference is confirmed by being added; a project preference names its project by id. |
| `openProject(projectId)` | Starts that project's engine if it isn't running yet. It never starts a different one. |
| `listEngines` | The state of every engine a project uses. Asking starts nothing. |
| `restartEngine(projectId)` | Restarts the project's engine, or checks its distribution again. |
| `getWsl`, `checkWsl` | What WSL offers on this machine, and how to fix it (Windows only). |
| `startHello(projectId, holdMs)`, `runEvents(runId, after)`, `cancelRun(runId)` | Runs. `startHello` sends the project's preference snapshot with the run. |
| `runDoctor(projectId)` | Environment checks on that project's engine. |
| `getSettings`, `setNebiusKey` | How the saved key is stored; save or remove it. |
| `checkTokenFactory(projectId)` | Lists the NVIDIA models and makes one Nemotron tool call, from that project's engine. |
| `getAppInfo` | Versions. |

### 4.3 Main process
- **`index.ts`**: the Electron shell. It owns the window, the security guards, single-instance handling, dialogs, the
  IPC handlers and the quit flow.
- **`Host`** (`host.ts`): the core, with no Electron in it. It holds the project registry, keeps one engine per target,
  routes calls, and produces the WSL guidance (D17).
- **`EngineSupervisor`**: starts, watches and stops one engine. Its states are `stopped`, `starting`, `online` and
  `failed`, and a failure carries a code and a reason.
- **Targets**: `LocalTarget`, `WslTarget`, WSL discovery, and a target factory.
- **`HostStore`**: projects, preferences and window state, as JSON in Electron's user-data folder. Writes are atomic,
  with retries for Windows renames.
- **Preferences** (`preferences.ts`): pure changes to the store, and `snapshotFor(project)`, which chooses what a run on
  that project receives (D21).
- **`SecretStore`**: the Nebius key, saved in `secrets.json`. It is encrypted with Electron `safeStorage` where a
  keychain is available. Otherwise it is stored unencrypted, and the window says so.

A source-rule test keeps `host.ts`, `preferences.ts`, the targets, the supervisor and the stores free of Electron (D12). That lets
`node --test` drive them on Linux and from a real Windows process.

---

## 5. Targets: where an engine runs *(built; D1, D10, D17)*

### 5.1 The folder decides, once
Nobody chooses a target. It is set when a folder is added, by the operating system that owns the folder:

| Folder picked in the dialog | Target | Recorded path |
|---|---|---|
| `C:\Users\me\app` (a Windows drive) | `local`, the native Windows engine | `C:\Users\me\app` |
| `\\wsl.localhost\Ubuntu\home\me\app` (or `\\wsl$\…`) | `wsl:Ubuntu` | `/home/me/app` |
| `\\wsl.localhost\Ubuntu\mnt\c\Users\me\app` | `local`: Windows owns drive C: | `C:\Users\me\app`, with a notice |
| `\\server\share\…` | refused: network shares aren't supported | — |
| `/home/me/app` (Linux host) | `local` | `/home/me/app`; a `/mnt/<drive>` folder inside WSL gets a slow-drive warning |

**The rules**
- A project's target never changes.
- WSL is never chosen just because it is installed.
- There is no fallback. A project whose distribution is missing or unusable says why and what to do; it is never run
  on another target.
- A WSL folder is checked when it is added. The distribution must exist and must not be Docker Desktop's. It must be
  WSL 2 and x86-64, with glibc 2.28 or newer and `tar`. A missing `git` is a warning.

### 5.2 WSL discovery and guidance *(Windows hosts)*
- **Language-independent.**
  - `%ProgramFiles%\WSL\wsl.exe` must exist and answer `--version`.
  - Names come from `wsl --list --quiet`.
  - The version, default distribution and default user come from the registry (`HKCU\…\Lxss`), never from the
    localised `--list --verbose`.
  - Errors are recognised by their `WSL_E_*` code.
- **Background only.** Discovery runs in the background at startup and never holds up Windows folders.
- **Always explained.** The window always says what WSL offers, with the command that fixes it and a **Check again**
  button. Possible states:
  - missing;
  - outdated;
  - not answering, with WSL's code;
  - no distribution Nivra can use: none, only Docker Desktop's, or only WSL 1 ones.

### 5.3 One engine per target, and routing
- **Lifetime.** An engine starts the first time a project on its target is opened, and runs until the app quits.
- **Routing.**
  - Project calls go to the engine of the project's folder.
  - Run calls go to the engine that started the run, through a run-to-target map kept in main.
- **What follows.**
  - Looking at another project never stops an engine.
  - No call can reach the wrong engine. A runtime target switch used to allow exactly that, which is why it was
    removed (D17).

### 5.4 Starting an engine

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant H as Host (main)
  participant S as Supervisor
  participant T as Target
  participant E as Engine
  UI->>H: openProject(id)
  H->>T: resolve the project's target (WSL: discovery)
  H->>S: start()
  S->>T: prepare(): probe, install the runtime if needed
  T-->>S: program, arguments (absolute paths), environment
  S->>E: spawn: stdin/stdout piped, stderr to the target's log file
  S->>E: initialize {protocolVersion, client, keys}
  E-->>S: EngineInfo {version, pid, home, platform, …}
  S-->>H: online
```

- **Native Windows and Linux.** The Node shipped with the app (`resources/runtime/<os>-<arch>/node`) runs
  `engine/main.mjs`.
- **WSL.** The command is `wsl.exe -d <distro> --cd <home> --exec <home>/.nivra/runtime/<hash>/node/bin/node …/engine/main.mjs …`.
  Every path is absolute, because `--exec` runs no shell and would not expand `~`.
- **Installing the runtime in WSL (D5).** On first use, a short, fixed `/bin/sh -c` script runs inside the distribution
  (§8). The app streams a deterministic Linux tarball to it over `wsl.exe`'s standard input. The script:
  1. extracts the tarball into a temporary folder;
  2. checks that Node, `node:sqlite` and the libsql driver load;
  3. renames the folder into place under the tarball's content hash.
  
  A runtime already installed under the same hash is reused: a second start took about 0.7 s. The newest two runtimes
  are kept.
- **Configuration travels only as arguments:** `--stdio --home <abs> --instance <uuid> --heartbeat-ms <n> --nivra-engine`.
  Environment variables don't cross `wsl.exe` (D3).
- **Time limits**, in order:
  1. probing the distribution: up to 60 s;
  2. installing the runtime: up to 300 s;
  3. once the engine process runs, `initialize` must answer within 60 s.
  
  A runtime that fails to load is installed again, once. Every failure says what happened, with a code and the tail
  of the engine's log.

### 5.5 Watching and stopping *(D4, D18)*
- **Heartbeat.**
  - The host pings each engine six times per heartbeat (30 s by default).
  - An engine that is alive but hasn't answered for longer than a heartbeat is marked failed with code `unresponsive`.
    It is stopped in the quit order below, and **Restart** starts a fresh one.
  - After the machine wakes from sleep, silence isn't counted for one heartbeat (D18).
- **Exits.** An engine that exits unexpectedly is shown as "The engine stopped unexpectedly (exit code …)" with a
  Restart button. The host doesn't guess at causes it can't see.
- **The engine stops in one way**, whichever of these triggers it:
  - the `shutdown` call;
  - the end of its standard input;
  - a broken stdout;
  - SIGTERM or SIGINT;
  - its own watchdog, when the host goes silent for longer than the heartbeat.
  
  It then stops its runs (with a 3 s grace period), closes its database, flushes its last reply and exits.
- **The host's quit order** for each engine:
  1. send `shutdown` and wait up to 5 s;
  2. close stdin and wait up to 2 s;
  3. force it to stop:
     - on Windows, with `taskkill /T /F`;
     - in WSL, by killing `wsl.exe`, then running `pkill -f -- --instance <uuid>` inside the distribution. That pattern
       never matches a developer's own engine.
- **Quitting.** On quit, every engine closes in parallel, and a closed supervisor refuses to start again.
- **Crashes.** On Windows, engines are spawned non-detached, so libuv's job object takes them down if the app itself
  dies.

---

## 6. Host ↔ engine protocol *(built, D2)*

- **Transport.** JSON-RPC 2.0 over the engine's stdin and stdout, one message per line (NDJSON). Lines are capped at
  8 MiB, and `PROTOCOL_VERSION` (now 2) is checked in `initialize`.
- **Stdout carries the protocol and nothing else.**
  - A small unbundled launcher keeps the real stdout writer for the protocol, and sends every other stdout write and
    every `console.log` to stderr.
  - Mastra's logger is off.
  - Tests assert that every stdout line parses as JSON-RPC.
  - Source-rule tests ban `stdio: 'inherit'`, `shell: true`, and `process.exit` outside the launcher.
- **Validation.** Both sides validate parameters and results with the same zod schemas, from `packages/domain`.

| Method | What it does |
|---|---|
| `initialize` | Version handshake; hands over the keys; returns `EngineInfo`. |
| `secrets.update` | Replaces keys in the engine's memory. |
| `ping` | Heartbeat. |
| `shutdown` | The single stop path. |
| `doctor` | Checks the engine, its data folder and git, and which execution boundaries this target could offer (detection only). |
| `providers.check` | Token Factory: the NVIDIA models the key can see, then one Nemotron tool call. |
| `runs.start`, `runs.get`, `runs.list`, `runs.events`, `runs.cancel` | Runs (§7). `runs.start` requires a `context`: the preference snapshot for the run's project (D21). |

**Notifications.** The engine sends one notification, `engine.fatal`, as its last word before it exits on a startup
failure. It carries a code: `locked`, `bad-arguments`, `home-unusable`, `runtime-broken` or `crashed`. The host reads
run progress by polling with a cursor.

---

## 7. Runs *(built)*

- **States.**
  - `queued → running → succeeded | failed | cancelled`, with checked transitions. A queued run can also fail
    without starting (below).
  - `waiting_for_approval` exists in the state machine, but nothing enters it yet (§11).
- **Storage.**
  - Each engine keeps runs in its own `nivra.db` (`node:sqlite`): a `runs` table and an append-only `run_events`
    timeline, numbered per run.
  - Clients read Nivra's tables, never Mastra's.
- **Events.**
  - Types: `run.*`, `step.*`, `step.output`, `command.started`, `command.finished`.
  - Data is capped at 8 KiB per event and messages at 2,000 characters.
  - Before anything is stored, the run store replaces the values of the keys Nivra holds. That is masking of known
    values only: it is not a general secret detector.
- **Scheduling.**
  - At most 2 runs at a time, in submission order.
  - Each run is a Mastra workflow run with the same id.
  - Cancel aborts the step's signal, which stops the whole process tree:
    - POSIX: SIGTERM, then SIGKILL, on the run's process groups;
    - Windows: a job object plus `taskkill /T /F`.
- **Restart.** A run still marked running when its engine starts again is failed with `run.interrupted`. It is never
  replayed: Mastra's automatic restart is off. A run still queued from an earlier instance fails the same way, without
  starting, because its context lived only in that instance's memory (D21).
- **Context (D21).** The scheduler holds each run's preference snapshot in memory from `runs.start` until the run ends.
  Steps read it by run id. It never enters workflow input, step output or the run's record, so neither `nivra.db` nor
  `mastra.db` keeps preference text.
- **The `hello` workflow** proves the chain without changing anything. Its steps:
  1. engine information;
  2. the context the app sent: how many preferences, their ids and revisions, and a SHA-256 fingerprint, never their
     text;
  3. the repository's working directory and real path;
  4. `git --version`;
  5. `git status --porcelain=v2 --branch`;
  6. optionally, a held child process, which shows that Cancel really stops work.

---

## 8. Security model *(built)*

| Area | What is enforced today |
|---|---|
| Electron | Sandbox, context isolation, CSP and a single instance. Navigation, pop-ups and permissions are denied. Fuses turn off RunAsNode and `NODE_OPTIONS`, and the app loads only from its asar archive. |
| IPC | A trusted-sender check and zod validation on every handler. The renderer sends ids; the paths it shows are for display only. |
| Starting programs | Programs start from argument lists, never through a shell, and a test bans `shell: true`. The one exception is probing and provisioning a WSL distribution: a fixed `/bin/sh -c` script runs inside it, with values passed as positional arguments, never spliced into the script. |
| Child environments | Children get a filtered environment: provider key variables, `NODE_OPTIONS` and Electron's variables are removed, and exactly one PATH key is kept. This removes **known** variables; it is not an allow-list, so other secrets in the environment are passed on. |
| Execution | Only the `Local` backend exists. It provides **no isolation** and is labelled "No isolation". It refuses sessions that need network rules, and Windows batch files. Today it runs only the hello check and git. The container, Token Factory Sandboxes and OpenShell backends are planned (§11). |
| Databases | Each database has one owner, and none is ever opened across the Windows/WSL boundary. SQLite's exclusive lock refuses a second engine on the same data folder. |
| Preferences | Only the host's `nivra.json` keeps their text. An engine gets a run's snapshot in `runs.start` and holds it in memory for that run; runs record ids and a fingerprint. A canary test checks that preference text never reaches `nivra.db*`, `mastra.db*` or the logs (D21). |

**The API key's path (D8)**
1. The person types the key into Settings. The renderer holds it until it is saved.
2. The host saves it in its secret store, `secrets.json`. It is encrypted with `safeStorage` where a keychain is
   available. Otherwise (Linux's `basic_text` and `unknown` backends) it is stored unencrypted with a warning, and
   re-encrypted once a keychain appears.
3. The key reaches an engine only through `initialize` and `secrets.update`. The engine holds it in memory.
4. The key is not passed in environment variables or command-line arguments. The engine removes provider variables from
   its own environment at start.
5. The engine never writes the key to its databases, logs, run input or events.
6. A canary test checks that a fake key never reaches `nivra.db*`, `mastra.db*` or the logs.

## 9. Data and storage *(built)*

| Data | Owner | Where | Notes |
|---|---|---|---|
| Projects, preferences, window state | Host | `<userData>/nivra.json` | Atomic writes. The only copy of the preferences (D21). |
| Nebius key | Host | `<userData>/secrets.json` | Encrypted where a keychain is available, otherwise unencrypted with a warning; engines hold a copy in memory only |
| Runs and events | Each engine | `<home>/nivra.db` | `node:sqlite`, exclusive lock; known key values masked |
| Workflow snapshots | Each engine | `<home>/mastra.db` | libsql, through Mastra. **Not covered by the run store's masking**: Mastra stores workflow input and step results as they are. Today's only workflow, hello, stores a repository path and a hold time. Planned workflows must pass ids, never sensitive content. |
| Engine logs | Host | `<logs>/<target>.log` | The engine's stderr; the previous log is kept |
| WSL runtime | — | `~/.nivra/runtime/<hash>`, inside the distribution | The newest two are kept |

**Engine data folders:**
- Windows: `%LOCALAPPDATA%\Nivra\engine`.
- Linux, and inside WSL: `~/.nivra`.
- Development: `~/.nivra-dev`.

*Planned:*
- the host gains per-project data-sharing flags;
- the engine gains artifacts, patches, approvals, apply intents and sandbox sessions, through an additive migration.

---

## 10. Models: Nebius Token Factory

**Built**
- **`providers.check`** runs from any engine:
  1. it lists `GET /v1/models`;
  2. it picks a Nemotron model the key can see, preferring `nvidia/nemotron-3-super-120b-a12b`, then
     `nvidia/Nemotron-3_5-Lightning`, then `nvidia/Nemotron-3-Ultra-550b-a55b`;
  3. it makes one tool call through Mastra.
  
  There are no retries (`maxRetries: 0`). Listing the models has a 30 s limit and the call 120 s. Errors are mapped by
  status: key refused (401/403), rate-limited (429), unreachable, no NVIDIA model. Token counts are shown when the
  provider reports them.
- **`pnpm probe:tokenfactory`** makes the same check from a terminal.
- **Not yet run with a real key.**

**Planned**
- **One `ModelClient`** for every model call:
  - no retries;
  - a time limit on every step;
  - usage recorded per call, as `null` when it isn't reported (never shown as 0);
  - errors mapped by status code or error class.
- **Model and route recorded on every call.** One suitable Nemotron model is enough for the first workflow.
- **Model tiers are optional:** `reasoning` and `agent` on Ultra or Super, `fast` on Nano or Lightning. If they're used,
  the choice follows which models the key can see and which handle tools reliably.
- **Offline tests.** Tests never call real models. They use a mock model in-process, or a stub server reached through
  a test-only, loopback-only engine argument.

---

## 11. Coding work *(a later milestone, deferred by D20; nothing in this section is implemented)*

Today the only execution backend is `Local`, which provides no isolation and runs nothing but the hello check and git.
The design below follows D9 and D15, and is kept for when coding work is promoted again. The coding worker's first
write task hasn't been chosen. Its open requirements are tracked in NIV-7 and NIV-8:
- the patch captures new files explicitly;
- approval is bound to the complete patch hash, the destination and its baseline;
- the patch is checked again immediately before a serialised apply;
- interrupted applies are reconciled, never replayed.

### 11.1 The agent loop
The planned worker is a Mastra agent on Nemotron that runs inside the engine. The model proposes actions; the engine
carries each one out in a sandbox and returns the result.

```mermaid
sequenceDiagram
  participant E as Engine (Mastra workflow + agent)
  participant M as Nemotron on Token Factory
  participant S as Sandbox
  E->>M: task, scoped context, tool definitions
  M-->>E: tool call, e.g. run_command("npm test")
  E->>S: run it inside the sandbox, with no network
  S-->>E: stdout, stderr, exit code
  E->>M: tool result
  M-->>E: next tool call … final answer
  E->>S: extract a complete patch, new files included
  E->>E: check the patch, store the proposal and its hash
  Note over E: the run waits for the person's approval
```

- **Tools:** `list_files`, `read_file`, `grep_search`, `write_file`, `run_command`. Paths are checked against the
  workspace, and output is masked and capped before the model sees it.
- **Limits:** a step limit and a time limit. Cancel aborts the model call and closes the sandbox.
- **The key stays out of the sandbox.** The key stays in the engine, which makes the model calls, so the sandbox needs
  no route to the model.
- **Adapter.** A `CodingWorker` adapter declares the worker's capabilities, so another worker (OpenCode, say) can be
  added later.

### 11.2 Sandboxes
`SandboxBackend` will be a type of its own, separate from today's `ExecutionBackend`, so that `Local` can never be used
for coding work.

| Backend | Role | What it would enforce | Availability |
|---|---|---|---|
| **Docker or Podman container** | Intended local default | Only a copy of the workspace is mounted, never the person's checkout. No network. A non-root user with all capabilities dropped, no new privileges, and process and memory limits. | Needs Docker Desktop's WSL integration, Docker Engine or Podman. Not built. |
| **Token Factory Sandboxes** | Cloud option | A disposable remote VM with network on or off. Commands run as subprocesses of a live instance. | **Beta, access by request.** Requested, not active: not an available path today. Not built. |
| **NVIDIA OpenShell** | Optional, stricter local sandbox | Landlock filesystem rules, a per-host network allow-list, credential placeholders | Linux and WSL with Docker or Podman. Not built; first to cut if time runs short. |

**Network**
- The model's commands will never have network access.
- Template and install steps (`npm create vite …`, `npm install`):
  - come from the approved plan;
  - are run by the engine, never the model;
  - need one explicit consent from the person;
  - run in a separate, short-lived networked container against the same workspace.
  
  On Token Factory, the equivalent is a networked instance that saves a checkpoint image, followed by an instance with
  no network.

**Choosing a sandbox.** Settings chooses the sandbox, separately from the target. A run whose sandbox is unavailable is
refused with what is missing. Installing the app needs no Docker; coding locally will.

### 11.3 From workspace to applied change

```mermaid
flowchart LR
  A["Workspace copy<br/>(empty for a new app)"] --> B["Worker edits files and runs checks<br/>inside the sandbox"]
  B --> C["Complete patch<br/>new files captured explicitly"]
  C --> D["Engine checks every rule:<br/>paths inside · case clashes · line endings<br/>links and modes · secrets · built artefacts"]
  D --> E["Proposal stored with its sha256<br/>run waits for approval"]
  E -->|"approve(hash)"| F["Record intent → git apply<br/>→ confirm with a reverse check"]
  E -->|"reject"| G["Run cancelled<br/>destination untouched"]
```

- **Who writes.** Only the engine on the operating system that owns the destination writes it. The host and the
  renderer never write repository files (D15).
- **Approval.** The person approves the exact patch they were shown, bound to:
  - its complete hash;
  - the destination and the engine that owns it;
  - the destination's baseline.
  
  A different hash is refused, and everything is checked again immediately before a serialised apply.
- **Restarts.**
  - An apply that was interrupted is inspected and reported as applied, not applied or unknown. It is never applied
    twice.
  - Whether a proposal waiting for approval can survive a restart is undecided. It can't be claimed until recovery is
    changed for it: today a restart fails runs that are waiting.
- **First write task:** not chosen yet. The new-app scaffold is deferred (D20), and edits to existing repositories need
  their own scope decision.

---

## 12. Context, explanation and preferences *(the immediate milestone, D20; the preference store and handoff are built, D21; the rest is planned)*

- **Explain with evidence (NIV-6, NIV-9).**
  - The engine reads the repository in bounded, targeted reads, inside the repository and with a limited budget.
  - The explanation cites `path:line`.
  - The engine checks each citation against the snapshot it actually read. It reports a valid location as just that,
    never as proof that the explanation is correct.
  - Run records keep the model and route, the elapsed time (measured with a monotonic clock) and the usage the provider
    reported, with `null` for anything unknown.
- **Repository map.**
  - Contents:
    - the file tree, with secrets and dependency or build output excluded;
    - manifests;
    - convention files;
    - an outline of exported symbols.
  - It needs no new dependencies.
  - Cached context is invalidated by the content revision of what was actually read. HEAD plus a dirty flag isn't
    enough.
- **Data sharing (D20, confirmed).**
  - **Two separate opt-ins per project, both off at first:** `modelContext` and `cloudExecution`.
  - **`modelContext`** governs every piece of repository-derived material sent to Token Factory, including read-tool
    results and later requests, not just the first prompt.
  - **`cloudExecution`** governs uploading a workspace.
    - It stays off and unused while cloud execution isn't built.
    - Turning on `modelContext` never turns it on.
  - **Always excluded:** secrets, and dependency and build output.
  - Reads stay inside the repository and are bounded, and output is capped.
  - Each run records which paths it sent and how many bytes, never the content.
  - Repository or model text can never grant consent, and can never promote private project information into the
    global profile.
  - A sandbox's network policy (later milestone) is a third, separate control.
- **Preferences** *(built for NIV-5, D21; NIV-10 builds on them)*.
  - **Storage.** One canonical store, owned by the host, in `nivra.json`.
  - **What each record holds:** an id, the statement, a scope (personal, or one project), a status (confirmed or
    suggested), an origin, a revision raised by every edit, and dates. The store has a revision of its own, raised by
    every change.
  - **How one is made.** The person types it and presses Confirm. Nothing else creates one.
  - **What engines get.** With each run, main sends the project's own engine a validated snapshot: the confirmed
    personal preferences, the project's own, and the store's revision. Engines never keep a copy of the profile, and
    never open the host's store.
  - **Persistence.** Preference contents stay out of Mastra's persisted step data and out of the run's record.
  - *Planned (NIV-10):* suggestions drawn from repository observations, which only the person can confirm; supersession;
    export and import.
  - *Planned (NIV-11):* a workflow that uses them, under the precedence below. Until then, the hello run proves the
    handoff.
- **Context assembly (NIV-11).**
  - Precedence: explicit task choices first, then the repository's own conventions (with evidence), then confirmed
    personal defaults.
  - Project A's records never reach project B.
- **Fixtures.** User-supplied repositories A and B (D20), recorded with their revisions and contrasting conventions in
  `docs/acceptance.md`. Repository B is private, so only its stack and revision appear there.
- **Deferred (later milestone):** new-app creation, with its plan preview, scaffold, proposal, approval and result view.

---

## 13. Packaging and distribution *(built)*

- **Runtime staging per target** (`stage-runtime.ts`, D5, D6):
  - Node 24.21.0, checked against nodejs.org's published checksums;
  - an esbuild bundle of the engine and the shared contracts;
  - the engine's production `node_modules` for that target, including libsql's prebuilt native driver;
  - `manifest.json`, with a content hash;
  - a deterministic Linux tarball, for WSL;
  - a guard against Windows' 260-character path limit;
  - the Visual C++ runtime DLLs next to `node.exe`; staging fails if they are missing.
- **Builds** (electron-builder):
  - Linux: a deb (the primary artifact) and an AppImage.
  - Windows: an unsigned zip. An NSIS installer needs a Windows build machine.
  - Runtimes sit outside the asar archive, under `resources/runtime/<os>-<arch>`. The Windows build also carries the
    Linux tarball for WSL.

**Platforms, as verified so far**

| Host | Folder | Status |
|---|---|---|
| Windows 10/11 x64 | Inside a WSL2 distribution (glibc 2.28+, x86-64) | Hello run, cancel and quit verified through the packaged app; the primary target |
| Windows 10/11 x64 | On a Windows drive | Hello run and Doctor verified; coding work comes later |
| Linux x64 | Local | Hello run, cancel and quit verified through the built and packaged app |
| macOS | Local | Deferred (D10) |

## 14. Verification *(D14: no CI; every check runs on the developer's machine)*

**What each check covers**

| Check | Coverage |
|---|---|
| `pnpm verify` | Typecheck and every unit and integration test, including real engines over stdio. See the list below. |
| `pnpm verify:windows` | The target and supervisor modules, driven by a real Windows process: native and WSL engines; start, hello (with a preference snapshot that must arrive intact), cancel, stop; engines killed from outside and restarted; engines dying with their parent |
| `test:packaged` | The packaged Linux app (`electron-builder --dir`), through its real UI, including the preference flow across an app restart |
| `test:windows` | The packaged Windows app, driven from WSL: both engines in one session, a WSL run kept alive and cancelled while the native engine works, preferences reaching both engines with each project's own kept to it, and quit leaving nothing running |
| `test:e2e` | The built Linux app, through its real UI, including the preference flow |
| `verify:interrupt` | The packaged Windows app and an observer, both on Windows, while a dedicated test distribution is terminated from outside: the native run carries on, Restart works, the cut-off run ends interrupted without replay |

The integration tests in `pnpm verify` include:
- stdout purity;
- the secrets canary;
- cancel stopping the process tree;
- the engine exiting when its input ends;
- the watchdog;
- `run.interrupted` after a restart;
- the database lock;
- paths containing spaces, `ü`, `%` and `#`;
- an engine that stops answering, and the grace period after a wake;
- the engine pool:
  - routing by folder;
  - a run kept on its own engine while another engine restarts slowly;
  - no fallback for a missing distribution;
  - every engine stopped on quit;
- preferences (D21):
  - real values arriving at real engines, shown by fingerprints worked out independently;
  - edits, deletions and a restart reaching the next run;
  - one project's own preferences never reaching another's runs;
  - the preference canary;
  - runs refused without their context;
  - queued runs failing, unstarted, after a restart.

**Recorded results from earlier runs**, before the final changes:

| Date | Check | Result |
|---|---|---|
| 16 Oct | `pnpm verify:windows` (bootstrap) | 15/15 |
| 17 Oct | `pnpm verify` (D16 fixes) | 88/88 |
| 17 Oct | `pnpm verify`, `test:e2e`, `test:packaged`, `verify:windows`, `test:windows` (D17, before D18) | 114/114 · 5/5 · 5/5 · 15/15 · 5/5 |
| 17 Oct, 05:16–05:35 | The foundation as committed in `2556052`: `pnpm verify`, `verify:windows`, `test:packaged`, `test:windows`, `test:e2e`, RPC | 116/116 · 17/17 · 5/5 · 5/5 · 5/5 · ok |

**Results against the final change set** (code and docs as they are to be committed):

These were run on 17 October 2026 (07:36–07:42 +08:00) against the working tree with every code change of the D21
change set in place. The only edits made afterwards record these results, here and in `docs/acceptance.md`. Markdown is
neither built nor tested.

| Check | Result |
|---|---|
| `pnpm verify` | Typecheck clean; tests 131/131 (domain 23, desktop 64, engine 44) |
| `pnpm verify:windows` | 17/17, including a preference snapshot arriving intact at the native and the WSL engine. Runtimes staged afresh: `linux-x64` `261063cd91eac407`, `win-x64` `044882c828c6b992`. |
| `pnpm --filter @nivra/desktop package:dir`, then `test:packaged` | 11/11 |
| `pnpm dev:win --no-launch`, then `test:windows` | 5/5 |
| `test:e2e` | 11/11 |
| `verify:interrupt --distro NivraTest` | 9/9. `NivraTest` was made from the Ubuntu 24.04 base image for this check and unregistered afterwards. |
| Real engine over RPC: a hello run with a one-preference snapshot and `--follow`, then `pnpm rpc doctor` | The run succeeded. Its `context` step recorded "1 confirmed preference from the app (revision 4)", and its stored input held only the path and the hold time. Doctor: engine, home and git `ok`; boundaries `warn` (no sandbox yet). |

**Not yet run** (still pending):
- the installed deb on a stock Ubuntu (an unpacked build test is not installation coverage);
- the Windows zip on a clean machine without the Visual C++ redistributable;
- a real Token Factory key;
- Token Factory Sandboxes;
- macOS.

---

## 15. Status and roadmap

| Area | Status | Linear |
|---|---|---|
| Desktop host, targets, protocol, engine core, runs, engine recovery, packaging, local checks | **Built**: the foundation, committed in `2556052` | NIV-3 (Done), NIV-5 |
| Scope, data sharing, out-of-scope list (D20); fixtures | Decided. The two user-supplied fixtures are recorded. | NIV-2 |
| Preference store, and the scoped handoff to engines | **Built** (D21); the whole-distribution interruption check passed | NIV-5, reused by NIV-10 |
| Explain with evidence, model client, repository map, the run lifecycle it needs | Planned (immediate milestone) | NIV-6, NIV-9, NIV-8 (read-only slice) |
| Managing preferences, context assembly and isolation | Planned (immediate milestone) | NIV-10, NIV-11 |
| Acceptance on packaged builds, release, video, submission | Planned | NIV-14 – NIV-17 |
| New-app creation, coding worker, sandboxes, patches, approvals | **Deferred** (later milestone, D20) | NIV-7, NIV-8 (rest), NIV-12, NIV-13 |

The estimates are not commitments. None of the planned work is a precondition for committing the foundation.

## 16. Decision index

| # | Decision |
|---|---|
| D1 | The window is native; the engine runs where the repository lives |
| D2 | NDJSON JSON-RPC 2.0 over stdio; stdout carries nothing else |
| D3 | Configuration crosses process boundaries as arguments or RPC, never as environment variables |
| D4 | One way to stop an engine, and a fixed quit order |
| D5 | Nivra ships its own Node and engine for every target |
| D6 | No native addons in Electron; the engine's one addon ships with its runtime |
| D7 | One owner per database |
| D8 | Secrets live in the host's secret store and in engine memory, nowhere else |
| D9 | Execution boundaries are pluggable sessions that declare what they enforce |
| D10 | Supported platforms for the proof of concept; macOS deferred |
| D11 | Toolchain pinned |
| D12 | Targets, the supervisor and the host core don't import Electron |
| D13 | Entered in the Coding and Agentic Engineering track (its Sandboxes statement is superseded by D19) |
| D14 | Cross-platform checks run locally, not in CI |
| D15 | Agents write in a workspace the engine owns; changes reach a checkout only as an approved patch |
| D16 | Fixes from the first code review |
| D17 | The folder decides where work runs; one engine per target for the session |
| D18 | An engine that stops answering is reported and stopped |
| D19 | Hackathon requirements, as published |
| D20 | The immediate milestone: explain with evidence and confirmed preferences; new-app creation deferred |
| D21 | Preferences: one store owned by the host, and a snapshot with every run |

The planned work in §§10–12 will be recorded in new decisions as it is built.

## 17. Hackathon requirements *(kept separate from the architecture)*

The dated checklist, with a source link for each requirement, is in [docs/submission.md](docs/submission.md) (NIV-15).
In short:
- **What every entry needs.** A runtime Token Factory inference call meets the general Nebius platform requirement, and
  an NVIDIA open-source model is also required. Nivra plans to meet both through the explain workflow; the live proof
  is pending.
- **Track fit is open.** The Coding and Agentic Engineering track describes agents that "write, run, and test code in
  Token Factory". It doesn't name the Sandboxes product. The immediate milestone is read-only (D20), so whether it fits
  the track needs reassessing. The options and draft questions for the organisers are in the checklist. No answer has
  been obtained or assumed.
- **No OpenShell bonus.** The rules publish no scoring bonus for NVIDIA OpenShell.
- **Sandboxes isn't available yet.** Token Factory Sandboxes is in beta and needs an access request. Access is
  requested but not active.
- **Judge access** must be free until judging ends (16 December, 04:00 SGT). How is undecided (NIV-16).
- **Effect on the design:** none. The architecture doesn't depend on these answers (D19, D20).

## 18. Questions for reviewers

Questions 1–3 apply to the later coding milestone.

1. **Local isolation.** Is a hardened Docker or Podman container an adequate local boundary for commands a model
   proposes? The planned container has no network, a non-root user, no capabilities, no new privileges and resource
   limits, and only a workspace copy mounted.
2. **Network for installs.** Template and install steps get network access only with consent, only from the approved
   plan, and only when run by the engine. The model's own commands stay offline. Is that the right line?
3. **Approvals across restarts.** Should a stored proposal stay approvable after the app restarts, or expire?
4. **Evidence.** Is checking each citation against the snapshot actually read enough to support the claim "evidence
   linked"? The explanation itself is never presented as verified.
5. **Model tiers.** Ultra or Super for planning and tool loops, Nano or Lightning for small jobs: is that the right
   split?
6. **Native Windows.** Windows-drive folders get the hello run and Doctor today. Coding on them would need Docker
   Desktop or Token Factory Sandboxes. Is that acceptable for the proof of concept?
7. **Judges.** Explaining will need only a Token Factory key. Coding will need Docker or Podman, or Sandboxes access.
   What should the judges' setup be?
