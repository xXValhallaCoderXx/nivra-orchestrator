# Demonstration script (NIV-50)

**Working outline, refreshed 30 October 2026; not a runnable recording recipe.** The release build and recording
time are still to be chosen. Target 2:50 or less in the final edit, leaving margin below the three-minute limit.
It shows only what works in the take itself, or what a real run showed, labelled with that run's build and date.
Every live call in the take is in the take's recipe, approved before recording. Nothing is sped up or simulated, and
long waits are cut with a caption.

**The story:** mission and planning, then a clear task brief, then execution in a Nebius sandbox, then verification
evidence and the person's decision. Existing task footage ends with human rejection.

## Scope for the next take

The earlier candidate-3 recording plan and approvals remain historical. A new build, live-call recipe and evidence review
must be settled before recording. This outline does not approve or start a paid call.

1. **Credentials:** Nate's own key and project id, entered under Settings before recording starts, as any user enters
   theirs. No owner credentials are distributed. Judge access is still unresolved in [submission.md](submission.md);
   a recording with Nate's credentials does not establish free access for judges. No credential appears on screen.
2. **The repository on screen:** Nivra's own public repository (MIT). SHE-65 appears only as genuine stills from its
   real run, cropped so no private content shows, each labelled with its actual build and run date.
3. **The task's outcome:** use the outcome already recorded, including candidate 3's rejection and unchanged checkout.
   Do not repeat paid work to improve the story. A new successful apply/accept sequence needs its own authorised,
   matching evidence; a failed attempt is never described as completing the task.
4. **The coach and the mission review** appear only after their budget integration and useful live acceptance are
   established on the chosen build. PR57's coach changes do not supply its missing host-ledger integration; the
   mission-review integration is separate work under NIV-52. Their offline checks are never presented as live results.
