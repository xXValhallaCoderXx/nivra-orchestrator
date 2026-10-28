# Demonstration script (NIV-50)

Under three minutes, from one recorded take on the build chosen for release. It shows only what works in the take
itself, or what a recorded live run showed, labelled with that run's build and date. Every live call in the take has
its own recipe and approval. Nothing is sped up or simulated, and long waits are cut with a caption.

The story: an agent that may change your code, in a boundary that enforces its limits, with tests it can't edit
judging the change, and nothing reaching your checkout until you approve that exact change.

## Decided before the take (by about 19:45 SGT)

Each decision changes what is filmed. The script below marks the beats that depend on one.

1. **The build:** candidate 1 (`570dd14`), candidate 2 or candidate 3, and its commit and hashes: PENDING-H2. It is
   named on screen once.
   - Candidates 1 and 2 have neither the coach nor the mission review, so those beats are left out.
   - Candidate 3 has both, if its checks pass and Nate chooses it.
2. **The credentials:**
   - with the judges' key and project id, the take is also the packaged judge rehearsal;
   - with Nate's own, it isn't, and the rehearsal is done separately.
3. **The repository on screen.** The video is public, so the repository is public, and no private material is
   filmed. SHE-65's baseline and frozen tests aren't public. The repository is one of:
   - public valhalla-fitness, once it has a licence;
   - Nivra's own repository (MIT);
   - SHE-65's live run, shown only as stills with every private part cropped.
4. **The task beat:** one of three endings, decided by the evidence that exists by then.
   - **Verified:** a change verified by its tests is approved, applied and accepted live, in the take.
   - **Not verified:** the run is shown up to its verdict, and Reject leaves the checkout untouched.
   - **Left out:** the beat is cut, and the text says the task path's live result is pending.

## Before recording

- **The build** chosen above, on the route proven live: the Linux packaged build. Windows with WSL is recorded only if
  its own live run passed: PENDING-WSL.
- **A fresh profile and engine home** for the take, so the opening scene starts empty and nothing touches `~/.nivra`.
- **The repository** chosen above, cloned at its commit into a neutral folder.
- **The credentials** chosen above, pasted under Settings *before* recording starts. The key field never shows the key,
  but the project id field shows what is typed, so it must not be filmed.
- **The screen:**
  - 1920×1080, with Nivra maximised and zoomed so text is legible. Under WSLg, Nivra sees no Windows display scaling.
  - Do not disturb on, and other windows closed. The terminal stays off the recorded screen.
- **The recorder:** Snipping Tool's screen recording, or Clipchamp's. One continuous take. Note the clock time of each
  beat for the edit.
- **The take's recipe,** approved before recording: every live call in it, with its bounds below, the build, the
  credentials file's path and the repository's commit, and one digest. PENDING-TAKE.

## The script

| Time | Beat | On screen | Words | Needs |
|---|---|---|---|---|
| 0:00–0:10 | The problem | Nivra, open on the repository's project | "A coding agent changes your repository. What did it read, what did it run, and did anything reach your files without you?" | — |
| 0:10–0:35 | Evidence | **Explain**, after allowing model sharing for this project: the answer, and its citations to the lines the model was shown | "Nemotron, through Nebius Token Factory, explains the repository. Every citation says which lines it was shown." | one explain call |
| 0:35–0:50 | Plans | A saved plan, its council review and its web research, as stills from their own live runs, each labelled with its build and date | "Plans are saved, reviewed by a council of specialists, and their assumptions researched on the web." | stills only |
| 0:50–1:15 | The coach | A vague task's guidance, with no model; the coach's preview, exactly what is sent; its questions and proposed changes; two changes ticked and saved as brief v2 | "Before any code, the coach asks what the brief is missing. Its suggestions change nothing until I pick them." | candidate 3, and one coach call |
| 1:15–1:30 | The boundary | **Sandbox check**: the preview of the upload (the commit, what's left out and why, what Nebius keeps), then the check with networking off | "The commit goes to a Nebius sandbox only when I allow uploads, and the sandbox runs with networking off." | one sandbox check |
| 1:30–2:35 | The task | The brief with its frozen acceptance tests, the Run preview (what is sent, what each service keeps, the limits), Start, the checks before and after in Nebius, then the run's verdict. *Cuts, captioned* | "Nemotron makes the change in Nebius. Tests it can't edit decide whether it's verified." | the chosen ending |
| | *Verified ending* | Approve, with the patch's hash, then the change applied unstaged with the originals kept; Accept | "Nothing reaches my checkout until I approve that exact change. Nothing is committed or pushed." | a verified run in the take |
| | *Not-verified ending* | The verdict says not verified; Reject; the checkout unchanged | "When the tests don't verify the change, nothing can be applied, and my checkout is untouched." | a run in the take |
| 2:35–2:55 | How it runs | Settings ("Key saved, encrypted", the project id set, never shown), the project's system label, then the release page | "NVIDIA Nemotron through Nebius Token Factory, Nebius Sandboxes for execution, and an engine on the repository's own system. Open source, MIT." | — |
| 2:55–3:00 | End card | The build and commit, and "Long waits shortened; nothing simulated" | — | — |

If a beat is left out, the others keep their order and the take stays under three minutes. PENDING-TAKE: the take's
real times.

## The live calls in the take, and their bounds

Each is approved on its own, in the take's recipe, before recording. A call that isn't approved isn't filmed.

- **Explain:** up to 16 model requests, each within 150 s and 8 minutes in all, each with up to 4,000 output tokens.
  The input admission budget is an estimate of 160,000 tokens, not a cap.
- **The coach** (candidate 3 only): one model listing, then one forced request, within 150 s and 180 s in all, with up
  to 4,000 output tokens and no retries.
- **Sandbox check:** at most 8 operations, each command up to 60 s and 10 minutes in all, then up to 7 minutes to
  close, with networking off. Nothing comes back to the checkout.
- **The task run:** the limits its Run preview prints for the chosen build, PENDING-H2. Candidate 2's preview printed
  24 model requests, 48 tool calls, 8 writes, a 20-minute session and a 33-minute run.
- Costs are shown only as reported by the services, never estimated in money.

## Never on screen

- the key, the project id, or the Settings fields while they are filled in;
- private material: SHE-65's brief, baseline, frozen tests or diff, private paths, Linear, evidence folders or the
  terminal;
- notifications, or other apps' windows;
- anything not shown working live: Windows with WSL unless its own run passed, task runs from the native Windows engine
  (refused by design), macOS, Linear import, custom agents;
- a council review or research result that isn't from its own labelled live run;
- any number not measured in the take or a recorded live run, and any claim beyond what the record shows. A task's bug
  is called fixed only if its acceptance tests verified the change in that run.

## After recording

1. Check the length is under 3:00. Watch every frame for anything in *Never on screen*.
2. Upload it to YouTube as **Public**.
   - Title: "Nivra: a coding agent in Nebius Sandboxes, with tests it can't edit".
   - Description: the build and its commit, the model's id, the links to the source and the release, and "Long waits
     are shortened; nothing is simulated."
3. Put the link in the submission and on NIV-50.
