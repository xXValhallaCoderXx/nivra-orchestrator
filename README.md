# Nivra

A desktop workspace for engineers. It explains a repository with evidence, remembers the engineer's confirmed
preferences, and runs a coding task in a Nebius sandbox, where tests the agent can't edit judge the change. Nothing
reaches your checkout until you approve that exact change.

> **Status:** this README describes the next release, which isn't released yet. Its release page will give the
> version, the source commit and the checksums. The submission build has not been selected; its validation and
> recording timings are pending. [Submission evidence](docs/submission-evidence.md) separates the existing records.
> - The current release is [v0.1.1](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1), for
>   Linux and Windows. It explains a repository with evidence, and applies your confirmed preferences with explicit
>   precedence. Its own install and testing steps are in the
>   [README as of commit `8086464`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/blob/8086464f8f7cd2c2aadfc3adf7829d6c2755bd36/README.md).
> - Built for the next release, in this repository: explaining a repository with evidence, confirmed preferences with
>   explicit precedence, saved plans with a council review and web research, and native tasks run in Nebius
>   Sandboxes, then approved and applied by you.
> - Shown live on a packaged build, candidate 3 (0.2.0 at `c99fe9d`, not published), 28 October: a real task run.
>   This run used an unpublished revision of the author's own public repository, including frozen acceptance tests.
>   It proposed a change that passed every configured acceptance case, but the repository typecheck failed with three
>   new errors. An AI review identified the broken caller before the decision; the proposal was rejected, and the
>   checkout remained unchanged. It was not a fix: no change has yet been approved, applied and accepted live.
>
> Built for the Nebius × NVIDIA Global AI Hackathon. What isn't built yet is said so where it comes up.

## What it does

- **Explains a repository with evidence.**
  - Each finding cites the files and lines it rests on.
  - Each citation is checked against the lines the model was actually shown, and labelled as just that, never as
    proof that the explanation is right.
  - An explanation is labelled with the commit checked out when it started, and says when files changed during it.
- **Remembers preferences you confirm, kept by the app on this computer.**
  - Personal ones apply to every project; a project's own apply only to it.
  - Each run gets a snapshot of the ones that apply when it starts, so an edit or a deletion reaches the next run.
- **Applies explicit precedence.** When a repository's conventions differ from your preferences, the explanation
  reports the conflict, and the engine says which source governs. Highest first: this task's choices, a project's
  decisions to change its conventions, the repository's existing conventions, a project's defaults, then personal
  defaults.
- **Plans with you.**
  - Missions and draft tasks can be written without a repository or provider key. The task editor gives guidance on
    missing brief fields without a model. Paid mission reviews and the readiness coach still need their separate
    budget integration and useful live acceptance; they are not part of the judge walkthrough yet.
  - Conversations about a repository are saved, and a plan is kept in versions.
  - A plan version can be reviewed by a council: two independent reviewers and a chair, inside one budget.
  - A plan's assumptions can be researched on the web through Tavily, with the queries you approve. Each quotation is
    checked against the page it came from. That shows where it came from, not that it supports the conclusion.
- **Runs a task in a Nebius sandbox.**
  - A task has a brief: its goal, and acceptance cases, each a command with the exact output and exit code it must
    give. The files the cases depend on are frozen.
  - Before anything is sent, the Run preview shows what goes to Token Factory and to Nebius, what each keeps, and the
    run's limits.
  - The repository's checks run before the model starts, so a missing tool stops the run instead of wasting it: up
    to three baseline checks ("Baseline checks, before the worker"), each a command with its exact output or a pattern
    that must match all of it, and its exit code, run once with networking off.
  - NVIDIA Nemotron makes the change on a copy of one commit, with networking off. It reads and writes files and runs
    the brief's cases through fixed tools that Nivra's engine carries out; it never chooses a command.
  - Nivra judges the result outside what the model can edit: every acceptance case and required repository check
    must pass, with complete evidence that frozen files and setup inputs are unchanged. A failed or missing required
    final check blocks verification and approval. A run that changed nothing is never verified.
  - The change comes back as an exact patch, with every case's verdict. You approve it by its hash, and the engine on
    the repository's own system applies it: each original is moved aside and kept, and nothing is committed, pushed or
    staged. Then you accept the change. Instead of approving, you can reject it, or ask for a revision with a note.
