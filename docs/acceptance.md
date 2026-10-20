# Acceptance

What "working" means for Nivra's proof of concept, and how each claim is checked. A check counts only when it was
run; a skipped check is reported as skipped.

## The demonstration (immediate milestone, D20)

> "Explain this repository using evidence. Remember the preference I confirm. Show that it follows me to another
> project without overriding that project's own conventions, and that editing or deleting it changes what happens
> next."

1. Inspect and explain repository A, citing the files and lines the explanation rests on.
2. Explicitly confirm a portable preference.
3. Inspect repository B, which follows contrasting conventions.
4. Show scope and precedence: B's conventions win over the personal default, and A's project-only records never reach
   B.
5. Edit the preference, then delete it; each later request uses the fresh context.

The whole sequence is read-only: no scaffold, no repository writes, no code execution. New-app creation is deferred
(D20).

**Fixtures: user-supplied repositories A and B**, recorded 17 October 2026 (NIV-2). Both are real projects of Nate's,
used where they are and never copied into this repository.

| | Repository A | Repository B |
|---|---|---|
| Identity | [`valhalla-fitness`](https://github.com/xXValhallaCoderXx/valhalla-fitness) (public) | A private repository of Nate's. Its name and location are recorded in NIV-2, not here. |
| Revision | `develop` at `29c3a40a23dc2fb56774e1c3054339a4419349f0` (2026-09-19) | `develop` at `7a69f1f2a62ce71152dbde3e6b018aaa57b491fc` (2026-10-04) |
| Shape | A pnpm monorepo: a web app, an Expo app and four shared packages, about 1,270 tracked files | One Expo / React Native app in feature folders, about 730 tracked files |
| Component file names | PascalCase (423 of the 441 `.tsx` files outside routes and tests) | kebab-case (all 86) |
| Tests | Vitest, in `tests/` folders, plus Playwright end-to-end tests for the web app | Jest (`jest-expo`), in `__tests__/` folders |
| UI styling | Mantine 9 with Tailwind, in the web app | NativeWind classes and `StyleSheet` |

Not a contrast, since both have them: TypeScript, Expo Router, Supabase, `AGENTS.md` and `CLAUDE.md`, and far more named
exports than default ones.

- **How the precedence tests use them.**
  - A personal preference that matches A's habits loses to B's own conventions inside B. For example: component files in
    PascalCase, tests with Vitest.
  - A preference recorded only for A, such as its Mantine web UI, never reaches B.
- **The checkouts are used as they are.** Both had uncommitted files when they were recorded: A, one modified file and two
  untracked items; B, one untracked file. So evidence cites the content actually read, not only the commit.
- **Consent.** Choosing a repository grants no model-context consent, no cloud-upload consent and no permission to
  publish its contents.
- **B is private.** Its contents stay out of public samples. Whether it may appear in the public demonstration video is
  Nate's decision (NIV-16, NIV-17).
- Every acceptance result that depends on the fixtures stays pending until it has been run against them.

## Proof-of-concept acceptance suite (immediate milestone)

Run on Windows with a WSL engine and on Linux. Native Windows results are reported separately. macOS is deferred.

| Test | Required result | Status |
|---|---|---|
| Evidence | Explanations cite `path:line`. Each citation is checked against the content actually read, and a valid location is never presented as proof that the explanation is right. | Passing offline against a stub, and live on A and B (D22; see below). |
| Repository conventions vs personal defaults | Repository B's conventions win over a confirmed personal default. | Passing: the engine ranks each conflict the model reports, and a repository convention with lines shown to the model outranks project and personal defaults (D23). Offline, through the UI (the D20 scenario) and over stdio; live on B on 18 October (counts only, B is private). See below. |
| Explicit override | A task-specific choice wins without changing the stored profile. | Passing: offline, through the UI (the D20 scenario), over stdio and in the host, with `nivra.json` byte-identical across the run; live on B on 18 October, where the choice governed while "Currently" still named B's test runner (D23). See below. |
| Context isolation | Project A's project-only records and files never reach project B's requests. | Passing for the run's context (D21) and for model requests, files included (D22), and for a suggestion kept in A (D23); offline, and in the D20 scenario. See below. |
| Changed or deleted preference | The next request uses the edited preference, or none after deletion. | Passing for the run's context, including after an app restart (D21), and for model requests (D22), offline; a replaced preference too, offline and live on A on 18 October (D23). See below. |
| Consent | No repository-derived material leaves the machine without that project's `modelContext` consent. `cloudExecution` stays off and unused. | Passing offline, including consent withdrawn while a run starts, waits or runs (D22; see below). |
| Cancellation and restart | The app reports the true state. An interrupted run ends as `run.interrupted` and is never replayed. | Passing at the engine level and for explain runs (`pnpm verify`). |
| Failure reporting | Each of these is reported clearly, with no silent retry: invalid key, unavailable model, rate limiting, timeout, malformed tool results, network failure, sharing refusal. | Passing offline against a stub, except timeouts, which are tested in-process with short deadlines (D22; see below). |

**On the packaged builds (NIV-14, 18–19 October):** every test above passed live on the Linux deb and on the Windows
zip driving WSL, from one candidate. Live, the failures covered were an invalid key, a network failure, sharing
refused and withdrawn, and a malformed answer. See *Packaged acceptance, live*.

### Preference handoff (D21, NIV-5)

The host's store sends each run a snapshot of the confirmed preferences that apply to its project. Today the hello
run's `context` step receives it and records the ids, revisions and a fingerprint. No workflow uses preferences yet.
*Seen passing 2026-10-17:*
- **Real values at real engines.** Each engine's fingerprint matched one worked out independently from what was sent.
  The text included “quotes”, `ü`, `%`, `#` and 日本語.
  - Native Windows and WSL engines: `verify:windows`, 17/17.
  - The same through the packaged Windows app's UI: `test:windows`, 5/5.
  - The local engine through the built and the packaged Linux UI: `test:e2e` and `test:packaged`, 11/11 each.
- **Freshness.** After an edit, the next run gets the new wording and revision. After a deletion, it gets nothing. After
  a restart of the app, it gets the same snapshot as before. This is covered by the host tests against real engines
  and by the UI tests.
- **Isolation.** A project's own preference never reached another project's run. The host test has two engines, and the
  packaged Windows UI test keeps the Windows project's own preference out of the WSL run. Unconfirmed suggestions are
  never sent (unit test).
- **No preference text outside the host's store.** A canary preference never appeared in an engine's `nivra.db*` or
  `mastra.db*`, or in the logs. Only `nivra.json` held it.
  - The scan can find content in Mastra's records: the run's input was found there.
  - Checked by the engine, host and UI tests.
- **Refusals.** A `runs.start` without its context, or with a malformed snapshot, is refused with nothing recorded. A
  queued run whose engine died fails as interrupted and never starts.

### Explain with evidence (D22, NIV-6, NIV-9)

Offline, against a loopback stub of Token Factory: tests never call a real model. *Seen passing 2026-10-17* in
`pnpm verify` (engine and host tests against real engines), `test:e2e` and `test:packaged`:
- **Evidence.**
  - A run lists, searches and reads, then answers. Citations of lines the model was shown are checked; a citation of a
    file it never read is not.
  - A search, then an edit, then a read marks the file as changed during the run. A citation that runs past a clipped
    result is not checked.
  - The result is labelled "HEAD at run start", and a commit made during the run is reported.
  - Search hits are listed in the context used, by file, line and hash, even for a file that was never read or cited.
  - An answer citing a file the model never read is turned down, naming the citation. Resubmitted without it, the
    answer is accepted. After two refusals, an answer is accepted as it is, with those citations labelled.
  - The built app's window shows checked and unchecked citations.
- **What reaches the model.**
  - Tracked files only. `.env` and other secret files, and dependency and build output, are never read, even when a
    README asks for them.
  - A secret-shaped token and a private-key block in a tracked file reach the model masked. They never reach `nivra.db*`,
    `mastra.db*` or the logs.
  - The key appears only in the `Authorization` header.
  - Folder names in the first request's map are masked: one named with the key, and one that looks like a secret.
  - A repository's own git settings (`grep.fullName`, `submodule.recurse`, with a submodule) change nothing that is listed
    or searched.
- **Preferences.**
  - Each run records the preferences it was given: the count, ids, revisions and a fingerprint, never their text. The
    host test works the fingerprint out independently.
  - An answer reports where the repository differs from a confirmed preference, by id and revision. One that names a
    preference the run wasn't given is turned down. (Superseded by D23's conflicts and precedence; see below.)
  - An edit reaches the next request, and a deletion removes it.
  - An old result keeps the revision it saw, and the window then says the preference changed since the run.
  - The engine writes no statement it was given. Text the model echoes stays in `nivra.db`, never in `mastra.db*` or the
    logs.
