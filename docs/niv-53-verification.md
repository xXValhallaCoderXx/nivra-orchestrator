# NIV-53 completion acceptance — 30 October 2026

**The acceptance tooling is implemented. NIV-53 remains open: the single live coaching did not produce a usable
answer.** The initial acceptance added tooling only. The coach response-budget follow-up below raises its completion
allowance and fixes its context reservation; visible subtasks and other workflows' limits remain separate.

The separate `feature/niv-53-completion` worktree initially started at main `06dc05ad269231ee4da52e510142fb9c2bb72e2e`.
The early frozen candidates below include uncommitted acceptance tooling. The branch was subsequently committed and
rebased onto main `033b600` for PR review; the fresh combined checks are recorded at the end. The original NIV-60
checkout and historical candidates were not edited.

## Delivered

- `scripts/coach-live.ts` freezes a native Windows build and isolated profile, prints its concrete recipe, rehearses
  the actual preview, claims one live attempt, retains the answer and removes the key. It reuses the existing
  single-use claim helper. A repeated or interrupted claim remains spent.
- The recipe binds the full source and build file fingerprints, revision, fixture, preview, profile/instructions,
  tool schema, preferred model and existing request limits. Uncommitted acceptance tooling is explicitly identified
  by its source fingerprint; no commit was created to satisfy a clean-tree shortcut.
- Saving is a separate unpaid action after inspecting the actual answer: `--save --reviewed <answer-sha256>
  --fields <comma-separated-fields>`. It requires a proper subset of usable proposals and verifies every brief
  field, task state, attempt count and persistence across restart. An unusable answer cannot reach this save.
- `scripts/coach-journey.ts` shares the real UI journey with the offline desktop check. A second desktop case
  reproduces the live output-limit failure and verifies refusal to save, unchanged brief/state and no replay.
- Build copying and hashing run natively on Windows. The key enters the existing named Settings call; scanning
  native profile/engine files also runs on Windows, after the app closes. No database is opened across operating
  systems. Release and shared development home fingerprints are checked.

## Verification

Evidence is under this worktree's ignored `.artifacts/niv53/` and
`~/nivra-acceptance/niv53/completion-06dc05a/`.

| Check | Result and limit |
| --- | --- |
| `pnpm verify` | 1,997 passed: domain 144, engine 1,081, desktop 772; none skipped. Includes four new acceptance-helper checks. |
| Coach UI suite plus the shared acceptance journey | 12 passed; provider stand-ins, not live model quality. |
| Final acceptance journey and output-limit regression | 2 passed, including the new regression after the live failure. Final desktop typecheck passed. |
| Real engine through `apps/engine/scripts/rpc.ts` | Valid, malformed, wrong-fingerprint and unsupported-model cases passed. Observed listing/inference counts were 1/1, 1/1, 0/0 and 1/0. |
| Native Windows development build and `test:windows` | Build/copy succeeded; all 18 Windows/native/WSL UI checks passed, none skipped. |
| Frozen Windows preview rehearsal | The visible packet and preview fingerprint matched the recipe; no key read, Start not pressed, no engine started. |
| One live Windows coaching | Failed at the existing output cap; details below. No paid retry. |
| Live failure reopened on Windows | Passed: original content/v1, Draft, zero coding attempts, one failed coaching, no Save action and no engine started on reopening. |
| Cleanup | Key removed; native exact-key scan read 72 files and found zero matches. Protected home fingerprints unchanged. |

The Linux packaged suite and `verify:windows` were not run: packaging, main/preload, targets, supervisor and staging
were not changed. The native Windows acceptance build is a copied packaged development-channel app; the Linux
provider-stand-in journey is an unpackaged build. These are separate receipts.

## Actual live result

The frozen candidate's source fingerprint was
`0052684eb79d0bb28fd5d22ee16d6728b8a11f7a76b062bcddb35ea25e7c2a97` (578 files); its complete Windows build fingerprint
was `4e6f454b173bcb98a0f019bbb9b167efde81578f51d6918125aa9f7f7bbd7735` (3,946 files). The later failure regression
and this documentation do not change the frozen application.

Recipe `9b9dc2c5d368af4ea347270975ee25e3193c0a82880b4e7a92a166cc5498effb` used Task readiness coach v2 and
`nvidia/Nemotron-3.5-Super-VL`, also named by the served-model report. The synthetic brief was “Personal records use
one unit”, with “It works” and “Records show the right unit”, and an explicit exclusion against changing stored
workout history. No repository, mission, findings, preferences or attachments were included.

The window estimated 4,389 input tokens for admission. The engine estimated 2,800; the provider reported **2,410
input and 4,000 output tokens**, one call, `finishReason: length`, approximately 20.1 seconds for inference. It
returned no usable structured questions or changes. The existing bounds stayed at one inference, 4,000 output
tokens, a 150-second request deadline within the 180-second engine run; nothing was retried. Live counts come from
the retained engine report, whereas the offline receipts count actual stand-in HTTP requests. Monetary cost was not
reported and is not shown as zero.

The retained report does not establish how output was divided between reasoning and answer text. Truncation is the
observed failure; a more specific provider cause is unproven. The UI reported that failure, saved no brief version
and offered no changes to apply. `answer.json`, `live-binding.json`, `credential-scan.json`, `failure-reopened.json`,
screenshots, `result.json` and `quality.md` retain the evidence. The single-use claim remains in
`~/nivra-acceptance/claims/coach-desktop/`.

## Remaining acceptance

