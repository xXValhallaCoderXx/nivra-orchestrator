# The full task, step by step

An optional walkthrough, after the README's quick path. It runs one real task on the public sample: a bug in
valhalla-fitness's workout records, fixed by NVIDIA Nemotron in a Nebius sandbox, judged by tests it can't edit, and
applied to your copy only after you approve the exact change. It takes about PENDING-TAKE minutes, most of them waiting
for Nebius and the model.

Nothing here pushes anything: the change stays in your clone.

## What you need

- Nivra PENDING-H4-VERSION on Linux, or on Windows with the sample cloned inside WSL. Task runs are refused for
  folders on a Windows drive.
- Under Settings, a key and a project id whose project has Sandboxes access: yours, or the ones in the private
  testing instructions.
- The public sample, cloned at its commit: PENDING-SAMPLE.

## What it sends, and what is kept

- **To Token Factory:** the brief, the files the model reads, and the output of the commands it runs.
- **To Nebius:**
  - for the environment's preparation, the repository's manifests, its lockfile and its workspace file;
  - for the task, the commit's tracked files, except those on Nivra's deny list, and every file the model writes.
- **Nebius keeps** each upload and each operation's record, including what a write contained, and offers no way to
  delete them. Images are kept for 180 days.
- With shared credentials, anyone holding them can read what was uploaded.

## 1. The environment

PENDING-H2: the steps and the screen's words. As designed, to be confirmed by PENDING-H2:
- The environment is prepared in a run of its own, with its own preview: Node 22.23.4 (the
  `node:22.23.4-alpine3.24` image, imported into your Nebius project if it isn't there), pnpm 11.5.3, and the data
  package's dependencies from the frozen lockfile.
- That preparation is the only run with networking on, to the npm registry. Every check, and the model's work, run with
  it off.
- An environment prepared in one Nebius project can't be used with another project's credentials. Nivra asks for it to
  be prepared again.

## 2. The task

PENDING-H2: the brief's fields, exactly as you enter them, with its goal, acceptance criteria, acceptance cases and
frozen files.

## 3. The Run preview, and Start

PENDING-H2: the preview's screens and the run's limits, as it shows them.

## 4. What the run does

- **At the baseline,** before the model starts, the repository's own tests run in Nebius: the new tests fail for the
  bug's reason, and the existing ones pass.
- **Nemotron then makes the change** on a copy of the commit, with networking off, through fixed tools Nivra's engine
  carries out.
- **The final checks run the complete suites.** Every frozen test must be named as passed, and the frozen files must be
  unchanged.

## 5. Review, approve, apply and accept

PENDING-H2: the card's sections, and the buttons' words.
- Approve only if you're satisfied with the patch: approval is by the patch's hash.
- Applying leaves the change unstaged in your clone, with each original kept in its git folder (`nivra-apply`).
- You can reject the change, or ask for a revision with a note, instead.
