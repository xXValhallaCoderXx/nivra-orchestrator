# Nivra

A desktop workspace for engineers. It explains a repository with evidence, and remembers the engineer's confirmed
preferences across projects without letting them override a project's own conventions.

> **Status:** v0.1.1 is released for Windows, with WSL, and for Linux.
> - Built: explaining a repository with evidence, confirmed preferences with explicit precedence, and task choices.
> - These passed live acceptance on the packaged builds, with NVIDIA Nemotron through Nebius Token Factory.
>
> Built for the Nebius × NVIDIA Global AI Hackathon. Sections marked *planned* describe work that isn't built yet.

## What it does

The target demonstration for the current milestone is read-only:

> "Explain this repository using evidence. Remember the preference I confirm. Show that it follows me to another
> project without overriding that project's own conventions, and that editing or deleting it changes what happens
> next."

- **Built:** repository explanations that cite the files and lines they rest on.
  - Each citation is checked against the lines the model was actually shown, and is labelled as just that, never as
    proof that the explanation is right.
  - An explanation is labelled with the commit checked out when it started, and says when files changed during it.
- **Built:** preferences you confirm, kept by the app on this computer.
  - Personal ones apply to every project; a project's own apply only to it.
  - Each run gets a snapshot of the ones that apply when it starts, so an edit or a deletion reaches the next run.
  - You can edit, replace or delete them, and export or import them. Suggestions drawn from a repository are saved only
    when you keep them.
- **Built:** explicit precedence.
  - When a repository's conventions differ from your preferences, an explanation reports the conflict, and the engine
    says which source governs.
  - Highest first: this task's choices, a project's decisions to change its conventions, the repository's existing
    conventions, a project's defaults, then personal defaults.
  - A task's choice governs that run only. It is shown as intended, never as current behaviour.
- **Built:** per-project consent before any repository content is sent to a model, off by default. Turning it off
  stops that project's explanations.
- *Deferred to a later milestone:* new-app creation and coding work inside a sandbox.

## How it uses NVIDIA and Nebius

- **Built:** explanations call **NVIDIA Nemotron** (Nemotron 3 Super by default) through **Nebius Token Factory**
  (OpenAI-compatible API at `https://api.tokenfactory.nebius.com/v1`). Nemotron reads the repository only through
  fixed, read-only tools that Nivra runs; it never runs anything itself.
- *Planned:* coding work runs in a sandbox. Nemotron only proposes actions; the engine carries them out:
  - a local Docker or Podman container by default;
  - **Nebius Token Factory Sandboxes** as a cloud option (in beta; access requested);
  - **NVIDIA OpenShell** as an optional, stricter local sandbox.
  
  Only the `Local` backend exists today. It provides no isolation and runs only the built-in hello check and git
  (for Doctor and for reading a repository's tracked files).

## Platforms

| Host | Engine runs | Status |
|---|---|---|
| Windows 10/11 x64 | in the WSL2 distribution that holds the folder (`\\wsl.localhost\…`; Ubuntu or another glibc distribution) | works (primary target) |
| Windows 10/11 x64 | natively on Windows, for folders on a Windows drive | works for the hello run and Doctor; coding work comes later |
| Linux x64 | locally | works |
| macOS | locally | later |

There is no target to choose: adding a folder decides where its work runs, by which system holds it, and each project
keeps that engine.

## Install a test build

Download v0.1.1 from the repository's [GitHub Releases](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases):
`Nivra-0.1.1-win-x64.zip` for Windows or `Nivra-0.1.1-amd64.deb` for Linux, with `SHA256SUMS` and `build-info.json`
(the commit and runtimes the build came from). To check a download, run `sha256sum -c SHA256SUMS --ignore-missing` in
Linux or WSL, or `Get-FileHash` in PowerShell.

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
sudo apt install ./Nivra-0.1.1-amd64.deb
nivra
```

There is no AppImage: it doesn't start on a stock Ubuntu 24.04 (D10).

**Removing it**
- Windows: delete the folder, then `%APPDATA%\Nivra` (your projects, preferences and saved key) and
  `%LOCALAPPDATA%\Nivra` (the native engine's data); in WSL, `~/.nivra`.
- Linux: `sudo apt remove nivra`, then `~/.config/Nivra` and `~/.nivra`.

**If something goes wrong**
- *"Another Nivra engine is using …"*: another Nivra window is using that engine. Close it, then press Retry.
- *WSL is missing, or has no usable distribution*: Nivra's WSL panel says what to install. Install it, then press
  Check again.
- *"No Nebius key is set"*: add your key under Settings.
- *Explain asks before sending*: sending a project's content to Token Factory stays off until you allow it for that
  project.

## Build from source

Requirements: Node 24.21.0 and pnpm 10.4.1.

```bash
pnpm install --frozen-lockfile
pnpm verify                 # typecheck and every test
pnpm dev                    # run the app (Linux, or WSLg on Windows)
pnpm package:linux          # deb and AppImage in apps/desktop/release
pnpm package:win            # Windows zip, built from WSL
```

On Windows, Nivra installs its own engine runtime into a WSL distribution (under `~/.nivra`) the first time you add a
folder from it; it does not need Node in WSL.

To check Token Factory access (lists the models, makes one Nemotron tool call, then checks tool choice):

```bash
NEBIUS_API_KEY=... pnpm probe:tokenfactory
```

## Testing instructions

A full pass takes about ten minutes. Each explanation sends excerpts of the public repository it explains to NVIDIA
Nemotron through Nebius Token Factory, and nothing else leaves your machine.

1. Install Nivra (above).
2. Clone the two public demonstration repositories, whose conventions contrast. On Windows, clone them inside WSL, for
   example in `~`:
   ```bash
   git clone https://github.com/xXValhallaCoderXx/valhalla-fitness
   git clone https://github.com/xXValhallaCoderXx/nivra-demo-timer
   ```
3. Start Nivra. Under **Settings**, paste the Token Factory key from the submission's private testing instructions (or
   your own), then press **Save**.
4. **Add** `valhalla-fitness`; on Windows, browse to `\\wsl.localhost\<distribution>\home\<you>\valhalla-fitness`.
   Press **Explain**, and allow sharing for this project. The answer's citations say which lines the model was shown.
5. Under **Preferences**, confirm *Name component files in PascalCase; write tests with Vitest* for **Every project**,
   and *valhalla-fitness builds its web UI with Mantine* for `valhalla-fitness` only.
6. **Add** `nivra-demo-timer` and **Explain** it. Under **Conflicts**, its kebab-case files and Jest govern over your
   personal default. **Context used** shows what the run received: never the `valhalla-fitness`-only preference.
7. Add the task choice *Use PascalCase for this task*, then **Explain** again. The choice governs this run only:
   "Currently" still shows the repository's convention, and your stored preferences don't change.
8. Edit the personal preference, then delete it, and **Explain** after each: every run uses your preferences as they
   are now.

What a run may send, and what it never sends, is in [docs/decisions.md](docs/decisions.md) (D20 to D23).

## How it is built

An Electron + React + Mantine window talks to a separate engine process over JSON-RPC on stdio. The engine runs where
the repository lives — on the host, or inside a WSL2 distribution — and uses Mastra for workflows. Decisions and their
reasons are in [docs/decisions.md](docs/decisions.md); what "working" means is in
[docs/acceptance.md](docs/acceptance.md).

## Provenance

Nivra reuses concepts and some code from Hird, an earlier app by the same author. Every reused piece is listed with
its source commit in [docs/provenance.md](docs/provenance.md).

## Licence

MIT — see [LICENSE](LICENSE).
