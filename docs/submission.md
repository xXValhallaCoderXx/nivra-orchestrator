# Submission checklist (NIV-15, refreshed for the execution release by NIV-50)

**How this was checked:** against the [official rules](https://nebiusglobalaihackathon.devpost.com/rules) and the
[official FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs), rechecked on 30 October 2026. Earlier readings
are kept in this file's history. Current implementation claims were checked against main at `75b38e0`; that source
revision is not a selected or validated submission build.

- Re-read the rules, the track's wording and the form in a browser before submitting.

The [evidence table](submission-evidence.md), [release-note draft](release-notes.md) and
[judge walkthrough](judge-walkthrough.md) are the review packet. Final identities and timings remain pending until
selected or measured; these drafts do not select a build or authorise paid calls, publication or submission.

A requirement counts as met only when its evidence exists. A plan or a design is not evidence.

## Requirements

| # | Requirement | Source | Evidence (where it will be) | Owner | Status |
|---|---|---|---|---|---|
| 1 | Submit by **30 October 2026, 10:00 PDT**, which is **31 October, 01:00 SGT** | Rules | The submission form | Nate | Open; earlier internal recording windows and cutoffs are superseded |
| 2 | Judging ends 23 December 2026 at 12:00 Pacific (24 December, 04:00 SGT) | Rules, checked 30 October | — | — | Noted; supersedes the earlier December date |
| 3 | A runtime Token Factory inference call | Rules, FAQ | Historical explanations, candidate-3 task execution and D50's model probes, each with its original build/model | Agent assembles; Nate reviews | Existing runtime evidence is inventoried in the evidence table. Matching selected-build evidence remains pending |
| 4 | An NVIDIA open-source model is used | Rules | The model id in each run record | Agent | Current task model: `nvidia/Nemotron-3.5-Super-VL`, route `token-factory`; its live compatibility evidence is recorded in D50. Historical Super runs retain their original model identity. Selected-build task evidence remains pending |
| 5 | Track selection | Rules | See *Track* below | Nate | **Decided** on 27 October: Coding and Agentic Engineering. It replaces Best Apps and Agents (18 October) |
| 6 | A working demo or test-build URL | Rules | The release's page: the Windows zip, the Linux deb, `build-info.json` and `SHA256SUMS`, published unchanged, with the version, the source commit and each file's SHA256 checksum. Devpost names and links that same release, and the README directs judges there | Claude prepares; Nate publishes | Open: published at the release |
| 7 | A public open-source repository with setup instructions | Rules | github.com/xXValhallaCoderXx/nivra-orchestrator (MIT) and its README | Agent | Public source; local documentation refresh awaits review and landing |
| 8 | A public YouTube demonstration, under three minutes | Rules | The video link | Nate records and uploads | Pending recording, measured length and public URL |
| 9 | Technology feedback | Rules | The submission form's text | Nate, with a draft from Claude | **Draft below** |
| 10 | An explanation of pre-existing work and significant new work | Rules, FAQ | [provenance.md](provenance.md), and *Significant new work* below | Claude | Draft below |
| 11 | Free judge access until judging ends (24 December, 04:00 SGT) | Rules | The judge walkthrough separates inference from sandbox permissions and proposes concrete access options. No development credentials are distributed | Nate | **Unresolved:** choose, fund and test the access arrangement and name its availability owner. Judges' own paid access is not established as satisfying free testing. Historical J0/J1 at `7a0acbe` prove owner access only |
| 12 | Eligibility and licensing (entrant eligibility, third-party licences) | Rules | — | Nate | To check; not presumed |

## The demonstration

One recorded take on the build chosen for release, showing only what works in the take or in a labelled live run:
explaining a repository with evidence, planning and a task run in Nebius. Show the coach or mission review only after
its budget integration and useful live acceptance are established on the chosen build. NVIDIA Nemotron makes the
change in a Nebius sandbox, and tests it can't edit judge it there, before and after. Only a verified change can be
approved, by its hash, and applied by the engine on the repository's own system. The outcome must match the evidence:
a verified change applied and accepted,
a failed verification, or a human rejection. Candidate 3's historical proposal passed its configured acceptance
suites but was rejected after review found the broken caller; do not describe it as an automatic refusal or a fix.
The final take, measured duration and video URL remain pending. No private material is filmed. The script is
[demo-script.md](demo-script.md).

Long waits are cut in the edit, with a caption saying so, never sped up or simulated.

## Track

**Coding and Agentic Engineering**, chosen by Nate on 27 October 2026 after the execution path was built. The official
rules describe the track as: "Build coding agents and developer tools: agents that write, run, and test code in Token
Factory." Nivra's worker is such an agent:
- NVIDIA Nemotron, through Token Factory, makes a change in a Nebius sandbox, on a copy of one commit, with networking
  off;
- the repository's own tests run there before the model starts and after it hands in, and acceptance cases it can't
  edit, together with every required repository check and integrity check, decide whether the change is verified;
- nothing reaches the checkout until the person approves that exact patch, and the engine that owns the checkout
  applies it.

Best Apps and Agents (18 October) was chosen when coding work was deferred (D20, D24). It no longer was by 27 October.

## Submission text (draft for the form)

For Nate to review and paste into Devpost. Resolve the release, selected-build evidence, video and judge-access
fields before submission. Match the field names to the actual form; implementation descriptions below must be checked
against the selected build rather than treated as a record of its live acceptance.

**Project name:** Nivra

**Elevator pitch** (200 characters at most; this one is 175):
> A coding agent in a boundary: NVIDIA Nemotron changes your code in a Nebius sandbox, tests it can't edit judge the
> change, and nothing lands until you approve the exact patch.

**About the project**

*Inspiration.* Coding agents can write code. It's harder to see what they read, where the code ran, whether the tests
that passed were the ones that matter, and what reaches your files. Nivra makes each of those visible, and nothing
reaches your checkout without your approval of the exact change.

*What it does*
- **Runs a coding task in a Nebius sandbox.**
  - A task's brief has a goal and acceptance cases: commands, each with the exact output and exit code only the right
    behaviour gives. The files they depend on are frozen.
  - The Run preview says what goes to Token Factory and Nebius, what each keeps, and the run's limits, before anything
    is sent.
  - Explicit baseline assertions run first; required repository checks are observed before changes and must pass
    on the result. NVIDIA Nemotron changes a copy of one commit with networking off, through fixed tools the engine carries out.
  - Nivra judges the result outside what the model can edit, and proposes it as an exact patch.
  - The person approves it by its hash. The engine on the repository's own system applies it, keeping every original,
    and leaves it unstaged. No commit, no push.
- **Prepares JavaScript and TypeScript environments with npm or pnpm:** resolves the supported Node version and
  package-manager choice, previews workspace-package selection, and installs from the committed lockfile inside
  Nebius. Package-manager pins are exact; bundled npm's actual version is recorded during preparation.
  Only preparation has networking on. Python and Rust environments remain out of this submission's scope.
- **Explains a repository with evidence,** each citation checked against the lines the model was shown.
- **Remembers preferences you confirm,** with explicit precedence: task choices, project decisions to change a
  convention, existing repository conventions, project defaults, then personal defaults.
- **Plans with you:** saved plans in versions, a council review (two reviewers and a chair), and web research of a
  plan's assumptions through Tavily, its quotations checked for where they came from.
- **Authors missions and briefs without a model:** native mission/backlog and task editors, plus deterministic
  readiness guidance. Paid mission review and coaching remain excluded from the demonstrated journey until their
  separate grant integration and useful live acceptance are evidenced.
- **Asks first:** sending content to the model, uploading a commit to Nebius, and research queries are separate
  permissions, each off until allowed.

*How we built it*
- **The desktop app:** Electron, with React and Mantine.
- **Engines:** a Node engine for each place repositories live (Linux, or the WSL distribution holding the
  repository), speaking JSON-RPC over stdio. Workflows run on Mastra, with SQLite for runs and workflow state.
- **The model:** NVIDIA Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) through Nebius Token Factory's
  OpenAI-compatible API. Every call has a deadline, so does every run, and the usage each call reports is recorded.