- **Isolation.** Two projects on two engines: A's own preference and file never reached B's model requests, and B's
  never reached A's.
- **Consent.**
  - It is off by default for every project.
  - The host refuses before starting any engine, and the engine refuses before any request.
  - Withdrawn while the engine was starting, the run was never submitted. Withdrawn while it was queued, it was cancelled
    before sending anything. Withdrawn after its first model call, it was cancelled, and no further request was made.
  - Removing the project withdraws consent too. Removed while its explanation was being submitted, the run was
    cancelled as soon as the engine answered. Removed while it ran, it was cancelled, and no further request was made.
    When the run couldn't be stopped, the project stayed in the list, with the reason. Once removal had begun, a new
    explanation was refused.
- **Failures.** Each was named by kind, after one request:
  - 401 and 403: `auth`;
  - 404: `model-unavailable`;
  - 429: `rate-limit`, with when to try again;
  - 500: `provider`;
  - an unreadable 200: `bad-response`;
  - a dropped connection and a refused one: `network`;
  - no accepted answer: `malformed`.

  No key, and consent off, made no request at all. The engine's log never held the question.

  A provider error that echoed the key, the question and repository text left none of them in Mastra's records,
  including the WAL file, or in the log. Neither the key nor the repository text reached `nivra.db`, from a model call
  or from the model list. Each request is recorded
  once: a first request that fails is one event, and a success followed by a failure is two. A cancel before any
  request, or between two, records none.
- **Budget and time.**
  - With a small context length, the answer was forced early. A context too small for the instructions and the map is
    refused before any chat request (D23).
  - Per-call and whole-run deadlines end as `timeout`, never as a quiet stop. This is shown in-process with short
    deadlines; the real ones (150 s and 480 s) aren't exercised.
- **Cancel and restart.**
  - Cancel during a model call ends `cancelled`. An internal failure stays `failed`.
  - An engine killed mid-run fails the run as interrupted on restart, with no further request.
- **Packaged app.** It ignores the test endpoint switch: Doctor shows Token Factory, and explaining without a key fails
  before any request.
- **Packaged Windows app,** driven from WSL (`test:windows`, 6/6): explaining on the WSL engine and on the native one
  asked for each project's consent, then failed with "no key" before any request, with no model chosen.
  `verify:windows`: 17/17.

