# Development

## Requirements

- Node 24.21.0 (`nvm use` reads `.nvmrc`) and pnpm 10.4.1 (`corepack enable`).
- git.
- For live checks: a Nebius Token Factory API key in `NEBIUS_API_KEY` (never committed, never written to a file in the
  repository). The Sandboxes probe also needs `NEBIUS_PROJECT_ID`, and takes both from a private file (below).

## Commands

```bash
pnpm install --frozen-lockfile
pnpm verify                 # typecheck + all tests (what CI runs)
pnpm typecheck
pnpm test
pnpm probe:tokenfactory     # live: list Token Factory models, one Nemotron tool call, then the tool-choice probes
pnpm probe:sandbox --plan   # the Nebius Sandboxes probe (NIV-29): its plan, limits and thresholds; no network
pnpm rpc doctor             # start a real engine on ~/.nivra-dev, send one request, print the answer
pnpm rpc runs.start '{"workflowId":"hello","input":{"repoPath":"/path/to/repo","holdMs":0}}' --follow
pnpm rpc runs.start '{"workflowId":"explain","input":{"repoPath":"/path/to/repo","question":""},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":true}}}' --follow
pnpm rpc runs.result '{"runId":"<id>"}'
pnpm rpc runs.start '{"workflowId":"chat","input":{"message":"How should I stage this?","scope":{"kind":"general"}}}' --follow
pnpm rpc runs.start '{"workflowId":"review","input":{"planId":"<uuid>","planVersion":1},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":false},"packet":{"scope":{"kind":"general"},"text":"Plan text","assumptions":[],"references":[]}}}' --follow
```

The explain example sends the repository's excerpts to Token Factory when `NEBIUS_API_KEY` is set, and uses tokens.
Without a key it is refused before any request.

The desktop app:

```bash
pnpm dev                    # Linux Electron under WSLg, hot reload; the local engine runs from source on ~/.nivra-dev
pnpm dev:win                # from WSL: build the real Windows app, for development, and start it on Windows (WSL and Windows folders)
pnpm --filter @nivra/desktop test:e2e        # build, then drive the app through its UI (Playwright, needs a display or xvfb-run -a)
pnpm --filter @nivra/desktop test:packaged   # the same against the electron-builder --dir output (package it first)
pnpm --filter @nivra/desktop test:windows    # from WSL: drive the Windows build `pnpm dev:win --no-launch` copied
pnpm package:linux          # deb (primary) and AppImage
pnpm package:win            # Windows zip, from WSL (an NSIS installer needs Windows)
pnpm release:candidate      # from a clean tree: verify, stage once, build the deb and the zip, write build-info.json and SHA256SUMS
```

Live acceptance on packaged builds (NIV-14). It is an explicit script, never part of `verify`; a live session uses
tokens:

```bash
pnpm accept:live --platform linux --session rehearsal --fixture-a <path>       # token-free: no key, no model
pnpm accept:live --platform windows --session rehearsal --fixture-a <path> --move-wsl-home
pnpm accept:live --platform linux --session live --fixture-a <path> --fixture-b-file <file> [--network]
pnpm accept:live --recover [<record>] [--dry-run]                              # after a session that died
```

It exits:
- 0 when every criterion the session must establish passed: every criterion for a live session, and the token-free
  ones for a rehearsal;
- 1 when a criterion failed, or the session stopped early;
- 2 when none failed, but one it must establish is incomplete or wasn't run.

- **Builds.** It drives the installed deb (`/opt/Nivra/nivra`) or the release zip, extracted on Windows. It checks both
  against `release/build-info.json` and `SHA256SUMS`.
- **Profiles.** It uses profiles and engine homes of its own.
- **The WSL home.** A Windows session moves `~/.nivra` aside, because every Windows profile's WSL engine uses it, then
  puts it back. The recovery record (`~/.nivra-acceptance-recovery.json`) is written before anything moves.
- **The key.** You type it into the window. The script only waits until Settings says one is saved.
- **Fixture B.** Its path is read from a file only you can read.
- **Evidence.** It goes to `~/nivra-acceptance/<run>/`.
  - `private/` holds everything, and is yours alone.
  - `public-summary.*` is built from listed fields only, so it gives B's numbers and nothing else.

Main is an ES module and the preload is CommonJS (a sandboxed preload must be). Two command-line switches isolate a
run: Chromium's `--user-data-dir=<dir>` for the host's records, and `--nivra-engine-home=<dir>` for the local engine's
data. Tests always pass both.

A third switch, `--nivra-token-factory-url=<loopback url>`, points the local engine at a stub instead of Token Factory
(D22). `test:e2e` uses it with the stub in `apps/engine/test/stub-token-factory.ts`, so no real model is called.
- Only an unpackaged app honours it; a packaged app ignores it.
- The engine accepts only `127.0.0.1`, `[::1]` or `localhost`.
- Doctor then reports a test endpoint, and each run records its route as `loopback-test`.
- **A plan to review without a model** (D31). A packaged app can't make one, so `review.spec.ts` (`test:packaged`) and
  `workspace-windows.spec.ts` (`test:windows`) seed one into the profile before launch through
  `e2e/seed-workspace.ts`, which uses the workspace's own functions. On Windows the staged `node.exe` runs it, bundled,
  so the file is only ever opened on Windows (D7): run `pnpm stage:runtime all` first.
- **A mission without a model** (D42). `seedMission` seeds a mission at v1 with its backlog of direct tasks, and
  `seedMissionReview` a completed review of some of them, with the findings given and no run behind it, through the
  workspace's own functions (`e2e/seed-workspace.ts`). Track C uses them to test the coach with a mission and
  findings before a real mission review is possible.
- **The context check** (D42). Code that applies a result made from a mission, its tasks or their findings calls
  `validateBinding(workspace, binding)` (`src/main/mission-context.ts`) inside the same `workspace.tx` as the save,
  next to the brief's version check, and refuses when it names any change (`changeText` words each one). It checks
  the stored binding itself, field by field; `bindingDigest` is asynchronous (WebCrypto), so it belongs in a preview's
  fingerprint, never inside the transaction.
  `missionContextForTask` gives a task's mission and the findings that name it, each with what changed since.

Cross-platform checks (D14; there is no CI):

```bash
pnpm stage:runtime all      # stage linux-x64 (+ WSL tarball, smoke-tested) and win-x64 into apps/desktop/build/stage
pnpm verify:windows         # from WSL: run the target harness as a Windows process (native + WSL engines)
```

`verify:windows` takes `--distro <name>` and `--skip-stage`. It works in `%LOCALAPPDATA%\nivra-dev\verify`.
- **A mission review** (NIV-52). `rpc.ts` drives one against a real engine: give `runs.start` a `review` with a mission
  packet in its context (`"packet": {"kind": "mission", ...}`, as `apps/engine/test/fixtures/mission-review/live.json`
  holds one), and it fills in the packet's and the preferences' digests when the input leaves them out. A packet that
  names a model is refused before any inference request unless the listing gives exactly that model.
