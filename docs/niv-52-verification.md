# NIV-52 completion and acceptance evidence

Implementation on `feature/niv-52-completion`, based on freshly fetched main
`033b600549c1e7b615208048e3e8ac44c9c9ad93`, 30 October 2026. The original `feature/niv-60` checkout and existing
candidate folders were not used for builds or staging. Verification preceded the delivery commit; source hashes below
identify the tested code. Publishing this pass does not close NIV-52 or authorise live execution.

## Runner refresh

- The mission live runner, public synthetic fixture and runner expectations pin exactly
  `nvidia/Nemotron-3.5-Super-VL` (D50). Another listed model is not a fallback. Every answer must name the pinned model
  for the evidence to call it held; an unidentified served model stays unknown.
- The real stdio engine's requests to a loopback stand-in carry `max_completion_tokens: 4000`, no `max_tokens`, and
  forced `submit_review` or `submit_synthesis` tool choice. The completion cap includes reasoning. A model listing is
  counted separately from inference. A 503 is not retried.
- D44's bounds remain three inference requests, 150 seconds per request and 330 seconds for the review. The runner
  follows for 360 seconds, including its existing 30-second margin. Recovery, cancellation and report reads each have
  a five-second RPC limit; the existing closer bounds shutdown, closing stdin and force. This is not a new overall
  spending ceiling. The 120,000 input-token figure remains an estimate.
- Collection now keeps a receipt when initialisation, start, polling, report collection or shutdown fails. A lost
  start reply is looked up by its original request id, never resent. Receipts distinguish a cancellation request from
  an observed terminal state and retain partial reports. `engineClose: "returned"` records only that the closer
  returned, not independent proof of process exit. Raw collection exceptions are not saved or printed.
- Recipe binding, clean-source refusal, single-use approval claims, isolated homes and private evidence files remain.
  No production engine, host, preload, renderer, domain contract, dependency or specialist prompt changed.

## Fresh verification

Checks ran in this worktree with Node 24.21.0 and pnpm 10.4.1, one heavy command at a time under
`/tmp/nivra-heavy-check.lock`. Local receipts are in `.artifacts/niv52/`.

| Check | Result | Receipt |
| --- | --- | --- |
| Focused engine tests: `mission-review-live.test.ts`, `mission-review.test.ts`, `tokenfactory.test.ts` | 48 passed; none failed, cancelled or skipped | `focused.log` |
| Initial `pnpm verify` | Typechecks passed; 144 domain and 783 desktop tests passed; engine: 1,104 passed, five failed | `verify.log` |
| Unchanged database-privacy suite in isolation | 47 passed; none failed, cancelled or skipped | `database-privacy-isolated.log` |
| Final `pnpm verify` with process CPU affinity limited to four CPUs | All typechecks and 2,036 tests passed: 144 domain, 783 desktop, 1,109 engine; none failed, cancelled or skipped | `verify-bounded.log`, `verify-bounded.json` |
| Built Linux app: `xvfb-run -a pnpm --filter @nivra/desktop test:e2e missions.spec.ts` | 8 passed, no skips | `missions-built.log`, `build.json` |
| `node apps/engine/scripts/mission-review-live.ts --plan` | Passed; draft recipe names the current model and grant prerequisite, and warns that the checkout is uncommitted | `draft-plan.log` |

The initial five failures were the existing database-privacy test's five-second startup deadline: a symlink or FIFO at
`nivra.db-wal`, and a hard link, directory or FIFO at `nivra.db-shm`. They passed both in isolation and in the full rerun,
where those five cases took roughly 0.6 seconds each. The full rerun changes only process CPU affinity to reduce Node's
concurrent test processes; no tests, assertions or timeouts were weakened.
The initial failure log is retained. The focused run preceded the final observation-only deadline-message refinement;
the final full run includes that refinement.

The runner tests start a real source engine over stdio and inspect the actual HTTP bodies received by a loopback
provider. They cover model pinning, refusal before inference, substituted and unidentified served models, one listing
versus three inference requests, single-use approval races/replay, no retries, partial evidence and absent keys in
outputs. Collection failure/deadline tests use a fake monotonic clock and RPC client. No real provider was called.

The eight built-app checks establish mission authoring without a repository or Linear, omitted-task visibility,
repository-linked task refusal, the exact preview and refusal with no key, findings opening their correct task,
deliberate brief v2 saving and stale-review display, readable reports after relaunch, no automatic task execution,
truthful no-findings/incomplete output, and mission deletion leaving the tasks. This is an unpackaged app with scripted
provider replies and its existing test data; it is separate from the three-task live fixture and demonstrates no
model usefulness. Cancellation is covered by the engine and collection tests, not a fresh mission-window cancel test.