- **Prepares JavaScript and TypeScript projects using npm or pnpm inside the boundary.** The committed project
  metadata determines the supported Node version and package-manager choice; missing Node declarations use a labelled
  default. Package-manager pins resolve to exact versions. When npm is bundled with the Node image, preparation
  records the version it finds. The preview shows the choices, install command, workspace packages and root tools.
  Dependencies are installed from the committed lockfile in a separate preparation, the only operation with
  networking on. Unsupported setup is refused with a reason; Python and Rust environments remain future work.
- **Asks before anything leaves.** Sending a project's content to the model, uploading its commit to Nebius, and
  sending research queries to Tavily are three separate permissions, each off until you allow it.
- *Not built:* new-app creation; task runs from the native Windows engine; macOS; package managers other than npm/pnpm;
  any execution backend besides Nebius Sandboxes.

## How it uses NVIDIA and Nebius

- **Every model call goes to NVIDIA Nemotron** (Nemotron 3.5 Super VL by default, `nvidia/Nemotron-3.5-Super-VL`)
  **through Nebius Token Factory**, at `https://api.tokenfactory.nebius.com/v1`: explanations, conversations, the
  council, research's assessment, and the task's worker. Every call has a deadline, and so does every run.
- **Sandbox checks and task runs execute in Nebius Sandboxes**, one operation per step, with state carried from step
  to step by the image each leaves.
  - Networking is off for the worker and for every check. Only an environment's preparation runs with it on, and its
    preview says where it goes.
  - **What Nebius keeps:** each upload, and each operation's record, including what a write contained. Nebius offers
    no way to delete them. Images are kept for 180 days, after which untagged ones may be deleted.
- Nivra's other backend, `Local`, provides no isolation. It runs only Nivra's own git and its hello check, and can
  never run a task.

## Platforms

| Host | Engine runs | Explain, plans, research | Sandbox checks and tasks |
|---|---|---|---|
| Linux x64 | locally | works | prepared and run live on candidate 3 (`c99fe9d`), to a proposal that was rejected; no change applied live yet |
| Windows 10/11 x64, folder in WSL 2 | in the WSL distribution that holds the folder (Ubuntu or another glibc distribution) | live explain/preferences evidence on v0.1.1; later planning checks use stand-ins | historical candidate 3 passed offline routing/UI checks; live sandbox task journey remains unproved |
| Windows 10/11 x64, folder on a Windows drive | natively on Windows | the hello run and Doctor; explanations there haven't been checked live | refused: tasks need the Linux or WSL engine |
| macOS | | not built | not built |

There is no target to choose: adding a folder decides where its work runs, by which system holds it, and each project
keeps that engine.

Linux startup behind a locked GNOME Wayland screen remains unverified (NIV-28). The five-second fallback is
implemented, but its [original-case check](docs/niv-28-manual-check.md) is deferred. Ordinary startup checks do not
establish that case.

## Credentials

Nivra calls Nebius with credentials you save under **Settings**. Nothing is built into the app.

- **A Token Factory API key.** Without one, nothing that uses a model runs. Create one in the Token Factory console,
  under API keys; it's shown only once.