- **The mission review's live check** is an explicit script, never part of `verify`, and runs only with Nate's approval
  of its digest:

  ```bash
  node apps/engine/scripts/mission-review-live.ts --plan                                   # the recipe; no network
  node apps/engine/scripts/mission-review-live.ts --credentials <file> --approved <digest> # one review, at most 3 requests
  ```

  The digest binds the revision (a clean checkout), the fixture, the three profiles, their instructions' hashes and the
  forms they hand in (the tools' definitions), the model and the limits. The engine home is a fresh folder under
  `~/.nivra-dev-niv52` (one inside `~/.nivra` or `~/.nivra-dev` is refused); evidence goes to
  `~/nivra-acceptance/mission-review-<UTC>-<rev>/`. The model counts as held only when every answer named it. One
  approval is one run: a launch claims it in `~/nivra-acceptance/claims/mission-review/` before the checkout is
  checked, the key is read or anything is sent, the claim is kept whatever happens next, and `--plan` then prints the
  next run's digest.
- **The window's tests** (`e2e/missions.spec.ts`) drive missions with the token factory stub: the council's roles are
  told apart by the instructions' first line, as for plan reviews. A packaged app runs only the parts that need no
  model.
- **Its WSL engine runs in a home of the run's own** (D27): `~/.nivra-test/verify-<UTC>-<id>` inside the distribution,
  removed at the end. `test:windows` does the same with `e2e-…`, and `verify:interrupt` with `interrupt-…`. A home an
  interrupted run left is removed by a later run once it is a day old.
- **The release's home is checked.** `~/.nivra` is what the installed app uses in every distribution. Each run records
  its database files (size, time and hash) and its runtime folders (with their times) before it starts, and fails if
  any of them changed. Close the installed Nivra first: its own engine writes there too. A read-only query of
  `~/.nivra/nivra.db` during a run also changes the time of its `-shm` file, so leave it alone until the run ends.
- **A candidate's runtimes:** `--zip <path>` takes both runtimes from a release candidate's Windows zip, exactly as
  packaged, instead of staging.
- **The Visual C++ runtime (D25):** it checks that the native engine loads only the copy shipped beside its addon. It
  also runs a controlled check in a copy of the runtime. There, the addon's import is renamed so that no installed
  runtime can stand in, and the engine must still start and run hello. Without the renamed DLL, it must refuse.
- **Sandbox checks (D36):** it runs a stand-in for Nebius Sandboxes on loopback in the distribution it is started from.
  The harness drives the host and the WSL engine against it, with no network: consent, a whole check, a cancel,
  uploads turned off, an uncertain submission, and recovery after a restart. Run it from the distribution the engine
  uses: the check says so when they differ, and `--distro` picks the engine's. `test/sandbox-checks.test.ts` rehearses
  the same checks on Linux.
- **`test:windows` on a candidate:** extract its zip into `%LOCALAPPDATA%\nivra-dev\app` with Windows' `tar.exe`, in
  place of `pnpm dev:win --no-launch`.

Terminating a whole distribution while the app runs needs a distribution made for the purpose. **The check terminates
it, with everything running in it**, and it refuses the distribution it runs in:

```bash
pnpm stage:runtime all && pnpm dev:win --no-launch   # the Windows build it drives (the distribution needs no ~/.nivra)
pnpm --filter @nivra/desktop verify:interrupt --distro NivraTest
```

It works in `%LOCALAPPDATA%\nivra-dev\interrupt`:
- the packaged app and an observer (Playwright on the staged `node.exe`) both run on Windows;
- the observer writes `trace.log` there, and the app's logs go under `user data\logs`.

One way to make a throwaway distribution, from the development distribution:

```bash
# Ubuntu's base image (about 30 MB); check it against SHA256SUMS in the same folder
#   https://cdimage.ubuntu.com/ubuntu-base/releases/noble/release/
wsl.exe --import NivraTest 'C:\…\nivratest\disk' 'C:\…\nivratest\ubuntu-base-24.04.5-base-amd64.tar.gz' --version 2
wsl.exe -d NivraTest -u root --exec /bin/sh -c 'apt-get update && apt-get install -y --no-install-recommends git ca-certificates && useradd -m -s /bin/bash -u 1000 nivra'
wsl.exe --manage NivraTest --set-default-user nivra
# afterwards
wsl.exe --unregister NivraTest   # deletes the distribution and its disk
```

`pnpm rpc` options:
- `--home <dir>` uses another engine home.
- `--token-factory-url <loopback url>` passes the engine its test endpoint.
- It passes `NEBIUS_API_KEY`, when set, in `initialize`, as the app does.
- A `runs.start` without a `context` gets an empty preference snapshot, with sharing off. An explain run sent that way
  is refused before any request; pass `"sharing":{"modelContext":true}` to allow it. The app always sends its own
  context (D21, D22).
- A chat turn without a `context` also gets an empty history (D26). After `--follow`, its stored reply is printed. A
  repository turn needs consent, like explain:
  `{"workflowId":"chat","input":{"message":"…","scope":{"kind":"repository","repoPath":"/path/to/repo"}},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":true},"history":{"exchanges":[],"omitted":{"overLimit":0,"unanswered":0,"preferencesChanged":0}}}}`.

**The engine's log (NIV-27, D29).** Every failure writes one line to it, `diagnostic {json}`, at most 1,000
characters. The line never holds an error's own words:
- `code`: what kind of failure, from a closed list (`unexpected-error`, `model-failure`, `git-failed`, `exec-refused`,
  `refused` and so on);
- `stage`: where, such as `models.list`, `read_file` or `explain.prepare`;
- `reason`: a refusal's own code;
- the run, request, workflow and step, or the RPC id and method;
- `error`: up to four allowlisted classes from the cause chain, a known errno, how many causes, and the message's
  length;
- `counts`, such as `elapsedMs`.

The app keeps each engine's log in its logs folder (`<user data>/logs/<target>.log`). A diagnostic says what kind of
failure it was and where; it never says what the error said. To see that, reproduce the failure. For example, a key
holding a newline makes `fetch` throw a TypeError that quotes it:

```bash
NEBIUS_API_KEY="$(printf '%s\n%s' "canary-one" "canary-two")" pnpm rpc providers.check --home ~/.nivra-dev-track-a/<check> --token-factory-url http://127.0.0.1:9/v1
```

- A review (D30) needs its context: the preferences, the consent and the packet. `rpc.ts` works out the two
  fingerprints when the input leaves them out; pass `"panel":"single"` for the one-reviewer baseline. After `--follow`,
  its report is printed.

`probe:tokenfactory` takes `--model <id>`, passed after `--`, to pick the Nemotron model.

The Nebius Sandboxes probe (NIV-29, D28) is an explicit live check, never part of `verify`. Each stage runs only after
Nate approves it, with its data and budget:

```bash
pnpm probe:sandbox --plan                                  # every step, the data it carries, the limits and the thresholds; no network
pnpm probe:sandbox --credentials <file> --stage 0          # read-only: the account and the public images
pnpm probe:sandbox --credentials <file> --stage 1 --image <uuid|tag:name> --deny <url> [--deny <url>] [--network-control <url>]
pnpm probe:sandbox --credentials <file> --recover <evidence folder>
```

- **Credentials.** A file holding `NEBIUS_API_KEY=…` and `NEBIUS_PROJECT_ID=…` lines, outside the repository and
  readable only by you (`chmod 600`), for example `~/.config/nivra/nebius-probe.env`. The probe refuses one inside the
  repository (judged by its real path, so a link from outside to a file inside counts as inside) or readable by others,
  and sends nothing. The two variables set in your own terminal also work. Never put
  them in a chat. They are removed from the environment once read, and never printed or written: evidence replaces
  them with placeholders.
- **Stage 0** prints only what the proof needs: the permissions, the limits, the token's expiry and the public busybox
  or alpine images. The full answers go to the evidence file.
- **What stage 1 runs:**
  - at most twelve operations, one at a time, on the synthetic fixture in `apps/engine/test/fixtures/sandbox-probe/`;
  - networking off, except the one approved control;
  - no model calls and no installs.
- **The token.** Stage 1 first reads the account twice, 15 s apart. It starts only if the token is renewed with each
  request (as it was on 20 October), or stays valid long enough for stage 1 and its cleanup.
- **Deadlines.** Stage 1 stops at 20 minutes, a hard limit: no wait goes past it, every request ends by it, POST and
  DELETE included (D33), and nothing starts after it. Cleanup then takes at most 7 minutes, on the same terms.
  - A request's timeout is the smaller of its own limit and the time its caller has left.
  - A write needs 2 s left to be sent at all.
  - No answer is taken after its deadline.
- **Evidence** goes to `~/nivra-acceptance/sandbox-probe-<UTC>/` (0700): the journal, each step's outcome, how each of
  pattern B's subprocesses ended, the verdicts and a summary.
- **Interruption.**
  - The first Ctrl+C stops every request, wait and upload at once.
  - Cleanup then settles every operation the probe started, with its own signal and at most 7 minutes.
  - A second Ctrl+C stops cleanup.
  - `--recover` finishes the rest later from the journal, on the same budget.

The council evaluation (NIV-40) compares the council with a single reviewer on five synthetic plans. It is an explicit
check, never part of `verify`, and its paid batch runs only after Nate approves its digest:

```bash
pnpm council:eval --plan                                           # the request for approval: every run, limit and rule; no network
pnpm council:eval --token-factory-url <loopback url> --out <dir>   # the same batch against a stub, as the tests run it
pnpm council:eval --credentials <file> --approved <digest>         # the paid batch: 10 runs, at most 20 requests
pnpm council:eval --resume <dir> [--credentials <file> --approved <digest> | --token-factory-url <url>]
pnpm council:eval --score <dir>                                    # once the sheet is labelled: the scores and the decision
```

- **Frozen inputs.** Five plans, `apps/engine/test/fixtures/council-eval/plans/f1…f5.json`, are exactly what both arms
  are sent: no repository, no path, no conversation, and no preferences. F5 is the control, a sound plan. The rubric
  (`rubric.json`) and the protocol (`protocol.json`) are never sent. The approval digest covers all three, read as
  data, and a test pins it.
- **The paid batch refuses to start** unless the digest is the one approved, the protocol says who labels the sheet,
  and the working tree is committed, so the revision it records is exact. The credentials file follows the sandbox
  probe's rules: outside the repository, `chmod 600`, a `NEBIUS_API_KEY=…` line. The batch uses the key to read the
  model listing before each run, and the engine gets it only through `initialize`.
- **Before each run, with no inference request,** the batch checks three things against the protocol, using the
  engine's own code:
  - where the engine sends its requests, from its doctor;
  - the model it would pick, from the endpoint's model listing (`GET /models`), read with the engine's own client and
    pick;
  - the sampling it gives that model, from the engine's own policy.

  A mismatch stops the batch with nothing sent. The engine reads the listing again inside its run, so each run's
  recorded route, model and sampling are checked again after it ends.
- **Each request is journalled before it is sent,** and nothing is retried or retaken. A batch that was killed is
  resumed with `--resume`:
  - a run that was out is found by its request id on the same engine home and followed to its end, never sent again;
  - the protocol's stops are checked again on every run the journal kept, so a stop lost with the batch (killed after
    a run's end was written, before its stop was) stops it again before anything more is sent.
- **Every wait is bounded,** and the batch's 60 minutes count them all from its engine's start:
  - the engine's start, its doctor, and before each run, the model listing, the run's start and reading its record;
  - a run is cancelled at its limit plus 30 s and given 30 s more to settle. One still going then is kept as
    unresolved, and the batch stops; resuming never sends it again.

  A run is started only if all of that, each wait at its limit, could end within the 60 minutes, and no wait goes past
  them. Only stopping the engine comes after, in at most 15 s. With every run and every wait at its limit, a batch
  would need 74 minutes, so it would stop before its last runs.
- **Scoring doesn't trust the model.**
  - The rubric's stems read each reviewer finding.
  - `sheet.json` is the blinded sheet: shuffled by the protocol's seed, with no arm, role or finding id on it.
    Which arm and reviewer each line came from is never written down. `--score` works it out again from the runs,
    and refuses a sheet that isn't the one those runs made.
  - Nate labels each line's `label`, from `sheet.md` alone: the runs folder, `batch.json` and the journal name each
    run's arm. `--score` then decides from the labels alone, with the automatic-only scores beside them.
  - `--score` scores only under the protocol the batch ran under: the journal's approval digest must be this one's,
    as for `--resume`. Changed rules can't rescore a batch, or overwrite what it scored.
  - It refuses labels it can't use, naming each: a defect that isn't one of that plan's known ones (misspelled, or
    another plan's), a value outside a field's allowed ones, a field set where it doesn't apply, or a label without
    its seven fields. These are the checks v1 passed when it was frozen.
- **Label versions.** A labelled sheet is frozen before it is scored, and never edited afterwards:
  - **v1:** `sheet.v1.json`, read-only, is the sheet the batch wrote with the approved labels copied in. Each row is
    checked first, and only the label fields are copied.
  - **Its record:** `labels.v1.json` holds its hash, who labelled it, and the hash of the sheet the batch wrote (kept
    as `sheet.original.json`). The script that did the checking and freezing is kept beside them, as
    `freeze-labels.ts`.
  - **Its scores:** `scores.v1.json` and `decision.v1.md`, with their hashes in `score.v1.json`.
  - **A correction** makes v2 the same way, scores it, and records whether the decision changed. v1 stays as it was.
- **Test-only options,** refused for a paid batch: `--only`, `--deadline-ms`, `--reconcile-ms`, `--engine` (a
  stand-in engine) and `--fixtures` (another copy of the frozen inputs).
- **Evidence** goes to `~/nivra-acceptance/council-eval-<UTC>-<revision>/` (0700): the journal, every run's summary,
  events and report, the engine's home and log, the sheet, the scores and `decision.md`.

The Nebius execution session (NIV-41, D33) is the sandbox probe's client and journal behind the execution contract, in
`apps/engine/src/exec/nebius/session.ts`. Nothing runs on it yet: it isn't wired into the engine or the app (B4,
NIV-44). Its tests run offline, against the fake service in `apps/engine/test/fake-sandboxes.ts` and a loopback server:

```bash
cd apps/engine && node --test test/nebius-session.test.ts test/nebius-transport.test.ts test/nebius-sandbox.test.ts test/local-backend.test.ts
```

- **The contract suite.** It is in `test/session-contract.ts`, and both `Local` and the session run it. A new backend
  supplies programs that behave as named, and runs it too.
- **The journals.** A session journals into a folder its caller gives, one file per session (0700 folder, 0600 files).
  - A session that closes with nothing open moves its journal into `settled/` there.
  - `scanJournals` lists what an earlier engine left open, without using the network, and says how many journals it
    couldn't read.
  - `reconcileJournals` settles what the scan found in one bounded pass.

Commit snapshots and validated patches (NIV-42, D34) are in `apps/engine/src/exec/`: `tar.ts`, `snapshot.ts`,
`patch.ts` and `proposal.ts`, with the engine's own git in `git-tool.ts` and the path rules in `workspace-rules.ts`.
B3's prescribed path runs them, below, and B4 wires it into the engine. Their tests make real repositories in the temp
folder, and stand in for the sandbox's machine by running the real prepare and collect scripts with this machine's
`sh` and GNU tools (busybox runs them in B3's live check):

```bash
cd apps/engine && node --test test/tar.test.ts test/workspace-rules.test.ts test/snapshot.test.ts test/patch.test.ts test/proposal.test.ts
```

- **Nothing writes a checkout.** A snapshot reads only the commit's objects, and its one `git status` runs with every
  filter driver switched off. A patch is built in a temporary bare store, under the temp folder, that holds nothing of
  the repository. Applying a patch is NIV-8's.
- **The tests compare each checkout before and after** by every name's kind, mode, size, time and bytes, `.git`
  included (`changedSince` in `test/workspace-fixtures.ts`).

The prescribed path (NIV-43, D35) is `runPrescribed` in `apps/engine/src/exec/prescribed.ts`: the snapshot, the
session, the steps, collect, the patch, the report, the proposal and close, as one composition. Its offline scenarios
use the fake guest in `apps/engine/test/fake-guest.ts`. The live check runs it once on Nebius, on a byte-exact fixture
(`apps/engine/scripts/sandbox-fixture.ts`), after its recipe is approved:

```bash
cd apps/engine && node --test test/prescribed.test.ts
node apps/engine/scripts/sandbox-check.ts --plan                                    # the recipe, what it sends, its bounds; no network
node apps/engine/scripts/sandbox-check.ts --credentials <file> --run                # once per approval
node apps/engine/scripts/sandbox-check.ts --credentials <file> --recover <folder>   # settles what a cut-short cleanup left
```

- **The credentials file** holds `NEBIUS_API_KEY=…` and `NEBIUS_PROJECT_ID=…` lines, with mode 600, outside the
  repository. The check refuses anything else, and never prints or writes either value.
- **Evidence** goes to `~/nivra-acceptance/sandbox-check-<UTC>/` (0700). Close the Nivra app first: the check fails if
  `~/.nivra` changed.
- **One approval covers one run,** its cleanup, and one `--recover` pass if cleanup is cut short. A rerun needs a new
  approval.

A sandbox check (NIV-44, D36) is the prescribed path wired into the engine and the app: a project's commit uploaded to
Nebius Sandboxes, one fixed probe run there with networking off, and a report. It needs the key and the Nebius project
id (Settings, or `NEBIUS_API_KEY` and `NEBIUS_PROJECT_ID` for `rpc.ts`) and the project's own upload consent. Without a
real sandbox, point the engine at the stand-in in `apps/engine/test/stub-sandboxes.ts` with `--sandboxes-url` (loopback
only); the window's tests pass `--nivra-sandboxes-url` to an unpackaged app:

```bash
pnpm rpc sandbox.preview '{"repoPath":"/path/to/repo"}' --home ~/.nivra-dev-track-b
pnpm rpc runs.start '{"workflowId":"sandbox","input":{"repoPath":"/path/to/repo"},"context":{"sharing":{"cloudExecution":true}}}' --follow --sandboxes-url http://127.0.0.1:<port> --home ~/.nivra-dev-track-b
pnpm rpc sandbox.status --home ~/.nivra-dev-track-b
cd apps/engine && node --test test/sandbox-engine.test.ts test/check.test.ts
```

- **`rpc.ts` fills in the preview's fingerprint** from `sandbox.preview`, a project id and the local target when the
  request leaves them out, and prints the report after `--follow`.
- **The engine's journals** are under `<home>/sandbox/`. One that closed with nothing open is in `sandbox/settled/`;
  what an earlier engine left open is listed by `sandbox.status`, and settled by a pass once the credentials arrive.
- **The real engine tests** (`sandbox-engine.test.ts`) run the production adapter against the stand-in: a preview, a
  whole check, refusals, one check of a project at a time, a failure before the session, a cancel, an uncertain spawn
  settled by a later engine, a pass that ends while a check goes, and an engine killed mid-check. The stand-in's
  `before` hook holds chosen requests, so a test can act while one is out.

Research of a saved plan version's assumptions (NIV-45, D37): the person picks one to three assumptions of a plan's
latest version and writes the query for each; the engine searches Tavily with those queries, reads passages from the
pages it found, and asks the model once to assess each assumption from them. It needs the Tavily key and the Token
Factory key (Settings, or `TAVILY_API_KEY` and `NEBIUS_API_KEY` for `rpc.ts`), research queries turned on in Settings,
and, for a project's plan, the project's sharing. Without the real services, point the engine at stand-ins with
`--tavily-url` and `--token-factory-url` (loopback only):

```bash
pnpm rpc runs.start '{"workflowId":"research","input":{"planId":"<uuid>","planVersion":1},"context":{"sharing":{"modelContext":false,"webResearch":true},"packet":{"scope":{"kind":"general"},"planText":"Plan text","assumptions":[{"id":"A1","text":"An assumption","origin":{"kind":"typed"},"query":"A query"}],"sites":null}}}' --follow --tavily-url http://127.0.0.1:<port> --token-factory-url http://127.0.0.1:<port>/v1 --home ~/.nivra-dev-track-a/<check>
pnpm rpc runs.research '{"runId":"<id>"}' --home ~/.nivra-dev-track-a/<check>
cd apps/engine && node --test test/research-run.test.ts test/research-engine.test.ts test/research-units.test.ts
```

- **`rpc.ts` fills in the packet's fingerprint** when the request leaves it out, adds no permission or deny list the
  request doesn't give, and prints the report after `--follow`.
- **Stand-ins.** `apps/engine/test/stub-tavily.ts` answers Search and Extract, and `stub-token-factory.ts` the model.
  `apps/desktop/scripts/research-stand-ins.ts` starts both with the answers verify:windows uses.
- **The window's tests** pass `--nivra-tavily-url` to an unpackaged app, and `--nivra-test-preview-delay-ms` to hold a
  preview's answer so a test can edit the selection first. A packaged app ignores both.
- **verify:windows** runs research through the WSL engine against those stand-ins, on loopback in the distribution:
  research off, refused before anything is sent; then a whole run, checking that Tavily got exactly the approved query
  with its key and never the plan, and that the model got one request. `test/research-checks.test.ts` rehearses the
  same checks on Linux.
- **The live check** (`apps/engine/scripts/research-check.ts`) runs the demonstration plan once against Tavily and
  Token Factory, in process, and only with an approval of its printed digest. `--plan` prints the recipe with no
  network. Each key comes from a file of its own (mode 600, outside the repository), never from the environment.
  Evidence goes to `~/nivra-acceptance/research-check-<UTC>-<revision>/`. One approval is one run.
- **Two more switches for the window's tests (D38),** also ignored by a packaged app:
  - `--nivra-test-permission-delay-ms` holds research's permission and a project's sharing before they are saved;
  - `--nivra-test-engine=gated` runs `apps/desktop/test/fixtures/gated-engine.mjs` as the local engine: it takes only
    a fixture's name. Its switches are files in its engine home (see the fixture's header), and
    `research-cancel.spec.ts` shows how a lost start's answer and a refused cancel are set up.