`source.json` records the base revision and hashes of the final runner, collector, fixture, tests and existing UI spec;
`implementation.patch` retains the code diff, including the new collector. `build.json` hashes the built main, preload
and renderer entry points. These receipts identify the source tested before commit. A future live recipe must be
generated and approved from its own clean revision after compliant grant admission exists. `receipt.json` records
commands, outcomes and log hashes. After verification, the four recorded normal engine
database files in `~/.nivra` and `~/.nivra-dev` matched their original bytes, modification times and hashes; no source
engine process from this worktree remained (`protected-before.json`, `protected-after.json`, `cleanup.json`). The
original `feature/niv-60` checkout remained clean. No existing candidate was built, staged or replaced.

No fresh packaged, Windows, staging or release checks were run: only runner tooling, its fixture/tests and evidence
docs changed. Historical candidate 3 Windows evidence remains credited only to `c99fe9d6e7dd5cbb94d8de7df881988299fe3c05`
(37 runtime/zip and 13 app checks, recorded by its owner in NIV-52); it is not evidence for this worktree or a new binary.

## Frozen usefulness rubric

Frozen before any live output, also saved as `.artifacts/niv52/rubric-before-live.md` with its SHA-256 receipt.
The public “Runner's weekly log” mission and its three unlinked tasks remain unchanged apart from the model pin.
No repository, preferences, attachments or saved conversation is included.

| Seeded gap | Grounding and useful advice | Live assessment |
| --- | --- | --- |
| Missing local-storage prerequisite | T1 and/or backlog: identify that the weekly total assumes stored runs without a task establishing storage; propose adding or sequencing that work | Not assessed |
| Unsupported duplicate-sync assumption | T2 and the mission: identify the conflict with never counting a run twice; propose explicit idempotency/deduplication behaviour and a reconnect/retry check | Not assessed |
| Vague weekly-target criterion | T3: identify that “It works well” cannot be tested; propose observable target-setting behaviour and a concrete check | Not assessed |

Assess every gap as **found**, **partly found** or **missed**, citing finding ids, recommendations and task/backlog
references. Equivalent wording is acceptable. At least one substantive seeded gap must be found with actionable advice
and correct references. Generic criticism or repeating the brief does not count. Any materially misleading finding
prevents acceptance, even if another finding is correct. Assess the actual reviewers and chair; agreement is not proof.

All technical and app-journey criteria still apply. Keep every miss visible. Success means useful feedback on this
fixture, not comprehensive review reliability. Do not change the rubric after seeing an answer or repeat paid attempts
merely to improve the score. Scripted test findings are not live usefulness evidence.

## Live prerequisite and closure

**No paid run was made and no real credential was read.** The person explicitly chose to defer it. AGENTS.md's D49
requires a host-ledger grant, marked dispatching and fsynced to its guard before a spendable call. At this source,
`createReviewWorkflow` constructs its model client without a budget binding, and the runner sends no host grant.
D44's finite per-review budget is not that grant. Wider coverage belongs with NIV-66; this pass neither fabricates a
grant nor changes budget integration. The new recipe message records the operating prerequisite, not new enforcement.

| Acceptance criterion | Position |
| --- | --- |
| Current-model runner and preserved bounded/advisory behaviour | Supported by fresh offline evidence |
| Select tasks, review findings, open the correct task, save a brief and show the old review stale | Passed in the built app with a provider stand-in |
| Full repository verification | Passed: all typechecks and 2,036 tests, under the recorded reduced concurrency |
| Grant-compliant live review, exact served model and bounded usage | Deferred; missing host-ledger grant path |
| Useful, grounded findings against the frozen rubric | Not assessed; no live output exists |

**Recommendation: keep NIV-52 In Progress.** Once compliant grant admission exists, freeze a clean revision, print and
separately approve its exact recipe digest, then run exactly one bounded review. Record its recipe, report, stage
statuses, request counts, served models, reported tokens and termination/cleanup. Unreported money stays unknown;
reasoning is not added twice to completion usage. Apply the frozen rubric and retain failures and misses. Any later
attempt needs its own authorisation; it never follows automatically from a poor score. A direct-engine live run is
separate from the app journey above and would not establish a paid packaged-app demonstration or future release
contents. Publication of this completion pass does not substitute for that remaining acceptance or authorise a merge.
