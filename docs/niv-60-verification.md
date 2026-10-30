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
proposal has been applied; no live provider call has run for this implementation yet.

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
does not prove environment readiness, baseline/reference/control results, worker check duration or successful tasks.

Live runners require a clean committed Nivra revision; the app runner additionally requires a release candidate frozen
from that revision and a concrete claimed recipe approval. The user has now authorised review commits, pushing the
branch and opening a PR into main. Necessary bounded live validation already has the user's authorisation; no
additional blanket live-test permission is needed. The PR keeps this remaining acceptance work visible.

Still required: execute each frozen baseline/reference/known-wrong control in the boundary; confirm the baseline's
named failures and green unrelated checks; measure duration/output against the worker's 60-second check limit; freeze
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
document; no implementation changed after the integrated checks. Generated output remains ignored. Live-provider
and useful larger-task acceptance evidence is still pending and is explicitly called out in the PR and reviewer note.
