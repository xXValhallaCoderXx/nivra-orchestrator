# Execution release notes (draft, NIV-50)

**Not published.** Prepared against main `75b38e07ca191cb79b16468d95941a21c47fe1c8` on 30 October 2026.
The current public release remains [v0.1.1](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1).
Nate selects the submission build after the active fixes are reviewed. Copy only the features and checks supported
by that build into the final release notes.

| Release identity | Value |
|---|---|
| Version, tag and release URL | Pending selection/publication |
| Source commit and clean source record | Pending selection |
| Linux/Windows app hashes and runtime identities | Pending selected-build `build-info.json` |
| Linux deb and Windows zip hashes | Pending frozen `SHA256SUMS`, then downloaded-asset verification |
| Relevant source, real-engine, packaged and Windows results | Pending evidence review for the selected build; do not substitute a historical candidate's receipt |
| Public video and measured duration | Pending recording, review and publication |

## Changes since v0.1.1

- Native missions, task briefs and saved plans put intent before execution. Draft authoring and basic readiness
  guidance work without a repository or provider key. Saved-plan council reviews and Tavily research retain their
  own evidence; mission-review and coach paid acceptance remain separate open work.
- Supported JavaScript and TypeScript projects resolve Node and npm/pnpm setup from the committed metadata. The
  preview names the install, workspace selection and network access. Dependencies install only during environment
  preparation inside Nebius; checks and task runs use the ready image with networking off.
- A Nemotron worker can change a copy of one commit in Nebius Sandboxes. The person sees what will be sent and
  explicitly allows model sharing and uploads. Current source prefers `nvidia/Nemotron-3.5-Super-VL`; final claims
  must retain the selected build's actual model and served-model evidence.
- Required final repository checks now decide verification alongside acceptance cases and frozen/setup integrity.
  A passing acceptance suite with a failing final typecheck cannot qualify. This enforcement has deterministic
  evidence; the older live task ran before it and was rejected by the person.
- Approval names the exact patch hash. The repository's own engine applies it unstaged, keeping originals in the
  git folder for recovery. No commit or push is made. Approval and apply have offline evidence; a useful live
  end-to-end apply/accept result remains unproved.

## Evidence and limitations

The [evidence table](submission-evidence.md) names each recorded revision and platform. Candidate 3's Linux live
task used Nemotron 3 Super, passed its configured acceptance suites, failed its repository typecheck, and was rejected
after review identified the broken caller. The checkout remained unchanged. It is neither a successful fix nor a
live demonstration of the newer required-check gate. New-model tool probes establish compatibility, not task quality.

Linux has historical live sandbox evidence. Windows-to-WSL routing and UI have offline evidence; a live Windows
sandbox task remains unproved. Native Windows tasks are refused. macOS, Python/Rust environments, other package
managers, Linear intake and other execution backends are outside this release scope. The locked GNOME Wayland
startup case (NIV-28) remains deferred and unverified; ordinary startup checks do not replace it.

## Install and judge access

Attach the unchanged deb, zip, `build-info.json` and `SHA256SUMS` for the selected build. Verify the public download
hashes against the frozen manifest. Link the README for installation and the [judge walkthrough](judge-walkthrough.md)
for the separate Explain and sandbox routes. A Token Factory key suffices for Explain; sandbox operations also need
the key's project id and Sandboxes access.

Free judge access, the service-cost owner and availability through 24 December 2026 at 04:00 SGT remain to be
resolved. No development credentials are included. The release, video and submission remain Nate's publication
steps; this draft provides no publication or paid-run approval.
