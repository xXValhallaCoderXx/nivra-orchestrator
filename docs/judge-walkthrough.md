# The full task, for judges

Not offered in this release. A public reproduction of the full task is deferred to a later release, so judges use the
README's quick path: Check Token Factory, an explanation, and a sandbox check on the public onboarding sample.

- **How a task run works,** what it needs and what bounds it: the README's *What it does* and *Running a task on your
  own repository*.
- **What a task run sends, and what Nebius keeps:**
  - to Token Factory: the brief, the files the model reads, and the output of the commands it runs;
  - to Nebius: for the environment's preparation, the repository's manifests, its lockfile and its workspace file;
    for the task, the commit's tracked files, except those on Nivra's deny list, and every file the model writes;
  - Nebius keeps each upload and each operation's record, including what a write contained, and offers no way to
    delete them. Images are kept for 180 days. With shared credentials, anyone holding them can read what was uploaded.
- **Only a verified change can be applied:** Approve is offered only when the brief's acceptance cases verified the
  change, and the engine refuses otherwise (D40).
