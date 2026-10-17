# Nivra

A desktop workspace for engineers. It explains a repository with evidence, and remembers the engineer's confirmed
preferences across projects without letting them override a project's own conventions.

> **Status:** the cross-platform foundation is built and verified: Windows with a WSL or native engine, and Linux.
> Explaining a repository with evidence is built, tested offline, and has run live on NVIDIA Nemotron through Nebius
> Token Factory. Built for the Nebius × NVIDIA Global AI Hackathon. Sections marked *planned* describe work that isn't
> built yet.

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
  - Explanations report where a repository's conventions differ from them, and the repository wins.
- **Built:** per-project consent before any repository content is sent to a model, off by default. Turning it off
  stops that project's explanations.
- *Planned:* overrides and full precedence between a task's own choices, a project's conventions and personal
  preferences, and suggestions drawn from a repository that only you can confirm.
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

*Planned:* installers will be attached to the repository's GitHub Releases. The Windows installer is not code-signed
during the hackathon: Windows SmartScreen asks once — choose **More info → Run anyway**. On a PC where Windows Smart
App Control is on, Windows refuses to start an unsigned app, with no way to run it anyway; the Linux build is not
affected.

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

*Planned:* step-by-step instructions for judges (NIV-16).

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
