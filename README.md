# Nivra

A desktop workspace for engineers that explains a repository with evidence, remembers the engineer's confirmed
preferences across projects, and runs coding work inside an execution boundary that enforces its limits instead of
just asking for approval.

> **Status:** the cross-platform foundation is built and verified (Windows with a WSL or native engine, and Linux);
> the AI features are next. Built for the Nebius × NVIDIA Global AI Hackathon (Coding and Agentic Engineering track).
> Sections marked *planned* describe work that is not built yet.

## What it does

The target demonstration:

> "Explain this repository using evidence. Remember my confirmed preference. Start a new small web app using my
> relevant defaults. Show me the proposed choices before making changes."

- *Planned:* repository explanations that cite the files and lines they rest on.
- *Planned:* an inspectable store of confirmed engineer preferences, kept separate from each project's own
  conventions and decisions.
- *Planned:* a new-app workflow that proposes choices from those preferences, waits for approval, then scaffolds and
  verifies inside a sandbox.

## How it uses NVIDIA and Nebius

- *Planned:* model calls use **NVIDIA Nemotron** models through **Nebius Token Factory** (OpenAI-compatible API at
  `https://api.tokenfactory.nebius.com/v1`).
- *Planned:* coding work runs in a sandbox. Nemotron only proposes actions; the engine carries them out:
  - a local Docker or Podman container by default;
  - **Nebius Token Factory Sandboxes** as a cloud option (in beta; access requested);
  - **NVIDIA OpenShell** as an optional, stricter local sandbox.
  
  Only the `Local` backend exists today. It provides no isolation and runs only the built-in hello check and Doctor's
  git check.

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
during the hackathon: Windows SmartScreen asks once — choose **More info → Run anyway**.

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

To check Token Factory access (lists the models, then makes one Nemotron tool call):

```bash
NEBIUS_API_KEY=... pnpm probe:tokenfactory
```

## Testing instructions

*Planned:* step-by-step instructions for judges, using the fixture repositories in `fixtures/`.

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