*Live, 17 October* (Nate's key, the Windows app, the WSL engine):
- Fixture A with the default question: `nvidia/nemotron-3-super-120b-a12b`, 46.4 s, 21,876 tokens in and 1,647 out over 4 calls, all reporting usage.
  - It read the README, `package.json` and `AGENTS.md`, then answered with 12 stack and convention findings that
    match the fixture record above.
  - 6 of its 21 citations point to lines the model was shown before it answered. The other 15 cite files it saw only
    named in the map, and the window marks them "file not read".
- Fixture B, which is private, also ran: its results stay out of this file.
- No preference had been confirmed in the app, so these runs don't test the preference contrast.

*Live, 17 October, after unread citations began to be turned down* (same setup):
- **Fixture A, default question:** 76.3 s, 77,514 tokens in and 2,420 out over 11 calls. The first answer was turned
  down for 6 citations of lines the model hadn't been shown. It then read the manifests it had cited and resubmitted.
  **13 of 13 citations** were shown to the model, across 9 findings.
- **Fixture A, "Where is the login component?":** 25.5 s, 6 calls. After one refusal, **4 of 4 citations** were shown.
  The answer named `AuthFormPanel` in `apps/web/src/domains/account/components/auth/AuthFormPanel.tsx`.
- **The preference's wording, asked as a question:** on A, 5 of 5 citations shown, with PascalCase and Vitest found as
  the fixture record says. Fixture B also ran again; its results stay out of this file.
- The statement was typed as a question rather than confirmed, so every run recorded "No confirmed preferences from
  the app (revision 0)". The preference contrast itself was still to run.
- The preference contrast then ran on B. B is private, so its result is recorded in NIV-6, not here. D23's checkpoint
  1 (below) ran B again with every kind of preference.

A real engine driven through `apps/engine/scripts/rpc.ts`:
- with no key, and with consent off, the run was refused each time with no request;
- against the stub, the run succeeded with 2 of 2 citations checked, its route recorded as `loopback-test`.

*Still pending:*
- a public pair of repositories for showing the preference contrast in the demonstration: B's live results are
  recorded privately in NIV-6 and NIV-11 (counts only);
- an explanation that reaches Token Factory from the native Windows engine.

*Since done:* the stronger provider probes ran with a real key on 18 October, from the WSL engine (D23's checkpoint 1,
below).

### Context assembly and the preference lifecycle (D23, NIV-11, NIV-10)

Offline (`pnpm verify`, `test:e2e`), against the loopback stub; no real model:
- **The D20 sequence, end to end through the UI** (`e2e/d20.spec.ts`):
  1. A is explained with checked citations.
  2. A portable preference and one of A's own are confirmed.
  3. B is explained: B's convention governs over the personal default, and A's own never reaches B's requests.
  4. A task choice governs that run only; "Currently" keeps B's convention, and `nivra.json` is byte-identical.
  5. An edit reaches the next request, then a deletion leaves none, and the old result stops quoting the preference.
- **Precedence.**
  - Every pair of the five kinds: the higher rank governs.
  - Ties at each rank are `unresolved`.
  - A repository claim with no line shown to the model doesn't rank, but is still reported.
  - Arrival order changes nothing.
- **Answers.**
  - Conflicts naming ids the run doesn't have, or fewer than two sides, are turned down twice at most, then dropped and
    counted; when the answer is due, they are dropped at once.
  - A repository convention or a suggestion citing no lines is turned down twice at most while there is time; after
    that, or when the answer is due, the convention decides nothing and the suggestion is dropped.
  - Suggestions keep only lines the model was shown.
  - A README can't add a choice, set an intent or name a winner.
  - A preference or choice asking for `.env` leaves it hidden.
- **Stored input.**
  - Two choices that masking made the same still run, as `c1` and `c2`.
  - A key block split across the question and a choice fails the run before any request, and every run still lists.
- **Canaries.**
  - Choices never reach `mastra.db*` or the log: on success, on a provider error echoing them, on a failed model list, or
    on a small-context refusal.
  - Model text in conflict topics and suggestions stays in `nivra.db`.
- **The context view's data** in a run forced by its budget: the budget, why the answer was due, hidden files and the
  preferences received.
- **The budget.**
  - The measured tool definitions match what the stub receives.
  - A model reporting a 6,000-token context is refused before any chat request.
- **The lifecycle.**
  - Replace keeps history, and the next run gets only the replacement.
  - Keep saves the person's wording as the project's default, with the run's evidence, once even on a double click. It is
    refused for another project's run, an unknown suggestion, or a project being removed or gone.
  - Export holds only the chosen scopes, with no ids, folders, history or key, and is written `0600`, leaving no temporary
    file behind even when the write fails part way. Each source project has a key of its own in the file, so two
    projects called `app` stay two.
  - Import brings the file's personal preferences only if the person keeps them in. Leaving them out leaves every other
    project's snapshot with the same preferences; only the store's revision rises.
  - Each source project's preferences go only where the person sends them. A destination is suggested only when the
    name is unambiguous; two same-named sources start left out, whether one or two local projects share the name.
  - Import skips what is already here, and the preview says so, a repeat within the file included. It refuses a choice
    that doesn't match the file, reads at most one byte past its size limit, never waits on a pipe, and never quotes a
    bad file.

*Live, 18 October* (Nate's dev Windows app on its own profile, driven through its UI by Claude at Nate's request; the
key stayed inside the app; the WSL engine):
- **Checkpoint 1, fixture B** (private: counts only):
  - Check Token Factory ran the stronger probes D22 left pending: required tool choice and a forced choice between two
    tools were honoured, and "Answer schema, forced: valid". It reported a context length of 262,144 tokens.
  - B had the personal default, a B default and a B decision. Without choices, B's decision governed tests, and "Currently"
    still named Jest; the repository governed naming. With the choice "Keep Jest for this task", the choice governed tests.
  - Both runs succeeded, with 8 of 8 and 12 of 12 citations shown, no conflict dropped, and `nivra.json` unchanged.
- **Checkpoint 2, fixture A:**
  - The first attempt produced no suggestion, so the prompt now asks for one per convention the findings establish.
  - Then the default question produced five suggestions, each with lines shown to the model.
  - "Name component files in PascalCase." was kept as A's default, then replaced. The next run received the replacement,
    not the replaced preference, and `nivra.json` was unchanged during it.

### Packaged acceptance, live (NIV-14)

This is the D20 journey and its failure cases, run live on the packaged builds of one candidate, each in profiles of
its own (`pnpm accept:live`).
- **The model:** `nvidia/nemotron-3-super-120b-a12b`, through Token Factory.
- **Fixture B** is private, so it appears as counts only.

**The candidate:** v0.1.0 at `ead56e8`, built by `pnpm release:candidate` from a clean tree after `pnpm verify`.
`build-info.json` and `SHA256SUMS` sit beside it.
- `Nivra-0.1.0-amd64.deb`: sha256 `33ee9691ec93e7948d835a817e884cd01449b8a1ff131d56f009650412d44493`
- `Nivra-0.1.0-win-x64.zip`: sha256 `f19a99ae3c2d9f67fef62c4b817e2789ff7cc22045ba0f678bd68b5fe78287b6`
- Runtimes: linux-x64 `f0f3baa2aafb1925`, win-x64 `e47d01e4a355740f`.

**The machine:**
- Windows 11 build 26300.9457 (26H2);
- WSL 2.7.8.0, with mirrored networking and WSLg 1.0.73.2;
- Ubuntu 24.04.1 LTS on kernel 6.18.33.1-microsoft-standard-WSL2;
- an AMD Ryzen 9 7900X, with 31 GiB visible to WSL;
- Electron 44.7.0 (Chrome 152.0.7977.130), and Node 24.21.0 in the app and in the engines.

It is one machine, not a minimum specification.

**The fixtures:**
- A: `valhalla-fitness` at `29c3a40a`, with 1,268 tracked files and 3 dirty entries.
- B: 728 tracked files, 1 dirty entry.

**How it ran**
- **Linux:** the deb installed with `dpkg --verify` clean, and launched under WSLg with its own profile and engine home.
- **Windows → WSL:**
  - the zip extracted on Windows;
  - `~/.nivra` moved aside, so the WSL runtime was installed fresh from the zip;
  - afterwards it was restored and checked against its recorded inode and store.
- **Rehearsals first.** Both platforms rehearsed without a key or a model: consent refused, no key, cancel, a graceful
  restart, a kill giving `run.interrupted`, closing the app mid-run, and switching between projects.
- **Strict checks** cover what Nivra itself does, and must pass on every run.
- **Required demonstrations** get one targeted retry: citations shown on A, the repository governing on B, and the task
  choice governing.

**Results: every criterion passes on both platforms.**

| Criterion | Linux (deb) | Windows → WSL (zip) |
|---|---|---|
| Identity: hashes, versions, runtimes | Passed | Passed; the WSL runtime was installed fresh from the zip, and no native engine started |
| Every run receives the current preferences, at the fixture's HEAD, through Token Factory | Every run | Every run |
| A explained with evidence | 14 of 14 citations shown to the model | 13 of 18 shown |
| A personal and an A-only preference confirmed | Passed | Passed |
| On B, the repository governs over the personal default, and A's own never reaches B | Attempt 1: the convention cited a file the model hadn't read, and arrived when the answer was due, so the personal default governed. Attempt 2: the repository governs, with 6 of 6 shown | The repository governs, with 8 of 8 shown |
| A task choice governs that run; Currently stays the repository's; nothing stored changes | The choice governs, with 19 of 19 shown; `nivra.json` byte-identical | Attempt 1: the choice governed, but its repository citations were of files not read. Attempt 2: the choice governs, with 8 of 8 shown |
| Edit, replace and delete reach the next request | Passed | Passed |
| A changed file reaches the next request | The map's `package.json` hash changed, and HEAD didn't | The same |
| Consent refused in the dialog and by the host; withdrawn mid-run, the run ends "Cancelled" | Passed | Passed |
| Cancelled mid-run, the run ends "Cancelled" | Passed | Passed |
| A graceful restart mid-run ends "Cancelled: the app asked it to stop"; a kill gives `run.interrupted`, started once, never replayed | Passed | Passed |
| Quitting mid-run cancels the run; none is left running in the WAL-recovered store; the profile is intact after relaunch | Passed; the quit took 107 ms | Passed; the quit took 2.1 s |
| Provider failures are named, with no chat request | A bad key gives `auth`; a proxy pointing nowhere gives `network` | A bad key gives `auth` |
| Cleanup: the key removed, the engines gone, the profiles deleted, the home restored | Passed | Passed |
| Runs, tokens and time | 16 runs; at least 727,084 tokens in and 30,906 out, with 3 runs cut short not reporting; 87 calls; 915.8 s | 15 runs; at least 891,999 in and 35,533 out, with 3 runs cut short not reporting; 99 calls; 1,002.5 s |

Each withdrawal, cancel and graceful restart cut a request in flight. The run recorded it once, as a `cancelled` model
call, and nothing more. Each kill ended `interrupted`, and the run was never started again.

**Earlier attempts, kept as evidence**
- **Linux, session 1** (candidate `cedaf53`):
  - A's first explanation failed `malformed`: Nemotron left `findings` out of all three answers, over 16 steps and
    187,201 input tokens. The targeted retry showed 6 of 6.
  - The session then stopped on a fault in the harness, since fixed.
- **Linux, session 2:** it stopped at the provider check.
  - The pasted key held a character that can't go in a request header, and Nivra could only say "Something inside
    Nivra failed (TypeError)".
  - **Fixed in the app** (`ead56e8`): Settings refuses such a key, saying why. Live, it refused the same paste.
- **Windows, the first session:** it timed out waiting for the key, and its cleanup restored the home.

**Re-evaluated with the corrected harness (20 October)**
- **What the review found.** The harness kept only one result per check and fixture, so a pass from one run could hide
  a strict failure from another. A session also exited 0 with a required demonstration still incomplete.
- **What changed.**
  - Each check now records its scenario: the purpose of the run it checks.
  - Retries collapse only within one scenario, and a strict failure is never superseded.
  - A session exits 1 on any failure, and 2 when a criterion it must establish is incomplete or wasn't run.
- **What re-evaluating all ten saved records showed.**
  - The two accepted sessions hold no strict failure, and still pass 14 of 14.
  - The old aggregation had hidden one strict failure, in Linux session 1 above: `handoff.head` on the run that failed
    `malformed`.
  - That failure was the harness's own: it read HEAD only from a result, which a failed run doesn't have. It was fixed
    in `3898f7e`, before the accepted sessions.

**Observations, not failures**
- **Quitting with a held hello run.** On Linux the quit took about 54 s in the rehearsals; on Windows → WSL, about
  0.3 s. With an explanation running, it took between 0.1 and 2.1 s. The final state was right every time. A follow-up
  is proposed.
- **Withdrawing consent** is recorded as a plain "Cancelled", the same as a cancel.
- **One WSL home.** Every Windows profile's WSL engine shares `~/.nivra`, so the session moved it aside rather than give
  itself a home of its own.
- **After an app restart,** earlier runs can't be viewed in the window; runs are kept for the session only. Their final
  states were read from the store.

**Native Windows** is reported separately. It isn't part of this harness, because checking its processes and reading
its store would need Windows tools.
- From existing evidence: `verify:windows` 17/17, and `test:windows` 6/6 (the native engine starts; consent; refused
  without a key; a Windows folder picked through WSL).
- An explanation from the native engine hasn't been run live.

**Evidence**
- Each session's private record (its runs, events, logs and store copies) stays with Nate.
- Its public summary is built from listed fields only, and checked for B's identifiers.
- Commands:
  - `pnpm release:candidate`
  - `pnpm accept:live --platform linux|windows --session rehearsal|live --fixture-a <A> [--fixture-b-file <private>] [--move-wsl-home] [--network]`

### Release candidate 0.1.1 (D25, NIV-16)

v0.1.0's runtime shipped `vcruntime140.dll` next to `node.exe`, where Windows never looks for an addon's dependencies.
So on a PC without the Visual C++ Redistributable, its native engine would stop at start. Candidate 0.1.1 ships the DLL
beside the addon (D25).

**The candidate:** 0.1.1 at `cad5eca`, built by `pnpm release:candidate` from a clean tree after `pnpm verify`. The build
re-hashed every packaged runtime file and checked where the DLL sits.
- `Nivra-0.1.1-amd64.deb`: sha256 `86da07456e6be5d602f6be433d4feb4824b27f8c79acc876cc0330b2d632d1ab`
- `Nivra-0.1.1-win-x64.zip`: sha256 `df371719c50b9387491e9cccc680233cd4c594340b7cb67858bdd02a9e6d7783`
- `build-info.json`: sha256 `8885a7875fb85a6a24d332f0b7b7811333cfae7aaead278684ec7dbee9809b5b`
- **Published** as the [v0.1.1 pre-release](https://github.com/xXValhallaCoderXx/nivra-orchestrator/releases/tag/v0.1.1)
  on 19 October, tagged at `cad5eca`, with these files unchanged. Each uploaded file's digest was checked against the
  local one. v0.1.0 stays published, with its files unchanged and a note saying it is superseded.

**What changed from v0.1.0**

| Payload | v0.1.0 | 0.1.1 |
|---|---|---|
| Linux runtime | `f0f3baa2aafb1925`, 3,708 files | Byte-identical |
| WSL tarball | sha256 `2d426b0f643f45a9…` | Byte-identical |
| Windows runtime | `e47d01e4a355740f`, with the DLL next to `node.exe` | `d7b773e6d952ca65`: the DLL moved beside libsql's addon, and the other 3,708 files unchanged |
| `app.asar`, on both platforms | `fc6812bc96f3c80f…` | `a6fdf4e50f213ee0…`: of its 9 files, only `package.json` differs, in its version |
| Electron and the toolchain | Electron 44.7.0 | The same |

So NIV-14's live evidence carries over to 0.1.1's Linux deb and to its Windows zip driving WSL. No model was called
again.

**Rerun on 0.1.1's packaged files (19 October)**
- `verify:windows --zip`, on the runtimes extracted from the zip: 20/20. That is the 17 earlier native and WSL checks,
  and the 3 below.
- `test:windows`, on the zip extracted with Windows' `tar.exe`: 6/6.
- `test:packaged`, on the candidate's Linux build: 16 passed. 5 were skipped, because they need the test endpoint
  switch, which a packaged app ignores.

**The controlled experiment,** on this PC, which has `vcruntime140.dll` in System32:

| Check | v0.1.0's zip | 0.1.1's zip |
|---|---|---|
| The engine loads only the Visual C++ runtime copy beside its addon | Failed: it loaded `C:\WINDOWS\SYSTEM32\VCRUNTIME140.dll` | Passed: only `engine\node_modules\@libsql\win32-x64-msvc\vcruntime140.dll` |
| In a copy where the addon's import is renamed to a name no installation has, the engine starts, runs hello and writes both stores | Failed: "The specified module could not be found" | Passed. It loaded only the renamed copy; the run is in `nivra.db`, and `mastra.db` has 44 tables |
| With the renamed DLL removed, the engine refuses to start (`runtime-broken`) | Passed | Passed |

**No clean-machine test has run yet.** It needs a Windows PC or VM without the redistributable
([clean-setup.md](clean-setup.md), check 3).

**Not rerun,** because the payloads they exercise didn't change:
- the live sessions, which call the model;
- the token-free `accept:live` rehearsals;
- installing the deb and running `dpkg --verify`.

**Commands**
- `pnpm release:candidate`
- `pnpm --filter @nivra/desktop verify:windows --zip release/Nivra-0.1.1-win-x64.zip`, and the same with v0.1.0's zip
- `pnpm --filter @nivra/desktop test:windows`, after extracting the zip into `%LOCALAPPDATA%\nivra-dev\app`
- `xvfb-run -a pnpm --filter @nivra/desktop test:packaged`

### Planning workspace, checkpoint 1 (D26, NIV-29 to NIV-32)

The workspace, conversation turns and native tasks, built without the window yet, and the Nebius Sandboxes probe
offline. Five commits on `feature/chat-managment`:

| Commit | What |
|---|---|
| `10f648f` | `workspace.db` |
| `97800df` | protocol 5 |
| `b87f8fc` | the conversation service |
| `4cc06b6` | native tasks |
| `2abe849` | Nebius offline |

**Checks (20 October)**
- `pnpm verify`: domain 36, desktop 168, engine 173. All passed.
- `test:e2e` (the built app): 21 passed. 1 was skipped, because it applies only to a packaged app.
- `test:packaged` (electron-builder `--dir`, Linux): 17 passed. 5 were skipped, because they need the test endpoint
  switch, which a packaged app ignores.
- `test:windows`, on the Windows build from `pnpm dev:win --no-launch`: 7 of 7. That is the 6 earlier checks, and the
  workspace check.
- `verify:windows`: 20/20, the native and WSL engines on runtime `35a433f1c58ac2d9` (protocol 5).
- A real engine through `apps/engine/scripts/rpc.ts`, against a loopback stub:
  - a general turn succeeded with no tools;
  - a repository turn read `README.md`, then replied with 1 of 1 citations shown to the model.

**The database, proven in the packaged apps first**

`workspace-store.spec.ts`, with `workspace-windows.spec.ts` for Windows, ran on the built app, the packaged Linux app and
the packaged Windows app. In each:
1. `node:sqlite` opened in Electron's main process.
2. A conversation survived a relaunch, and starting it started no engine.
3. A file that isn't a database was kept aside with its `-wal`, and the app started with a new one.

The store's own tests cover the rest:
- **Opening:**
  - each failure class by its SQLite code: locked, access and disk errors leave everything alone;
  - a newer schema is refused with its bytes unchanged;
  - journal files with no database are kept aside;
  - damage SQLite finds past a good header is kept aside.
- **Restarts:** reopening adds no duplicates, and projecting the same answer twice gives one message.
- **Versions:** brief versions are immutable, and an attempt keeps its brief version.
- **Deletion:** no text of a deleted conversation is left in the file's bytes.

**Recovery: how a turn ends** (`host.test.ts`, real engines, the stub and the gated fixture engine)

| Case | Result |
|---|---|
| Graceful quit with a turn in flight | Interrupted. The stub saw one request, and reopening sent none |
| The engine killed with a turn in flight | Interrupted. One request, no replay |
| Lost answer, the run recorded in the same store | Adopted, then answered. One `runs.start` |
| Lost answer, no record in the same store | Not sent |
| Lost answer, a replaced store (new `homeId`) | Unknown |
| The run accepted, then an error answer | Adopted through `runs.find`. Sent once |
| Cancelled while being sent | Cancelled as soon as the engine answered. One start, one cancel |
| Deleted while being sent | The late run was cancelled, and no row came back |
| Deleted while its answer was being projected | The answer went nowhere, and no text of it is in the file |
| Reading a conversation | No engine started, and no request was made |
| An engine that can't be reached | Unresolved, never failed |
| Sharing turned off | "Stopped: sharing for this project was turned off", and the next turn was refused |

Isolation and history:
- **A repository turn** reads only its own project's files and preferences, even with another project open.
- **A general turn** sends no path, no map and no project preference.
- **History** is sent oldest first, as question-and-answer pairs.
- **The canaries,** a saved key and a credential shape, are refused in a message, masked in an answer, and absent from
  every file under the profile.

**Native tasks.**
- A direct task and one from a plan have the same brief.
- Plan v2 leaves a brief from v1 alone until it is refreshed.
- Deleting the conversation keeps the brief. Its question is gone from the file's bytes, and the brief's text stays with
  the task.
- The state rules hold, and a stale revision is refused.
- Moving a task to another repository clears and marks what came from the old project.
- Every field refuses a credential.

**Nebius Sandboxes, offline (NIV-29).** 17 tests run against a fake service that behaves as the documentation of 20
October describes:

| What | Covered |
|---|---|
| Outcomes | the verdicts, kept apart from the operation's status |
| Every spawn | networking off and disposability stated; one operation at a time |
| The network control | each refusal |
| Lost and unsettled spawns | a lost answer is found; a 5xx is uncertain and never retried; beyond the search's bounds stays unknown |
| Connections | reattaching to the same operation; cancels, and cancelling an operation that has already ended; the observation deadline; `Retry-After` and the read deadline |
| Cleanup | after an interruption, a discovered operation is cancelled; `--recover` finishes the rest |
| Subprocesses and downloads | a 504 on a subprocess; download caps and hashes |
| The whole of stage 1 | judged as adopt; inconclusive without a working positive control |

No live call has been made. The plan is printed by `pnpm probe:sandbox --plan`.

**Not run yet:**
- the window: navigation, conversations, plans and tasks;
- the end-to-end tests for it;
- the live chat check;
- the live probe stages.

These are checkpoint 2.

**A side effect to know.** The Windows checks migrated Ubuntu's shared `~/.nivra/nivra.db` to schema v3, so the
installed v0.1.1 refuses that home until it is put back (D26).

### Planning workspace: the review of checkpoint 1 (D27)

A review of PR 4 found seven gaps, and asked for a WSL engine home that development and tests never share with the
release. Six commits on `feature/chat-managment`:

| Commit | What |
|---|---|
| `8b9a0c1` | Nebius: recovery, a subprocess not ready yet, each pattern judged on its own (findings 1, 7 and 3) |
| `9ec15d0` | a repository reply of spaces (6) |
| `e355720` | a deleted conversation's run (2) |
| `22db256` | a task made from another project's plan (5) |
| `2460259` | a crashed session's damaged workspace (4) |
| `7ea90a4` | engine homes by channel, and a WSL home for each test run |

**Each finding, reproduced and fixed.** Each has a test that fails on the code before its fix.

| Finding | Before | Now |
|---|---|---|
| 1. A probe dies after sending a spawn, before its answer | Cleanup: 0 cancelled, nothing unresolved, the operation still running | The intent is looked for, found, cancelled and seen to end `CANCELLED` |
| 2. A conversation is deleted while its turn is out; the engine makes the run, then answers `runs.start` with an error | No `runs.find`, no cancel: the run went on | One `runs.find`, then that run is cancelled. The same when the deletion comes while a lost answer is being looked for |
| 3. Pattern A passes at 25 s a step; pattern B takes 1 s, but a connection gets through, its failing test passes, and its cancel never ends the parent | "adopt", on B's timings | "adopt with concern", on A; B "defer", for its own network, cancel and exit checks |
| 4. A session dies with its last write in the WAL, and the file is damaged past its header | The 4,152-byte WAL was gone, and the file set aside had already changed | The file and its WAL kept aside byte for byte: on ext4 in the tests, and on NTFS in the packaged Windows app |
| 5. A task for project B made from project A's plan | Brief v1 held A's source, the plan's text and "Alpha uses Vite" | Cleared and marked to be written again, as when moving a task; the same for a task with no repository yet |
| 6. `submit_reply({answer: " \n\t "})` | The run succeeded with that answer | Turned down; a model that never fixes it ends `malformed`, with no reply stored |
| 7. HTTP 425 while a subprocess runs | The read threw | Polled as long as `Retry-After` says, never past the deadline; a signalled child (`exit_code` -1) counts as ended |

Finding 4's read-only check was tried by hand first, with `node:sqlite` on ext4 and on NTFS (the Windows `node.exe`,
SQLite 3.53.4). It found the damage (SQLite error 11) and left the file and the WAL byte-identical. A writing
connection, closing, had folded the WAL in and deleted it.

**The engine homes (20 October, the development build from `pnpm dev:win --no-launch`)**

| Check | Result |
|---|---|
| `verify:windows` | 22/22. The WSL engine ran in `~/.nivra-test/verify-20261020T013521Z-dcaa14f7`, and runtime `2d6e0abc44da7fdd` was installed there. `~/.nivra`'s 8 entries were unchanged, and the run's home was removed |
| `test:windows` | 9/9. The WSL engine's home was the run's own. `~/.nivra` was unchanged, and the run's home was removed. Includes finding 4 on NTFS |
| `~/.nivra`, compared by hand before and after both | Identical. `nivra.db` is still schema 2, with 164 runs |
| The install script in a real shell | Three installs into `.nivra-dev` kept its newest two; the three runtime folders in `.nivra` were untouched |

One thing changed afterwards, and it was the hand check itself. A read-only query of `~/.nivra/nivra.db`, made after
both comparisons, moved the time of its `-shm` file; the file's content is the same.

**Checks**
- `pnpm verify`: domain 36, engine 181, desktop 176. All passed.
- `test:e2e` (built): 21 passed. 1 was skipped, because it applies only to a packaged app.
- `test:packaged` (Linux, `--dir`): 17 passed. 5 were skipped, because they need the test endpoint switch.
- A real engine through `apps/engine/scripts/rpc.ts`, against a loopback stub: the reply of spaces was turned down, and
  the next one succeeded, trimmed, with 1 of 1 citations checked.
- `pnpm probe:sandbox --plan` prints the thresholds per pattern. No live call has been made.

**Not run:** `verify:interrupt`. This machine has no dedicated test distribution to terminate. Its scripts only gained
the run's own WSL home and its removal; typecheck covers them.

### Deferred to a later milestone (kept, not dropped)

| Test | Required result |
|---|---|
| New project | Relevant confirmed defaults are proposed without being entered again. |
| Approved writes | A change reaches a checkout only as an approved, checked patch. Denied actions never run, and writes are never replayed. |

## Bootstrap exit checks

The cross-platform foundation is done when all of these were seen to pass:

- **Engine targets, verified locally (D14):** on Linux (`pnpm verify`), and on native Windows and in WSL from a real
  Windows parent (`pnpm verify:windows`), the engine starts, streams the `hello` run, cancels it with no surviving
  child, and exits cleanly, with the engine home and the repository in paths containing spaces, non-ASCII characters,
  `%` and `#`.
  - An engine also dies with a parent that was killed.
  - An engine killed from outside (a native one, or a WSL one killed inside its distribution) is reported as stopped,
    and Restart starts it again (D18).
  - The hello run on each engine receives a preference snapshot intact (D21).
  
  *Seen passing 2026-10-17: 17/17.*
- **Unresponsive engine (D18):** an engine that stays alive but stops answering is reported as `unresponsive` within
  bounds, then stopped, and Restart starts a fresh one. Silence after a resume from sleep is not counted for one
  heartbeat. *Covered by `supervisor.test.ts` with a fixture engine; seen passing 2026-10-17.*
- **WSL distribution terminated while the app runs** (`verify:interrupt`). The packaged Windows app and its
  observer run on Windows, with the trace and logs there, against a dedicated throwaway distribution.
  - **Setup:** a held WSL run and a held native run are going when the distribution is terminated from outside
    (`wsl --terminate`).
  - **While it is down:** the app stays usable, and the WSL engine is reported as failed straight away ("The engine
    stopped unexpectedly"). The native run keeps going on the same engine, and later finishes there.
  - **Restart in the UI:** it brings up a fresh engine. The cut-off run ends as `run.interrupted`, and was started only
    once. A new run works.
  - **Quitting** leaves no engine on Windows or in the distribution.

  *Seen passing 2026-10-17: 9/9, against `NivraTest`.* That distribution was made from the Ubuntu 24.04 base image for
  this check and unregistered afterwards. The development distribution was never terminated.
- **Stdout purity:** every line the engine writes to stdout parses as JSON-RPC, through hello, cancel and a provider
  check.
- **Secrets canary:** a fake key never appears in `nivra.db*`, `mastra.db*` or the logs.
- **Restart:** a run still marked running when the engine starts again ends as failed with `run.interrupted` and is
  not replayed. A second engine on the same home is refused.
- **Packaged Windows app**, one session with both engines (D17):
  - a `\\wsl.localhost` folder provisions Ubuntu and runs hello on a path with spaces, `ü`, `%` and `#`;
  - a run held on WSL keeps going while a Windows folder starts and runs hello on the native engine;
  - the WSL run then cancels on its own engine;
  - a preference confirmed in the window reaches both engines intact, and the Windows project's own preference stays out
    of the WSL run (D21);
  - the same Windows folder picked through WSL is recognised as the Windows project;
  - quitting leaves no engine running (`pgrep` in WSL, `tasklist` on Windows).
  
  *Seen passing 2026-10-17 through the real UI (`test:windows`, 5/5); on 2026-10-19 against `ead56e8`, 6/6; latest against 0.1.1's zip (`cad5eca`), 6/6.*
  The zip carries both runtimes.
  - *Checked as a judge would use it, 19–20 October.* The published v0.1.1 zip was downloaded in Edge and extracted with
    Extract All. README steps 4–8 then passed through the UI against a fresh WSL distribution: Ubuntu 26.04.1, today's
    `wsl --install` default, with 23 checks of 23 ([clean-setup.md](clean-setup.md), check 1; NIV-16).
    - It ran on Nate's existing account, with a fresh Nivra profile and his mirrored networking.
    - A fresh Windows account with WSL's default networking hasn't been checked.
- **Packaged Linux app** (`electron-builder --dir`): the same flow on the local target through the real UI, plus the
  preference handoff (`test:packaged`, 11/11). *Seen passing 2026-10-17; on 2026-10-19 against `ead56e8`, 16 passed,
  with 5 skipped that need the test endpoint switch, which a packaged app ignores; latest the same against `cad5eca`.*
- **Actionable refusals and guidance** for:
  - no WSL, or an outdated WSL;
  - WSL with no distribution, or only Docker Desktop's, or only WSL 1 ones;
  - a WSL listing that fails;
  - WSL1, `docker-desktop`, a musl distribution, ARM64, a distribution never opened;
  - a network share;
  - missing git.
  
  *Covered by unit tests with captured tool output; not yet seen on a machine that has them.*
- **Installed deb** on Ubuntu 24.04, launched without changing AppArmor: the same flow on the local target.
  - *Installed and accepted live on 19 October* in this machine's Ubuntu 24.04 under WSL2 (see *Packaged acceptance,
    live*).
  - *Checked on 19 October, for 0.1.1,* on a stock Ubuntu 24.04.5 desktop VM with AppArmor on and unprivileged user
    namespaces restricted.
    - The installed profile was loaded, and Chromium's sandbox ran in its own user namespace.
    - README steps 4–8 passed through the UI, 22 checks of 22.
    - apt removed everything but the data folders, which the README says to delete ([clean-setup.md](clean-setup.md),
      check 2; NIV-16).
- **Token Factory** reached from both the WSL and the native engine: models listed and one Nemotron call made
  (Settings → Check Token Factory, on each target).
  - *Seen once, 17 October, with Nate's key:* 28 models, five of them NVIDIA's. Nemotron 3 Super called the tool and
    answered in 2,249 ms (964 tokens in, 65 out). It honoured required tool choice, and a forced tool when it was the
    only one offered. Rate-limit headers were present, and `/models` gave no context length.
  - *18 October, from the WSL engine* (D23's checkpoint 1): required tool choice and a forced choice between two tools
    were honoured, the real answer schema was valid when forced, and `/models?verbose=true` gave a context length of
    262,144 tokens.
  - Reaching it from the native engine is still pending.
- **Clean machine:** the Windows zip runs native hello on a VM or Windows Sandbox with no Visual C++ redistributable
  installed. *Not yet run.*
  - v0.1.0 would fail it. Its runtime shipped the DLL next to `node.exe`, and Windows doesn't look there for an addon's
    dependencies.
  - 0.1.1 ships the DLL beside the addon (D25). The controlled check passes on its zip (*Release candidate 0.1.1*).
  - A clean machine is still to run ([clean-setup.md](clean-setup.md), check 3).

## Hackathon submission checklist

The dated checklist, with a source link for each requirement, is in [submission.md](submission.md) (NIV-15).