- **A project id, for sandbox checks and tasks.** It is the Nebius project the key belongs to, shown under the
  project's name in its Project settings. That project needs Sandboxes access, which is in beta: request it on Nebius's
  [Sandboxes page](https://tokenfactory.nebius.com/sandboxes/about).
  - Without a project id, Nivra refuses: "A task run needs your Nebius key and project id, and they aren't both set.
    Add them in Settings, then preview the run again."
  - If the project has no Sandboxes access, or the key and the id don't belong together, Nebius turns the key down,
    and Nivra says so (HTTP 403).
- **Judge access is being arranged.** The instructions below explain the normal credential-entry flow; requiring
  judges to buy API access has not been established as meeting the hackathon's free-testing requirement. No
  development key is distributed. The [judge walkthrough](docs/judge-walkthrough.md) records the open access decision
  and the permissions each route needs. Use the onboarding sample, or code you're happy to share.

The key and the id are encrypted by your system where it can (Settings says "Key saved, encrypted"), and handed to the
engine in memory only.

## Install a test build

The next release isn't published yet. Until it is, the build to install is
[v0.1.1](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1), with the steps in the
[README as of commit `8086464`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/blob/8086464f8f7cd2c2aadfc3adf7829d6c2755bd36/README.md).
The steps below are for the next release.

Download it from the release's page on the repository's
[GitHub Releases](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases). The page gives the version, the
source commit it was built from, and the SHA256 checksum of each file: the Windows zip, the Linux deb, `SHA256SUMS` and
`build-info.json` (the commit and runtimes the build came from). To check a download, run
`sha256sum -c SHA256SUMS --ignore-missing` in Linux or WSL, or `Get-FileHash` in PowerShell, and compare with the page.

**Windows 10/11 x64**
1. Extract the zip into a folder of your own, for example `%LOCALAPPDATA%\Programs\Nivra`, and run `Nivra.exe`.
2. The build isn't code-signed. SmartScreen may ask once: choose **More info → Run anyway**. If Smart App Control is
   on, Windows may refuse an unsigned app it doesn't yet have enough reputation for, with no way to run it anyway
   ([Microsoft's explanation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
   Use the Linux build, or a PC where Smart App Control is off.
3. For folders in WSL you need WSL 2 and a distribution such as Ubuntu (`wsl --install`). The first time you add a
   folder from it, Nivra installs its own engine runtime there, under `~/.nivra`; it doesn't need Node in WSL.

**Linux x64** (Ubuntu 24.04 and similar)

```bash
sudo apt install ./Nivra-<version>-amd64.deb   # the deb's name, as the release page gives it
nivra
```

There is no AppImage: it doesn't start on a stock Ubuntu 24.04 (D10).

**Removing it**
- Windows: delete the folder, then `%APPDATA%\Nivra` (your projects, preferences and saved key) and
  `%LOCALAPPDATA%\Nivra` (the native engine's data); in WSL, `~/.nivra`.
- Linux: `sudo apt remove nivra`, then `~/.config/Nivra` and `~/.nivra`.

## Testing instructions

The duration on the selected submission build is pending measurement. The quick path can use the public onboarding sample,
[nivra-sample](https://github.com/xXValhallaCoderXx/nivra-sample): a few plain files with an MIT licence, which need
nothing installed, at commit `bbf62893cb699c6994cca9fa7219b66f87f5a30d`. The sample is optional: any git repository works, as
*Using another folder* below says, and Nivra treats the sample like any other.

**What your credentials need.**
- **Check Token Factory and Explain:** a Token Factory API key whose model listing offers an NVIDIA model. Nemotron
  3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) is preferred, and a task run uses only it.
- **The sandbox check:** the id of a Nebius project with Sandboxes access. Sandboxes is in beta, and Nebius enables it
  per project on request, on its [Sandboxes page](https://tokenfactory.nebius.com/sandboxes/about). With it, the key can
  start, list and cancel sandboxes in that project. Without it, Nebius turns the key down (HTTP 403), and Nivra says
  so.

1. Install Nivra (above).
2. Clone the sample, if you want to use it, and check out its commit. On Windows, clone it inside WSL, for example in
   `~`:
   ```bash
   git clone https://github.com/xXValhallaCoderXx/nivra-sample.git
   git -C nivra-sample checkout bbf62893cb699c6994cca9fa7219b66f87f5a30d
   ```
3. Start Nivra. Under **Settings → Connections**, save the **Nebius API key**. Explain needs no project id or Sandboxes access.
4. In the project switcher, choose **Add project…**, then the sample's folder. On Windows, browse to `\\wsl.localhost\<distribution>\home\<you>\nivra-sample`.
5. With that project selected, **Settings → Connections → Check Token Factory** is an optional paid diagnostic. It lists
   the models your key can use, makes one Nemotron call that has to use a tool to answer, then three small probes: at
   most six model requests, within 150 seconds.
6. Open **Home → Explain this project**, then press **Explain**, and allow sharing for this project when asked.
   The answer's citations say which lines the model was shown. Its duration on the selected build is pending measurement.
7. **Optional sandbox path:** save **Project ID, for Nebius Sandboxes** under **Settings → Connections**. In
   **Settings → Advanced diagnostics → Sandbox check**, press **Preview the check**: the commit, its files and bytes, what's left out and why, and
   what Nebius keeps. Then press **Upload and check**, and **Allow uploads for this project**. A check runs Nivra's own
   fixed steps with networking off: at most 8 operations, each command up to 60 seconds, 10 minutes in all, then up to
   7 minutes to close. Nothing comes back to your checkout.

A full task run on a public sample isn't offered in this release: its public reproduction is deferred. How a task run
works, and what it needs, is in *Running a task on your own repository* below.

**Using another folder.** Any git repository with at least one commit works, from the commit only: uncommitted and
untracked work is never sent.
- An explanation sends excerpts of the files the model reads to Token Factory.
- A sandbox check or a task uploads the whole commit, except files on Nivra's deny list, to the Nebius project of the
  key you saved. Nebius keeps it, and offers no way to delete it. If you share credentials with others,
  anyone holding them can read it. Nivra refuses a commit in which it finds what looks like a key or token, but it
  can't recognise every secret.

## Running a task on your own repository

- **What it needs:** a JavaScript or TypeScript repository with supported npm/pnpm setup and a committed lockfile,
  opened on the Linux engine or a WSL one; your key and project id; and both permissions for the project. Review the
  resolved versions and workspace selection, then prepare the environment before starting a task. The preview
  explains unsupported versions, install hooks or configuration instead of silently substituting another setup.
- **What you write:** the brief's goal, and its acceptance cases. Each case is a command, and the exact output and exit
  code only the right behaviour gives: a case that only prints "passed" can be satisfied by the wrong change.
- **What bounds a run:** **Preview the run** shows its actual model, request and completion allowances, estimated
  context admission, tool/write/command allowances and deadlines. A monthly allowance applies only to the workflows
  explicitly included in its saved policy; it is not a provider credit balance. Unknown billed cost stays unknown.
- **What reaches your checkout:** nothing, until you approve the patch by its hash. Then the change is left unstaged,
  each original is kept in the repository's git folder (`nivra-apply`), and nothing is committed or pushed.

## If something goes wrong

- *"Another Nivra engine is using …"*: another Nivra window is using that engine. Close it, then press Retry.
- *WSL is missing, or has no usable distribution*: Nivra's WSL panel says what to install. Install it, then press
  Check again.
- *"No Nebius key is set"*: add your key under Settings.
- *Explain asks before sending*: sending a project's content to Token Factory stays off until you allow it for that
  project. Uploads to Nebius have their own permission.
- *"A task run needs your Nebius key and project id…"*: save both under Settings, then preview the run again.
- *"Nebius turned the key down (HTTP 403)…"*: the project has no Sandboxes access, or the project id isn't the key's
  own. Check both, then try again.
- *The environment no longer matches:* select **Environment → Preview the preparation** (or **Preview preparing
  again**) and review the reason. Changed setup files, install choices or Nebius project may require preparation
  again. If dependency builds were skipped, review the reported list before accepting that environment or preparing again.

## Build from source

Requirements: Node 24.21.0 and pnpm 10.4.1.

```bash
pnpm install --frozen-lockfile
pnpm verify                 # typecheck and every test
pnpm dev                    # run the app (Linux, or WSLg on Windows)
pnpm package:linux          # the deb (and an AppImage, which isn't shipped) in apps/desktop/release
pnpm package:win            # Windows zip, built from WSL
```

For a development build on Windows, Nivra installs its engine runtime into the WSL distribution under
`~/.nivra-dev`; the packaged release uses `~/.nivra`. The shipped runtime does not require a separate Node install
in WSL. Keep test profiles and engine homes separate from both normal homes.

To check Token Factory access from a terminal, provide `NEBIUS_API_KEY` through your private shell session, then run
the same paid check as Settings' (a model listing, then at most six model requests):

```bash
pnpm probe:tokenfactory
```

## How it is built

An Electron + React + Mantine window talks to a separate engine process over JSON-RPC on stdio. The engine runs where
the repository lives — on the host, or inside a WSL2 distribution — and uses Mastra for workflows and SQLite for its
records. Decisions and their reasons are in [docs/decisions.md](docs/decisions.md); what "working" means, and the
evidence for it, is in [docs/acceptance.md](docs/acceptance.md).

## Provenance

Nivra reuses concepts and some code from Hird, an earlier app by the same author. Every reused piece is listed with
its source commit in [docs/provenance.md](docs/provenance.md).

## Licence

MIT — see [LICENSE](LICENSE).
