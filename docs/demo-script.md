# Demonstration script (NIV-50)

Under three minutes, from one recorded take on the release candidate, showing only behaviour that has been observed
working. It follows [submission.md](submission.md)'s story: one real bug in a public repository, fixed in a Nebius
sandbox by NVIDIA Nemotron, judged by tests it can't edit, and applied only after the person approves the exact
change.

The take is also the packaged judge rehearsal. It follows the README's testing instructions and
[judge-walkthrough.md](judge-walkthrough.md) exactly, with the credentials judges will get, so what the video shows is
what a judge can do. It has its own recipe and approval.

## Before recording

- **The build.** The release candidate PENDING-H2 (its commit and hashes), on the route already proven live: the Linux
  packaged build first. Windows with WSL is recorded only if its own live run passed.
- **A fresh profile and engine home** for the take, so the opening scene starts empty and nothing touches `~/.nivra`.
- **The repository.** The public sample, cloned at its commit into a neutral folder: PENDING-SAMPLE.
- **The credentials.** The judges' key and project id, pasted under Settings *before* recording starts. The key field
  never shows the key, but the project id field shows what is typed, so it must not be filmed.
- **The screen.**
  - 1920×1080, with Nivra maximised and zoomed so text is legible. Under WSLg, Nivra sees no Windows display scaling.
  - Windows' Do not disturb on, and other windows closed. The terminal stays off the recorded screen.
- **The recorder.** Snipping Tool's screen recording, or Clipchamp's. One continuous take, from opening the project to
  Accept the change. Note the clock time of each beat for the edit.

## The script

Each wait is cut in the edit, with a short caption on the cut, such as "Run in Nebius, about N minutes, shortened".
Nothing is sped up or simulated.

| Time | Beat | On screen | Voiceover or caption |
|---|---|---|---|
| 0:00–0:15 | The problem | Nivra, open on the sample's project | "A coding agent changes your repository. What did it run? What checked it? And did anything reach your files without you?" |
| 0:15–0:35 | The task | The task's brief: its goal, and its acceptance cases, which name the five frozen tests. The frozen files are listed | "A real bug: workout records compared old loads in the wrong units. The tests that will judge the fix are frozen before the agent starts." |
| 0:35–1:00 | The Run preview | What goes to Token Factory and to Nebius, what each keeps, the prepared environment and its versions, the run's limits. Both permissions given in place, then Start | "Before anything is sent, Nivra says what leaves, what stays, and the limits. Uploads and model access are separate permissions." |
| 1:00–1:40 | In Nebius | The run's progress: the repository's checks at the baseline, the regression failing for the bug's reason and the existing tests passing; Nemotron reading and editing `completion.ts`; the final checks, every expected test named as passed. *Cuts, captioned* | "NVIDIA Nemotron, through Nebius Token Factory, makes the change in a Nebius sandbox with networking off. The repository's own tests run there, before and after." |
| 1:40–2:15 | The review | The run's card: the verdict, each check before and after, the patch as text, the frozen files unchanged, the duration, and usage as reported | "The agent's word isn't the verdict. Nivra judges the change against tests the agent couldn't edit, and proposes the exact patch." |
| 2:15–2:40 | Approve and apply | **Approve**, with the patch's hash, then the applied state: unstaged, with the originals kept. Then **Accept the change** | "Nothing touches my checkout until I approve that exact change. Nothing is committed or pushed." |
| 2:40–3:00 | How it runs | Settings ("Key saved, encrypted", "Project id saved"), the project's system label, then the release page | "NVIDIA Nemotron through Nebius Token Factory, Nebius Sandboxes for execution, and an engine on the repository's own system. Open source." |

PENDING-H2: the exact labels and screens, once tonight's integration lands. PENDING-TAKE: the take's real times.

**Plan review and research** appear only as stills from earlier live runs, labelled with their build and date, after
a privacy check. Otherwise they are left out, and named in the text.

## Never on screen

- the key, the project id, or the Settings fields while they are filled in;
- Linear, evidence folders, the terminal, or any private path;
- notifications, or other apps' windows;
- anything not shown working live: Windows with WSL unless its own run passed, task runs from the native Windows engine,
  macOS;
- any number not measured in the take or the live run, and any claim beyond what the record shows. The video shows
  SHE-65's data-layer fix, verified by its own tests; the ticket's own acceptance stays open.

## After recording

1. Check the length is under 3:00 (item 8). Watch every frame for anything in *Never on screen*.
2. Upload it to YouTube as **Public**.
   - Title: "Nivra: a coding agent in Nebius Sandboxes, with tests it can't edit".
   - Description: the build and its commit, the model's id, the links to the source, the release and the public sample,
     and "Long waits are shortened; nothing is simulated."
3. Put the link in the submission (item 8) and on NIV-50.
