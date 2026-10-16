# Nivra

A desktop workspace for engineers that explains a repository with evidence, remembers the engineer's confirmed
preferences across projects, and runs coding work inside an execution boundary that enforces its limits instead of
just asking for approval.

> **Status:** bootstrap in progress for the Nebius × NVIDIA Global AI Hackathon (Coding and Agentic Engineering
> track). Sections marked *planned* describe work that is not built yet.

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
- *Planned:* scaffolding, dependency installs and verification run inside **Nebius Token Factory Sandboxes**.
- *Planned, optional:* **NVIDIA OpenShell** as a local execution boundary on Linux and WSL2, when it is installed.

## Platforms

| Host | Engine runs | Status |
|---|---|---|
| Windows 10/11 x64 | inside a WSL2 distribution (Ubuntu or another glibc distribution) | *planned* — primary target |
| Windows 10/11 x64 | natively on Windows | *planned* |
| Linux x64 | locally | *planned* |
| macOS | locally | later |

## Install a test build

*Planned:* installers will be attached to the repository's GitHub Releases. The Windows installer is not code-signed
during the hackathon: Windows SmartScreen asks once — choose **More info → Run anyway**.

## Build from source

Requirements: Node 24.21.0 and pnpm 10.4.1.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

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