5. **The sandbox check's repository:** the public onboarding sample,
   [nivra-sample](https://github.com/xXValhallaCoderXx/nivra-sample) (MIT), at the commit the judges' instructions pin:
   `bbf62893cb699c6994cca9fa7219b66f87f5a30d`. It runs through the normal app and a real Nebius sandbox, with no special bypass. Nivra's own
   commit can't be checked: the check's credential scan refuses it, because its tests hold fake keys on purpose.

## Before recording

- **The build:** pending selection, with its own commit and checksums. Historical live task evidence is from Linux
  candidate 3; the selected build's platform acceptance remains pending. Windows-to-WSL sandbox execution is not
  portrayed as live-proven from the earlier explain or stand-in checks.
- **A fresh profile and engine home** for the take, separate from `~/.nivra`, `~/.nivra-dev` and every active agent's
  profile. Freeze their paths in the recording recipe.
- **The repositories:** Nivra's own, and nivra-sample, cloned at their commits into neutral folders.
- **The credentials** pasted under Settings *before* recording starts. The key field never shows the key, but the
  project id field shows what is typed, so it must not be filmed.
- **Historical task stills:** label them with their own build and date, even when the take uses a newer build. Keep
  candidate 3's rejection outcome intact. The existing stills are parked pending the recorded caption correction;
  see [submission-evidence.md](submission-evidence.md#recording-and-closure). Preserve the masks, review corrected
  images at full size and regenerate their hashes before use.
- **The screen:**
  - 1920×1080, with Nivra maximised and zoomed so text is legible. Under WSLg, Nivra sees no Windows display scaling.
  - Do not disturb on, and other windows closed. The terminal stays off the recorded screen.
- **The recorder:** Snipping Tool's screen recording, or Clipchamp's. One continuous take. Note the clock time of each
  beat for the edit.
- **The take's recipe,** approved before recording: each live call below with its bounds, the build, the approved
  credential-entry method, the repositories' commits, and one digest. Pending the selected build and approval.

## The script

| Time | Beat | On screen | Words | Needs |
|---|---|---|---|---|
| 0:00–0:10 | The problem | Nivra, open on its own repository's project | "A coding agent changes your repository. What did it read, what did it run, and did anything reach your files without you?" | — |
| 0:10–0:30 | Evidence | **Home → Explain this project → Explain**, after allowing model sharing: the answer and its citations | "Nemotron, through Nebius Token Factory, explains the repository. Every citation says which lines it was shown." | one approved Explain run, or matched historical footage |
| 0:30–0:50 | Mission and planning | A mission and its backlog. Add review findings or plan/research stills only if supported by their own labelled live evidence | "A project starts from what it's for. I turn the work into tasks before execution." | saved native data; any live review separately included in the recipe |
| 0:50–1:10 | A clear task brief | The brief and deterministic guidance. If live coaching is ready, show its preview, questions and selected changes saved as a new brief version | "I make the intended behaviour and checks explicit before starting." | no model call for manual guidance; one coach call only after its integration and acceptance. The coach does not add executable acceptance cases |
| 1:10–1:30 | Execution in Nebius | **Settings → Advanced diagnostics → Sandbox check**, on nivra-sample: the preview, then the check with networking off | "The commit goes to a Nebius sandbox only when I allow uploads, and the sandbox runs with networking off." | one approved check, or matched historical footage |
| 1:30–2:25 | Verification and approval | A real task's Run preview, checks, verdict and actual decision, as cropped stills labelled with their own build and date | "The result comes back with its check evidence. I review the exact change before deciding." | stills from the real run; use the matching outcome below |
| | *Verified* | Approve, with the patch's hash, then the change applied unstaged with the originals kept; Accept | "Nothing reaches the checkout until I approve that exact change. Nothing is committed or pushed." | a verified run |
| | *Not verified* | The verdict says not verified; Reject; the checkout unchanged | "When the tests don't verify a change, it can't be applied, and the checkout is untouched." | an unverified run |
| | *Historical candidate-3 rejection* | Its acceptance suites passed, the typecheck failed, AI review found the broken caller, and Nate rejected the proposal. Checkout unchanged | "The configured tests passed, but review caught a broken caller. I rejected the proposal. It was not a fix." | label `c99fe9d`, 28 October; never call this an automatic refusal or an applied fix |
| 2:25–2:42 | How it runs | The project's system label and the chosen build's release details; keep Settings off camera | "NVIDIA Nemotron through Nebius Token Factory, Nebius Sandboxes for execution, and an engine on the repository's own system. Open source, MIT." | release details only when finalised |
| 2:42–2:50 | End card | The build and commit, and "Long waits shortened; nothing simulated" | — | — |

The eight timed beats total 2:50; outcome rows are alternatives inside the 1:30–2:25 beat. If a beat is left out,
the others keep their order and the take stays under three minutes. Actual edited length remains pending measurement.
Current code requires every final repository check to pass before approval (NIV-67); do not overlay
that claim onto candidate 3's older verdict. Any demonstration of the new gate must use its own matching evidence.

## The live calls in the take, and their bounds

The figures below describe the documentation-base source, not an approved take. Recheck the selected build and its
grant coverage when preparing the concrete recipe. Historical footage needs no repeated paid call; if a new call is
proposed, it must be in the approved recipe before recording.

- **Explain:** up to 16 model requests, each within 150 s and 8 minutes in all, each with up to 4,000 output tokens.
  The input admission budget is an estimate of 160,000 tokens, not a cap.
- **The coach:** current PR57 source permits one listing, then one request, within 150 s and 180 s in all, with up
  to 8,000 completion tokens and no retries. Reasoning, when reported, is included in that completion total. It admits
  at most 56,000 estimated input tokens within its 64,000-token application ceiling. Its paid acceptance remains
  blocked until host-ledger grants are wired and verified; this is not permission to run it from the current outline.
- **The mission review:** two reviewers and a chair, at most three model calls, nothing retried. Use only after
  NIV-52's separate grant integration and live acceptance; copy final limits from the approved build's recipe.
- **Sandbox check:** at most 8 operations, each command up to 60 s and 10 minutes in all, then up to 7 minutes to
  close, with networking off. Nothing comes back to the checkout.
- **No task run** happens in the take: the task's beat uses the real run's stills.
- Keep reported usage separate from any explicitly labelled price estimate. Unknown billed cost stays unknown,
  never zero; an estimate is not an enforced spending ceiling.

## Never on screen

- the key, the project id, or the Settings fields while they are filled in;
- unpublished material from SHE-65's public repository revision, including its frozen tests and private task text;
  Linear, evidence folders and the terminal. Existing masks stay; a public repository does not make its unpublished
  revision public. Corrected captions say "Grey boxes hide project details and unpublished content";
- notifications, or other apps' windows;
- anything not shown working live: Windows with WSL unless its own run passed, task runs from the native Windows engine
  (refused by design), macOS, Linear import, custom agents;
- a council review, research or mission review result that isn't from its own labelled live run;
- any number not measured in the take or a real run, and any claim beyond what the record shows. A fix is described
  as applied and accepted only when that actual journey completed; verification alone is not a human acceptance.

## After recording

1. Check the length is under 3:00. Watch every frame for anything in *Never on screen*.
2. Upload it to YouTube as **Public**.
   - Title: "Nivra: a coding agent in Nebius Sandboxes, with tests it can't edit".
   - Description: the build and its commit, the model's id, the links to the source and the release, and "Long waits
     are shortened; nothing is simulated."
3. Verify the public link without the uploader's login. Put it in the submission, with the release/source links and
   each historical clip's actual model/build attribution. Record Nate's actual submission confirmation for NIV-50.
