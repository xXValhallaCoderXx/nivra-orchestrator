# Nivra

A desktop workspace for engineers. It explains a repository with evidence, remembers the engineer's confirmed
preferences, and runs a coding task in a Nebius sandbox, where tests the agent can't edit judge the change. Nothing
reaches your checkout until you approve that exact change.

> **Status:** this README describes the next release, which isn't released yet. Its release page will give the
> version, the source commit and the checksums; the values marked PENDING- here are filled in when it is out.
> - The current release is [v0.1.1](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1), for
>   Linux and Windows. It explains a repository with evidence, and applies your confirmed preferences with explicit
>   precedence. Its own install and testing steps are in the
>   [README as of commit `8086464`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/blob/8086464f8f7cd2c2aadfc3adf7829d6c2755bd36/README.md).
> - Built for the next release, in this repository: explaining a repository with evidence, confirmed preferences with
>   explicit precedence, saved plans with a council review and web research, and native tasks run in Nebius
>   Sandboxes, then approved and applied by you.
> - Shown live on a packaged build: PENDING-H3.
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
  - Nivra judges the result outside what the model can edit: every case's output is compared byte for byte on this
    computer, and the frozen files must be unchanged (PENDING-H2). A run that changed nothing is never verified.
  - The change comes back as an exact patch, with every case's verdict. You approve it by its hash, and the engine on
    the repository's own system applies it: each original is moved aside and kept, and nothing is committed, pushed or
    staged. Then you accept the change. Instead of approving, you can reject it, or ask for a revision with a note.
- **Prepares a Node and pnpm environment inside the boundary** (Node 22.23.4 from the `node:22.23.4-alpine3.24` image,
  and the exact pnpm version the repository's `package.json` pins in `packageManager`): the Node image is imported into
  your Nebius project, and the dependencies are installed from the frozen lockfile in a run of its own, the only one
  with networking on. Its preview says so first.
- **Asks before anything leaves.** Sending a project's content to the model, uploading its commit to Nebius, and
  sending research queries to Tavily are three separate permissions, each off until you allow it.
- *Not built:* new-app creation; task runs from the native Windows engine; macOS; package managers other than pnpm;
  any execution backend besides Nebius Sandboxes.

## How it uses NVIDIA and Nebius

- **Every model call goes to NVIDIA Nemotron** (Nemotron 3 Super by default, `nvidia/nemotron-3-super-120b-a12b`)
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
| Linux x64 | locally | works | PENDING-H3 |
| Windows 10/11 x64, folder in WSL 2 | in the WSL distribution that holds the folder (Ubuntu or another glibc distribution) | works | PENDING-WSL |
| Windows 10/11 x64, folder on a Windows drive | natively on Windows | the hello run and Doctor; explanations there haven't been checked live | refused: tasks need the Linux or WSL engine |
| macOS | | not built | not built |

There is no target to choose: adding a folder decides where its work runs, by which system holds it, and each project
keeps that engine.

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
- **Judges** use their own key and project id, as any user does. The quick path's sandbox check needs a project with
  Sandboxes (beta) access, requested on the Sandboxes page above. Everything uploaded stays with Nebius in your
  project. Use the onboarding sample below, or code you're happy to share.

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

The quick path takes about PENDING-TAKE minutes. It uses the public onboarding sample,
[nivra-sample](https://github.com/xXValhallaCoderXx/nivra-sample): a few plain files with an MIT licence, which need
nothing installed. Use the commit named here, so what you upload is what was checked: PENDING-SAMPLE-COMMIT.

1. Install Nivra (above).
2. Clone the sample, and check out that commit. On Windows, clone it inside WSL, for example in `~`:
   ```bash
   git clone https://github.com/xXValhallaCoderXx/nivra-sample.git
   git -C nivra-sample checkout PENDING-SAMPLE-COMMIT
   ```
3. Start Nivra. Under **Settings**, paste your key and press **Save**, then your project id and **Save**.
4. **Add** the sample's folder. On Windows, browse to `\\wsl.localhost\<distribution>\home\<you>\nivra-sample`.
5. Under **Settings**, press **Check Token Factory from …** (the label names the system the folder is on). It lists
   the models your key can use, makes one Nemotron call that has to use a tool to answer, then three small probes: at
   most six model requests, within 150 seconds.
6. Press **Explain**, and allow sharing for this project when asked. The answer's citations say which lines the model
   was shown. An explanation takes about PENDING-TAKE minutes.
7. Under **Sandbox check**, press **Preview the check**: the commit, its files and bytes, what's left out and why, and
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

- **What it needs:** a repository whose checks run with Node 22.23.4 and the exact pnpm version its `package.json`
  pins in `packageManager`, opened on the Linux engine or a WSL one; your key and project id; and both permissions for
  the project.
- **What you write:** the brief's goal, and its acceptance cases. Each case is a command, and the exact output and exit
  code only the right behaviour gives: a case that only prints "passed" can be satisfied by the wrong change.
- **What bounds a run:** PENDING-H2, the limits the Run preview shows.
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
- PENDING-H2: the environment's own messages, such as one prepared in another Nebius project.

## Build from source

Requirements: Node 24.21.0 and pnpm 10.4.1.

```bash
pnpm install --frozen-lockfile
pnpm verify                 # typecheck and every test
pnpm dev                    # run the app (Linux, or WSLg on Windows)
pnpm package:linux          # the deb (and an AppImage, which isn't shipped) in apps/desktop/release
pnpm package:win            # Windows zip, built from WSL
```

On Windows, Nivra installs its own engine runtime into a WSL distribution (under `~/.nivra`) the first time you add a
folder from it; it does not need Node in WSL.

To check Token Factory access from a terminal, the same check as Settings' (a model listing, then at most six model
requests):

```bash
NEBIUS_API_KEY=... pnpm probe:tokenfactory
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