- **Execution:** Nebius Sandboxes, one operation per step, with state carried by the image each leaves. Commit
  snapshots go in, and a validated patch comes out. Nivra runs fixed scripts with the model's input as arguments, so
  nothing the model writes is interpolated into a command.
- **Verification:** acceptance cases and every required repository check must pass, with complete frozen-file and
  setup-integrity evidence; named test results are required where declared, not just an exit code. A failed or missing
  required final check prevents approval.
- **Apply:** a writer that holds every folder it passes through open, never follows a link, records its intent first,
  and reconciles after a crash. It never replays a write, and it never removes the originals it keeps.

*Challenges*
- **Making approval mean something.** An approval isn't a boundary: the sandbox is. Several rounds of independent
  review of the apply path found races a careful design still had, such as an editor's atomic save landing between a
  check and a removal. Each was reproduced, then fixed with a test.
- **Real checks with networking off.** The historical preparation imported a pinned Node 22 image and installed
  dependencies in a separate operation. The current npm/pnpm resolver previews supported versions and install
  options; only preparation has networking on.
- **Keeping the verdict away from the worker.** Acceptance inputs are frozen before the worker starts. Verification
  also requires every final repository check and complete integrity evidence; regression tests cover missing,
  failed and altered evidence. The command still proves only what it actually checks.