R3's demonstration through the app (NIV-45, D37) researches one seeded project plan on the WSL engine of the Windows
app. Its values (the plan, its two assumptions, the queries, the sites, the project's name and the fixed ids) live in
`apps/desktop/scripts/research-demo.ts`. The journey (`scripts/research-journey.ts`) is shared by an offline e2e and
the live script:

```bash
cd apps/desktop && xvfb-run -a pnpm -s test:e2e research-journey.spec.ts   # the whole journey, against stand-ins
node scripts/research-live.ts --freeze      # builds the Windows app from this clean tree, copies it to %LOCALAPPDATA%\nivra-dev\r3-<UTC>, records its hashes
node scripts/research-live.ts --plan        # the recipe and its digest, for approval; no app, no network
node scripts/research-live.ts --rehearse    # the journey on the frozen build with fake keys, up to the preview; nothing starts
node scripts/research-live.ts --live --approved <digest>   # the approved run, detached; follow its log
node scripts/research-live.ts --cleanup     # opens the last live profile and removes its keys, if a run left them
```

- **The plan is seeded,** so no model call makes it: the app adds the project through its window, then
  `seedProjectPlan` (`e2e/seed-workspace.ts`, run by the staged `node.exe` with the app closed) saves a project
  conversation's repository answer as plan v1 under fixed ids. Its preview's fingerprint is known in advance, and the
  approval binds it, with the revision and the frozen build's `Nivra.exe`, `app.asar` and WSL runtime.
- **One approval is one run.** `--live` claims the approval in `~/nivra-acceptance/claims/research-r3/`, just before it
  presses Start, and only once the window's preview has the approved fingerprint. A failure before then removes the
  keys and spends nothing.
- **The person's part.** They paste the keys into Settings, and save the amended version themselves. The script waits
  for files in the evidence folder (`go-close`, `stop`), and nothing after Start can throw it out of the run.
- **Homes and evidence.** Each mode uses a profile of its own under the frozen folder and a WSL home under
  `~/.nivra-dev-track-a/`. It proves the route (the WSL engine, never the native one), and checks `~/.nivra` and
  `~/.nivra-dev` are unchanged. It scans the evidence, the profile and the engine's home for credential shapes
  (`scripts/shape-scan-cli.ts`), which can't see a Token Factory key. Evidence goes to
  `~/nivra-acceptance/research-r3-<mode>-<UTC>-<revision>/`.

A task run (NIV-7, D39) changes a copy of one commit in Nebius Sandboxes with a model, and checks the result itself:
the brief's acceptance cases require their exact output and exit code, judged by the engine. Every listed repository
check is also required to pass (NIV-67, D57), alongside complete frozen-file and setup-integrity evidence. Repository
checks run before the worker as comparison observations and again on the final result; these are separate from the
brief's explicit baseline assertions. A failure before the change never waives a final failure. A run needs the key and
the project id (Settings, or `NEBIUS_API_KEY` and `NEBIUS_PROJECT_ID` for `rpc.ts`) and both of the project's
consents, model sharing and uploads. Windows itself is refused; Linux and Windows-to-WSL are the targets. Without the
real services, point the engine at the stand-ins with `--sandboxes-url` and `--token-factory-url` (loopback only):

```bash
pnpm rpc task.preview '{"repoPath":"/path/to/repo","brief":{"goal":"…","acceptanceCriteria":[],"scope":"","exclusions":"","context":"","checks":[],"acceptanceCases":[{"name":"…","command":"…","expectedOutput":"…\n","expectedExitCode":0}]}}'
pnpm rpc runs.start '{"workflowId":"task","input":{"repoPath":"/path/to/repo"},"context":{"sharing":{"modelContext":true,"cloudExecution":true},"brief":{…}}}' --follow --sandboxes-url http://127.0.0.1:<port> --token-factory-url http://127.0.0.1:<port>/v1
cd apps/engine && node --test test/task-engine.test.ts test/task-run.test.ts test/task-worker.test.ts test/task-timing.test.ts
cd apps/desktop && xvfb-run -a pnpm -s test:e2e task-run.spec.ts
```

- **`rpc.ts` fills in** the brief's digest and the preview's fingerprint (from `task.preview`), a project, a task,
  brief version 1 and the local target when the request leaves them out, and prints the report and the proposal after
  `--follow`. A run without both consents in its context is refused at its check.
- **Stand-ins.** `stub-sandboxes.ts` takes a guest: `test/real-guest.ts` runs each command with this machine's tools,
  in a folder per image, and with `busybox = true` stands in for an image that has busybox (the engine names
  `/bin/busybox`; its applets are this machine's tools). `stub-token-factory.ts` scripts the worker's tool calls, by
  request. The fixture, `greet.sh` with its no-name bug and `check.sh`, is `apps/engine/scripts/task-fixture.ts`.
- **What the engine keeps.** The report is the run's `task` artefact (masked); the proposal is a row of `proposals`
  (engine migration 4), with its exact bytes, read with `runs.proposal` as masked text. Journals are the sandbox
  check's (`<home>/sandbox/`).
- **The window's tests** pass `--nivra-sandboxes-url` and `--nivra-token-factory-url` to an unpackaged app:
  `task-run.spec.ts` writes an acceptance case into a brief, gives both consents in the Run preview, runs the task,
  and reads what Nivra found, with the checkout untouched. The host's tests run the WSL stand-in target, since a host
  on Windows refuses a task on the local one; `wslEntry` puts the gated engine there for lost answers.
- **The task page's hooks** (NIV-56, G3). The shown run's area carries `task-attempt` (its status and id) and, once
  approved, `task-apply` (its status and resolution) around both columns, so a spec finds a run's parts inside them
  wherever the layout puts them: the result, checks and change in the main column, the decision in the aside, or
  after the result in a narrow window. Rename, Change repository and Delete sit behind `task-more`; the aside's tabs
  are `task-tab-brief`, `task-tab-coach` and `task-tab-runs`, and choosing the coach's gives it the main column.
  Every tab and the coach stay mounted when hidden, so a count or a text can be read without opening them; a press
  needs them open. The narrow-window test runs at 656 px (820 at 125%), below the page's 48em breakpoint: at 547 px
  the shell's navigation covers the page until it collapses below its own breakpoint.
- **The live toolchain probe** (`apps/engine/scripts/task-probe.ts`): five operations on Nebius with no model, the
  fixture only. `--plan` prints the recipe with no network; `--run --credentials <file>` needs an approval of that
  recipe, and refuses a fixture or write that isn't the pinned one; `--recover <folder>` settles what a cut-short
  cleanup left. Evidence goes to `~/nivra-acceptance/task-probe-<UTC>/`. It passed 10 of 10 on 26 October (D39).

Applying a task's change (NIV-8, D40): the person approves a verified proposal by its hash, and the engine that owns the
checkout applies it itself, never with git apply: each file it replaces is moved aside into
`<git folder>/nivra-apply/<apply id>/` and checked, each new file is linked into place without replacing anything, and
nothing is staged. The approval is the apply request, idempotent by the host's request id. With a finished run on the
stand-ins (above):

```bash
pnpm rpc task.apply '{"runId":"<uuid>"}'                     # fills in the approval from the run, as the host would
pnpm rpc task.applyStatus '{"requestId":"<uuid>"}'
pnpm rpc task.dismiss '{"applyId":"<uuid>","as":"accepted"}'   # or dismissed (not applied), kept (partial)
pnpm rpc task.restore '{"applyId":"<uuid>"}'                   # a partial apply only
cd apps/engine && node --test test/apply-*.test.ts
cd apps/desktop && xvfb-run -a pnpm -s test:e2e task-apply.spec.ts
```

- **The engine's parts** (`apps/engine/src/apply/`): `plan.ts` (the shared contract and the refusals' words),
  `revalidate.ts` (the checks before anything is written), `writer.ts` (the write, rollback and restore, and
  reconciling), `anchors.ts` (the folders an apply holds open: every call names its file through
  `/proc/self/fd/<descriptor>/<name>`, so nothing is written through a folder swapped for a link), `io.ts` (every
  filesystem call the writer makes, so a test can fail any of them), `journal.ts` (engine migration 5) and `service.ts`
  (the protocol's four calls, one apply at a time, and reconciling at start).
- **Recovery folder names** are positional: `new-<n>` (Nivra's bytes), `orig-<n>` (the original moved aside),
  `back-<n>-<m>` (a version taken back by rollback or restore). `nivra-apply/lock` names the engine and the apply that
  hold the folder. Settling removes nothing from it, so each apply's folder stays, with every copy, until the person
  deletes it.
- **The writer's tests** fail every filesystem call in turn (`apply-writer.test.ts`), save a file at each gap through
  the writer's step hooks, and kill a child process at every call (`apply-kill.test.ts`, with `apply-kill-child.ts`);
  `apply-fixtures.ts` holds the plan helpers. Revalidation's tests use real proposals from `attempt()`.
- **The gated engine** stands in for the apply calls in the host's tests: `task-report` makes runs.task answer with a
  verified proposal; `refuse-apply`, `hold-apply`/`release-apply`, `error-apply` and `partial-apply` (with
  `aside-apply`, a file moved aside too) shape `task.apply`'s answer; `error-settle` settles and then answers with an
  error, `hold-settle` settles and never answers; and `applies.log` records each request id.
- **The window's journey** (`e2e/task-apply.spec.ts`) approves, applies and accepts one run, rejects another, and asks
  for a revision of a third, on the built app against the stand-ins.

A project's environment (NIV-49, D41): one pinned Node and pnpm setup, prepared inside Nebius from the commit's
manifests, lockfile and workspace file (never `.npmrc`), and kept as an image its task runs start from. The preparation
is a run of its own; it needs upload consent, the key and the project id, and it is the one operation with networking
on. A task run bound to the environment starts from its image, runs the brief's baseline selections before the model,
and refuses changes to the brief's frozen files. Against the stand-in:

```bash
pnpm rpc environment.preview '{"repoPath":"/path/to/repo","spec":{"filters":["@scope/package..."]}}'
pnpm rpc runs.start '{"workflowId":"environment","input":{"repoPath":"/path/to/repo"},"context":{"sharing":{"cloudExecution":true},"spec":{"filters":[]}}}' --follow --sandboxes-url http://127.0.0.1:<port>
pnpm rpc runs.start '{"workflowId":"task","input":{"repoPath":"/path/to/repo","environment":{"image":"…","inputsDigest":"…","projectFingerprint":"…","node":"v22.23.4","pnpm":"11.5.3","arch":"x86_64"}},"context":{…}}' --follow --sandboxes-url … --token-factory-url …
cd apps/engine && node --test test/environment-*.test.ts test/task-environment.test.ts
cd apps/desktop && xvfb-run -a pnpm -s test:e2e environment.spec.ts
```

- **`rpc.ts` fills in** a preparation's preview fingerprint (from `environment.preview`), a project id and the local
  target, and prints
  `runs.environment` after `--follow`. A task run's `environment` is the prepared one's report, `prepared` field by
  field; `rpc.ts` binds the task preview to it.
- **The engine's parts** (`apps/engine/src/environment/`): `inputs.ts` (the inputs from the snapshot, the refusals,
  the digest and the install's arguments), `preview.ts` (what the preview shows and the bounds), `prepare.ts` (the
  image listed or imported, the upload, the preparation and its checks) and `report.ts`. The workflow is
  `workflows/environment.ts`; a task run's baseline and frozen files are in `task/harness.ts` and `task/worker.ts`.
- **Stand-ins.** The stand-in's `RealGuest` extracts the inputs a preparation was sent and adds the dependency folders
  an install would leave, so nothing is installed on this machine; `environment-engine.test.ts` prepares a workspace
  and a single-package repository through a real engine, with no change to Nivra between them.
- **What the host keeps** (workspace migration 5): per project, the spec and the prepared environment, and each
  preparation with its request id, saved before it is sent. The gated engine stands in for preparations in the host's
  tests (`environment-store.test.ts`, `host.test.ts`).
- **The live feasibility probe** (`apps/engine/scripts/env-probe.ts`): one preparation, then Nivra's own session
  started from its image, running a config's baseline selections with networking off. No model. `--plan` prints the
  recipe with no network; `--run --approved <digest>` needs an approval of that recipe; `--recover <folder>` settles
  what a cut-short cleanup left. Evidence goes to `~/nivra-acceptance/env-probe-<UTC>/`. It passed 15 of 15 on
  27 October (D41).
- **A test switch** holds the apply writer before a named step, for recovery checks through the real engine:
  `--apply-hold <file>` on the engine, `--nivra-test-apply-hold <file>` on an unpackaged app (an absolute path). The
  engine writes `<file>.held` when it holds.

Project-driven environments (NIV-55, NIV-58), the first part: a recipe contract that names no runtime or package
manager, and Node's resolver, which reads a project's own declarations into it. The second part, below, wires them
into the engine, the host and the window; this part's own tests are:

```bash
cd apps/engine && node --test test/environment-node.test.ts test/environment-releases.test.ts test/environment-inputs.test.ts
cd packages/domain && node --test test/environment.test.ts
cd apps/engine && node scripts/environment-releases.ts           # what a refreshed release index would hold
cd apps/engine && node scripts/environment-releases.ts --write   # write it: review the result as data
```

- **The contract** (`packages/domain/src/environment.ts`): the requested configuration (`EnvironmentRecipe`), which the
  person approves and which never changes afterwards; the verified tool record a preparation writes once; and the
  `EnvironmentRef` a task run carries, with both digests. A fact only preparation can know, such as the npm a Node
  release newer than the index bundles, is written in the recipe as a rule, never as a guessed value.
- **The resolver** (`apps/engine/src/environment/node.ts`, with its file readers in `node-files.ts`) honours exact pins,
  resolves ranges to an exact release, takes a labelled default when nothing is declared, and puts conflicting or
  unreadable declarations to the person as choices. It refuses, naming the file, the layouts that need the project's
  sources to install, until preparing from the sources is built. It reads workspace patterns with `*`, `**`, `?` and
  brace lists, and lockfile entries in either YAML style; a pattern or an entry it can't read is refused, never passed
  over. A chosen version is checked against the project's Node and lockfile as a pin is, and each pnpm build setting
  counts only from the pnpm version that reads it, where it reads it (`BUILD_SETTINGS`, from pnpm's changelog).
- **The release index** (`releases.ts`, with generated rows in `release-data.ts`) is the Node, npm and pnpm releases known
  when this Nivra was built, from nodejs.org and the npm registry, with each source's SHA-256 and the time it was
  fetched. The engine never fetches it: ranges resolve only within it, and a pin newer than it is checked when
  preparing. Refreshing it doesn't change an unchanged project's recipe: given the exact versions its last preparation
  settled on, the resolver keeps them while the project's setup configuration is the same. (The host passes them in.)
- **Tests** use a small fixed index of their own, so each answer is known whatever the shipped index holds.

Project-driven environments, the second part (NIV-55, NIV-59, D48): the engine resolves a project's recipe
(`environment.resolve`) and prepares it in Nebius, and the host, the store and the window use it; a task run starts
only from a ready environment, and carries an `EnvironmentRef`. The engine's half runs against the stand-in for Nebius
Sandboxes, whose guest answers the inspect, preparation and readiness steps as an image would: nothing is installed on
this machine.

```bash
cd apps/engine && node --test test/environment-recipe-engine.test.ts test/environment-prepare.test.ts test/task-recipe-engine.test.ts test/task-environment.test.ts
cd apps/engine && node --test test/environment-node.test.ts test/environment-workspace.test.ts test/nebius-sandbox.test.ts
cd apps/engine && node --test test/snapshot.test.ts test/patch.test.ts test/prepared-image.test.ts test/nebius-session.test.ts
cd apps/desktop && node --test test/environment-store.test.ts test/environment-scope.test.ts test/tasks.test.ts test/task-started.test.ts test/task-live-checks.test.ts
cd apps/desktop && node --test --test-name-pattern="from its own recipe" test/host.test.ts
xvfb-run -a pnpm --filter @nivra/desktop test:e2e environment.spec.ts environment-scope.spec.ts task-journey.spec.ts
```

- **The preparation** (`environment/prepare.ts`, its scripts and readers in `environment/scripts.ts`): the base image;
  an inspect step with networking off before any upload; the setup files uploaded; the bootstrap and the frozen
  install with networking on; pnpm's report of the builds it didn't run (10.1 and later); and readiness with networking
  off, which also lists what the workspace holds besides the install's folders. A stop's words are chosen by its code,
  and its detail says what was found, in Nivra's words.
- **Task runs**: sessions start from the environment's image with its task variables, and leave out only its
  dependency folders (`ExecutionSession.leftOut`, which collect reads too). The worker can't write a setup file, and
  the setup files are digested again after collect. A tracked file is source wherever it is: only the secrets deny
  list and the engine home leave one out of a snapshot.
- **The host and the store**: `resolveEnvironment`, `prepareEnvironment(choices)` and `acceptMissingBuilds`. The store
  reads its rows with the domain's schemas, D41's as legacy, and workspace migration 8 keeps an acceptance of missing
  builds bound to one verified record. The run preview's fingerprint v3 binds a run to the environment.
- **What to install** (D52): the whole project, the default; workspace packages ticked in the list the engine sends,
  with a switch for the root's own dependencies; or, under Advanced, pnpm selectors sent as typed. Which ways a project
  supports, and why not, comes with the resolution's `WorkspaceFacts`, on every answer that read the workspace.
  - `environment/workspace.ts` works out what a chosen install reaches from the lockfile's own links: pnpm's importers
    (`version: link:PATH`), and npm's tree, each name looked up as Node does from the dependent's folder. It passes
    every package reached: pnpm by exact name, npm as `./FOLDER`. It also holds the releases chosen installs are
    offered on (`filteredInstallProblem`, each range checked against its release notes) and the settings that refuse
    them. `node-files.ts` reads the links; the sandbox's `isInstallArgs` takes exactly the forms the resolver builds.
  - The preparation stops a chosen install whose log says pnpm passed over a filter (the script's `filters-unmatched`
    marker), and checks an image's bundled npm against the list before any upload.
  - The window keeps the facts apart from the preview, so a tick clears the preview and keeps the list. A folder the
    workspace no longer lists stays ticked and flagged until it is unticked. `src/shared/environment-scope.ts` holds
    the pure helpers, held to the domain's limits by `test/environment-scope.test.ts`.
  - The gated engine answers with fixed facts (packages/data, and packages/web, which links it), refuses a package it
    hasn't got, and answers as one package while an `env-single` file exists.
  - These tests check commands, refusals and the stand-in's preparation, offline. They don't prove a real filtered
    install: a live check needs its own approved recipe and digest. Choosing packages narrows only the install, never
    what a task sends.
- **Live runs**: `task-live.ts`'s recipe (kind v3 since the live checks' state folders) takes the person's choices for
  the project's own recipe in the task file's `environment` (`{}` for none; a `scope` says what to install, which the
  journey's preview chooses in the window by test id: packages ticked, or selectors typed under Advanced), and binds
  the resolution's fingerprint and
  warnings, the recipe's digest and the setup files' digest. Each live run needs Nate's approval of its own recipe and
  digest. Run the window's e2e through `pnpm --filter @nivra/desktop test:e2e`: the development engine runs on the Node
  that started pnpm's script.

A task's journey and its recovery, through the real host and engine (NIV-35): the built app with the production engine
against the stand-ins, through the unpackaged-only switches. A packaged app ignores the switches, so these skip there.

```bash
xvfb-run -a pnpm --filter @nivra/desktop test:e2e task-journey.spec.ts task-recovery.spec.ts
```

- **Run e2e specs through the package's script**, never `pnpm exec playwright`: only the script sets
  `npm_node_execpath`, and without it the app's local engine doesn't start ("Engine stopped").
- **The journey** (`e2e/task-journey.spec.ts`) takes the live run's own steps (`scripts/task-journey.ts`): the
  environment previewed and prepared in the window, uploads allowed in their own dialog; a task made from a saved plan
  with baseline checks and a frozen file; its run previewed and started once; the change judged, approved by its hash,
  applied and accepted.
- **Recovery** (`e2e/task-recovery.spec.ts`): a cancel while the worker waits on the model; an engine killed while an
  operation goes, then Restart; a quit mid-run, timed; a stale approval; an apply held by `--nivra-test-apply-hold`,
  its engine killed, read back as partial and restored.
- **The live run's script** (`apps/desktop/scripts/task-live.ts`), never part of `pnpm verify`:
  - `--state <folder>` is required by every mode that writes, which is every mode but `--check`: the frozen build,
    the recipes, the rehearsals and the runs go there. It is refused when it is, holds or sits in candidate 3's
    frozen take (`~/nivra-acceptance/task-live`), the claims, or any of Nivra's checkouts (this one and every worktree
    of its repository, candidate 3's among them), links followed. Approvals are claimed in one folder for every state
    folder, `~/nivra-acceptance/claims/task-live`, so one approval is one run wherever it runs;
  - `--check` reads the task file and its checkout and prints what a plan binds but the build (the snapshot, the
    environment's recipe and its warnings, the task or the stop it expects), with no network and nothing written;
  - `--freeze` copies a release candidate's unpacked Linux build, made from a clean tree, with its hashes: every file
    of the build, and its runtime's files as staging names them, refused when the runtime's manifest names others.
    Every other mode hashes the frozen build again first (`scripts/task-live-checks.ts`);
  - `--plan` prints the recipe and its digest, with no network;
  - `--rehearse` drives the frozen build with fake keys up to each preview, sending nothing. It checks the run's
    preview as the live run does, with no environment;
  - `--live --approved <digest>` runs the approved run: the person pastes the keys, the script presses Prepare and
    Start once each, and the decisions are the person's, in the window.
    Before Start, the run's preview must carry the fingerprint worked out from the recipe's brief digest and snapshot
    with the environment just prepared (the window's, which Start sends and the host checks again, and the app's),
    and show the approved commit, snapshot, frozen files with their hashes and environment inputs;
  - `--cleanup` removes the keys from the last live profile, whatever the task's checkout holds.
  - The recipe binds the one model a task run may use (D46), and the run's preview must name it. `--live` follows a
    run past its own deadline (the recipe's `runMinutes` and 10), and saves screenshots of the prepared environment,
    the run's preview, its end and the final state (0600; they come out blank under WSLg, so evidence never rests on
    them).
  The task, its repository and its brief are in a file outside the repository (by default
  `~/nivra-work/she65/task-live.json`), with any `review` points: what the person checks in the proposal that its
  tests can't show, which the recipe binds and lists. A file may instead expect its preparation to stop
  (`"expect": { "preparation": { "code": "install", "step": "install", "detail": "…" } }`, with no brief): the recipe
  names the stop, Nivra's words for it and its guidance word for word (`detail`, null for a stop that gives none), the
  run passes only on exactly that stop, with nothing kept (and, for an install, its log's end), and no task is created.
  Nothing in the script names a repository. A rehearsal reads the protected homes only once its app is closed.

A task run's bounds that no brief changes live in `packages/domain/src/task.ts`: `TASK_RUN_BOUNDS` (requests, the
output cap, the hand-in's cap, the rate, a request's input time, the input estimate, tool calls, writes, runs, a check's
seconds, and the session's and the run's minutes), with `requestMsFor` (a request's time from its cap: 830 s for 8,000
tokens, 180 s for the hand-in's 1,500) and `minutesMs`. The engine's `TASK_LIMITS` (`apps/engine/src/task/limits.ts`)
reads them as it reads `TASK_BRIEF_LIMITS`, and copies none; so does main's `getRunLimits`, which Settings › Budget and
usage shows. The engine is the only one that enforces them. The tests still pin each number on its own.

The engine's fetch (D47): at start, before any request, the engine makes undici's agent, with 15 minutes' waits for a
reply's headers and body, the global dispatcher that Node's own fetch reads (`apps/engine/src/providers/transport.ts`),
since a model's reply is not streamed and comes whole; with `NODE_USE_ENV_PROXY=1` it is undici's `EnvHttpProxyAgent`,
as Node's own would be. Every request keeps its own, shorter deadline. Tests may shorten
the wait with `--fetch-wait-ms` (never lengthen it); undici counts it in half-second ticks, so test waits are seconds.

```bash
(cd apps/engine && node --test test/transport.test.ts test/task-timing.test.ts)
(cd apps/engine && node --test --test-name-pattern='heartbeat|fetch waits' test/task-engine.test.ts)
```

The task readiness coach (NIV-53, D43): what a brief is missing, worked out without a model; one bounded coach call
when the person asks; and only the changes they tick, saved as the next brief version. The engine's half is checked in
process and over stdio, the host's against real engines and a stub, and the window's in the built app against
stand-ins. A packaged app ignores the stub switches, so there only the coach's checks that need no stand-in run: no
key, no sharing, and nothing else reached.

```bash
(cd apps/engine && node --test test/coach.test.ts test/coach-units.test.ts test/coach-answers.test.ts)
(cd apps/desktop && node --test test/host-coach.test.ts test/coach.test.ts test/coach-store.test.ts test/task-guidance.test.ts test/coach-shared.test.ts)
xvfb-run -a pnpm --filter @nivra/desktop test:e2e task-coach.spec.ts
```

- **`rpc.ts` fills in** a coaching's packet and preferences fingerprints, a task and a brief, a binding naming them, and
  the coach's profile, when they are left out; after `--follow` it prints the report. Pass a home of its own, never
  `~/.nivra-dev`, and a stand-in with a test key in `NEBIUS_API_KEY`:
  `pnpm rpc runs.start '{"workflowId":"coach","context":{"packet":{…}}}' --follow --token-factory-url http://127.0.0.1:<port>/v1 --home ~/.nivra-dev-niv53/<check>`.
- **Stand-ins.** `stub-token-factory.ts` plays the coach, told apart by `Nivra coach role: task-readiness-coach` on the
  first line of its instructions. Its tool is `submit_coaching`. The gated engine (`test/fixtures/gated-engine.mjs`)
  plays a coaching too: `runs.start` records it in `coaches.log`, and `runs.coach` answers with a report bound to it.
- **The engine's parts** (`apps/engine/src/coach/`):
  - `prompt.ts`: the instructions, whose hash a test pins to the profile's version;
  - `answers.ts`: the lenient form and the strict pass that sets aside and counts what doesn't fit;
  - `run.ts`: the one request;
  - `task.ts`: the stored input, and `asEnded`;
  - `workflows/coach.ts` holds the steps.
- **The host's parts** (`apps/desktop/src/main/`):
  - `coach.ts`: the packet, the preview's fingerprint, the report check, the change views, the ticked changes and the
    stale words;
  - `coach-store.ts`: the coachings table's functions (workspace migration 7);
  - the coach's block in `host.ts`.
  - In `src/shared/`: `task-guidance.ts` holds the rules without a model, and `coach.ts` the views and
    `applyCoachChange`.
- **A test hook,** `coachApplying`, runs inside the transaction that saves a coach's ticked changes, after the new
  version and before the applied mark. The host's test throws there to show that both or neither are kept.
- **Track B's seam** (D42): `validateBinding` runs inside that transaction; `missionContextForTask` lists a task's
  mission and the findings about it for the person to tick.

The shared monthly budget (NIV-66, D49): the host keeps its ledger in `workspace.db` and its guard, `budget-guard.log`,
beside it in Electron's user-data folder. Nothing spends through it yet: grants reach model calls with lane C's PR 2a.
Six calls on `window.nivra` drive it, for the budget screen and the development harness alike:

```
getBudgetPolicy()                         the current policy, or null
setBudgetPolicy(draft)                    saves the next policy version; null turns the monthly budget off
budgetSummary()                           this month: money (null when unknown), usage, counted services, gaps, clock
budgetPrices()                            the price list Nivra counts with
confirmBudgetMonth(month)                 confirms the new month the summary showed, by its label, such as 2026-11
startNewBudgetHistory(remaining)          after a loss: what is left this month ({ micros, allowances }), or null to wait
```

```bash
(cd packages/domain && node --test test/budget.test.ts)
(cd apps/desktop && node --test test/budget-store.test.ts test/budget-guard.test.ts test/host-budget.test.ts)
xvfb-run -a pnpm --filter @nivra/desktop test:e2e budget-api.spec.ts
```

- **The harness sets a policy** the way it already calls `window.nivra` for keys and checks, through
  `apps/desktop/scripts/live-ui.ts`: the same preload, IPC, trusted-sender check and validation the screen uses.
- **Amounts** are integer micro-units (25 dollars is 25000000). A budget in dollars is set only when the price list's
  currency, every model's bounds and free listings are established, and today's aren't: `setBudgetPolicy` refuses one
  with the reason and saves nothing, and `null` (the budget off: the existing per-run limits apply) keeps recording.
  With the budget off, a call to a model the price list doesn't have is counted, its money unknown; under a dollar
  budget it is refused. Tests set dollar budgets through the host's `prices` option (tests only), with a test list. A
  call that reaches no model costs no money.
- **A history put back.** Close Nivra, replace `workspace.db` with the matching copy, and open Nivra: the check at the
  first budget call clears the recovery once the ledger holds the guard's last revision and digest again. Deleting
  `budget-guard.log` while the workspace exists rebuilds it from the ledger (after a loss was found and before it was
  resolved, that clears the recorded recovery: one of D49's known limits). `budget-guard.test.ts` makes these faults
  with real files: it takes backups at each point the plan names, does paid work, and puts them back.
- **A new history's restriction** (the wait, or what is left) holds through the summary's `afterLoss.through`: the
  latest month the lost history established, which every guard record keeps (`month` in `budget-guard.log`), or the
  ledger's own when that is later, never a clock's. A history put back from an older month keeps its own month until
  the later one is established again, and the restriction holds in both.
- **The parts** (`apps/desktop/src/main/`): `budget-store.ts` (grants, journals, months and the summary, synchronous,
  each write in one transaction), `budget-guard.ts` (the log and the start-of-session check), migration 9 in
  `workspace-db.ts`, and the budget block at the end of `host.ts`. The contract is `packages/domain/src/budget.ts`, and
  the price list `packages/domain/src/prices.ts`.
- **Writing, dispatching and releasing a grant** (`writeGrant`, `markDispatching`, `releaseGrant`) take the ledger state
  the guard last verified: the host's check at the first budget call, or its latest append. On a ledger that no longer
  holds it they throw `BUDGET_UNVERIFIED`. Code that spends passes that state, never the ledger's own, which would
  verify nothing (the tests may, since they aren't checking the guard).
- **A new price list.** `(cd apps/engine && node scripts/prices.ts --version token-factory-YYYY-MM-DD)` prints one from
  Token Factory's public model list, for review. It sends no key and never runs in tests. A new version is added beside
  the old ones in `prices.ts`, never edited into one.

## A preview of the integrated build

To try the app without touching your own profile or engine homes, start it from `apps/desktop` with folders of its own
(never `~/.nivra` or `~/.nivra-dev`, D27):

```bash
pnpm dev -- --user-data-dir="$HOME/nivra-preview/user-data" --nivra-engine-home="$HOME/nivra-preview/engine-home"
```

Everything after `--` goes to Electron. Under WSLg, if the window or the focus misbehaves, add
`--ozone-platform=wayland` or `--ozone-platform=x11` there too. Delete the folders afterwards to start fresh.

## Where things will live

| What | Where |
|---|---|
| Engine home (installed app, release builds) | `~/.nivra` on Linux and inside WSL; `%LOCALAPPDATA%\Nivra\engine` on Windows |
| Engine home (development builds: `pnpm dev`, `pnpm dev:win`, `pnpm rpc`) | `~/.nivra-dev` on Linux and inside WSL; `%LOCALAPPDATA%\nivra-dev\engine` on Windows; or any folder passed with `--home` or `--nivra-engine-home` |
| Engine home (a Windows check's run) | `~/.nivra-test/<kind>-<UTC>-<id>` inside WSL (`--nivra-wsl-home`), removed when the run ends |
| Preferences, project registry | `nivra.json` in Electron's user-data folder (`%APPDATA%\Nivra`, `~/.config/Nivra`) |
| Engine logs | Electron's logs folder, one file per target |
| WSL runtime | `$HOME/<engine home>/runtime/<contentHash>/` inside the distribution; the newest two are kept in each home |

## Working on WSL

The developer machine runs WSL2 with mirrored networking. Nivra does not depend on networking between Windows and
WSL (D2), so the same code works under the default NAT mode.

A Node installed with nvm is invisible to `wsl.exe --exec`; that is expected, and it is why Nivra ships its own Node
(D5).

Development builds never use the installed app's engine homes (D27). One development home is shared, though: `pnpm
dev` under WSLg, `pnpm rpc` and the WSL engine of `pnpm dev:win`'s build all use `~/.nivra-dev` in the development
distribution. One engine holds a home at a time (D7), so the second to start is refused until the first stops.

## Not built yet

- Capturing the login shell's PATH for tools the engine starts. Until then, tools are looked up in the engine's own
  PATH, with WSL's leaked Windows folders removed. **Required before agents run builds (D15)**: nvm and similar are
  invisible to `wsl.exe --exec`.


### Companion and planning delivery checks (NIV-66 / NIV-68 / NIV-69)

The Companion and planning setting, labelled Monthly AI request limit, counts dispatched inference requests from both features across all projects and engines. An absent limit leaves monthly requests
unlimited under existing per-turn bounds; zero stops inference. Tokens are reported separately and incomplete totals
remain unknown. Coding, research, sandbox operations and other agents are not covered by this allowance; it is not a dollar ceiling.

Use isolated homes and loopback provider stand-ins for verification; no live paid call is part of `pnpm verify`.
The engine's `budget-journal`/`budget-model` tests cover grants, seals and SDK token shapes. Desktop
`companion-usage-accounting` tests cover unknown usage without double-counting. `budget-usage.spec.ts` exercises the
shared request policy through the native window. A disconnected target retains its grants until it reconnects.

For NIV-68, run `companion-engine.test.ts`, `companion-host.test.ts`, `knowledge.test.ts` and the built/packaged
`companion.spec.ts` journeys. Privacy fixtures scan SQLite/WAL, Mastra, artifacts and logs for synthetic transcript
markers, permitting separately selected structured outcomes. `pnpm rpc repository.inspect '{"repoPath":"/absolute/path"}'
--home /tmp/nivra-inspect-check` exercises local inspection without a provider or repository scripts. Guidance never
runs `environment.resolve` merely to refresh status. The companion composer never uses draft recovery.

When the host's computer month is later than its established budget month, Settings > Budget and usage > Companion
requests offers explicit month confirmation. Check the displayed month before confirming. Save and Refresh never
renew an exhausted allowance. The existing guard/recovery checks remain authoritative, and older outstanding requests
stay in their original month.

`companion-lifecycle.spec.ts` uses named IPC stand-ins to order context refreshes and replies without a provider. It
checks that own retained outcomes preserve the reply, external forgetting clears it, old polls cannot complete a newer
turn, and End clears text before cancellation is acknowledged. Its native navigation cases open a task's project
Settings from another sidebar selection and General, inspect the actual project controls, and return to the prior scope.
`companion-engine.test.ts` also checks that one task's preference is absent from another task's model context.

For the affected built journeys, use the package script:

```bash
pnpm --filter @nivra/desktop run test:e2e companion.spec.ts companion-lifecycle.spec.ts environment-scope.spec.ts
```

The package script supplies the absolute Node executable needed by source engines; a direct `pnpm exec playwright`
invocation does not supply it in this checkout.

For NIV-69, run the desktop `planning-host`, `planning-runner` and `host-planning` tests and engine `planning` and
`planning-evidence` tests. The planner tests drive a real engine over stdio against loopback model stand-ins; no paid
provider is needed. `planning.spec.ts` exercises manual review, selected draft saves, restart, unresolved prerequisites,
multiline acceptance entry and the explicit companion handoff in built and packaged apps. The Windows workspace
suite also covers manual selected saves, idempotency and restart with no provider key.

The planning regressions also cover commentary alongside exploratory tools, citations spanning consecutive reads,
combined mission/project knowledge and its invalidation, first-save validation recovery, selection preservation and
handoffs into an already open planner. Relevant task, selected mission and project notes share the existing bounded
snapshot; the host binds exactly the records sent to the engine. A selected mission replaces an inherited mission,
and another project's notes remain excluded. Engine and host use the same inclusive-range merger: consecutive reads
may support one citation, while unread gaps or inconsistent hashes/revisions cannot.

After saving a subset, choose Review remaining tasks to create a new reviewed version before saving more drafts.
Save reviewed version also creates a revision when the content is unchanged. Selection survives first creation and
navigation within the same window; it is not durable application data. If proposal validation fails after first brief
creation, the planner retains that draft's ID and the unsaved edits, so correcting and retrying reuses the record.
Each new companion handoff receives its own planner identity.

Repository-enabled planning requires the project's current model-context sharing consent. The original sharing epoch
is checked after asynchronous engine startup, before each inference and before retaining a result. Revocation/removal
cancels the operation; late results cannot update its plan. Only structured briefs, validated proposals and selected
outcomes persist; temporary companion discussion, repository excerpts, grants and raw model replies do not.

An explicit repository planning pass permits **up to eight** inference requests, not eight guaranteed requests. The
host sizes its finite grant against the shared allowance and reserves the final answer. A one-request grant skips
exploration and explains that repository impact was not assessed. Time/context limits can end exploration earlier.
Requests without repository exploration use one inference. All calls retain their existing deadlines and no automatic
repair/retry follows an invalid final response.

The shared pool migrates a legacy companion limit by appending a guarded policy version, preserving the month, limit,
usage and active reservations. Historical policy, grant and recovery records are never rewritten. The renderer's
existing companion usage methods remain named compatibility entries; their returned totals now cover both features.

Planning records use workspace schema v13; the planner RPC/result/authorisation handoff uses protocol v20. Native task
creation, first brief versions, mission membership, provenance and save receipts commit in one workspace transaction.
Saving does not create executable checks, mark tasks Ready or authorise execution. Existing active tasks are untouched.

Verification fixtures require a genuinely plain temporary directory. If the environment places a `.git` marker under
`/tmp`, use an isolated `TMPDIR` without a Git-marked ancestor; retain the production uncertainty refusal and the test's
plain-folder assertion. On machines with many CPUs, bounding CPU affinity for `pnpm verify` limits Node's automatic
worker count without skipping tests or changing deadlines. Preserve failed-run logs alongside the final receipt.

Required task verification (NIV-67, D57): version-4 task reports retain their expected-check manifest and before-change
repository-check observations. Every final check must pass, with at least one acceptance case and complete integrity
evidence. The host uses `task.admission`, which reads the exact proposal-bound report; `task.apply` repeats that gate.
Older reports retain their original recorded result, with current eligibility shown separately. The original brief
is supplied for legacy admission and must match the proposal's brief digest. No check failure can be approved anyway.

Focused offline checks and the affected built journeys:

```bash
pnpm --filter @nivra/engine exec node --test test/task-required-checks.test.ts test/task-admission.test.ts test/task-engine.test.ts test/task-timing.test.ts
xvfb-run -a pnpm --filter @nivra/desktop test:e2e --project=built task-run.spec.ts task-apply.spec.ts task-journey.spec.ts
```

Packaged apps ignore the stand-in endpoint switches, so those task journeys remain built-app evidence; the packaged
suite and Windows project cover their own stated scenarios.

## Engine database privacy (NIV-46, D58)

Linux/WSL engine homes support owner-controlled directories, including existing 0755 homes, below trusted ancestors.
Group/other-writable directories and symlinked home paths are refused; root-owned sticky temporary ancestors are
allowed for disposable fixtures. Newly created home directories request 0700. The engine requires a local filesystem
that honours POSIX modes and, on Linux, directory-descriptor access through `/proc/self/fd`. This is file privacy,
not encryption or isolation from the same user/root. Native Windows retains its existing ACL behaviour.

Startup validates both recognised SQLite families, privately prepares `nivra.db`, acquires its exclusive lock, repairs
its existing sidecars, and privately prepares Mastra's family before constructing its storage driver. Repair uses
validated descriptors and checks that 0600 took effect; it preserves bytes, inodes and recovery data. A missing main
file with surviving recovery files is refused rather than replaced with an empty database. Unsafe paths and repair
failures report `home-unusable`; fix the ownership/path or restore the affected entries from a trusted backup, then
start again. A refused startup does not broaden permissions or remove recovery files.

Only the two database families are repaired. Existing runtime executables and user files remain untouched. No global
umask is changed, no sidecars are manufactured and no database schema migration is introduced. Normal release startup
repairs its own selected home; never point a development engine or migration check at the real release home.

Focused offline checks, followed by the full suite and the Windows/WSL harness:

```bash
pnpm --filter @nivra/engine exec node --test test/database-privacy.test.ts test/engine.test.ts
pnpm --filter @nivra/engine exec node --test test/sandbox-engine.test.ts
pnpm verify
pnpm verify:windows
```

The driver gate checks modes before Mastra schema initialisation, during writes, and through sidecar recreation under
umask 022 and 000. The normal regression checks do not replace the explicit creation-time acceptance trace: after a
driver change, observe each creating syscall before subsequent userspace code can chmod the result. Use a disposable
home, never a real installation. FIFO tests retain their strict deadlines and verify non-blocking handling if a regular
file becomes a FIFO between inspection and opening. Run focused and full suites separately to avoid competing startup
loads. No paid/provider calls are required.

### Confirmed preferences in coding runs (NIV-71)

The task preview/start bridge accepts optional temporary choices. The host resolves confirmed personal preferences
and the task's own project preferences, screens them and the choices for credentials, and binds their digests into
preview v5. Relevant edits, deletion, supersession or changed choices require a fresh preview; an unrelated project's
edit does not. At acceptance the host rechecks after its asynchronous prerequisites. The accepted context is retained
in memory through engine startup and deep-copied/frozen by the scheduler; subsequent requests use that same snapshot.

The actual worker prompt carries scope/intent, choices and D23 precedence, inside the existing input budget. Nothing
in that text grants consent, relaxes final checks or changes execution/spending limits. Both digests and explicit
context are mandatory for new requests under protocol 22. Historical stored input permits absent digests only for
reading; it cannot reconstruct or replay private context. `rpc.ts` requires explicit preference and choice context
(including explicit empty records/choices) and constructs matching digests from it. Omitted context is refused rather
than silently constructing an empty snapshot.

Choices survive a Preferences detour only in window memory. Return checks task, brief and project identity and refreshes
the preview. Leaving Settings for the task list does not cancel the originating preview. Explicit preview Cancel,
switching tasks or an accepted Start clears choices; a refused or failed Start before acceptance keeps them. A brief revision invalidates its preview without discarding that task’s choices; a repository
reassignment cannot inherit the former project’s choices. They never enter draft persistence, the brief, knowledge or the canonical preference store.

Focused checks include the NIV-71 cases in desktop `host.test.ts`, domain task-contract tests, engine `task-engine`,
`task-run` and `task-worker` tests, and `task-preferences.spec.ts`. The host test captures production model requests,
edits preferences while the worker is active, verifies the next attempt's fresh context and scans engine/Mastra/workspace
persistence for private canaries. Credential tests cover recognised patterns and exact saved-key values without echoing
those values. The worker also rechecks frozen input before every request, including hand-in, so a newly saved key
matching private input stops another send without echoing the value. Existing required-check, admission, consent and cancellation regressions remain in force.

Run built task/preference journeys against loopback stand-ins, then packaged and Windows UI checks with fresh runtimes.
The keyless packaged preference journey admits no provider work; it checks empty state, Preferences return, stale
preview, failed starts, cancellation and task switching. Record those separately from actual worker-request evidence.

PR #49's return regressions also run against React's development runtime: a production bundle alone does not replay
StrictMode effects. The `development` Playwright project starts a loopback Vite server for `task-preferences.spec.ts`;
the app retains its sandbox, typed preload and trusted-sender checks. Use the package script so the unpackaged engine
receives the absolute Node path, as in the other built-app checks:

```bash
xvfb-run -a pnpm --filter @nivra/desktop test:e2e --project=development task-preferences.spec.ts
pnpm --filter @nivra/engine exec node --test test/task-run.test.ts test/task-engine.test.ts
```

The first command checks both built and development projects. Cases include correcting blank/duplicate choices
after returning from Preferences. Workflow tests cover keys newly matching accepted preferences/choices between
steps and context-digest mismatches: both produce finished refusal reports before inference or execution, including
when a previous step already saved an in-progress report. The closed stop codes keep recovery messages independent
of private input and prevent these refusals from appearing as engine interruptions.

## Council evaluation deadlines (NIV-48)

The cancellation and reconciliation deadlines are fixed when a run begins to be followed. A late polling turn does
not renew either window. If cancellation is due while hard batch time remains, the runner journals its intent once,
then rechecks the monotonic remainder before attempting the RPC. The call is bounded by the existing 10-second cap
and remaining batch time; an on-time call also respects the original reconciliation deadline. A cancellation first
requested after that window gets no fresh settling wait.

At hard batch exhaustion, no new cancellation or evidence-collection RPC is started. If the journal write consumes
the last time, its intent remains evidence but no cancellation is dispatched. A sub-millisecond remainder cannot fund
a positive RPC timeout and is described as insufficient time, not as a fully expired cap. The existing engine shutdown
remains separately bounded by at most 15 seconds of waits.

Every summary, events-page and report read checks its remaining collection allowance before dispatch. Zero would
disable the RPC client's timer, and a 1 ms floor would initiate a request outside the allowance; neither is used after
exhaustion. Earlier observations survive a later missing/failed read. An unresolved evaluation keeps status
`unknown`, request usage `null`, and a truthful reason distinguishing a missed run window, a late cancellation
attempt and hard batch exhaustion. An acknowledgement alone is not termination. An unresolved record stops the batch
and is never sent again on resume; historical journal/evidence formats remain readable.

These bounds apply to newly initiated waits and RPCs. Event-loop stalls and synchronous journal/evidence writes are
not themselves bounded by timers. Production uses `performance.now()`; the internal clock/wait seam exists only for
tests and adds no CLI controls or approval inputs.

Offline verification uses disposable homes and loopback provider stand-ins:

```bash
pnpm --filter @nivra/engine typecheck
pnpm --filter @nivra/engine exec node --test test/council-eval.test.ts
pnpm verify
```

Run the focused suite before the final full suite. The missed-turn regression advances a fake monotonic clock past
both run windows; it must fail if give-up is moved back ahead of cancellation. The original stuck-run watchdog,
numeric timing bound, journal assertions and no-resend checks remain in place; only its exact note changes to avoid
claiming an unobserved full interval after cancellation. No paid evaluation or real credentials are needed.

### Task discussion and reference context (NIV-70)

Protocol 23 and workspace migrations 14–15 add task comments, private reference files, exact source manifests and required
coding grants. See [the behaviour, limits and verification receipt](niv-70-verification.md) and D60. The PDF worker is
a separate bundled main entry; image preparation is a bundled renderer worker. Do not replace either with an
unbounded main-thread extraction/decoding path. Attaching/selecting/previewing makes no provider request.

Focused checks, all using local fixtures or provider stand-ins:

```bash
pnpm --filter @nivra/desktop exec node --test test/task-references.test.ts
pnpm --filter @nivra/engine exec node --test test/multimodal.test.ts test/task-run.test.ts test/task-worker.test.ts test/budget-model.test.ts
xvfb-run -a pnpm --filter @nivra/desktop test:e2e task-discussion.spec.ts task-preferences.spec.ts
pnpm --filter @nivra/desktop package:dir
xvfb-run -a pnpm --filter @nivra/desktop test:packaged task-discussion.spec.ts task-preferences.spec.ts
```

Use the `test:e2e` package script for an unpackaged app: it supplies the absolute Node path. On a heavily loaded WSL
machine, `taskset -c 0-3 pnpm verify` runs the same complete typecheck/test command with fewer concurrent test
processes; it changes no assertions or deadlines. Run Windows lifecycle checks after other heavyweight checks finish.
`verify:windows` includes an unpaid large reference-payload/hash check on both native Windows and Windows-to-WSL RPC.
After fresh staging and `dev:win --no-launch`, `test:windows` also checks native picker/image preparation and packaged
PDF extraction. All Windows checks keep their own test homes and compare the release's `~/.nivra` before/after.

New coding `runs.start` requests require a real host-ledger grant: a CLI caller must not invent a grant or bypass the
host budget authority. Historical run reads need no replacement grant. Provider image understanding requires a
harmless, separately approved live check; transport/fixture checks alone establish no such claim.

### Larger coding attempts (NIV-60, D63)

New app previews default to at most 64 working requests and one separately reserved hand-in. Edit the maximum and
refresh before Start. Time/context may stop the worker sooner. Settings can explicitly include coding in the shared
monthly request allowance; existing Companion/Planning policies retain their coverage until saved. A historical
recovery restriction needs its own explicit coverage acknowledgement. Sandbox cost remains outside this request pool.

The worker still uses exact single-span edits. Existing files may reach 2 MiB with a replacement up to 16 KiB;
creation remains 32 KiB. Validate full results and private values before transport encoding. Every successful write
requires the existing download/hash check. Do not replace the fixed splice with model-authored shell or replay an
uncertain operation. `CodingCapacity` accepts host-guarded portions only between settled operations; its phase/need
fence and the execution session's cumulative operation counter both matter.

Focused checks use provider stand-ins, with no paid inference:

```bash
node --test apps/engine/test/task-editing.test.ts apps/engine/test/coding-capacity.test.ts apps/engine/test/task-operation-capacity.test.ts
node --test --test-name-pattern=NIV-60 apps/desktop/test/host.test.ts apps/desktop/test/budget-store.test.ts
node --test apps/desktop/test/task-live-checks.test.ts
xvfb-run -a pnpm --filter @nivra/desktop test:e2e budget-usage.spec.ts task-run.spec.ts task-preferences.spec.ts
```

Use the prepared A1/B1/C1 fixtures for real evidence, solely inside Nivra's execution boundary. The acceptance
commits must not contain validation/reference material. Their pinned pnpm 11.5.3 is not in the checked range for
package-only installs: the NIV-60 evaluation copies choose whole-project preparation without altering their pins,
checks or source. The preflight does not prove that preparation or the checks will succeed within worker deadlines.

`task-live.ts --check --task <file>` is unpaid. Live validation requires a final clean committed revision, concrete
recipes and the existing claimed-approval flow; preserve prior release candidates before rebuilding. An optional
`--credentials <file>` supplies the existing named Settings calls from a private, owned file outside this repository
with mode 0600 and only the required Nebius values; values never enter recipes or logs. Interactive Settings entry
remains available. Remove keys and check isolated homes after the run; never apply the proposals automatically.
Record every actual attempt and independently inspect successful proposals. If all useful tasks finish below old
limits, their success does not close the larger-task evidence gap. See [the acceptance record](niv-60-verification.md).

### Task coach desktop acceptance (NIV-53)

The explicit helper runs from WSL, using a new state folder for each frozen candidate. It copies the Windows build
to a unique folder, uses an isolated native profile/engine, and checks release/shared homes. No key is read by
freeze, plan or rehearsal. Close other Windows Nivra/Electron instances before its test slot.

```bash
node apps/desktop/scripts/coach-live.ts --state ~/nivra-acceptance/niv53/completion-example --freeze
node apps/desktop/scripts/coach-live.ts --state ~/nivra-acceptance/niv53/completion-example --plan
node apps/desktop/scripts/coach-live.ts --state ~/nivra-acceptance/niv53/completion-example --rehearse
node apps/desktop/scripts/coach-live.ts --state ~/nivra-acceptance/niv53/completion-example --live --approved <recipe-digest>
node apps/desktop/scripts/coach-live.ts --state ~/nivra-acceptance/niv53/completion-example --save --reviewed <answer-sha256> --fields acceptanceCriteria
node apps/desktop/scripts/coach-live.ts --state ~/nivra-acceptance/niv53/completion-example --cleanup
```

Live mode reads the owned, private `~/.config/nivra/token-factory.env` (`NEBIUS_API_KEY`), or the file explicitly
named by `--credentials`. It passes the key through the existing named Settings call, removes it when finished,
then scans native files on Windows. The exclusive claim is kept even after failure or interruption; never remove
it to repeat a paid attempt. A stale slot lock names its PID: verify that process has ended before removing only
that lock. This does not release a paid claim.

Live mode retains `answer.json` and stops before saving. Inspect the actual output before supplying its printed
SHA-256 and the selected fields. Save requires some, but not all, usable proposals; it checks the resulting brief
and its persistence across reopening. Neither an unusable answer nor the runner's structural checks establish
useful coaching. The model named by the retained report must match the recipe for acceptance; the helper does
not change the application's model-selection policy. Cleanup remains available after source changes.

```bash
node --test apps/desktop/test/coach-live-checks.test.ts
xvfb-run -a pnpm --filter @nivra/desktop test:e2e coach-acceptance.spec.ts task-coach.spec.ts
```

The [NIV-53 verification record](niv-53-verification.md) records the failed live output-limit attempt separately
from the passing stand-in journeys. Do not close the issue or silently increase its limits from that evidence.

The separately requested coach response-budget follow-up now allows 8,000 completion tokens and reserves that
actual allowance against context, leaving at most 56,000 estimated input tokens under the existing 64,000-token
ceiling. Other workflows keep their existing defaults. Its 150-second request/180-second overall deadlines and
strict concise form are unchanged. Coach `model.call` metadata includes reported reasoning tokens, or null when
unreported; completion totals already include reasoning. The helper records these numeric measurements after close.
Its observer allows 270 seconds for cold engine initialisation, the complete run and a final polling margin; that
outer wait changes neither the 150-second model deadline nor the 180-second workflow deadline.

Paid mode is currently refused before another claim or credential read: the coach start route has not been wired
to a host-ledger grant as AGENTS.md D49 requires. An approval digest does not replace that grant. Freeze, plan and
unpaid rehearsal remain available; the live/save commands above describe the later path once actual grant admission
is implemented and verified. The prior failed evidence and claim stay unchanged.
