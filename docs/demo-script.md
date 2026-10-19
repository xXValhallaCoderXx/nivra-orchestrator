# Demonstration script (NIV-17)

Under three minutes, recorded on the released v0.1.1, showing only behaviour that has been observed working (D20). It
follows [submission.md](submission.md)'s narrative: evidence → confirmed memory → a contrasting repository → an
override → fresh context.

## Before recording

- **The build.** Use the v0.1.1 Windows zip from the release, and record on Windows with WSL folders, the main path.
- **Separate profiles for rehearsal and recording.** A profile keeps its projects, preferences and consent.
  - Rehearse in `--user-data-dir=%LOCALAPPDATA%\nivra-demo\rehearsal`.
  - Record each take in `--user-data-dir=%LOCALAPPDATA%\nivra-demo\recording`, deleting that folder before the take.
    The opening scene then shows an empty project list, and consent is asked again.
- **One Nivra at a time.** Close any other Nivra, such as the dev app, first: every profile's WSL engine uses `~/.nivra`
  in the distribution, and only one engine can hold it.
- **The repositories.** Clone the two public ones into a neutral WSL folder, for example `~/demo`:
  ```bash
  mkdir -p ~/demo && cd ~/demo && git clone https://github.com/xXValhallaCoderXx/valhalla-fitness && git clone https://github.com/xXValhallaCoderXx/nivra-demo-timer
  ```
- **The key.** Save it under Settings before recording. The field never shows it; Settings says "Key saved, encrypted".
- **The screen.**
  - 1920×1080, with Nivra maximised at 100% zoom.
  - Windows' Do not disturb on, and other windows closed.
- **The recorder.** Snipping Tool's screen recording, or OBS. The voiceover can be recorded live or added afterwards.
- **A rehearsal first.** Run the whole sequence once and time each beat. Claude can drive it through the UI, as in the
  clean-setup checks.

## The script

Each explanation takes about one to four minutes (46–212 s in the clean-setup checks). Cut the wait, and put a short
caption on the cut, such as "Model run, about 2 minutes, shortened". Nothing is sped up or simulated.

| Time | Beat | On screen | Voiceover |
|---|---|---|---|
| 0:00–0:12 | The problem | Nivra, open on its empty project list | "Coding assistants remember what you like. But when a repository's own conventions disagree, whose rule wins? And what did the model actually read?" |
| 0:12–0:45 | Evidence | **Add folder…** → `valhalla-fitness`. **Explain** → **Allow for this project**. *Cut.* The answer: findings with citation chips. Then the line "Context used: … N of N citations point to lines the model was shown" | "Nivra explains a repository with evidence. NVIDIA Nemotron reads it through read-only tools, over Nebius Token Factory. Every citation is checked against the lines the model was actually shown." |
| 0:45–1:05 | Confirmed memory | Under Preferences:<br>• type `Name component files in PascalCase; write tests with Vitest`, keep **Every project**, press **Confirm**;<br>• type `valhalla-fitness builds its web UI with Mantine`, choose **valhalla-fitness only**, press **Confirm** | "I confirm two preferences: a personal one for every project, and one for this project only." |
| 1:05–1:45 | A contrasting repository | **Add folder…** → `nivra-demo-timer`. **Explain** → **Allow for this project**. *Cut.* Under **Conflicts**: "Currently: …kebab-case…", then **Governs this task**: the repository, with the personal default outranked. In Preferences, the Mantine row says "not sent to nivra-demo-timer". Expand **Context used**: under **What the model was given**, "Preferences received: 1 personal default" | "This repository names its files in kebab-case and tests with Jest. Nivra reports the conflict, and the repository's convention governs over my personal default. The Mantine preference belongs to the first project, so it was never sent." |
| 1:45–2:15 | An explicit override | **Choices for this task** → **Add a choice** → `Use PascalCase for this task` → **Explain**. *Cut.* The conflict shows **Currently** (the repository's convention), **Intended** (the choice) and **Governs this task** (the choice). Then the Preferences list, unchanged | "For one task, I can decide differently. The choice governs this run only: 'Currently' still shows the repository's convention, and my stored preferences don't change." |
| 2:15–2:40 | Fresh context | **Remove** the choice. **Edit** the personal preference and save it: Preferences shows the new wording at "revision 2". **Explain**. *Cut.* Context used: "Preferences received: 1 personal default", with a new store revision and fingerprint. **Delete** the preference, then **Explain**. *Cut.* "Preferences received: none" | "Edit or delete a preference, and the very next run uses it as it is now." |
| 2:40–2:58 | How it runs | Settings ("Key saved, encrypted"), the project's WSL label, then the release page | "Nemotron 3 Super through Nebius Token Factory, at runtime. The engine runs where the repository lives, here in WSL. Nivra is open source, for Windows and Linux." |

## Never on screen

- the key itself, or any other credential;
- fixture B, the private repository, or any private path;
- notifications, or other apps' windows;
- anything planned shown as working: sandboxes, coding work, new-app creation, macOS;
- an explanation from the native Windows engine, which hasn't been checked live;
- any claim the recorded evidence doesn't support.

## After recording

1. Check the length is under 3:00 (#8). Watch every frame for anything in *Never on screen*.
2. Upload it to YouTube as **Public**.
   - Title: "Nivra: repository evidence and confirmed preferences on NVIDIA Nemotron".
   - Description: the links to the source, the v0.1.1 release and the two demonstration repositories, the model's id,
     and "Long model runs are shortened; nothing is simulated."
3. Put the link in the submission (#8) and on NIV-17.
