# NIV-70: task discussion, activity and multimodal context

Implemented from main `60c121667db3ee22912ee3717db1d871d48ee83b`. The final combined candidate is in the isolated
`nivra-orchestrator-niv70` worktree, on `feature/niv-70-pr`, based on current main
`a9dbc30`. NIV-48's script and tests match that main byte for byte; both tickets' documentation is retained.
The person's follow-up authorises publishing the PR and a reviewer comment. No merge, Linear update or paid provider
call was made.

## Behaviour

- Tasks have add-only comments, labelled **You**, with independent immutable ordering and timestamps. Adding a
  comment does not revise the execution brief. Comments are included by default; individual exclusions persist.
- Reference files are copied into private application-data folders by project and task, including an unassigned
  area. Metadata records ownership, optional comment links, detected types, sizes and source/prepared hashes.
  Files start unselected. The native picker and named IPC calls expose IDs, not filesystem paths, to the renderer.
- A copied file is verified before its metadata commits. Valid import receipts can recover interrupted imports.
  Moves verify every destination before changing ownership, retain recovery copies until the destination can be
  checked again, then remove matching redundant copies. Missing or damaged files cannot be included. Removal
  excludes future requests and deletes registered private byte copies; retained records identify removed files.
- Changing project preserves attachment IDs and comment links, clears attachment selection and invalidates previews.
  The notice is: “Project changed. Your attachments are still here. Select which ones to include again.” The new
  project's sharing settings govern subsequent requests.
- Activity projects retained brief versions, attempts, checks, proposals, decisions, apply results and acceptance.
  Brief versions and attempts can be opened. Small transition references retain otherwise overwritten future
  decisions/apply states. The page explicitly identifies gaps in older history. Partial, refused and failed evidence
  does not become a pass.
- One reference adapter supplies task Companion, task-sourced Planning and coding. Its manifest binds ordered comment
  payloads, attachment source/prepared hashes and hashes of the exact canonical attempt summaries supplied, including
  the existing worker's written hand-in, status, verification, proposal and apply facts. Small masked hand-in
  projections stay in the host's native store; missing historical hand-ins are labelled unavailable. Existing brief,
  preference, knowledge and choice bindings remain.
  Excluded comments and unselected files do not affect the reference digest.
- Included files and summary facts are read again before dispatch. An accepted request keeps its own cloned frozen
  content in memory. Later changes affect subsequent requests and advice freshness. The host retains source records
  privately; request receipts contain references and hashes. Raw reference context stays out of run inputs, events,
  logs and Mastra storage.
- Images reach the installed Mastra/Nebius transport as image content. Every request that carries an image, including
  tool rounds, Planning passes and hand-in, admits its input estimate again. Provider-reported totals replace those
  estimates; they are never added to reported usage. Missing usage remains unknown.
- Selected images require available, grant-covered `nvidia/Nemotron-3.5-Super-VL`. An unavailable or uncovered route
  refuses the request; it does not substitute a model or omit an image. The UI previews the actual prepared PNG.
- PDFs supply text only, labelled **PDF text only — images and layout aren’t included**. Unreadable, encrypted,
  scanned or oversized PDFs are refused with a suggestion to attach relevant PNG/JPEG pages.
- Planning results and saved draft tasks retain the source manifest/provenance. Saving does not select attachments
  on the new task or copy them into a checkout. Discussion/files support the approved brief; the worker is instructed
  to hand in unchanged with a clarification summary for a material conflict. Existing human approval, verification,
  cancellation, consent and execution controls remain in force.

## Coding grant prerequisite

Every new coding request requires a finite host-ledger grant attributed to its project, task, attempt and existing
coding-worker profile. The host guards the written grant and its dispatching revision before `runs.start`. The engine
requires the task model, one model listing, 23 productive requests capped at 8,000 output tokens and one reserved
hand-in capped at 1,500. A missing accepted binding refuses model-client construction. Both listing and generation
use the existing send-point journal. Hand-in-only requests use finalisation, including early hand-in for time,
context or tool limits.

Existing seal/reconciliation logic now includes task grants. Complete seals settle once; interrupted work, missing
acknowledgements and unknown usage retain the existing conservative rules. Nothing replays inference. Coding uses
the shared ledger but remains outside the **Companion and Planning monthly request allowance**. Sandbox operations
and their accounting are unchanged. Catalogue validation, monetary bounds and dollar-budget refusal policies are
unchanged; an image admission estimate establishes none of them.

## Limits and packaging

Only `unpdf@2.0.1` was added, as a bundled desktop devDependency. No canvas dependency was added. Protocol 23 replaces
22 for new host/engine requests; historical stored task records remain readable. Workspace migrations 14 and 15 append
native discussion/reference storage, masked hand-in projections and activity triggers, including withdrawn approvals,
without rewriting released migrations.

