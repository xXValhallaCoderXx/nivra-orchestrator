# Submission checklist (NIV-15)

**How this was checked:** verified on 17 October 2026 against the [official rules](https://nebiusglobalaihackathon.devpost.com/rules)
(sections 1 and 4) and the [official FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs).
- The pages were read in a browser during the 17 October review, and the findings were recorded in NIV-15.
- Devpost answers automated requests with HTTP 403, so tooling has not re-fetched them for this file.
- Re-check the pages before submitting.

A requirement counts as met only when its evidence exists. A plan or a design is not evidence.

## Requirements

| # | Requirement | Source | Evidence (where it will be) | Owner | Status |
|---|---|---|---|---|---|
| 1 | Submit by **30 October 2026, 10:00 PDT**, which is **31 October, 01:00 SGT** | Rules §1 | The submission form | Nate | Open |
| 2 | Judging runs 1–15 December 2026, ending 15 December at 12:00 Pacific (16 December, 04:00 SGT) | Rules §1 | — | — | Noted |
| 3 | A runtime Token Factory inference call: this meets the general Nebius platform requirement | Rules §4, FAQ | The NIV-6 explain workflow, plus a recorded live run (model id, timing, usage) | Claude builds it; Nate supplies the key | **Pending.** The workflow isn't built and no live call has run. `providers.check` existing is not evidence. |
| 4 | An NVIDIA open-source model is used | Rules §4 | The model id in the run record | Claude | Pending, as for #3 |
| 5 | Track selection: Coding and Agentic Engineering, whose agents "write, run, and test code in Token Factory" (the Sandboxes product isn't named) | Rules §4 | See *Track fit* below | Nate | **Open**: fit to be reassessed |
| 6 | A working demo or test-build URL | Rules §4 | A GitHub Release with the Windows zip, Linux deb and `SHA256SUMS` | Claude prepares; Nate publishes (NIV-16) | Pending |
| 7 | A public open-source repository with setup instructions | Rules §4 | github.com/xXValhallaCoderXx/nivra-orchestrator (MIT) and its README | Claude | Repository public; setup instructions final at release |
| 8 | A public YouTube demonstration, under three minutes | Rules §4 | The video link (NIV-17) | Nate | Pending |
| 9 | Technology feedback (Token Factory, the NVIDIA models) | Rules §4 | The submission form's text | Nate, with a draft from Claude | Pending |
| 10 | An explanation of pre-existing work and substantial updates | Rules §4, FAQ | [provenance.md](provenance.md) | Claude | In place; final wording at submission |
| 11 | Free judge access until judging ends (16 December, 04:00 SGT) | Rules §4 | The access arrangement (NIV-16) | Nate | **Open**: arrangement undecided |
| 12 | Eligibility and licensing (entrant eligibility, third-party licences) | Rules | — | Nate | To check; not presumed |

## The demonstration (D20)

The demonstration shows only behaviour that has been observed working; it does not promise scaffolding, code
execution or applying patches:
1. Explain repository A with cited evidence.
2. Explicitly confirm a portable preference.
3. Open repository B, which has contrasting conventions.
4. Show scope and precedence: B's conventions win, and A's project-only records stay out of B.
5. Edit, then delete, the preference, and show that the next request uses the fresh context.

**How it uses NVIDIA and Nebius:** the explain workflow (NIV-6) calls an NVIDIA Nemotron model through Token Factory
at runtime. The live proof is pending (#3, #4).

**Linked gaps**
- Build and judge access: NIV-16.
- Recording and evidence: NIV-17.

## Track fit (open, for Nate)

**The gap.** The immediate milestone is read-only: it explains repositories and keeps confirmed preferences (D20). The
Coding and Agentic Engineering track describes agents that "write, run, and test code in Token Factory". Meeting the
general platform requirement (#3) doesn't show that a read-only workflow fits that wording.

**Options.** Nothing is decided, and no replacement coding feature is invented.
1. **Stay in the Coding track** and separately promote a minimal write/run/test capability. That needs its own scope
   decision, because D20 defers writes and execution. If coding execution returns, the question of local execution
   versus Token Factory Sandboxes comes back with it (D19).
2. **Change to a track whose wording fits** repository explanation and confirmed memory. The list of tracks has to be
   checked against the rules (an app-and-agents track was noted earlier).
3. **Ask the organisers first** whether a read-only code-understanding agent fits the Coding track, then decide.

**Questions for the organisers** (drafts; not sent):
1. Does a coding agent qualify for the Coding and Agentic Engineering track if it explains repositories with cited
   evidence and keeps engineering preferences the person has confirmed, but doesn't execute code?
2. Does "write, run, and test code in Token Factory" require the Token Factory Sandboxes product? Or does code run
   elsewhere, with Token Factory inference, qualify?
3. A desktop app needs a Token Factory API key. What does free judge access require: may judges use their own key, or
   must access be provided?

**Answers:** none yet. Record each one with its date and source when it arrives.
