# Submission checklist (NIV-15, refreshed for the execution release by NIV-50)

**How this was checked:** against the [official rules](https://nebiusglobalaihackathon.devpost.com/rules) and the
[official FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs), as Nate read them on 27 October 2026 (NIV-50,
and the delivery plan linked there). The 17 October reading (NIV-15) is kept in this file's history.
- Exact wording quoted here comes from Nate's reading of the official pages.
- Re-read the rules, the track's wording and the form in a browser before submitting.

A requirement counts as met only when its evidence exists. A plan or a design is not evidence.

## Requirements

| # | Requirement | Source | Evidence (where it will be) | Owner | Status |
|---|---|---|---|---|---|
| 1 | Submit by **30 October 2026, 10:00 PDT**, which is **31 October, 01:00 SGT**. Nate's working budget ends sooner: Thursday 29 October, 13:00 SGT | Rules | The submission form | Nate | Open |
| 2 | Judging ends 15 December 2026 at 12:00 Pacific (16 December, 04:00 SGT) | Rules | — | — | Noted |
| 3 | A runtime Token Factory inference call | Rules, FAQ | Recorded runs: the v0.1.1 explanations (17–20 October), and the execution release's live task run | Claude records; Nate supplies the key | v0.1.1's evidence is recorded (below). The execution release's: PENDING-H3 |
| 4 | An NVIDIA open-source model is used | Rules | The model id in each run record | Claude | `nvidia/nemotron-3-super-120b-a12b`, route `token-factory`, in every recorded run. The task run's: PENDING-H3 |
| 5 | Track selection | Rules | See *Track* below | Nate | **Decided** on 27 October: Coding and Agentic Engineering. It replaces Best Apps and Agents (18 October) |
| 6 | A working demo or test-build URL | Rules | The release's page: the Windows zip, the Linux deb, `build-info.json` and `SHA256SUMS`, published unchanged, with the version, the source commit and each file's SHA256 checksum. Devpost names and links that same release, and the README directs judges there | Claude prepares; Nate publishes | Open: published at the release |
| 7 | A public open-source repository with setup instructions | Rules | github.com/xXValhallaCoderXx/nivra-orchestrator (MIT) and its README | Claude | Public. The README is refreshed for the release |
| 8 | A public YouTube demonstration, under three minutes | Rules | The video link | Nate records and uploads | PENDING-TAKE |
| 9 | Technology feedback | Rules | The submission form's text | Nate, with a draft from Claude | **Draft below** |
| 10 | An explanation of pre-existing work and significant new work | Rules, FAQ | [provenance.md](provenance.md), and *Significant new work* below | Claude | Draft below |
| 11 | Free judge access until judging ends (16 December, 04:00 SGT) | Rules | The testing instructions: judges enter their own Token Factory key and Nebius project id, as any user does; no credentials are given (Nate, 28 October). The sandbox check needs a project with Sandboxes (beta) access | Nate | Decided on 28 October: judges bring their own credentials. Whether that meets the rules' free-access requirement is for Nate to confirm against the official rules: PENDING-NATE. Our own credentials checked: PENDING-J0, PENDING-J1; through the app: PENDING-TAKE |
| 12 | Eligibility and licensing (entrant eligibility, third-party licences) | Rules | — | Nate | To check; not presumed |

## The demonstration

One recorded take on the build chosen for release, showing only what works in the take or in a labelled live run:
explaining a repository with evidence, saved plans with their council review and research, the coach (if the build
has it), a sandbox check, and a task run in Nebius. NVIDIA Nemotron makes the change in a Nebius sandbox, and tests it
can't edit judge it there, before and after. Only a verified change can be approved, by its hash, and applied by the
engine on the repository's own system. Whether the take ends with a verified change applied, or an unverified one
refused with the checkout untouched, depends on the evidence by then: PENDING-TAKE. No private material is filmed. The
script is [demo-script.md](demo-script.md).

Long waits are cut in the edit, with a caption saying so, never sped up or simulated.

## Track

**Coding and Agentic Engineering**, chosen by Nate on 27 October 2026 after the execution path was built. The track
asks for coding agents and developer tools that work inside Token Factory Sandboxes (PENDING-NATE: the track's exact
wording, from the official page). Nivra's worker is such an agent:
- NVIDIA Nemotron, through Token Factory, makes a change in a Nebius sandbox, on a copy of one commit, with networking
  off;
- the repository's own tests run there before the model starts and after it hands in, and acceptance cases it can't
  edit decide whether the change is verified;
- nothing reaches the checkout until the person approves that exact patch, and the engine that owns the checkout
  applies it.

Best Apps and Agents (18 October) was chosen when coding work was deferred (D20, D24). It no longer was by 27 October.

## Submission text (draft for the form)

For Nate to paste into Devpost and edit. Each claim rests on recorded evidence. Placeholders in capitals wait for
results not yet produced. Match the field names to the form when submitting.

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
  - The repository's checks run first (PENDING-H2), then NVIDIA Nemotron makes the change on a copy of one commit, with
    networking off, through fixed tools Nivra's engine carries out.
  - Nivra judges the result outside what the model can edit, and proposes it as an exact patch.
  - The person approves it by its hash. The engine on the repository's own system applies it, keeping every original,
    and leaves it unstaged. No commit, no push.
- **Prepares a Node and pnpm environment inside the boundary:** the pinned Node image imported into the person's Nebius
  project, and the dependencies installed from the frozen lockfile in a run of its own, the only one with networking
  on.
- **Explains a repository with evidence,** each citation checked against the lines the model was shown.
- **Remembers preferences you confirm,** with explicit precedence over a repository's own conventions.
- **Plans with you:** saved plans in versions, a council review (two reviewers and a chair), and web research of a
  plan's assumptions through Tavily, its quotations checked for where they came from.
- **Asks first:** sending content to the model, uploading a commit to Nebius, and research queries are separate
  permissions, each off until allowed.

*How we built it*
- **The desktop app:** Electron, with React and Mantine.
- **Engines:** a Node engine for each place repositories live (Linux, or the WSL distribution holding the
  repository), speaking JSON-RPC over stdio. Workflows run on Mastra, with SQLite for runs and workflow state.
- **The model:** NVIDIA Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) through Nebius Token Factory's
  OpenAI-compatible API. Every call has a deadline, so does every run, and the usage each call reports is recorded.