Do not close NIV-53 from these results. Selective saving and draft preservation passed offline, but the requested
live material improvement and selective save were not reached. No retry or cap increase occurred in that initial
attempt. The following response-budget change was requested separately before any further live work.
Visible reviewed subtasks remain the separate follow-up described in the planning handoff.

## Coach response-budget follow-up

The next coach request allows **8,000 completion tokens**, including reported reasoning, and reserves those same
8,000 against the model context and the existing 64,000-token application ceiling. Its input admission maximum is
56,000, also shown in the preview. `requestBudget` accepts the explicit completion reservation; all other callers
keep their 4,000-token default. The coach's v2 prompt, form, field limits, validation, one-request maximum,
cancellation and no-retry behaviour are unchanged. Extra completion allowance does not make the structured answer
more verbose.

The existing deadlines remain finite: 30 seconds for listing, at most 150 seconds for inference within the engine's
180-second overall deadline, reduced by time already spent. The 900-second engine transport wait exceeds both.
The failed 4,000-token response took about 20.1 seconds; a rough doubling would be about 40 seconds, within the
existing request deadline. That projection is not a claim about the next response's latency. Tests retain the
request timeout, cancellation and reduced-time-left cases.
The acceptance observer waits up to 270 seconds: the host's 60-second initialise allowance, the engine's full
180 seconds and 30 seconds to observe its end. Its former 200-second wait could pre-empt an otherwise valid run
after a cold start; neither workflow deadline was extended.

The original failure's report and native engine `model.call` event were inspected read-only. Both retain
`finishReason: length`, 2,410 input and 4,000 output tokens; neither retains a reasoning count. Its reasoning split
therefore remains unknown. All 12 evidence-file hashes match the originals. The old frozen build, profile,
artifacts, recipe and spent claim are preserved.

For the next measurement the coach opts into reasoning-token diagnostics in ModelClient. The adapter can replace
an absent reasoning count with zero, so the diagnostic reads original usage metadata: an explicit zero stays zero,
an absent or contradictory value stays null. It records only numeric usage and finish metadata in `model.call`;
reasoning is already included in output and is never added to it. The live helper copies this allow-listed metadata
to `measurements.json` using native SQLite after closing the app. It copies no reasoning text or raw response.

Updated receipts are in `.artifacts/niv53/budget/`:

| Check | Result |
| --- | --- |
| `pnpm verify` | 2,000 passed: domain 144, engine 1,084, desktop 772; none skipped. |
| Coach window checks | 13 passed. Preview explicitly shows 8,000 output tokens. |
| Real-engine RPC | Four cases passed; returned reports bind the 8,000-token allowance, with unchanged listing/request counts. |
| Linux packaged coach checks | 1 passed, 12 skipped because their stand-in switches are unavailable in a packaged app. A final no-key preview check passed with the explicit 8,000-token assertion. |
| Fresh Windows build and UI | 18 passed, none skipped. |

New behavioural coverage refuses a context one token short of the full 8,000-token reservation and admits the exact
boundary. A valid concise form with 6,100 completion tokens, including 5,900 reasoning tokens, is accepted and counted
once. Truncated 8,000-token answers still fail with one request; explicit zero, absent and contradictory reasoning
counts remain distinguishable. The former maximal 57,831-token input preview is now refused against the 56,000-token
allowance, with guidance to shorten it.

The updated frozen recipe and unpaid rehearsal use
`~/nivra-acceptance/niv53/completion-coach-8000-final-06dc05a/`; `recipe.json` binds the actual source/build, preview,
reservation, workflow deadlines, 270-second observer and measurement fields. No second paid coaching is part of this follow-up.

**Paid admission remains deferred.** Checking current main at `033b600` also confirmed that the coach start route
sends no host-ledger grant. The initial live attempt should have been deferred under AGENTS.md D49; its bounded
request and single-use approval did not replace that required grant. The helper now refuses paid mode before
claiming another recipe or reading credentials. Coach grant integration must be verified separately; this change
does not silently wire all of NIV-66 or expand the shared monthly pool. The NIV-52 mission-review grant assessment
is separate and has not changed mission-review code here.

## PR candidate after main integration

Code candidate `b87dd6a` is rebased onto main `033b600`, including PR #54/NIV-60. The three documentation append
conflicts retain both tracks' records; D63 remains NIV-60's and D64 the coach correction. The shared ModelClient
retains NIV-60's dynamic grant selection alongside the coach's opt-in numeric diagnostic. No target, supervisor,
staging source, dependency, operating-guide or mission-review implementation changed in this PR.

Fresh combined checks, under `.artifacts/niv53/pr/`:

| Check | Result |
| --- | --- |
| `pnpm verify` | 2,034 passed: domain 144, engine 1,103, desktop 787; none skipped. |
| Built coach UI | 13 passed. |
| Real engine through `apps/engine/scripts/rpc.ts` | All four cases passed; 8,000-token reports and listing/inference counts unchanged. |
| Fresh Linux package and targeted coach suite | 1 passed, 12 skipped because packaged builds ignore the stand-in switches. |
| Fresh staged Windows build and UI | 18 passed, none skipped; release-home guard passed. |
| Diff and retained evidence | All 17 changed paths inspected; no generated artifacts or credentials committed. All 12 original failed-run evidence hashes match. |

The documentation-only record follows the tested code. Earlier frozen recipes remain historical receipts of the
source/build hashes they name; they do not identify this rebased PR candidate. Before any future paid acceptance,
verify host-ledger grant wiring and freeze a new concrete recipe from the actual candidate. No further paid run was
made while preparing this PR. NIV-53 remains open for that admission and useful live-coaching evidence.
