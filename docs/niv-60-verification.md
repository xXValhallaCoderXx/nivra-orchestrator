# NIV-60 implementation and evidence

Local implementation on `feature/niv-60`, based on merged main
`f1eaf4770dd8e5b3cd44340ed4131496455526e2`, 30 October 2026. Current-main integration and PR verification are recorded below.
This record does not mark NIV-60 complete. The agreed
[implementation handoff](https://linear.app/sentiment-hound/document/niv-60-implementation-handoff-reliable-coding-on-larger-tasks-32156fd9d31d)
and the user's late-reply/larger-task additions remain the acceptance requirements.

## Delivered behaviour

1. Precise editing: fixed engine-owned hash-checked UTF-8 splices, replacement up to 16 KiB and result up to the
   existing 2 MiB policy, preserved mode and downloaded read-back; creation stays at 32 KiB. Full-result protection
   applies before encoding. Identical edits use no write, submission closes work tools, early model completion is
   reported accurately and three repeated failed work operations on unchanged files leave only hand-in. Reads/searches
   do not trigger no-progress; verified writes reset repetition history.
2. Budgeted attempts: a previewed editable maximum, default 64 working requests plus one hand-in outside new monthly
   coding coverage. Explicit monthly opt-in counts prior coding in the current established month without resetting
   history. Older recovery statements require their own acknowledgement. Host-guarded portions extend existing grants
   and cumulative boundary operation capacity between settled operations, with one final reserve and unchanged time
   and context boundaries. Late replies after cancellation, submission, finalisation or host timeout are refused.
3. Evaluation preparation: separate clean A1/B1/C1 acceptance and validation copies, unchanged pinned commits and
   frozen cases, whole-project install scope compatible with their pinned pnpm, and current live-recipe checks.
   Private credentials can be supplied through the existing Settings bridge without entering recipes or logs.

The monthly request pool does not establish sandbox cost coverage, a token ceiling, a dollar ceiling or an account
invoice limit. Sandbox operations/seconds retain their existing accounting and finite per-run bounds. No user-repository
proposal has been applied. A1's live validation passed on `63ae1d8`; no live worker has started. The review corrections
and the remaining approval boundary are recorded below. PR #54 remains on hold for merging.

## Offline evidence

Commands run from the Nivra checkout with Node 24.21.0 and pnpm 10.4.1. Heavy checks use
`/tmp/nivra-heavy-check.lock`; tests use disposable homes and local provider stand-ins. Local ignored receipts are in
`.artifacts/niv60/`. The prior release candidate at `cad5eca680c7` is preserved outside the checkout before packaging.

| Check | Observed result | Receipt |
| --- | --- | --- |
| `pnpm verify` | Passed: domain 144, desktop 765, engine 1,097; zero failures/skips | `verify.log` |
| Final editing, worker, capacity and boundary regressions | Passed 51, zero skips, including two added repetition tests after the full run | `final-editing-capacity.log` |
| Real-engine task run and editing regressions | Passed 27, including private project-id refusal before encoded dispatch | `secret-write.log` |
| NIV-60 real-host/ledger focused tests | Passed 9 | `host-ledger.log` |
| Current live recipe/credential checks | Passed 18 | `live-checks.log` |
| Real engine through `pnpm rpc task.preview` | Passed with the 64-working-request profile; no model called | `rpc-preview.log` |
| Linux and Windows runtime staging | Passed; Linux smoke checked, Windows cross-staged | `stage-runtime.log` |
| Built app | Full run: 157 passed, one existing packaged-only skip, two failures; both resolved, affected screen rerun passed 6/6 | `e2e-built.log`, `e2e-budget-final.log` |
| Packaged Linux UI | Full run: 87 passed, 72 existing skips, one outdated coverage-copy assertion failed; corrected screen rerun passed 6/6 | `e2e-packaged.log`, `e2e-budget-packaged-final.log` |
| Native Windows UI after fresh `dev:win --skip-stage --no-launch` | Passed 16/16, no skips | `windows.log` |
| Windows/WSL RPC and lifecycle, freshly staged | Passed 39/39, repeated successfully with the corrected protocol label | `windows.log`, `windows-final.log` |
| Final typecheck after the focused fixes | Passed in every package | `typecheck.log` |

The full run first exposed a project-identifier transport bypass caused by encoding the replacement. The worker now
rejects masked private content before encoding; the existing real-engine refusal test passes. A desktop check also
caught a static default number shown when main could not return limits. Numbers are now shown only after a successful
limits read; the existing no-figure failure assertion remains intact.
The other desktop failure was an assertion still expecting coding to remain outside monthly coverage. It now checks
the explicit opt-in wording and an unchecked coding control under old coverage. The full app suites were not repeated:
the affected six cases passed against both rebuilt and packaged apps. Existing packaged skips require unpackaged-only
test endpoint/engine switches, which production deliberately ignores; they are not live-provider evidence. The built
suite's one packaged-only switch-refusal case is exercised by the packaged suite. No skips were added.

The Windows transport receipt now reports the imported protocol version instead of a stale literal 23. Its native
and WSL checks exercise protocol 24 without provider calls. A final `verify:windows --skip-stage` reruns the same
39 checks against the freshly staged runtime; the final receipt is `windows-final.log`. The release's WSL home and
normal profiles remain intact; each test home is removed. The preserved prior candidate's deb, zip and build-info
all match their original `SHA256SUMS`.

The real-host enforcement fixture uses a real stdio engine, HTTP provider stand-ins and actual execution scripts on
Nivra-owned test fixtures. Its frozen check requires all 32 separate part functions and the greeting to be fixed:
65 inference requests, 33 writes, realistic prompts over 10,000 bytes each and reported cumulative input above
480,000 tokens. All four grants settle, with exactly one hand-in reserve and an untouched checkout. This is deliberately
scripted enforcement evidence, with no claim about a model's usefulness.

Separately, a monthly limit of 26 admits 25 working calls plus hand-in, refuses further work and still verifies the
useful fixture edit. An extension dispatch-guard failure sends only 16 working calls plus hand-in, keeps final
verification and exposes the guard failure. Tests cover old coverage, partial/idempotent grants, multiple targets
sharing a pool, accepted task totals, stale guard authority and explicit recovery expansion. Capacity regressions
deliver delayed positive replies after cancellation, submission and finalisation, proving no grant acceptance, no
capacity increase and no restarted work. Boundary tests reject extension while an operation is busy and demonstrate
that adding capacity resets neither usage nor the deadline.

## Representative real-task evidence remains open

Dedicated copies live under `~/nivra-acceptance/niv60/evaluation/`. Preflight checks confirm clean acceptance and
validation trees, no `nivra-validation` material in the worker snapshots and the intended frozen identities:

| Slot | Worker acceptance commit | Validation commit | Prepared validation selections |
| --- | --- | --- | --- |
| A1, SHE-65 regression | `69d63feaa54e2d14b1b4e7d0a90f9933fa6f5d65` | `a6d5505365ab9618c6066b695351612f56dce8c0` | 24 |
| B1, SHE-20 feature | `160faf512181dce591a31f8e53e787ba177cb105` | `f5fd572f0a49d13c7cf5ea0aedb56017388ff77e` | 18 |
| C1, SHE-30 multi-file bug | `29cf38cdbbc47dc0bf0f2776905f2b070ef75d7d` | `ccf1de6c4f4e5008e88d4047d352ebe13deccc12` | 12 |

Each current task recipe and validation plan passes unpaid preflight. The original package-only scope is refused
because pnpm 11.5.3 is outside Nivra's checked filtered-install range; the new recipes choose whole-project preparation
without changing source pins, frozen files or judges. The existing strict report-judge self-tests passed 8/8. This
did not prove environment readiness, baseline/reference/control results, worker check duration or successful tasks.
The subsequent A1 validation is recorded below; B1 and C1 have not run live.

Live runners require a clean committed Nivra revision; the app runner additionally requires a release candidate frozen
from that revision and a concrete claimed recipe approval. The user authorised the six exact recipes in
`~/nivra-acceptance/niv60/approval/approval.md` for `63ae1d86bf9a98937feeb3ce18252f4d84ce9e77`. Only A1 validation
ran. The other five recipes are unused and held: that approval does not authorise the changed source or build.
Review commits, pushing the branch and the PR into main are authorised; merging and applying or accepting a proposal
remain separate decisions. The PR keeps the remaining acceptance work visible.

Still required for B1 and C1: execute each frozen baseline/reference/known-wrong control in the boundary; confirm the
baseline's named failures and green unrelated checks; measure duration/output against the worker's 60-second check limit; freeze
the final build/environment/recipe identities; run one worker attempt per task; and inspect every successful proposal
against its frozen brief. Record requests, tools, writes, checks, time, interventions, known/unknown usage and failures.
Do not install or execute these repositories locally, expose validation solutions to workers, retry paid failures
without a concrete diagnostic, or apply proposals to the person's repositories.

At least one useful nontrivial proposal must pass its independent frozen checks, and C1 must receive a genuine
multi-file attempt. A useful real task must separately demonstrate work beyond a formerly limiting allowance. If
all successful tasks finish below those limits, record their successes and keep that evidence gap open. Never pad
calls or writes. Deterministic threshold tests cannot close this gap. NIV-60 stays open until these facts exist.

## PR candidate after current-main integration — 30 October 2026

Implementation commit `74a91cb` is integrated with main `7f7e26f6cd62e24993d7a8a9b34c60075e62076e` in
`51306bc4195b5001a44b403f853f6a7ffd1dbcb2`. The only merge conflict was the two appended acceptance records; both
are retained in full. NIV-28's window-visibility helper and tests are byte-for-byte unchanged from current main, and
its main-process wiring is preserved. The PR diff remains the 49 reviewed NIV-60 source/test/documentation files.

The following checks ran on that integrated implementation, superseding earlier counts for PR review:

| Command/check | Result | Local receipt |
| --- | --- | --- |
| `pnpm verify` | All typechecks and 2,015 tests passed: 144 domain, 772 desktop, 1,099 engine; no failures, cancellations or skips | `pr-verify.log` |
| Built app: app, budget usage, task run, task preferences and task discussion | 21/21 passed, no skips | `pr-ui.log` |
| Fresh Linux package, same affected cases | 20 passed, one existing skip for a task run requiring unpackaged-only endpoint switches | `pr-ui.log` |
| Fresh Windows development package, full native UI | 17/17 passed, no skips, including native-window visibility | `pr-ui.log` |
| `pnpm verify:windows --skip-stage`, using the freshly staged protocol-24 runtimes | 39/39 passed on native Windows and WSL; release-home comparison unchanged and test home removed | `pr-ui.log` |
| Real stdio engine through `pnpm rpc task.preview`, working maximum 64 | Passed, no model call, disposable home removed | `pr-rpc.log` |

These runs used Node 24.21.0, pnpm 10.4.1 and the shared heavy-check lock. The final receipt commit changes only this
document; no implementation changed after those integrated checks. Generated output remains ignored. These historical
checks did not cover the four transitions reported at `63ae1d8`; the corrections and new regressions follow.

## A1 validation on the approved revision — 30 October 2026

The single approved A1 validation recipe
`451a74cff208ac7aa473fa7a47025ae1effb576b5d1ecd6d85d9ec282e0a9784` completed successfully on `63ae1d8` before
the review hold could interrupt it. No process was signalled and no worker started. All 36 validation checks passed,
and all 24 baseline/reference/control selections matched. The baseline had the intended eight failing acceptance
cases; the reference passed, the known-wrong controls failed as intended and unrelated checks stayed green.
The longest required baseline/reference check took 12,541 ms, within the worker's 60-second limit. This establishes
the fixture's validation on that revision, not a useful worker result on either revision.

Receipts remain outside the checkout in `~/nivra-acceptance/env-probe-2026-10-30T125547578Z/` and
`~/nivra-acceptance/niv60/runs/A1-validation-summary.json`. The latter retains reported preparation and all 27
task-session operation usage records. Preparation reported 33.42 seconds, CPU 27.010764, memory 911408 and image size
761419533, with the raw resource fields preserved. Memory units and the resource `cost` field's currency/conversion
were not established; monetary cost is `null`, not $0. No model inference requests were made. Collection matched the
pinned commit, cleanup left no unresolved operations and the release home was unchanged.

The remaining paid runs are held for a revised source/build and concrete recipe approval. No proposal has been
applied or accepted. Successful real-task proposals, a genuine C1 multi-file attempt and useful work beyond a formerly
limiting allowance remain open requirements; no calls or writes will be added merely to cross a threshold.

## Four review corrections — 30 October 2026

1. Recovery accounting now charges every grant admitted since the loss against the fixed recovered remainder,
   independently of later coverage changes. New grants still require the applicable coverage acknowledgement.
   Tests reserve and dispatch all five recovered requests for coding, then disable coding or turn the monthly budget
   off; neither Companion nor adaptive Planning can reserve the same five again. Unknown usage retains its bound.
2. Task preview and admission reconcile existing coding journals before calculating availability. Only the existing
   guard-verified unsent evidence or a complete engine seal releases unused capacity. Separate real-host tests finish
   two two-request tasks under a monthly allowance of 17, through a fresh preview and through an already-open preview,
   without visiting Settings. The ledger ends with four used, none reserved and 13 remaining.
3. The fixed splice prefixes its relative path with `./`, protecting `mktemp` and subsequent commands from a leading
   dash. A real execution-script regression edits and verifies `-src/file.txt` with exactly one write.
4. The Preferences handoff saves and restores `workingRequests` with the existing temporary choices. Electron tests
   retain a selected maximum of 16 both outside monthly coding coverage and under a shared monthly allowance, across
   unmounting and returning to the preview. The monthly toggle also retains its finite-limit selection.

Before the production fixes, the filtered regression run reproduced four failures: the two recovery-policy changes,
the blocked next task and the leading-dash splice. Afterward all six matching tests passed, including independent
preview and admission paths. Full budget/editing/worker tests passed 140/140, the existing host task group passed
18/18, and Preferences passed 10/10 across built and development StrictMode apps. The final full run includes the
new host admission case. No regression tests were skipped or weakened to fix these findings.

Final checks use `.artifacts/niv60/review-fixes/`, Node 24.21.0 and pnpm 10.4.1; heavy checks use the shared lock:

| Command/check | Result | Receipt |
| --- | --- | --- |
| `pnpm verify` | All typechecks and 2,020 tests passed: 144 domain, 776 desktop, 1,100 engine; no failures, cancellations or skips | `verify.log` |
| `pnpm stage:runtime all` | Passed; Linux smoke checked and Windows cross-staged with hashes `05cdbff81603d6ca` and `f0e69278e0f13afd` | `stage.log` |
| Built app: app, budget usage, task run, task preferences and task discussion | 22/22 passed, no skips | `built.log` |
| Fresh Linux package, same affected cases | 21 passed, one existing skip requiring unpackaged-only endpoint switches; that task run passed in the built app | `package-build.log`, `packaged.log` |
| Fresh Windows development package and full native UI | 17/17 passed, no skips | `windows-build.log`, `windows-ui.log` |
| `pnpm verify:windows --skip-stage`, with the freshly staged runtimes | 39/39 passed, protocol 24; release home unchanged and test home removed | `windows-rpc.log` |
| Real stdio engine through `pnpm rpc task.preview`, working maximum 64 | Passed with no model call; disposable home removed | `rpc.log` |

No implementation changed after this verification sequence started; the subsequent edits record these results.
The full correction diff and untracked files were inspected; no dependencies, generated output or credentials are
included. These checks support re-review of the four fixes. PR #54 remains held for merging, and real-task acceptance
remains open under the source-specific approval boundary above.