*Accomplishments* (measured; the conditions are below)
- **The live task** (candidate 3, 0.2.0 at `c99fe9d`, 28 October): the configured acceptance suites passed, but the
  repository typecheck failed with three new errors. An AI review identified the broken caller before Nate's decision.
  He rejected the proposal, and his checkout remained unchanged. It was not a fix: no change has yet been approved,
  applied and accepted live.
- **The selected build's checks:** pending build selection and applicable source, real-engine, packaged and Windows
  receipts. The evidence table names earlier candidates; their counts are not the final build's counts.
- **Historical explain/preferences evidence:** 14/14 live criteria on each v0.1.0 packaged route, Linux and
  Windows→WSL, carried to v0.1.1 only because those payloads were unchanged. v0.1.1 then passed its own clean-setup
  checks: 23/23 Windows→WSL and 22/22 Linux. These do not validate later model/runtime changes.

*What we learned:* passing the frozen tests isn't the whole of a correct change. On candidate 3's live run, a change
passed every acceptance case while breaking a caller those cases don't reach. That historical verdict counted only
the cases; the repository typecheck was reported without deciding. An AI review found the defect and the person
rejected the proposal. NIV-67 is now implemented: every required final check must pass, and before/after observations
help explain failures without excusing them. Its offline evidence is in [acceptance.md](acceptance.md), under
"Required repository checks and trustworthy approval"; it does not retroactively fix the historical task. Earlier
runs taught that a request's limit must fit its whole answer: requests aren't streamed, and on candidate 2 two runs
stopped when a request reached its 150 s. Candidate 3 allowed 830 s, and its
longest request, 156.1 s, completed.

*What's next (planned, not built):* macOS; a browser and screenshot specialist; read-only ticket intake; another
execution backend; task runs from the native Windows engine; package managers other than npm/pnpm; Python and Rust
environments.

**Built with:** Electron, React, Mantine, TypeScript, Node.js, Mastra, SQLite, zod, NVIDIA Nemotron, Nebius Token
Factory, Nebius Sandboxes, Tavily, WSL, Playwright.

**Links**
- Source: https://github.com/xXValhallaCoderXx/nivra-orchestrator (MIT)
- Release: the release's page, which gives the version, the source commit and the checksums (its URL goes in when
  Nate publishes it)
- Video: pending genuine recording, review, measured length and public YouTube URL
- The onboarding sample (optional): https://github.com/xXValhallaCoderXx/nivra-sample (MIT), at `bbf62893cb699c6994cca9fa7219b66f87f5a30d`

**Track:** Coding and Agentic Engineering (item 5).

**Testing instructions** (draft for the private form field, item 11). Access arrangement and private delivery are
pending. Do not submit this field with an unresolved promise or the owner's development credentials.

1. Install the release from its page (the Windows zip, or the Linux deb), which lists the version, the source commit
   and each file's checksum.
2. Follow the agreed private access instructions, then save its key under **Settings → Connections → Nebius API key**.
   No Nebius project id is needed for Explain.
   - For the optional sandbox path, also save **Project ID, for Nebius Sandboxes**. That project needs Sandboxes (beta) access,
     which Nebius grants per project on request, on its Sandboxes page.
3. Follow the [judge walkthrough](judge-walkthrough.md) on the optional public sample. Selected-build duration is
   pending measurement. **Check Token Factory** is an optional paid diagnostic, separate from Explain.
4. Use the onboarding sample, or code you're happy to share: whatever you upload stays with Nebius in your project.

**Measured, with conditions,** for the text or the video. The model and the sandboxes run on Nebius, so times depend on
the service.
- **The environment's feasibility run** (27 October, revision `9fb57a2`, run by the engine's own script, not the app):
  - importing the Node 22 image took 9.7 s. Then pnpm 11.5.3 installed the data package's dependencies in one
    operation, with networking on, which took 13.1 s by Nebius's own usage figure;
  - then, with networking off, the regression alone failed for the bug's reason in 2.9 s (5 of 5 tests); the existing
    data tests passed in 6.5 s (227 passed, 4 skipped); the domain suite passed in 11.7 s (1,122).
- **The live task run** (candidate 3, 0.2.0 at `c99fe9d`, 28 October, through the app):
  - the preparation took 30 s. The run, from Start at 18:25:48 to its report at 18:32:20 SGT, made 20 model requests,
    all reported: 436,012 input and 7,395 output tokens. The longest answered 3,086 tokens in 156.1 s;
  - the data suite passed (232 passed, 4 skipped: the repository's database integration tests, which run only against
    a local database), the domain suite passed (1,122), the frozen files were unchanged, and the typecheck failed with
    three new errors. Rejected at 18:48 SGT.
