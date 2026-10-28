# Demonstration script (NIV-50)

Under three minutes, from one recorded take on the build chosen for release, about 20:00 to 23:00 SGT on 28 October.
It shows only what works in the take itself, or what a real run showed, labelled with that run's build and date.
Every live call in the take is in the take's recipe, approved before recording. Nothing is sped up or simulated, and
long waits are cut with a caption.

**The story:** mission and planning, then a clear task brief, then execution in a Nebius sandbox, then verification and
the person's approval.

## Decisions (Nate, 28 October)

1. **Credentials:** Nate's own key and project id, entered under Settings before recording starts, as any user enters
   theirs. Judges bring their own: no credentials are given to them. The take follows the judges' quick path, so it is
   also its packaged rehearsal. Track A's private task runs stay separate, and no credential appears in a file or on
   screen.
2. **The repository on screen:** Nivra's own public repository (MIT). SHE-65 appears only as genuine stills from its
   real run, cropped so no private content shows, each labelled with its actual build and run date.
3. **The task's outcome:** aim for a verified real change. If it doesn't verify, show the honest Reject and the
   unchanged checkout. A failed attempt is never described as completing the task.
4. **The coach and the mission review** appear only if they ship in the chosen build: candidate 3. Their offline checks
   are never presented as live results.
5. **The sandbox check's repository:** the public onboarding sample,
   [nivra-sample](https://github.com/xXValhallaCoderXx/nivra-sample) (MIT), at the commit the judges' instructions pin:
   `bbf62893cb699c6994cca9fa7219b66f87f5a30d`. It runs through the normal app and a real Nebius sandbox, with no special bypass. Nivra's own
   commit can't be checked: the check's credential scan refuses it, because its tests hold fake keys on purpose.

## Before recording

- **The build:** the one chosen for release, with its commit and checksums as the release page lists them: PENDING-H2.
  It is named on screen once. The route proven live is the Linux packaged build. Windows with WSL is recorded only if
  its own live run passed: PENDING-WSL.
- **A fresh profile and engine home** for the take, so the opening scene starts empty and nothing touches `~/.nivra`.
- **The repositories:** Nivra's own, and nivra-sample, cloned at their commits into neutral folders.
- **The credentials** pasted under Settings *before* recording starts. The key field never shows the key, but the
  project id field shows what is typed, so it must not be filmed.
- **The SHE-65 stills:** taken from the real run's own screens on the chosen build, cropped, and checked frame by frame
  for private content before the edit.
- **The screen:**
  - 1920×1080, with Nivra maximised and zoomed so text is legible. Under WSLg, Nivra sees no Windows display scaling.
  - Do not disturb on, and other windows closed. The terminal stays off the recorded screen.
- **The recorder:** Snipping Tool's screen recording, or Clipchamp's. One continuous take. Note the clock time of each
  beat for the edit.
- **The take's recipe,** approved before recording: each live call below with its bounds, the build, the credentials
  file's path, the repositories' commits, and one digest. PENDING-TAKE.

## The script

| Time | Beat | On screen | Words | Needs |
|---|---|---|---|---|
| 0:00–0:10 | The problem | Nivra, open on its own repository's project | "A coding agent changes your repository. What did it read, what did it run, and did anything reach your files without you?" | — |
| 0:10–0:30 | Evidence | **Explain**, after allowing model sharing for this project: the answer, and its citations to the lines the model was shown | "Nemotron, through Nebius Token Factory, explains the repository. Every citation says which lines it was shown." | one explain call |
| 0:30–0:55 | Mission and planning | A mission and its backlog, and the mission review's findings, each opening its task. Then a saved plan with its council review and web research, as labelled stills from their own live runs | "A project starts from what it's for. Plans are reviewed by a council of specialists, and their assumptions researched." | the mission review: candidate 3, and a live review in the recipe, or left out. The plan stills: only from labelled live runs |
| 0:55–1:20 | A clear task brief | A vague task's guidance, worked out with no model; the coach's preview, exactly what is sent; its questions and proposed changes; two ticked and saved as brief v2 with its acceptance cases | "Before any code, the coach asks what the brief is missing. Nothing changes until I pick it." | candidate 3, and one coach call. Otherwise the brief's form alone |
| 1:20–1:40 | Execution in Nebius | **Sandbox check** on nivra-sample: the preview (the commit, what's left out and why, what Nebius keeps), then the check with networking off | "The commit goes to a Nebius sandbox only when I allow uploads, and the sandbox runs with networking off." | one sandbox check |
| 1:40–2:35 | Verification and approval | SHE-65's real run, as cropped and labelled stills: the Run preview's limits, the checks before and after in Nebius, and the verdict. *Captioned with the build and date* | "Tests the agent can't edit decide whether the change is verified." | stills from the real run |
| | *Verified* | Approve, with the patch's hash, then the change applied unstaged with the originals kept; Accept | "Nothing reaches the checkout until I approve that exact change. Nothing is committed or pushed." | a verified run |
| | *Not verified* | The verdict says not verified; Reject; the checkout unchanged | "When the tests don't verify a change, it can't be applied, and the checkout is untouched." | an unverified run |
| 2:35–2:52 | How it runs | Settings ("Key saved, encrypted", the project id set, never shown), the project's system label, then the release page | "NVIDIA Nemotron through Nebius Token Factory, Nebius Sandboxes for execution, and an engine on the repository's own system. Open source, MIT." | — |
| 2:52–3:00 | End card | The build and commit, and "Long waits shortened; nothing simulated" | — | — |

If a beat is left out, the others keep their order and the take stays under three minutes. PENDING-TAKE: the take's
real times.

## The live calls in the take, and their bounds

Each is in the take's recipe, approved before recording. A call that isn't approved isn't filmed.

- **Explain:** up to 16 model requests, each within 150 s and 8 minutes in all, each with up to 4,000 output tokens.
  The input admission budget is an estimate of 160,000 tokens, not a cap.
- **The coach** (candidate 3 only): one model listing, then one forced request, within 150 s and 180 s in all, with up
  to 4,000 output tokens and no retries.
- **The mission review** (candidate 3 only, if approved): two reviewers and a chair, at most three model calls, nothing
  retried, on tasks with no repository.
- **Sandbox check:** at most 8 operations, each command up to 60 s and 10 minutes in all, then up to 7 minutes to
  close, with networking off. Nothing comes back to the checkout.
- **No task run** happens in the take: the task's beat uses the real run's stills.
- Costs are shown only as the services report them, never estimated in money.

## Never on screen

- the key, the project id, or the Settings fields while they are filled in;
- private material: SHE-65's private repository's paths, code, tests, diff or ticket; Linear; evidence folders; the
  terminal;
- notifications, or other apps' windows;
- anything not shown working live: Windows with WSL unless its own run passed, task runs from the native Windows engine
  (refused by design), macOS, Linear import, custom agents;
- a council review, research or mission review result that isn't from its own labelled live run;
- any number not measured in the take or a real run, and any claim beyond what the record shows. A task is called done
  only if its acceptance tests verified the change in that run.

## After recording

1. Check the length is under 3:00. Watch every frame for anything in *Never on screen*.
2. Upload it to YouTube as **Public**.
   - Title: "Nivra: a coding agent in Nebius Sandboxes, with tests it can't edit".
   - Description: the build and its commit, the model's id, the links to the source and the release, and "Long waits
     are shortened; nothing is simulated."
3. Put the link in the submission and on NIV-50.
