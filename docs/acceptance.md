# Acceptance

What "working" means for Nivra's proof of concept, and how each claim is checked. A check counts only when it was
run; a skipped check is reported as skipped.

## The demonstration

> "Explain this repository using evidence. Remember my confirmed preference. Start a new small web app using my
> relevant defaults. Show me the proposed choices before making changes."

Fixtures, kept small and checked in under `fixtures/` when the steps that use them are built:

- **Repository A** follows familiar conventions (React, TypeScript, Mantine).
- **Repository B** follows deliberately different conventions (another component library and layout), so that
  personal defaults visibly do not override a project's own conventions.
- **An empty destination folder** for the new-app workflow.

## Proof-of-concept acceptance suite

Run on Windows with a WSL engine and on Linux. Native Windows is tracked separately until its coding worker passes.
macOS is deferred.

| Test | Required result |
|---|---|
| Existing repository versus personal defaults | The existing repository's conventions are respected. |
| New project | Relevant confirmed defaults are proposed without being entered again. |
| Explicit override | A task-specific choice wins without silently rewriting the global profile. |
| Context isolation | Project A's private decisions do not appear in project B. |
| Changed or deleted memory | Future requests stop using the obsolete preference. |
| Cancellation and restart | The app reports the true state and does not silently replay a write operation. |

## Bootstrap exit checks

The cross-platform foundation is done when all of these were seen to pass:

- **Engine targets, verified locally (D14):** on Linux (`pnpm verify`), and on native Windows and in WSL from a real
  Windows parent (`pnpm verify:windows`), the engine starts, streams the `hello` run, cancels it with no surviving
  child, and exits cleanly, with the engine home and the repository in paths containing spaces, non-ASCII characters,
  `%` and `#`; an engine also dies with a parent that was killed. *Seen passing 2026-10-16: 15/15.*
- **Stdout purity:** every line the engine writes to stdout parses as JSON-RPC, through hello, cancel and a provider
  check.
- **Secrets canary:** a fake key never appears in `nivra.db*`, `mastra.db*` or the logs.
- **Restart:** a run still marked running when the engine starts again ends as failed with `run.interrupted` and is
  not replayed. A second engine on the same home is refused.
- **Packaged Windows app**, on the WSL and the native target: finds and provisions Ubuntu, runs hello on a repository
  whose path has spaces, streams, cancels, and quits with no engine left running (`pgrep` in WSL, `tasklist` on
  Windows). *Seen passing 2026-10-17 through the real UI (`test:windows`, 3/3); the zip carries both runtimes.*
- **Packaged Linux app** (`electron-builder --dir`): the same flow on the local target through the real UI
  (`test:packaged`, 5/5). *Seen passing 2026-10-17.*
- **Actionable refusals** for: no WSL, WSL1, `docker-desktop`, a musl distribution, ARM64, a distribution never
  opened, and missing git. *Covered by unit tests with captured tool output; not yet seen on a machine that has them.*
- **Installed deb** on Ubuntu 24.04, launched without changing AppArmor: the same flow on the local target. *Not yet
  run: installing needs sudo.*
- **Token Factory** reached from both the WSL and the native engine: models listed and one Nemotron call made
  (Settings → Check Token Factory, on each target). *Waiting for an API key.*
- **Clean machine:** the Windows zip runs native hello on a VM or Windows Sandbox with no Visual C++ redistributable
  installed. *Not yet run.*

## Hackathon submission checklist

- [ ] Public repository with the MIT licence and a README covering NVIDIA model use, Nebius use, setup and testing.
- [ ] A test build at a URL (GitHub Release with the Windows installer and the Linux deb).
- [ ] A demo video under three minutes on YouTube, showing the demonstration above.
- [ ] Track: Coding and Agentic Engineering; the coding workflow operates within Token Factory Sandboxes.
- [ ] Feedback on Nebius Token Factory and the NVIDIA models and tools used.
- [ ] Explanation of pre-existing components ([provenance.md](provenance.md)).