- **v0.1.1's explanations** (19–20 October, Windows 11 with WSL 2.7.8, and an Ubuntu 24.04 VM): 46–212 s each, and
  11,887–142,580 input tokens each. Every citation pointed to lines the model was shown: 129 of 129, across ten
  explanations.

**Significant new work (item 10).** Nivra was started on 16 October 2026, inside the submission period (26 August to 30
October 2026). It reuses concepts and some code from Hird, an earlier desktop app by the same author, also started
inside the period, on 8 October 2026. [provenance.md](provenance.md) lists every piece, with the Hird commit it came
from. Since v0.1.1 (19 October): saved plans and conversations, the council review, Tavily research, the Nebius
sandbox adapter and sandbox checks, task runs judged by acceptance cases, approval by hash and the apply writer, and
project-driven npm/pnpm environments with workspace selection, native missions and task guidance, explicit budget
coverage for integrated workflows, and required repository-check enforcement. The selected release must actually
contain the features claimed; paid coach/mission-review acceptance remains open.

## Final completion record

- [ ] Review and land this documentation refresh; reconcile claims with the selected, reviewed build.
- [ ] Record version, full source revision, runtime identities, relevant checks and frozen asset hashes.
- [ ] Publish that build and verify the downloaded assets against its hashes and source link.
- [ ] Bind each advertised model/execution claim to its own evidence; disclose platform and live-quality limits.
- [ ] Resolve and test free judge access, cost responsibility and availability through 24 December at 04:00 SGT.
- [ ] Review genuine footage and historical captions, measure the edit and verify the public YouTube link.
- [ ] Finish Devpost text, testing instructions, links and technology feedback; record Nate's actual submission confirmation.

Nate publishes and submits unless he separately delegates. No VM, new paid attempt or publication is authorised by
this checklist. NIV-28's locked-GNOME case remains deferred; NIV-58/59 evidence remains separately tracked. Keep
NIV-50 In Progress until publication and submission are evidenced, even if the docs are approved or merged.

## Technology feedback (draft for item 9)

From recorded runs; Nate edits before submitting.

**Token Factory and Nemotron**
- **Current model compatibility:** the five inference requests recorded in D50 for `nvidia/Nemotron-3.5-Super-VL`
  passed the tool-use probes. They used 3,293 input and 1,489 completion tokens, including 547 reasoning tokens already
  counted in the completion total. `max_completion_tokens` was accepted; the forced-answer probe used its entire
  1,000-token allowance. These small probes establish compatibility, not reliable completion of substantial work.
  The provider reported no cost. The following Super observations are historical, not measurements of the new model.
- **The OpenAI-compatible API** worked for runtime tool calling with `nvidia/nemotron-3-super-120b-a12b`: every call
  reported usage, and the documented rate-limit headers were present.
- **Tool choice:** Nemotron 3 Super honoured `toolChoice: "required"`, a forced choice between two tools, and a forced
  structured answer that validated against our schema.
- **`/models?verbose=true`** reports each model's `context_length` (262,144 tokens for Nemotron 3 Super), which let us
  size requests without guessing.
- **Structured answers:** when an answer was due in one step, Nemotron sometimes sent lists as strings. Allowing three
  answer steps, with the problem named in a tool result, let it recover.
- **Evidence discipline:** it sometimes cited files it had only seen named. Refusing citations of lines it hadn't been
  shown, and saying which, made it read them and resubmit.

**Nebius Sandboxes** (beta)
- **One operation per step worked**, with state carried by the image each leaves: a median step of 2.9 s in our first
  probe (20 October).
- **Networking off held, shown by behaviour:** only the loopback interface existed, and requests failed to resolve or
  reach. The same request with networking on connected.
- **Outcomes need care:** a failing test comes back as `SUCCESS` with exit 1, and a timeout as exit -1 with signal 9,
  while `signal: -1` means no signal at all. A client has to read all three.
- **The access token renews with each request,** about five minutes ahead. The API key's own expiry is only in the
  console.
- **Nothing can be deleted:** uploads, operation records and logs stay, and an operation's record keeps the content a
  command wrote. That shaped what Nivra sends and what its preview says.
- **The `cost` field has no documented unit,** so Nivra shows it raw and never turns it into money.
- **No public Node 22 image:** importing a pinned one from Docker Hub worked (27 October). Nebius's API reference
  describes an import's tag as what identifies the image "when listing publicly available images". Without one, the
  image is "private and only accessible by ID", and a tag that already exists in the public images is replaced by the
  import. So Nivra leaves its imports untagged. Whether a tagged import is visible to other accounts wasn't tested.
- **One upload was answered with HTTP 500** on a first attempt (21 October). The approved rerun passed.
