# Submission checklist (NIV-15)

**How this was checked:** verified on 17 October 2026 against the [official rules](https://nebiusglobalaihackathon.devpost.com/rules)
(sections 1 and 4) and the [official FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs).
- The pages were read in a browser during the 17 October review, and the findings were recorded in NIV-15.
- Devpost answers automated requests with HTTP 403, so tooling has not re-fetched them for this file.
- On 18 October Nate fetched the official rules in a browser: the Best Apps and Agents track's wording supports this
  submission (#5).
- Re-check the pages before submitting.

A requirement counts as met only when its evidence exists. A plan or a design is not evidence.

## Requirements

| # | Requirement | Source | Evidence (where it will be) | Owner | Status |
|---|---|---|---|---|---|
| 1 | Submit by **30 October 2026, 10:00 PDT**, which is **31 October, 01:00 SGT** | Rules §1 | The submission form | Nate | Open |
| 2 | Judging runs 1–15 December 2026, ending 15 December at 12:00 Pacific (16 December, 04:00 SGT) | Rules §1 | — | — | Noted |
| 3 | A runtime Token Factory inference call: this meets the general Nebius platform requirement | Rules §4, FAQ | The NIV-6 explain workflow, plus a recorded live run (model id, timing, usage) | Claude builds it; Nate supplies the key | **Evidence recorded** on 17 October: live explanations of fixture A with `nvidia/nemotron-3-super-120b-a12b`. The default question took 76.3 s, with 77,514 tokens in and 2,420 out over 11 calls, all reporting usage, and 13 of 13 citations shown to the model. The workflow (D22) is merged (PR #1), with precedence and the preference lifecycle (D23, PR #2). |
| 4 | An NVIDIA open-source model is used | Rules §4 | The model id in the run record | Claude | **Evidence recorded**, as for #3: the run records `nvidia/nemotron-3-super-120b-a12b` and the route `token-factory`. |
| 5 | Track selection | Rules §4 | See *Track* below | Nate | **Decided** on 18 October: Best Apps and Agents |
| 6 | A working demo or test-build URL | Rules §4 | The v0.1.1 GitHub Release: the Windows zip, the Linux deb, `build-info.json` and `SHA256SUMS`, published unchanged | Claude prepares; Nate publishes (NIV-16) | **Candidate 0.1.1** (`cad5eca`, D25). v0.1.0 (`ead56e8`, accepted live, D24) is a published pre-release, but its native Windows engine needs the Visual C++ Redistributable. 0.1.1 fixes that, and its Linux and WSL payloads are unchanged, so NIV-14's evidence carries over. **Published** on 19 October, and marked Latest on 20 October after clean-setup checks 1 and 2 passed on its files. Check 3, a PC without the Visual C++ Redistributable, is still to run. v0.1.0 is marked superseded |
| 7 | A public open-source repository with setup instructions | Rules §4 | github.com/xXValhallaCoderXx/nivra-orchestrator (MIT) and its README | Claude | Repository public; setup instructions final at release |
| 8 | A public YouTube demonstration, under three minutes | Rules §4 | The video link (NIV-17) | Nate | Pending |
| 9 | Technology feedback (Token Factory, the NVIDIA models) | Rules §4 | The submission form's text | Nate, with a draft from Claude | **Draft below**, for Nate to edit |
| 10 | An explanation of pre-existing work and substantial updates | Rules §4, FAQ | [provenance.md](provenance.md) | Claude | In place; final wording at submission |
| 11 | Free judge access until judging ends (16 December, 04:00 SGT) | Rules §4 | Nate's existing Token Factory key, in the submission's private testing instructions (D24, NIV-16) | Nate | **Decided** on 19 October |
| 12 | Eligibility and licensing (entrant eligibility, third-party licences) | Rules | — | Nate | To check; not presumed |

## The demonstration (D20, Best Apps and Agents)

Under three minutes, on the packaged app, with the two public demonstration repositories: A,
[valhalla-fitness](https://github.com/xXValhallaCoderXx/valhalla-fitness) (PascalCase component files, Vitest), and B,
`nivra-demo-timer` (kebab-case component files, Jest), a small synthetic repository made for the purpose. It shows
only behaviour that has been observed working; it doesn't promise scaffolding, code execution or applying patches.

| Time | Beat | What is on screen |
|---|---|---|
| 0:00–0:15 | The problem | An engineer's preferences, and a repository with its own conventions: which governs? |
| 0:15–0:50 | Evidence | Explain A: findings with citation chips, each "shown to the model". |
| 0:50–1:10 | Confirmed memory | Confirm a personal preference (PascalCase, Vitest) and one for A only (its Mantine web UI). |
| 1:10–1:45 | A contrasting repository | Explain B: its kebab-case and Jest govern over the personal default; Context used shows A's own was never sent. |
| 1:45–2:15 | An explicit override | A task choice governs that run only; "Currently" still shows B's convention, and the stored preferences are unchanged. |
| 2:15–2:40 | Fresh context | Edit, then delete, the preference; the next run uses the preferences as they are now. |
| 2:40–3:00 | How it runs | NVIDIA Nemotron 3 Super through Nebius Token Factory at runtime; the engine on the repository's own system (Windows → WSL, or Linux); open source. |

Long model runs are cut in the edit, never faked.

**How it uses NVIDIA and Nebius:** the explain workflow (NIV-6, D22) calls an NVIDIA Nemotron model through Token
Factory at runtime, with tool calls to list, search and read the repository, and a structured answer whose citations
the engine checks. Fixture A's live explanation is the recorded evidence (#3, #4).

**Linked gaps**
- The release, the judges' instructions and judge access: NIV-16.
- Recording and evidence: NIV-17.

## Track

**Best Apps and Agents**, decided by Nate on 18 October 2026 after reading the official rules: Nivra is a desktop app
whose agent explains repositories with evidence and applies an engineer's confirmed preferences with explicit
precedence. The Coding and Agentic Engineering track's "write, run, and test code" wording described work that D20
defers, so that track is no longer the target.

**Questions for the organisers:** not needed. The track is decided, Sandboxes no longer matter to this submission,
and judges get a key in the private testing instructions (#11). None was sent.

## Submission text (draft for the form)

For Nate to paste into Devpost and edit. Each claim rests on recorded evidence, and planned work is labelled as planned.
Match the field names to the form when submitting: Devpost blocks tooling, so they haven't been read here.

**Project name:** Nivra

**Elevator pitch** (200 characters at most):
> A desktop agent that explains your repository with checked evidence, and applies your confirmed preferences with
> explicit precedence, on NVIDIA Nemotron through Nebius Token Factory.

**About the project**

*Inspiration.* Coding assistants remember what you like, but they rarely say whose rule wins when a repository's own
conventions disagree, or which lines they actually read. Nivra makes both visible.

*What it does*
- **It explains a repository with evidence.** Each finding cites files and lines. Nivra checks every citation against
  the lines the model was actually shown, and labels it as just that, never as proof that the explanation is right.
- **It remembers preferences you confirm.** Personal ones apply to every project, and a project's own apply only to it.
  Each run gets a snapshot of the ones that apply when it starts, so an edit or a deletion reaches the next run.
- **It applies explicit precedence.** When a repository's conventions differ from your preferences, the explanation
  reports the conflict, and the engine says which source governs. Highest first:
  1. this task's choices;
  2. a project's decisions to change its conventions;
  3. the repository's existing conventions;
  4. a project's defaults;
  5. personal defaults.

  A task's choice governs that run only, and is shown as intended, never as current behaviour.
- **Nothing is sent without consent.** Sending a project's content to the model is off until you allow it for that
  project.
- **It runs where the repository lives.** On Windows, folders in WSL run in their distribution; on Linux, locally.

*How we built it*
- **The desktop app:** Electron, with React and Mantine.
- **Engines:** a Node engine for each place repositories live, speaking JSON-RPC over stdio. Its workflows run on
  Mastra, with SQLite for runs and workflow state.
- **The model:** explanations call NVIDIA Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) through Nebius Token
  Factory's OpenAI-compatible API.
  - The model reads the repository only through fixed, read-only tools that the engine runs: list, search and read.
  - It answers in a structured form that the engine validates.
  - Every call has a deadline, and so does the whole run. The usage each call reports is recorded.
- **Ranking:** the model reports each conflict and names its sources. The engine ranks them by the sources' kind and
  id, never by their words.

*Challenges*
- **Evidence discipline.** Models cite files they have only seen named. Nivra turns down an answer that cites lines the
  model wasn't shown, naming each one, while there's time to read them. After two refusals, or once the answer is due,
  it accepts the answer, and any such citation stays labelled "Not checked".
- **Running across Windows and WSL.** That meant a protocol-only stdout, `wsl.exe`'s UTF-16 output, a runtime
  installed into each distribution on first use, and paths that cross the boundary.
- **Packaging honestly.** Preparing clean-machine checks, we found that the Windows runtime shipped a C++ runtime DLL
  where Windows never looks. We fixed it in v0.1.1, with a regression check that an installed copy can't satisfy.

*Accomplishments*
- **Live acceptance on the packaged builds:** every criterion passed on the Linux deb and on the Windows zip driving
  WSL, 14 of 14 each. It ran on candidate 0.1.0, whose Linux and WSL payloads v0.1.1 keeps unchanged.
- **Clean-setup checks of the published v0.1.1 files,** with README testing steps 4–8 run through the app:
  - Windows → WSL against a fresh Ubuntu 26.04.1: 23 of 23 checks;
  - Ubuntu 24.04 with AppArmor on: 22 of 22.

*What we learned:* structured answers need a refusal loop that names the problem, and an agent's evidence is worth
showing only when the app checks it.

*What's next (planned, not built):*
- coding work inside a sandbox, with patches you approve;
- new-app creation;
- macOS.

**Built with:** Electron, React, Mantine, TypeScript, Node.js, Mastra, SQLite, zod, NVIDIA Nemotron, Nebius Token
Factory, WSL, Playwright.

**Links**
- Source: https://github.com/xXValhallaCoderXx/nivra-orchestrator (MIT)
- Release: https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1
- Demonstration repositories: https://github.com/xXValhallaCoderXx/valhalla-fitness and
  https://github.com/xXValhallaCoderXx/nivra-demo-timer
- Video: to add from NIV-17

**Track:** Best Apps and Agents (#5).

**Testing instructions** (the private field for judges, #11)
1. Install v0.1.1 from the release.
   - Windows 10/11 x64: the zip. Folders inside WSL 2 run there. SmartScreen asks once: **More info → Run anyway**.
     Smart App Control may refuse an unsigned app.
   - Linux x64: the deb, installed with `sudo apt install ./Nivra-0.1.1-amd64.deb`.
2. Under Settings, paste this Token Factory key: `<the key, entered here only>`. It works until judging ends, 16
   December, 04:00 SGT.
3. Follow the README's testing instructions: about ten minutes, with five explanations that take one to four minutes
   each.

**Measured, with conditions,** for the text or the video. The model runs on Nebius, so times depend on the service.
These were measured on 19–20 October on Windows 11 with WSL 2.7.8, and on an Ubuntu 24.04 VM:
- explanations took 46–212 s each;
- each used 11,887–142,580 input tokens;
- every citation pointed to lines the model was shown: 129 of 129, across the ten explanations.

**Pre-existing work (#10):** Nivra was started on 16 October 2026, inside the submission period (26 August to 30
October 2026). It reuses concepts and some code from Hird, an earlier desktop app by the same author, also started
inside the period, on 8 October 2026. [provenance.md](provenance.md) lists every piece, with the Hird commit it came
from.

## Technology feedback (draft for #9)

From recorded runs (D22, D23); Nate edits before submitting.
- **Token Factory's OpenAI-compatible API** worked for runtime tool calling with `nvidia/nemotron-3-super-120b-a12b`:
  every call reported usage, and the documented rate-limit headers were present.
- **Tool choice:** Nemotron 3 Super honoured `toolChoice: "required"`, a forced choice between two tools, and a forced
  structured answer that validated against our schema.
- **`/models?verbose=true`** reports each model's `context_length` (262,144 tokens for Nemotron 3 Super), which let us
  size requests without guessing.
- **Structured answers:** when an answer was due in one step, Nemotron sometimes sent lists as strings. Allowing three
  answer steps, with the problem named in a tool result, let it recover.
- **Optional fields:** Nemotron left optional suggestions empty until the prompt asked for one per established
  convention.
- **Evidence discipline:** it sometimes cited files it had only seen named. Refusing citations of lines it hadn't been
  shown, and saying which, made it read them and resubmit, with every citation then checked.