| Area | Enforced POC limit |
| --- | --- |
| Stored attachments | 10 active files, 25 MiB including prepared copies |
| Original image | Static PNG/JPEG/WebP, 5 MiB, 16 megapixels |
| Prepared image | Bundled renderer Web Worker, Chromium decoding and OffscreenCanvas; PNG, longest edge at most 2,048, at most 1 MiB; host validates dimensions, decoded bounds and hashes |
| Text/code | UTF-8, 128 KiB original, 20,000 characters per file |
| PDF | 5 MiB, five pages, 20,000 extracted characters; separate bundled host worker, five-second termination deadline and 128 MiB JavaScript heap limit |
| Selected files | Five, at most three images, 40,000 attachment-text characters |
| Discussion | 8,000 characters per comment; 50 included comments and 24,000 included characters |
| Start request | Complete serialised parameters at most 6 MiB, inside the unchanged 8 MiB protocol-line limit |

Readable text and filenames are checked for credentials before storage and sharing, and again for requests. This
does not detect secrets in images. Attaching, preparing, extracting, previewing and selecting make no paid calls.

## Verification receipt

Commands ran on Node 24.21.0 and pnpm 10.4.1. The final non-document manifest contains 561 source/configuration/test
files; its SHA-256 is `7779002b44cd231fa9b03e0eab56d63c39a5a310f63378e99ab55baf1e3d7f23`.

| Check | Result |
| --- | --- |
| `taskset -c 0-3 pnpm verify` on combined main | All typechecks and **1,963 tests passed**: 144 domain, 738 desktop, 1,081 engine; zero failures, cancellations or skips |
| Desktop typecheck after E2E assertion updates | Passed |
| Real engine through `apps/engine/scripts/rpc.ts` | Keyless `doctor` passed in a disposable home; provider credential variables removed from the child; graceful shutdown |
| `pnpm stage:runtime all` | Linux x64 smoke passed, content hash `b01b4e83245b3989`; Windows x64 cross-staged, `feda0cac4bcc0b0a` |
| Linux `package:dir` and Windows `dev:win --skip-stage --no-launch` after staging | Passed; PDF worker and unpdf chunks bundled; Windows development build copied |
| Full built Electron suite | **156 passed, one existing skip**, zero failures; the skipped switch-rejection case is packaged-only and passed in the packaged suite |
| Full packaged Electron suite | **85 passed, 72 existing skips**, zero failures; packaged apps ignore the provider/test-engine switches required by those skipped tests |
| Windows engine/supervisor/transport checks, `verify:windows --skip-stage` after fresh staging | **39/39 passed**, including Windows and Windows-to-WSL reference transfer; release `~/.nivra` unchanged and nonce test home removed |
| Windows UI, `test:windows` after the fresh development copy | **16/16 passed**, including native picker, Chromium image preparation and bundled PDF extraction |
| Focused environment journey after assertion corrections | **4/4 passed** |

Focused reference tests also cover immutable discussion, task isolation, copy/move interruption, removal, damaged or
missing files, bounded PDF extraction, credential refusal, exact summary hashes, stale previews and frozen accepted
content. Real stdio/loopback-provider checks cover all three consumers, actual HTTP image parts, repeated transmission
through tool rounds/Planning/hand-in, reported and unknown usage, finite grant exhaustion, cancellation and restart
seals, and a newly saved credential stopping the next Planning request. These are offline transport/behaviour checks.

Earlier failed or superseded runs are not passes. Expectations were corrected for the new fingerprint, API ordering,
schema version and added tables. The broad UI run found an old budget-coverage sentence and two inherited environment
expectations: current main already says “explicit baseline check” and explicitly describes revalidated legacy reports
and unavailable comparisons. The replacement verdict assertion checks the complete current message. Production code
and unit tests did not change for these E2E corrections; desktop typechecking was repeated afterwards. An initial built
invocation lacked pnpm's script environment; concurrent heavyweight checks also caused startup/lifecycle timeouts.
No test was removed, no new skip was added, and no assertion or timeout was weakened to obtain a pass.

Local logs, source manifests, packaged hashes and the worktree audit are retained under ignored `.artifacts/niv70/`
in the isolated worktree. The original checkout was restored using verified copies of only this task's files, then
fast-forwarded to current main. Older branch-only commits and the separate recovery worktree were left untouched.

Live provider image understanding remains **unassessed**. It requires a harmless, separately approved live visual
check. Cloud sync, OCR, PDF rendering, indexing and background summaries remain deferred.