- **Execution:** Nebius Sandboxes, one operation per step, with state carried by the image each leaves. Commit
  snapshots go in, and a validated patch comes out. Nivra runs fixed scripts with the model's input as arguments, so
  nothing the model writes is interpolated into a command.
- **Verification:** acceptance cases compared byte for byte on the person's computer; frozen files checked; named test
  results required, not just an exit code.
- **Apply:** a writer that holds every folder it passes through open, never follows a link, records its intent first,
  and reconciles after a crash. It never replays a write, and it never removes the originals it keeps.

*Challenges*
- **Making approval mean something.** An approval isn't a boundary: the sandbox is. Several rounds of independent
  review of the apply path found races a careful design still had, such as an editor's atomic save landing between a
  check and a removal. Each was reproduced, then fixed with a test.
- **Real checks with networking off.** Nebius has no public Node 22 image, so the environment imports a pinned one and
  installs the dependencies in a run of its own, with networking on only there.
- **Keeping the verdict away from the worker.** The tests that judge the change are frozen before the worker starts,
  and a regression shows that editing, skipping or excluding them can't produce a verified change (PENDING-H2).

*Accomplishments* (measured; the conditions are below)
- **The live task:** PENDING-H3.
- **The offline suite:** PENDING-H4 tests at the release's commit, with the packaged and Windows checks as recorded.
- **Earlier, still valid:** the explain and preferences features passed live acceptance on packaged builds (14 of 14
  criteria on Linux and on Windows to WSL, 18–19 October), and the v0.1.1 clean setups (23 of 23, and 22 of 22).

*What we learned:* PENDING-H3, from the live run and the reviews.

*What's next (planned, not built):* macOS; a browser and screenshot specialist; read-only ticket intake; another
execution backend; task runs from the native Windows engine; package managers other than pnpm.

**Built with:** Electron, React, Mantine, TypeScript, Node.js, Mastra, SQLite, zod, NVIDIA Nemotron, Nebius Token
Factory, Nebius Sandboxes, Tavily, WSL, Playwright.

**Links**
- Source: https://github.com/xXValhallaCoderXx/nivra-orchestrator (MIT)
- Release: the release's page, which gives the version, the source commit and the checksums (its URL goes in when
  Nate publishes it)
- Video: PENDING-TAKE
- The onboarding sample: https://github.com/xXValhallaCoderXx/nivra-sample (MIT), at PENDING-SAMPLE-COMMIT

**Track:** Coding and Agentic Engineering (item 5).

**Testing instructions** (the form's field for judges, item 11). No credentials are given: judges use their own.
1. Install the release from its page (the Windows zip, or the Linux deb), which lists the version, the source commit
   and each file's checksum.
2. Under Settings, paste your own Token Factory key and your Nebius project's id.
   - The project needs Sandboxes (beta) access, which Nebius grants per project on request, on its Sandboxes page.
3. Follow the README's testing instructions, the quick path on the onboarding sample: about PENDING-TAKE minutes.
4. Use the onboarding sample, or code you're happy to share: whatever you upload stays with Nebius in your project.

**Measured, with conditions,** for the text or the video. The model and the sandboxes run on Nebius, so times depend on
the service.
- **The environment's feasibility run** (27 October, revision `9fb57a2`, run by the engine's own script, not the app):
  - importing the Node 22 image took 9.7 s. Then pnpm 11.5.3 installed the data package's dependencies in one
    operation, with networking on, which took 13.1 s by Nebius's own usage figure;
  - then, with networking off, the regression alone failed for the bug's reason in 2.9 s (5 of 5 tests); the existing
    data tests passed in 6.5 s (227 passed, 4 skipped); the domain suite passed in 11.7 s (1,122).
- **The live task run:** PENDING-H3.
- **v0.1.1's explanations** (19–20 October, Windows 11 with WSL 2.7.8, and an Ubuntu 24.04 VM): 46–212 s each, and
  11,887–142,580 input tokens each. Every citation pointed to lines the model was shown: 129 of 129, across ten
  explanations.

**Significant new work (item 10).** Nivra was started on 16 October 2026, inside the submission period (26 August to 30
October 2026). It reuses concepts and some code from Hird, an earlier desktop app by the same author, also started
inside the period, on 8 October 2026. [provenance.md](provenance.md) lists every piece, with the Hird commit it came
from. Since v0.1.1 (19 October): saved plans and conversations, the council review, Tavily research, the Nebius
sandbox adapter and sandbox checks, task runs judged by acceptance cases, approval by hash and the apply writer, and
the prepared environment (D26 to D40, and PENDING-H4).

## Technology feedback (draft for item 9)

From recorded runs; Nate edits before submitting.

**Token Factory and Nemotron**
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
