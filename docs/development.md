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

Cross-platform checks (D14; there is no CI):

```bash
pnpm stage:runtime all      # stage linux-x64 (+ WSL tarball, smoke-tested) and win-x64 into apps/desktop/build/stage
pnpm verify:windows         # from WSL: run the target harness as a Windows process (native + WSL engines)
```

`verify:windows` takes `--distro <name>` and `--skip-stage`. It works in `%LOCALAPPDATA%\nivra-dev\verify`.
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
Nothing runs them yet: B3 puts them together, and B4 wires them in. Their tests make real repositories in the temp
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
- Approved apply for agent writes (D15, NIV-8). Commit snapshots, patch checks and proposals bound by one hash are
  built (D34), and so is the Nebius execution session they run with (D33), but none of them is wired into the engine.
