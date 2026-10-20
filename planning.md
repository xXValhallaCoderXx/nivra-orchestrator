# Planning and execution workspace

Implementation handoff, 20 October 2026. Created in the [Planning and execution workspace](https://linear.app/sentiment-hound/project/planning-and-execution-workspace-79c46fb3324e) Linear project after explicit approval. Five milestones and nine new tickets are saved; seven existing tickets have current-scope updates. This file is uncommitted planning documentation, not implementation evidence.

## Direction and verified starting point

Deliver useful review/planning through saved general and single-repository chats, native tasks and bounded council reviews. Execute one native task safely before adding specialists, integrations or concurrent writers. Native tasks never depend on an external tracker account.

The user now has Nebius Sandbox access and has no known existing local setup to reuse. At checkout 001e56a, the only integrated backend is Local (no isolation). Windows Docker CLI is installed, but the daemon is unavailable and Ubuntu WSL integration is inactive. No Podman/OpenShell was found on checked PATHs. This is an inventory, not a sandbox conformance pass.

**Preferred first candidate: Nebius, subject to NIV-29.** Chat/council progress does not depend on sandbox access. Implement one full backend first; local containers are a second option or an explicitly selected alternative if the proof fails. No automatic backend fallback.

## Architecture constraints

- Conversation: durable discussion, optional explicit project scope, messages and source attachments.
- Task: durable native work item, optional source links, versioned brief and acceptance criteria. A coding task needs a project before execution, but a general conversation does not.
- Run: one attempt linked to a conversation/turn/task and its engine/target. A successful run is distinct from accepted task completion.
- Artifact: immutable version of a plan, report or patch with provenance. Execution consumes a version, not a mutable chat summary.
- Host owns conversation/task history and canonical preferences; owning engines keep execution state. Persist routing and reconcile on restart, without sharing SQLite across operating systems or replaying paid calls.
- General chat exposes no repository capability. Repository chat preserves sharing, precedence and scope. Long-term memory requires explicit wording/scope confirmation.

## Nebius contract considerations

Official documentation describes fresh compute per operation and filesystem continuation through returned images, not persistent guest processes. Network access defaults on and must explicitly be disabled for the initial coding workload. Operation SUCCESS does not imply a zero command exit. Connection loss is not cancellation. Track uncertain submissions before starting another operation.

A cancelled/disposable operation is not evidence that uploaded data, images or logs were erased. Record account-effective limits and retention. The first probe uses only a tiny public/synthetic fixture, no model, no dependency installation and an approved bounded resource budget. Existing consent for model excerpts does not authorise a cloud workspace upload.

A later UI specialist must separately prove preview/browser operation; it cannot assume a long-lived remote preview or public ingress. Prefer evaluating preview and browser within one operation first.

Sources checked on 20 October 2026:

- [Overview and operation/image model](https://docs.tokenfactory.nebius.com/sandboxes/overview)
- [Execution lifecycle](https://docs.tokenfactory.nebius.com/sandboxes/concepts/execution-lifecycle)
- [Interface selection](https://docs.tokenfactory.nebius.com/sandboxes/start/choose-an-interface)
- [Security and data handling](https://docs.tokenfactory.nebius.com/sandboxes/operate/security-and-data-handling)
- [Limits, retention and usage](https://docs.tokenfactory.nebius.com/sandboxes/operate/limits-retention-and-usage)

## Milestones

### F0 — Execution feasibility is proven

Prove the first enforcing sandbox on a tiny public fixture before committing to the coding architecture. Nebius is the preferred candidate because access is now available and no working local integration was found. Record execution/state-transfer/cancellation/recovery/network behaviour and an explicit adopt-or-defer decision. This gate does not block chat or council development.

### P1 — Saved chats and native tasks work

General and single-repository conversations survive restart. A person can create a native task directly or from a versioned conversation artifact without any tracker account. Context, sharing and run routing stay explicit; interrupted calls never replay.

### P2 — Council review and bounded research are useful

A versioned plan receives two independent reviews and a chair synthesis with evidence, dissent and honest failures. Compare against a single reviewer before expanding. Add bounded research and explicitly confirmed scoped memory as a separate increment.

### E1 — One native task executes safely

One agent executes one small task against a copied commit in the proven boundary, returns a validated patch and real checks, and applies only the exact approved patch through the owning engine. Cancellation, stale baselines and restart recovery are demonstrated in the UI. Concurrency is one.

### E2 — Specialists and optional integrations extend the workflow

After E1, validate browser/UI evidence and a second sandbox independently. Provider-neutral ticket intake starts read-only with Linear; ClickUp and external write-back are later increments. No automatic task intake, scheduling or concurrent writers in the initial release.

## Start here

1. [NIV-30 — durable conversations, tasks and artifacts](https://linear.app/sentiment-hound/issue/NIV-30/persist-conversations-native-tasks-and-versioned-artifacts) and [NIV-29 — Nebius feasibility proof](https://linear.app/sentiment-hound/issue/NIV-29/prove-nebius-sandbox-execution-and-choose-the-first-backend) are independent first tickets. Offline work can begin; live cloud/model tests need explicit budget and data-scope approval.
2. [NIV-31 — saved general/repository chats](https://linear.app/sentiment-hound/issue/NIV-31/ship-saved-general-and-repository-chats-in-the-planning-workspace), then [NIV-32 — native task creation and planning handoff](https://linear.app/sentiment-hound/issue/NIV-32/create-native-tasks-directly-and-from-versioned-plans). No tracker account is required.
3. [NIV-22 — council review](https://linear.app/sentiment-hound/issue/NIV-22/deliver-bounded-council-review-of-versioned-plans), with NIV-26 answer reliability and NIV-27 diagnostics completed before live evaluation. [NIV-33 — bounded research](https://linear.app/sentiment-hound/issue/NIV-33/add-bounded-research-with-sources-and-confirmed-scoped-memory) is a separate increment.
4. After the sandbox proof passes, [NIV-34 — boundary/workspaces/patches](https://linear.app/sentiment-hound/issue/NIV-34/integrate-the-proven-sandbox-with-isolated-workspaces-and-patch), then NIV-7 worker, NIV-8 approval/recovery and NIV-13 result view. [NIV-35](https://linear.app/sentiment-hound/issue/NIV-35/verify-the-complete-native-task-execution-journey) is the packaged end-to-end exit gate.
5. Later: [NIV-36 — UI specialist](https://linear.app/sentiment-hound/issue/NIV-36/prove-browser-and-screenshot-verification-for-a-ui-task), [NIV-24 — provider-neutral ticket intake](https://linear.app/sentiment-hound/issue/NIV-24/add-provider-neutral-ticket-intake-with-a-linear-adapter), and [NIV-37 — local container backend](https://linear.app/sentiment-hound/issue/NIV-37/add-a-local-container-backend-against-the-execution-contract). A failed Nebius proof can explicitly pull local evaluation forward; no automatic fallback.

## Agent handoff

The repository draft is docs/planning-execution-plan.md. Read AGENTS.md, reuse existing contracts, and implement one reviewable slice at a time. Each ticket includes acceptance criteria, failure checks and exclusions. Keep chat/council independent of coding sandbox availability. One coding task at a time; no automatic commit/push/PR/deployment. Preserve separate consent for model excerpts and cloud workspace uploads. Record supported platforms and actual evidence; plans and test counts alone are not implementation completion.

## Work order and pass gates

1. Start NIV-30 (durable records) and NIV-29 (sandbox proof) as independent work. Prioritise NIV-26 and NIV-27 before live multi-agent evaluation. Offline prototype work does not authorise paid/cloud calls.
2. Complete NIV-31 saved chats and NIV-32 native tasks. Demonstrate direct task creation and planning handoff without Linear.
3. Deliver NIV-22 council review as the first substantial new agent feature. Compare five seeded plans against one reviewer before expanding. NIV-33 research is a separate bounded increment.
4. As soon as NIV-29 passes, build NIV-34 and then NIV-7/NIV-8/NIV-13. Test the deterministic patch path early; do not wait for a broad research UI to discover execution failures.
5. NIV-35 is the E1 exit gate: packaged direct-task and planned-task journeys, failure/cancellation/restart/stale-approval evidence. Do not claim completion from unit-test totals alone.
6. Pull NIV-36, NIV-24 or NIV-37 only when their prerequisites and user value justify them. Concurrency, unattended scheduling, device sync, multi-repository chats and scaffolding stay deferred.

No calendar deadlines or assignees are imposed. Todo means planned next work; it does not claim implementation has started. Preserve NIV-8's existing In Progress state and historical evidence.

## New tickets

### NIV-29 — Prove Nebius sandbox execution and choose the first backend

[Open NIV-29 in Linear](https://linear.app/sentiment-hound/issue/NIV-29/prove-nebius-sandbox-execution-and-choose-the-first-backend)

Milestone: F0. Status: Todo. Priority: High. Depends on: none.

#### Outcome

Choose a backend from evidence, with a small executable probe that exercises the execution lifecycle without model calls. Nebius-first is the current candidate; local containers remain a later option.

#### Current evidence (20 October 2026)

At 001e56a, Nivra always constructs LocalBackend, which claims no isolation. Windows Docker CLI is installed but its daemon is unreachable, and Ubuntu reports WSL integration unavailable. Podman and OpenShell were not found on checked PATHs. The user now has Nebius Sandbox access. No authenticated sandbox probe has run.

#### Scope

Use one tiny synthetic/public fixture, a known image, one operation at a time and no dependency installation. Inspect official REST support before adding an SDK; do not introduce Python solely for this adapter. Complete offline tests first, then obtain approval for the concrete cloud probe, its retained data and bounded resource/time budget.

#### Done when

- [ ] Access and effective account limits are checked without disclosing credentials.
- [ ] Only the selected fixture is uploaded; no engine home, preferences, secrets or unrelated checkout content is included.
- [ ] A deterministic edit and test run with networking explicitly disabled. Attempt a harmless outbound connection to an approved destination and demonstrate denial, not just a configuration flag. Test unsuccessful exit and timeout separately from provider operation status.
- [ ] Filesystem state continues through a returned image and a second operation; patch/report download is bounded and its hashes verified.
- [ ] Exercise a short edit → inspect → test sequence resembling real tool use. Record end-to-end and per-operation latency plus reported usage/resource consumption; agree adoption thresholds before the probe. Unknown monetary cost remains null, and raw resource units are not treated as currency.
- [ ] Cancellation reaches a confirmed terminal remote state. Disconnect/reconnect observes the same operation; it does not submit it again. Unknown submission outcomes are reconciled or held for user attention.
- [ ] Operation/image identifiers and lifecycle limits are recorded. Cancellation/disposable output are not represented as deletion of uploaded data, logs or retained images.
- [ ] Record supported capabilities, remaining limitations and adopt/defer decision. If the proof fails, keep execution blocked and evaluate local containers explicitly; never use Local as fallback.

#### Stop conditions

Stop before uploading private code, making model calls or extending beyond the approved live budget. A failed critical capability blocks coding integration, not saved chat/council work.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-30 — Persist conversations, native tasks and versioned artifacts

[Open NIV-30 in Linear](https://linear.app/sentiment-hound/issue/NIV-30/persist-conversations-native-tasks-and-versioned-artifacts)

Milestone: P1. Status: Todo. Priority: High. Depends on: none.

#### Outcome

Provide the minimum durable records needed by chat and tasks, using current host/engine ownership rather than creating a general workflow framework.

#### Contract

Conversation: personal/general or one project, messages and explicit source attachments. Task: durable goal, optional conversation/source links, project required before coding execution, brief revision, acceptance criteria and task state. Run: one attempt, linked by conversation/turn/task and target/engine identifiers. Artifact: immutable version of a plan/report/patch with provenance. A successful run is distinct from accepted task completion.

#### Done when

- [ ] Host-owned history and task storage survives restart and supports additive migrations. Do not grow streamed transcripts inside the whole-file nivra.json settings store.
- [ ] Engine execution records remain engine-owned; no database is opened by two operating systems. Persist enough routing to resolve historical runs after restart.
- [ ] Messages and final artifacts are projected idempotently; restarting does not duplicate messages or replay paid calls.
- [ ] General conversations carry no repository capabilities. Scope changes and source attachments are explicit and cannot leak previous project context.
- [ ] An execution attempt freezes a brief/artifact revision; editing the source creates a new revision without mutating the existing attempt.
- [ ] Deletion/retention rules cover derived summaries and indexes; confirmed preference handling is explicit. No automatic long-term memory extraction.
- [ ] Restart, duplicate-event, migration, unavailable-engine and project-isolation cases have behavioural tests.

#### Not included

Cloud/device sync, vector databases, broad workflow designers, multiple repositories per conversation or provider integrations. Propose and obtain approval for any new persistence dependency before implementation.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-31 — Ship saved general and repository chats in the planning workspace

[Open NIV-31 in Linear](https://linear.app/sentiment-hound/issue/NIV-31/ship-saved-general-and-repository-chats-in-the-planning-workspace)

Milestone: P1. Status: Todo. Priority: High. Depends on: NIV-30.

#### Outcome

A person opens Review & planning, creates a general chat or a single-repository chat, receives a useful answer and continues it after restart.

#### Done when

- [ ] Add a modest side navigation and conversation list without rebuilding unrelated working screens.
- [ ] General chat works without a project. Repository chat reuses the current scoped read tools, source evidence, sharing consent and preference precedence.
- [ ] The active conversation's scope and context are inspectable. Selecting another sidebar project never silently changes the conversation.
- [ ] Reuse ModelClient with deadlines, cancellation, zero hidden retries and bounded context. Unknown usage stays null; an empty/failed response is not shown as a useful completed answer.
- [ ] History is durable; reopening an interrupted turn reports interruption without repeating the call. Continuing starts a new explicit turn.
- [ ] Automated UI tests cover both chat types, restart, cancellation and isolation; one small explicitly authorised live check validates the provider path.

#### Not included

Execution tools, automatic memory updates, council modes, web retrieval, multi-repository context or broad visual redesign.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-32 — Create native tasks directly and from versioned plans

[Open NIV-32 in Linear](https://linear.app/sentiment-hound/issue/NIV-32/create-native-tasks-directly-and-from-versioned-plans)

Milestone: P1. Status: Todo. Priority: High. Depends on: NIV-30, NIV-31.

#### Outcome

Nivra tasks work without Linear or any external tracker. Direct entry and a conversation's Send to execution action produce the same native task.

#### Done when

- [ ] A person can create/edit a task with goal and acceptance criteria; choose a repository before coding execution.
- [ ] A selected plan creates a versioned brief with source references, scope/exclusions, relevant context, checks and execution policy.
- [ ] Briefs remain inspectable and revisable. Changing a plan/ticket/repository marks affected assumptions for revalidation rather than silently changing a run.
- [ ] Simple tasks use a short brief; a council review is optional. Readiness does not require a provider account or a remote status.
- [ ] Show a basic task list with truthful draft/ready/active/review/completed behaviour. Retrying adds an attempt to the task; a worker's success does not automatically complete it.
- [ ] Run is clearly unavailable until an enforcing backend and worker are connected. Do not simulate execution success.

#### Not included

Kanban customisation, automatic queue processing, provider sync, scheduling or concurrent coding tasks.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-33 — Add bounded research with sources and confirmed scoped memory

[Open NIV-33 in Linear](https://linear.app/sentiment-hound/issue/NIV-33/add-bounded-research-with-sources-and-confirmed-scoped-memory)

Milestone: P2. Status: Backlog. Priority: Medium. Depends on: NIV-31.

#### Outcome

A conversation can research a question over explicit allowed sources and save a useful report with evidence, alternatives and open questions.

#### Done when

- [ ] Start with selected repository content and supplied documents; web retrieval is a separately reviewed increment with its own source/data policy.
- [ ] Establish a single-researcher baseline. Add a bounded parallel comparison only when NIV-22's evaluation supports it.
- [ ] Each claim links to available evidence or is marked as an assumption; inaccessible or conflicting sources are reported.
- [ ] Aggregate time/call/token limits and cancellation apply to all child work; partial reports survive failures.
- [ ] Working summaries retain provenance and are invalidated when sources are edited/deleted. Retrieve bounded relevant history rather than all transcripts.
- [ ] Memory candidates show exact wording and scope and enter the existing canonical preference store only on confirmation. No automatic personal promotion or cross-project transfer.

#### Not included

Unbounded swarms, automatic background research, cross-device memory or a new competing preference store.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-34 — Integrate the proven sandbox with isolated workspaces and patch proposals

[Open NIV-34 in Linear](https://linear.app/sentiment-hound/issue/NIV-34/integrate-the-proven-sandbox-with-isolated-workspaces-and-patch)

Milestone: E1. Status: Backlog. Priority: High. Depends on: NIV-29.

#### Outcome

Turn the successful backend proof into a production engine boundary and produce a validated patch from one copied commit. Nebius is selected only if NIV-29 passes.

#### Done when

- [ ] Model operation/image lifecycle explicitly; do not promise persistent processes across calls. Store operation/image routing outside model prompts and reconcile uncertain submissions without duplicate execution.
- [ ] Separate repository excerpt consent from per-project cloud workspace upload consent, both initially off. Revocation stops new transfers and attempts cancellation; retained provider artifacts are described honestly.
- [ ] Build the run workspace from an explicit commit, apply deny rules, and reject/handle dirty-checkout differences without silently losing user work. The sandbox receives no host credentials/preferences/home.
- [ ] Network is explicitly disabled for model-controlled commands. Resource/output/time limits are enforced and cancellation cleans up owned work as far as the backend guarantees.
- [ ] Extract a complete patch including new/deleted files, validate paths, links, modes, case collisions, line endings, secrets and generated output, and bind hash/destination/baseline.
- [ ] Untrusted downloaded archives/paths cannot escape the extraction directory; reports and patch sizes are bounded.
- [ ] This ticket proposes changes only; application remains owned by NIV-8. No commit/push/PR/deployment.
- [ ] Missing backend capability refuses the run with a useful explanation. Never silently switch to Local or another provider.

#### Verification

Use a deterministic fixture and fake transport for failure cases, then a budgeted public-fixture live check. Cover invalid patches, network denial, cancellation, lost connection and expired/missing images.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-35 — Verify the complete native task execution journey

[Open NIV-35 in Linear](https://linear.app/sentiment-hound/issue/NIV-35/verify-the-complete-native-task-execution-journey)

Milestone: E1. Status: Backlog. Priority: High. Depends on: NIV-7, NIV-8, NIV-13, NIV-32.

#### Outcome

Demonstrate one native task end to end in the packaged product: direct entry and a planning handoff, real sandbox execution, evidence review, approval and application.

#### Done when

- [ ] One small existing-repository change and regression check pass through the UI with concurrency one, using no external tracker.
- [ ] Rejecting the proposal leaves the checkout untouched; requesting revision creates another attempt under the same task.
- [ ] Test failed commands, provider failure, cancellation, engine loss and app restart. Include the known NIV-25 shutdown behaviour in the cancellation evidence rather than assuming it is solved.
- [ ] Stale patch approvals are refused. Crash tests around intent recording/application reconcile as applied/not applied/unknown without reapplying.
- [ ] Linux and Windows-to-WSL evidence names the packaged revision and exact supported backend. Native Windows is claimed only after its own checks; unsupported paths fail explicitly.
- [ ] Report useful result, checks actually run, duration/available usage and remaining work. User acceptance is distinct from run success.

#### Stop condition

Do not expand to concurrent workers, unattended intake or a second backend until critical boundary/recovery failures are resolved.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-36 — Prove browser and screenshot verification for a UI task

[Open NIV-36 in Linear](https://linear.app/sentiment-hound/issue/NIV-36/prove-browser-and-screenshot-verification-for-a-ui-task)

Milestone: E2. Status: Backlog. Priority: Medium. Depends on: NIV-35.

#### Outcome

An optional UI specialist checks a stated interaction in an existing execution run and returns reproducible evidence linked to acceptance criteria.

#### Done when

- [ ] Prove browser/preview feasibility in the selected boundary first. For Nebius, evaluate running preview and browser in one operation; do not assume persistent preview processes or public ingress.
- [ ] Restrict browser access to the task's approved preview/resources, keep credentials outside the guest, and bound/redact captured evidence.
- [ ] On a small fixture, detect a deliberately introduced UI defect, capture the relevant screenshot and exercise the functional interaction (including keyboard behaviour when relevant).
- [ ] Verification-only is the first increment. Authorised fixes later occur only in the same isolated workspace and produce the normal reviewed patch.
- [ ] Cancellation stops preview/browser work; report what was actually inspected and what was not.

#### Not included

An independent browser runtime with unrestricted host access, automatic account login or screenshots as a substitute for functional tests.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

### NIV-37 — Add a local container backend against the execution contract

[Open NIV-37 in Linear](https://linear.app/sentiment-hound/issue/NIV-37/add-a-local-container-backend-against-the-execution-contract)

Milestone: E2. Status: Backlog. Priority: Medium. Depends on: NIV-29, NIV-35.

#### Outcome

Offer a local execution option after the first end-to-end backend works, using the same conformance tests and honest capabilities.

#### Done when

- [ ] Confirm Docker/Podman installation, daemon access and target integration; installing a runtime alone is not a passing Nivra integration.
- [ ] Mount only the run workspace copy, use the approved hardened container policy and enforce network/process/resource limits.
- [ ] Pass the same workspace, output, cancellation, patch and restart tests as the first backend.
- [ ] Backend selection is explicit and remains pinned to a run. No automatic local/cloud fallback or implicit cloud upload.
- [ ] Document exact OS/target support and setup failures with actionable messages.

#### Scheduling

This can be pulled forward as an explicit alternative if NIV-29 cannot establish Nebius suitability; replan its dependency on NIV-35 in that case. Do not build two full backends before proving one safe task.

#### Verification and handoff

Follow AGENTS.md and the existing security/ownership rules. Run pnpm verify and the relevant packaged/Windows/real-engine checks for changed areas; distinguish unavailable or skipped checks from passes. Use stubbed providers in automated tests. Live model/cloud probes must have an explicitly approved budget and data scope; never print credentials. Record the revision, demonstration, failure cases and remaining limitations. Obtain approval before dependency/package changes, and update decisions/architecture last.

## Updated existing tickets

NIV-22, NIV-7, NIV-8, NIV-13 and NIV-24 now belong to this project and the milestones below. Original descriptions and evidence are preserved below explicit current-scope updates. NIV-26 and NIV-27 remain in Core POC, prioritised as Todo/High and blocking the council's live evaluation. No completed ticket was reopened or closed. NIV-13's obsolete NIV-12 dependency was removed; new-app creation remains deferred.

### NIV-22 — Deliver bounded council review of versioned plans

[Open NIV-22 in Linear](https://linear.app/sentiment-hound/issue/NIV-22/deliver-bounded-council-review-of-versioned-plans)

Milestone: P2. Status: Todo. Add dependencies: NIV-31, NIV-26, NIV-27.

#### Current implementation scope — 20 October 2026

This promotes the earlier exploration into the next review/planning feature. Focus on plans, architectural decisions and research alternatives; coding execution is not a dependency.

- [ ] Run two independent reviewers against the same versioned plan/source snapshot, then a chair. Reviewers do not see one another's first report.
- [ ] Preserve finding identifiers, evidence, assumptions and dissent. A missing/failed reviewer produces an incomplete/inconclusive result, not an unqualified approval. Agreement is not proof.
- [ ] Reuse ModelClient and explicit scoped context. Apply shared call/time/token budgets and cancellation to all child runs, with no hidden request retries. Keep partial evidence.
- [ ] Save the report into its conversation; revised plans produce a new review and never overwrite the previous artifact.
- [ ] Compare against one reviewer on five small plans with known weaknesses. Record useful findings, false alarms, latency and available usage; record adopt/simplify/defer against criteria agreed before the comparison.
- [ ] A council report informs a task's readiness but does not automatically approve code changes or update an external ticket.

No dynamic agent marketplace, unbounded debate or concurrent repository writes. Research mode is separately tracked by NIV-33. Follow the project handoff's verification requirements.

### NIV-7 — Execute one native task through a bounded coding worker

[Open NIV-7 in Linear](https://linear.app/sentiment-hound/issue/NIV-7/execute-one-native-task-through-a-bounded-coding-worker)

Milestone: E1. Status: Backlog. Add dependencies: NIV-32, NIV-34.

#### Current implementation scope — 20 October 2026

This activates the deferred coding slice for one small change to an existing repository. New-app scaffolding remains deferred. Reuse the existing engine/ModelClient for the first worker unless the feasibility evidence requires another choice; ACP/provider parity is not a prerequisite.

- [ ] Consume an immutable native task brief and its selected project, baseline and scoped context. External tracker accounts are optional.
- [ ] One worker and one task at a time; file/command tools act only through the proven sandbox workspace, never the checkout or Local backend.
- [ ] Use bounded steps/output/time and available usage. Credentials remain in engine memory and outside model inputs/guest workloads.
- [ ] Return real progress, verification results and the validated patch from NIV-34. Worker success is not task acceptance.
- [ ] Cover denied actions, nonzero test results, cancellation, provider/worker failure and lost remote observation without duplicate submissions.
- [ ] First evidence: Linux and Windows-to-WSL. Native Windows is separately proven before support is claimed. No automatic commit, push, PR or deployment.

Patch approval/application and recovery stay in NIV-8; result presentation stays in NIV-13. The first sandbox is selected by NIV-29, with Nebius the current candidate.

### NIV-8

[Open NIV-8 in Linear](https://linear.app/sentiment-hound/issue/NIV-8/implement-run-progress-approvals-cancellation-and-failure-reporting)

Milestone: E1. Status unchanged. Add dependencies: NIV-34.

#### Remaining coding scope — 20 October 2026

The read-only run lifecycle already has evidence. Keep this ticket open for the unfinished write path; preserve its In Progress status and prior history.

- [ ] Approve the exact validated patch hash, destination, owning engine and baseline; reject changes to any binding and revalidate immediately before serialised apply.
- [ ] Record apply intent before writing. Recover interrupted application as applied/not applied/unknown; never replay a write or claim success while state is unknown.
- [ ] User rejection leaves the checkout untouched. Only the owning engine applies changes; the worker operates solely in its isolated workspace.
- [ ] Persist/reconcile remote operation references. A disconnected client is not cancellation; confirm terminal remote state or report uncertainty and retain cleanup responsibility.
- [ ] Cancel all owned child work and report available usage and masked failures. Pending-approval behaviour across restart is explicitly chosen and tested.
- [ ] Distinguish task state, run status, provider operation status, command exit and user acceptance.

NIV-34 provides boundary/patch validation, NIV-7 provides the worker, and NIV-13 displays evidence. The project acceptance ticket NIV-35 exercises these together.

### NIV-13

[Open NIV-13 in Linear](https://linear.app/sentiment-hound/issue/NIV-13/show-implementation-changes-and-verification-results)

Milestone: E1. Status unchanged. Add dependencies: NIV-7, NIV-8. Remove dependency: NIV-12.

#### Current implementation scope — 20 October 2026

Show results for native tasks editing existing repositories. This supersedes the earlier dependency on new-app creation (NIV-12), which remains deferred.

- [ ] Show a task's attempt history, exact proposed patch and changed files, scoped context/brief revision, executed checks and evidence.
- [ ] Distinguish passed/failed/not run/unknown; include useful partial evidence after cancellation or failure.
- [ ] Approval controls identify the exact patch and baseline through NIV-8. A narrative summary or provider SUCCESS never substitutes for real verification.
- [ ] Requesting revision creates another attempt under the same task. Accepting an applied change is distinct from a worker ending successfully.
- [ ] Reopen after restart with durable routing and honest unavailable/expired-artifact states.

Depends on worker/lifecycle evidence, not scaffolding. Linux and Windows-to-WSL are the initial verified targets; native Windows claims require separate evidence.

### NIV-24 — Add provider-neutral ticket intake with a Linear adapter

[Open NIV-24 in Linear](https://linear.app/sentiment-hound/issue/NIV-24/add-provider-neutral-ticket-intake-with-a-linear-adapter)

Milestone: E2. Status unchanged. Add dependencies: NIV-32.

#### Current implementation scope — 20 October 2026

Native Nivra tasks work without a tracker. Add optional integrations around them, with Linear as the first provider and ClickUp a future provider.

- [ ] Separate provider authentication/API handling from deterministic normalisation. Preserve provider + connection/workspace + external ID, source URL, native status, revision/freshness and supported capabilities.
- [ ] Use one common work-item/task contract and test a second provider shape with fixtures. Do not require two live providers before shipping the first.
- [ ] Start read-only; importing the same item does not create duplicates. Repository mapping is explicit and never guessed from a title.
- [ ] AI transformation produces a separately versioned brief/plan linked to the source; it does not overwrite the source item.
- [ ] Reading provider data does not automatically authorise sending it to a model or publishing derived private context.
- [ ] External write-back is a later increment requiring an exact preview, approval, source-revision conflict checks and idempotency. A remote Ready status does not grant execution authority.

No dependency on a Linear subscription for general chat, native tasks or execution. Do not add a generic plugin marketplace or automatic ticket intake.

### NIV-26

[Open NIV-26 in Linear](https://linear.app/sentiment-hound/issue/NIV-26/three-forced-answers-without-findings-end-an-explanation-malformed)

Status: Todo.

#### Next workspace milestone — 20 October 2026

Address before the live council evaluation so multiplying reviewers does not multiply costly empty/malformed results. Retain the original reproduction and measure repair overhead. Cover missing findings and the later rehearsal's empty answer separately: a requested explanation with no useful answer must not be presented as useful success. Repairs, if any, stay inside the explicit ModelClient/run budgets and do not enable hidden provider retries. An unsupported request or legitimate lack of evidence should be reported honestly, not filled with invented findings.

### NIV-27

[Open NIV-27 in Linear](https://linear.app/sentiment-hound/issue/NIV-27/log-the-detail-of-an-engines-internal-failures-masked)

Status: Todo.

#### Next workspace milestone — 20 October 2026

Prioritise diagnostic evidence before live council/execution evaluation. Keep the original canary-key check and also prove that arbitrary repository/provider text is not persisted merely because credentials were masked. Use a bounded safe diagnostic record when an error cannot be safely rendered. Preserve protocol stdout purity and keep public errors in Nivra's own words.

## First implementation-agent instruction

Read this plan and AGENTS.md. Begin NIV-30's contract/persistence design and NIV-29's offline feasibility probe independently; do not create a new framework or choose a new dependency without required approval. Show one durable chat/task round-trip and one bounded public-fixture sandbox proof before expanding. Record evidence and stop on failed boundary/recovery checks. Cloud credentials, approved resource budget and workspace-sharing scope must be settled before live provisioning. Do not commit, push, merge, publish or send external updates without the user's applicable authorisation.
