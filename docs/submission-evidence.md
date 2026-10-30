# Submission evidence (NIV-50)

**Inventory checked 30 October 2026.** Documentation base and fetched main are
`75b38e07ca191cb79b16468d95941a21c47fe1c8`. This is not a selected submission build. GitHub still lists v0.1.1,
published 19 October, as the latest public release. Local candidates 3 and 4 are historical, unpublished builds.
No application suite, Windows/packaged check, VM check or paid call was run for this documentation pass.

## What existing evidence establishes

Commit links identify the source; the linked repository records explain commands and build fingerprints. These
are retained results, not tests rerun for the documentation. A source inspection establishes implementation only.

| Feature | Exact source or build | Platform and evidence type | Recorded result | Remaining limitation |
|---|---|---|---|---|
| Explain and confirmed preferences | Published v0.1.1; source [`cad5eca`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/commit/cad5eca680c75148728f53639a70259f746e45f0) | Linux Ubuntu GNOME VM; native Windows host with WSL engine; live packaged checks | v0.1.1 clean setups: 22/22 Linux and 23/23 Windows→WSL. Earlier 14/14 live criteria per route carry from v0.1.0 only because Linux/WSL payloads are unchanged | Historical model/build only; Windows shared the owner's account and mirrored networking; not a clean PC without VC++ runtime. [Clean-setup record](clean-setup.md#results), [published release](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1) |
| Current NVIDIA-model compatibility | Source [`77e3a45`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/commit/77e3a45a8ad74aef0d1f5638a7c4ec633c1c92dd); `nvidia/Nemotron-3.5-Super-VL` | Linux source check through the production model client, 28 October | Five inference requests answered; tool choices and a schema-valid answer observed; 3,293 input and 1,489 completion tokens, including 547 reasoning tokens | Forced answer reached its 1,000-token cap. Small compatibility probes, not a full task, useful coaching, billing proof or selected-build acceptance. [D50](decisions.md#d50-nemotron-35-super-vl-replaces-nemotron-3-super-and-every-requests-cap-is-sent-as-max_completion_tokens-2026-10-28) |
| Environment preparation, task execution and human rejection | Candidate 3, 0.2.0, source [`c99fe9d`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/commit/c99fe9d6e7dd5cbb94d8de7df881988299fe3c05); Nemotron 3 Super | Linux packaged app, real Nebius, 28 October | Preparation and 20 model calls; 232 data tests passed, four skipped; 1,122 domain tests passed; typecheck failed with three new errors; AI review found the broken caller; Nate rejected; checkout unchanged | No live approved/applied/accepted fix. Its recorded acceptance-only verification predates NIV-67. [Candidate/run record](acceptance.md#niv-35s-live-runs-and-the-candidates-they-ran-on-d46-d47) |
| Candidate-3 Windows routing and UI | Same frozen `c99fe9d` build; Linux runtime `243e80bf38451c39`, Windows `982edbd3e39bd053` | Real Windows process, native/WSL engines; external services replaced by stand-ins | 37/37 runtime/zip checks and 13/13 Windows app checks | No live Windows-to-WSL sandbox task. These receipts do not validate later code or the selected submission build. [Candidate checks](acceptance.md#niv-35s-live-runs-and-the-candidates-they-ran-on-d46-d47) |
| npm/pnpm setup and workspace selection | Recorded source [`9787c2e`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/commit/9787c2e8f95d1e45d19b6aeb3c0fda8b4c7429dd), D48/D52; implementation retained in documentation base | Deterministic resolver, real-engine and built UI checks with sandbox stand-ins | Preview, chosen packages/root dependencies, install arguments, readiness and refusal behaviour covered | Does not establish a real filtered install on current source; NIV-58/59 evidence remains separate. [Workspace record](acceptance.md#workspace-package-selection-d52-niv-55-pr-43) |
| Required repository-check enforcement | Integrated source [`ffc4961`](https://github.com/xXValhallaCoderXx/nivra-orchestrator/commit/ffc4961e34258bbf09c249f7ac8b29dd5302b814), with later review corrections recorded separately; retained in documentation base | Offline source, real stdio engine, Linux built/packaged app, Windows UI | Integration: 1,856 tests/typechecks; 13 built journeys; 80 packaged checks passed, 72 conditional skips; 15 Windows checks. Failed required final checks and forged reports cannot admit approval | Deterministic gate evidence only, not a live task result. Later correction receipts and their own source identities remain in the [full record](acceptance.md#required-repository-checks-and-trustworthy-approval-niv-67-d57--30-october-2026) |
| Native mission and brief editing | Documentation-base source `75b38e07ca191cb79b16468d95941a21c47fe1c8`; earlier mission journey recorded by NIV-52 | Source inspection plus retained built UI journeys with scripted replies | Manual authoring available without a provider key; mission journey covers correct task links, deliberate brief v2 and stale reports | No paid mission review has passed usefulness acceptance. NIV-52 owns its grant/recovery integration. [NIV-52 record](niv-52-verification.md) |
| Task-readiness coach | Historical frozen source fingerprint `0052684eb79d0bb28fd5d22ee16d6728b8a11f7a76b062bcddb35ea25e7c2a97`, Windows build fingerprint `4e6f454b173bcb98a0f019bbb9b167efde81578f51d6918125aa9f7f7bbd7735` | One real Windows coaching with Nemotron 3.5 Super VL; later code/offline follow-up | One call reported 2,410 input/4,000 completion tokens, stopped at the cap, no usable answer or brief save. PR57 raises completion reservation to 8,000 | Useful live coaching and host-ledger admission remain open; old failure does not validate the raised cap. [NIV-53 record](niv-53-verification.md#actual-live-result) |
| Locked GNOME Wayland startup (NIV-28) | Five-second fallback included in documentation-base source after PR53 | Controller mocks and ordinary Linux/Windows startup, not the original locked-GNOME case | Ordinary startup checks passed at their recorded candidate | Original-case packaged check is deferred by Nate; no VM started. [Saved manual procedure](niv-28-manual-check.md), [record](acceptance.md#niv-28-bounded-window-startup-visibility-30-october-2026) |

The sample is public and MIT-licensed at `bbf62893cb699c6994cca9fa7219b66f87f5a30d`. It offers a plain-file Explain
and fixed sandbox-check route, not a public reproduction of the historical coding task. J0/J1 on 28 October at
`7a0acbe70e4940c9ce03301dc74bf4922531264e` established only the owner's inference/project access. Their results do
not establish judge access or compatibility of the final selected build.

## Final build record to complete

After NIV-52's reviewed result is known, agree the build with Nate. Record the version, full commit, source state,
engine/protocol versions, Node/Electron identities, each runtime hash, both app hashes and asset SHA-256 values from
its own manifest. None has been selected here. Keep the source and frozen assets together.

For each advertised route, link the matching receipt with command, working directory, source/build, platform,
status, skips and limitation. When carrying an earlier result, identify its original source and show why the relevant
code is unchanged. Do not relabel it as a fresh check. Documentation-only changes do not require rebuilding accepted
binaries; runtime changes need their applicable checks.

## Recording and closure

- Use the [2:50 outline](demo-script.md) and actual footage. Each historical still keeps its own build, model,
  date and outcome. New coaching/mission-review results need their own matched acceptance before inclusion.
- Candidate-3 stills are parked pending their recorded caption correction and visual review. In local
  `~/nivra-acceptance/candidates/v0.2.0-c99fe9d/screens/CORRECT-BEFORE-REUSE.md`, Nate requires stills 1–3 to say
  “Grey boxes hide project details and unpublished content”. Preserve the masks, review the changed images and
  regenerate their hashes before use. No still was changed by this documentation pass.
- Free judge access and its owner are unresolved; choose and test an [access option](judge-walkthrough.md#access-options-for-nate).
  Keep it available through **24 December 2026 at 04:00 SGT**.
- Review the [Devpost draft](submission.md) and [release notes](release-notes.md), replace final-build/video fields
  only from actual evidence, publish unchanged assets and verify downloaded hashes and public links.
- Nate publishes/submits unless separately delegated. Record his actual Devpost confirmation and final links.
  A docs change or feature merge alone does not close NIV-50.
