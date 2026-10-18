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
| 6 | A working demo or test-build URL | Rules §4 | The v0.1.0 GitHub Release: the Windows zip, the Linux deb, `build-info.json` and `SHA256SUMS`, published unchanged once NIV-14 accepts them | Claude prepares; Nate publishes (NIV-16) | **Candidate accepted** (D24): `ead56e8`, live on the Linux deb and on the Windows zip driving WSL. The clean-setup check of the judge's path, then publishing, are next |
| 7 | A public open-source repository with setup instructions | Rules §4 | github.com/xXValhallaCoderXx/nivra-orchestrator (MIT) and its README | Claude | Repository public; setup instructions final at release |
| 8 | A public YouTube demonstration, under three minutes | Rules §4 | The video link (NIV-17) | Nate | Pending |
| 9 | Technology feedback (Token Factory, the NVIDIA models) | Rules §4 | The submission form's text | Nate, with a draft from Claude | **Draft below**, for Nate to edit |
| 10 | An explanation of pre-existing work and substantial updates | Rules §4, FAQ | [provenance.md](provenance.md) | Claude | In place; final wording at submission |
| 11 | Free judge access until judging ends (16 December, 04:00 SGT) | Rules §4 | A dedicated Token Factory key for judging, in the submission's private testing instructions (NIV-16) | Nate | **Decided** on 18 October; the key is still to create |
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
