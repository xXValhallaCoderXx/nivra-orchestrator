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

The whole sequence was read-only by design: no scaffold, no repository writes, no code execution. That was this
milestone's scope. Coding work came later, behind its own boundary, each with its record below: task runs (D39),
applying an approved change (D40) and a project's environment (D41). New-app creation is still deferred (D20).

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
| Consent | No repository-derived material leaves the machine without that project's `modelContext` consent. In this milestone `cloudExecution` stayed off and unused; it now gates uploads to Nebius Sandboxes, asked for on its own (D36, D39, D41). | Passing offline, including consent withdrawn while a run starts, waits or runs (D22; see below). |
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
release. A second review, at `7155917`, found one more read in finding 7's fix. Seven commits on
`feature/chat-managment`:

| Commit | What |
|---|---|
| `8b9a0c1` | Nebius: recovery, a subprocess not ready yet, each pattern judged on its own (findings 1, 7 and 3) |
| `9ec15d0` | a repository reply of spaces (6) |
| `e355720` | a deleted conversation's run (2) |
| `22db256` | a task made from another project's plan (5) |
| `2460259` | a crashed session's damaged workspace (4) |
| `7ea90a4` | engine homes by channel, and a WSL home for each test run |
| `483f49d` | a subprocess result read at its deadline (7, the second review) |

**Each finding, reproduced and fixed.** Each has a test that fails on the code before its fix.

| Finding | Before | Now |
|---|---|---|
| 1. A probe dies after sending a spawn, before its answer | Cleanup: 0 cancelled, nothing unresolved, the operation still running | The intent is looked for, found, cancelled and seen to end `CANCELLED` |
| 2. A conversation is deleted while its turn is out; the engine makes the run, then answers `runs.start` with an error | No `runs.find`, no cancel: the run went on | One `runs.find`, then that run is cancelled. The same when the deletion comes while a lost answer is being looked for |
| 3. Pattern A passes at 25 s a step; pattern B takes 1 s, but a connection gets through, its failing test passes, and its cancel never ends the parent | "adopt", on B's timings | "adopt with concern", on A; B "defer", for its own network, cancel and exit checks |
| 4. A session dies with its last write in the WAL, and the file is damaged past its header | The 4,152-byte WAL was gone, and the file set aside had already changed | The file and its WAL kept aside byte for byte: on ext4 in the tests, and on NTFS in the packaged Windows app |
| 5. A task for project B made from project A's plan | Brief v1 held A's source, the plan's text and "Alpha uses Vite" | Cleared and marked to be written again, as when moving a task; the same for a task with no repository yet |
| 6. `submit_reply({answer: " \n\t "})` | The run succeeded with that answer | Turned down; a model that never fixes it ends `malformed`, with no reply stored |
| 7. HTTP 425 while a subprocess runs | The read threw. After the first fix, one more read at the deadline was still taken: with 5 s left and `Retry-After: 10`, reads at 0 and 5 s, and the second answer counted | Polled as long as `Retry-After` says. Once the deadline is reached, no request is made and no answer taken: one read, and no result. A signalled child (`exit_code` -1) counts as ended |

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
- `pnpm verify`: domain 36, engine 182, desktop 176. All passed (after the second review's fix).
- `test:e2e` (built): 21 passed. 1 was skipped, because it applies only to a packaged app.
- `test:packaged` (Linux, `--dir`): 17 passed. 5 were skipped, because they need the test endpoint switch.
- A real engine through `apps/engine/scripts/rpc.ts`, against a loopback stub: the reply of spaces was turned down, and
  the next one succeeded, trimmed, with 1 of 1 citations checked.
- `pnpm probe:sandbox --plan` prints the thresholds per pattern. No live call has been made.

**Not run:** `verify:interrupt`. This machine has no dedicated test distribution to terminate. Its scripts only gained
the run's own WSL home and its removal; typecheck covers them. The second review's fix is in the offline Nebius client,
which nothing in the app or the engine's RPC uses yet, so the UI, Windows and `rpc.ts` checks above weren't run again
for it.

### Planning workspace, checkpoint 2 (D26, NIV-30 to NIV-32)

The window for checkpoint 1's workspace: a side navigation, conversations, plans and native tasks. Four commits on
`feature/planning-window`, then the live checks:

| Commit | What |
|---|---|
| `5cb164d` | The bridge: 18 calls for methods `Host` already had, a restart for a conversation's own engine, and size refusals in plain words |
| `04c5ab9` | The navigation and the conversation window |
| `14d1e17` | Plans saved from answers, and native tasks |
| `2cfc60f` | The window on the packaged Linux and Windows builds |

**The window, end to end** (`e2e/workspace.spec.ts`, the built app against the loopback stub, one profile through the
file, each test building on the last):

| Test | Shown |
|---|---|
| No key | A general turn fails before any request: "No Nebius key is set, so nothing was sent." The stub saw nothing |
| A general chat | Two answers. The follow-up's details showed 1 earlier exchange sent, as counts and a fingerprint, and the run's model, time and tokens |
| A repository chat | The project's consent asked first, with nothing sent; then an answer in its parts, 2 of 2 citations checked |
| Another project chosen elsewhere | The open conversation kept its scope, and its next turn read alpha's README, never beta's |
| Cancel | With the answer held, the turn ended "Cancelled. Nothing was resent."; Send again made a new, answered turn |
| A killed engine | The turn waited, unresolved; Restart; "Interrupted: … Nothing was resent."; Send again was answered; one request per turn |
| A relaunch | Every conversation kept; nothing sent on reopening; the repository chat went on with 2 earlier exchanges |
| Deletion | Asked first, saying what stays (each engine's run records, with the messages; briefs' copies) |
| A plan | Saved as shown first (answer, Proposed, Assumed); a task from v1; the plan's v2 shown on the task, whose brief stayed v1 until Update made v2 |
| A direct task | The same brief fields; ready refused without criteria; a stale view refused and read again; Ready, Completed, Reopen; Run disabled with its text |
| The plan's conversation deleted | The brief kept its text; moving the task to beta cleared what came from alpha, in v3, marked to write again |

**Checks (20 October)**
- `pnpm verify`: domain 36, engine 182, desktop 181. All passed.
- `test:e2e` (the built app): 32 passed. 1 was skipped, because it applies only to a packaged app. The workspace file
  passed three more times on its own.
- `test:packaged` (electron-builder `--dir`, Linux, runtimes staged afresh): 21 passed. 12 were skipped, because they
  need the test endpoint switch, which a packaged app ignores. The no-key turn, a relaunch, deletion and a direct
  task's states ran.
- `test:windows`, on the build from `pnpm dev:win --no-launch`: 10 of 10. The new check: with no key, a general turn
  refused on the native Windows engine before any request, the only engine started; a task marked ready; both kept
  across a relaunch. `~/.nivra` was unchanged.
- **Not run:** `verify:windows` and `verify:interrupt`: no target, supervisor or staging code changed. `rpc.ts`: the
  engine didn't change.

**Live, in the Windows development app (20 October, 11:15–11:20 UTC).** Nate approved both checks and their budget,
and Claude drove the app on Nate's development profile, so the key stayed in the app. Each turn had at most 16 model
calls; a general turn's answer, at most 4,000 output tokens. Fixture A's sharing was already on, from Nate's earlier
choice.

| Turn | Engine | Calls | Time | Tokens in / out | Shown |
|---|---|---|---|---|---|
| General: "How should I stage a refactor that splits a large settings page into smaller components?" | Windows, native | 1 | 13.2 s | 255 / 1,679 | Answered; 1 preference received (the personal one) |
| General: "What would you test first?" | Windows, native | 1 | 4.9 s | 1,775 / 564 | Answered; given 1 earlier exchange, 5,619 characters, the first answer (6,271) shortened to its start and end |
| Fixture A: "Plan a CSV export of a user's workout history: what exists today, and what would change?" | WSL, `~/.nivra-dev` | 14 | 133.9 s | 219,488 / 3,481 | Answered, at HEAD `29c3a40a`: 4 statements of what the code does now, 1 proposal, 2 assumptions; 7 of 7 citations shown to the model; 2 preferences received (the personal one and one of A's own) |
| Fixture A: "Which files would the first commit touch?" | WSL, `~/.nivra-dev` | 7 | 64.0 s | 53,862 / 2,019 | Answered; given 1 earlier exchange; 7 of 7 citations shown |

- **What the answer found.** A's export button writes only the rows on screen (`SessionTotalsPanel.tsx` 96–109), and
  recent history stops at 60 sessions (`history.ts` 341–347). The proposal was a full-history export. Its assumptions
  were that a query can return every session, and that building the CSV in the browser is fine at that size.
- **Then, with no model call:** a plan saved from the first answer, as answered, and a task made from it: a draft on
  valhalla-fitness, brief v1, citing plan v1 and its 7 checked lines, with Run disabled.
- **Never resent.** Read after the app had closed, each engine's store held exactly one run per turn, its request id
  the turn's id. The Windows store was read through a copy, with the app's own Windows Node; the WSL store, through a
  copy, once its engine had stopped. WSL's clock ran about a minute ahead of Windows', so runs are matched by id, not
  by time.
- **Against the budget.** Every turn kept to its calls (1, 1, 14 and 7), and the general answers to their output limit
  (1,679 and 564 tokens). The first repository turn's 219,488 input tokens are 2.8 times the heaviest explain run on A
  (77,514), which was quoted for scale: each of its 14 calls carried the reads and searches made so far. Nothing in a
  turn's limits bounds its total input today.
- **Corrected after the run.** The approval said the development profile had no confirmed personal preference. It has
  one, and the general turns received it, as designed. The count before the run had read the wrong field of
  `nivra.json`.
- **Seen, not changed:** the model answers in Markdown, and the window shows answers as plain text, so its markers
  show.

### Nebius Sandboxes, live (D28, NIV-29)

NIV-29's live probe, run on 20 October in stages Nate approved one at a time, each with its data and budget. A synthetic
fixture, no model calls and no installs. Eight commits on `feature/niv-29-live`, the last after review:

| Commit | What |
|---|---|
| `c7622dc` | Every wait and every read ends at its caller's deadline, and stage 1's 20 minutes are a hard limit (the retry-deadline follow-up) |
| `7918730` | `--credentials`: the key from a file only you can read, outside the repository. Stage 0 prints only what the proof needs |
| `51027d4` | A patch counts only when it holds the edit, and the report the passing test |
| `adc391d` | Stage 1 starts only on a token that outlasts it and its cleanup |
| `c3da9d4` | The token check takes two readings, and tells a token renewed with each request apart |
| `8334299` | Signal -1 is no signal, and every request gets whole milliseconds: the first run's two bugs |
| `3e8bd4e` | Each subprocess's signal and stderr, and a failed read's error, are kept: the second run's gaps |
| `d3a0c62` | The review of PR 5: an interruption stops everything under way at once, and a credentials file is judged by its real path |

**Stage 0 (04:22 UTC): two reads, `whoami` and `images`.**
- The key and the project were accepted.
- Permissions: `spawn`, `spawn_disposable`, `list`, `cancel`, `import` and `set_image_tag`.
- Limits: a 3,600 s maximum timeout and 50 instances at once, plus limits on importing images.
- The token's expiry: about 5 minutes after the request.
- 100 public images were listed, among them `alpine:3.20` and `busybox:latest`.

**Stage 1.** It used the image `alpine:3.20`. It denied `http://example.com/`, by name and as `http://104.20.23.154/`,
and its positive control was `http://example.com/`.

| Run | At | What happened |
|---|---|---|
| An attempt | 04:28 UTC, at `adc391d` | Refused before any operation: one reading put the token's expiry 5 minutes away |
| The first run | 04:34 UTC, at `c3da9d4` | Steps 1 to 6 ran, and every outcome was read as "signalled". Step 7's reads failed with a RangeError, so it stopped before its cancel, and steps 8 to 11 were refused before spawning. Cleanup cancelled 1 operation and saw it end `CANCELLED`, with nothing unresolved. Decision: inconclusive |
| The second run | 09:58 UTC, at `8334299` | All 11 steps ran, with no errors. Cleanup: nothing to cancel, nothing unresolved. Decision: adopt, on pattern A |

The first run's stored outcomes, read again with `8334299`'s fix, pass pattern A's network, continuation, exit, patch
and timeout checks. Its cancel and reattaching didn't run, so it stays inconclusive.

The second run, step by step:

| Step | For | Seconds | What the service reported |
|---|---|---|---|
| 1. Edit | A | 1.6 | `SUCCESS`, exit 0. Only `lo` |
| 2. Network denied | A | 5.3 | `SUCCESS`. It saw step 1's edit. Both attempts blocked: "bad address", and "Network unreachable" |
| 3. Network control | both | 0.7 | `SUCCESS`, exit 0: connected, with networking on |
| 4. Failing test | A | 1.6 | `SUCCESS`, exit 1: told apart as a failed command |
| 5. Patch | A | 1.6 | `SUCCESS`. The patch (105 bytes) and the report (19 bytes) matched their hashes and held the edit and the passing test |
| 6. Timeout | both | 5.2 | `SUCCESS`, exit -1, signal 9, `timed_out`: told apart as a timeout |
| 7. Cancel | A | 1.1 | `CANCELLED`, 0.4 s after the cancel |
| 8. Reconnect | both | 10.3 | A fresh client reattached to the same operation. One spawn |
| 9. Lost answer | recorded | 4.1 | Found by its correlation id. One spawn |
| 10. Parent | B | 4.2 | Seven subprocesses, about 0.4 s each. The network attempt ended with exit -1 after "CONTINUED". The patch and the report matched and held |
| 11. Parent cancel | B | 1.2 | The parent `CANCELLED`, 0.4 s after the cancel. The read of its running child failed |

| Check | Pattern A, one operation per step | Pattern B, a parent with subprocesses |
|---|---|---|
| Network denial, against a working control | Pass | Inconclusive: no attempt was seen refused |
| State continues | Pass, through the image | Pass, between subprocesses |
| A cancel reaches `CANCELLED` within 60 s | Pass, in 0.4 s | Inconclusive: the parent in 0.4 s, but its child wasn't seen to end |
| A failing exit code told apart | Pass | Pass |
| The patch and the report | Pass | Pass |
| Reattaching (for both) | Pass | Pass |
| A timeout told apart (for both) | Pass | Pass |
| The median step | 2.9 s: adopt | 0.4 s: adopt |
| **Outcome** | **Adopt** | **Inconclusive** |

The probe didn't keep the network attempt's signal or the child read's error. It does now (`3e8bd4e`), with a test that
reproduces both gaps on the fake service.

**Budget and cost**
- Operations: 7 in the first run and 11 in the second, one at a time, of at most 12.
- Uploads: 642 bytes of synthetic files in each run. Downloads: 124 bytes in the first run, and 248 in the second.
- The second run took about a minute, inside stage 1's 20 minutes.
- Cost: the service gave a cost for 9 of the second run's operations, from 0.0000465 to 0.0000828 each, 0.00059 in all.
  It doesn't say in what unit, so it isn't turned into money here.
- What stays on Nebius: six uploads of the three fixture files, the result images the steps left, and the operation
  records. Images are kept for 180 days, after which untagged ones may be deleted. No API deletes uploads or records.

**Evidence.** The folders under `~/nivra-acceptance/` (0700, each file 0600) hold the journals, results, verdicts and
reports, with the key and the project id replaced: `sandbox-probe-2026-10-20T042222871Z` (stage 0),
`…T043434287Z` (the first run, with `reevaluated-8334299.json`) and `…T095807550Z` (the second run). The attempt at
04:28 UTC left its folder empty.

**The review of PR 5** found two gaps in the probe, both reproduced and fixed in `d3a0c62`. Neither touches the
measurements above.

| Finding | Before | Now |
|---|---|---|
| 1. Ctrl+C during stage 1 | It moved the deadline, which every loop under way had already taken. The review saw requests go on 1 and 2 s after it, and the remaining fixture files still uploaded; cleanup waited for that to unwind | One signal reaches every request (`fetchTransport` joins it to the request's timeout), the reading of every answer, every retry's wait and every poll. Loops read their cap afresh. Uploads stop at the first one cut off. A spawn cut off on its way back stays uncertain, for cleanup to find and stop. Cleanup has its own signal (a second Ctrl+C) and its own budget, 7 minutes as a hard cap, and with none left it sends no cancel |
| 2. A credentials file inside the repository | `repo/..private/key.env` passed as outside, by its prefix, and so did a link from outside to a file inside | Both paths are compared as they really are, links followed, by whole components; the file read is the one checked |

The new tests, each failing on the code before the fix:
- an interruption during a GET, during a spawn's POST, during the uploads, and during a retry's wait;
- a cap that moves earlier mid-wait;
- cleanup's own budget;
- `fetchTransport` against a loopback server that never answers, and one that never finishes its body;
- `insideRepository` on temporary folders;
- through the script: a `..private` path, and a link to the README, refused as inside.

**Checks**
- `pnpm verify`: domain 36, engine 202, desktop 176. All passed (after review).
- `pnpm probe:sandbox --plan`: the same steps, data and limits as approved. Only the token check's line changed, in
  `c3da9d4`, which was approved too, and a line on Ctrl+C was added after review.
- **Not run:** `rpc.ts` and the UI checks. The client isn't wired into the engine or the app, and nothing else changed.
  The fixes weren't run live: they change how an interruption is handled, not what a run does.

### Answer reliability and safe diagnostics (D29, NIV-26, NIV-27)

Track A's first checkpoint (A0, NIV-22): two commits on `feature/niv-26-27-reliability`, from `dc48874`.

| Commit | What |
|---|---|
| `7ba8a07` | NIV-26: a missing `findings` costs one refusal at most, and an answer without findings is labelled, never shown as evidence; protocol 6 |
| `f780acc` | NIV-27: one safe diagnostic per failure, and only Nivra's own words leave the engine |

**NIV-26, each case through a real engine over stdio** (`apps/engine/test/explain.test.ts`, the loopback stub):

| Case | Shown |
|---|---|
| The original regression: forced, then three answers without findings, then one with them | 15 requests. The first answer was refused once, with the template; the next was taken and labelled `no-findings`. Answers 3 and 4 were never asked for. The conflict the answer reported was kept |
| The rehearsal's case: an answer with `findings: []`, then one with findings | `established` after one refusal, in 3 requests |
| No step left for another answer, after two answers refused for their shape | Taken at once, labelled `no-findings` |
| A blank summary every time | `malformed`, naming why ("3 turned down (3 for their shape)"), and no result stored. A padded summary is trimmed |
| Findings citing only lines the model wasn't shown | Labelled `unsupported`: "0 of 1 citations" |

- **The regression and the rehearsal's case both fail on the code before the fix.**
  - The first ends `malformed` after 16 steps, its three answers refused for their shape.
  - The second succeeds with no findings and no label.
- **What the refusals cost is recorded with the result:** the steps that gave the turned-down answers, their tokens as
  reported, and their time.

**NIV-27, through a real engine over stdio** (`apps/engine/test/diagnostics-stdio.test.ts`).
- **The header reproduction.** The key: about 4,000 characters, with a newline between two canaries.
  - `providers.check` answered "Something inside Nivra failed (TypeError)." with `{kind: "internal"}`.
  - An explain run failed as `internal`.
  - Neither made a request.
  - The log held exactly two diagnostic lines. Both named the stage (`models.list`); one gave the RPC id, the other
    the run, the request, the workflow and the step.
  - Neither half of the key was in the log, the answers, the run's records, or any file of the home.
  - Stdout carried JSON-RPC alone.
- **Private text that masking can't catch,** in two places:
  - git's stderr, from a fake git that exits 128;
  - the path of a git that can't start.

  Each run failed in Nivra's words ("git ls-files failed (exit 128). Run git status …", or the fixed refusal for a
  program that can't start). Each wrote one `git-failed` or `exec-refused` diagnostic. The private text was nowhere in
  the home, the log or the run's records.
- **Before the fix,** git's stderr went into the run's stored failure, and no diagnostic was written.
- **The unit tests** (`diagnostics.test.ts`) cover:
  - names, codes and causes that carry canaries;
  - a cycle, throwing getters, proxies, a 5 MB message, `AggregateError`, and values that aren't errors;
  - the line's checks and its cap;
  - spoofed kinds;
  - the RPC server, the scheduler, the step guard and the crash report.

**Checks (20 October)**
- `pnpm verify`: domain 38, engine 226, desktop 181. All passed.
- `test:e2e` (the built app): 33 passed. 1 was skipped, because it applies only to a packaged app.
  - The new check: an answer without findings is asked for them once, then shown labelled.
  - Its status reads "no findings", and its context reads "1 for having no findings".
- `pnpm stage:runtime all`: the new launcher's smoke test passed on linux-x64 (self-check, then initialize and shut
  down over stdio), and win-x64 was cross-staged.
- `test:packaged` (electron-builder `--dir`, Linux, runtimes staged afresh): 21 passed. 13 were skipped, because they
  need the test endpoint switch, which a packaged app ignores.
- `rpc.ts`: a real engine, on homes under `~/.nivra-dev-track-a`, against a scratch stub.
  - **The regression:** `no-findings` after one refusal; the refused step cost 20 in / 5 out tokens.
  - **The rehearsal's case:** `established`.
  - **`providers.check`, then an explain run, with the newline key:** two diagnostics, and the key nowhere in the
    output or the home.
  - **The fake git:** one `git-failed` diagnostic, and the private text nowhere.
- **Not run.**
  - `verify:windows` and `test:windows`: no target, supervisor or staging code changed. `verify:windows` runs once at
    A1, which contains A0.
  - No live model call: none is needed.

### Plan review runtime and run budgets (D30, NIV-38)

Track A's second checkpoint (A1, NIV-22): commits on `feature/niv-38-council`, stacked on A0.

| Commit | What |
|---|---|
| `b12d242` | The review contract, recorded before the runtime: packet, fingerprints, report, protocol 7 |
| `fee717a` | The shared run budget, for explain and repository chat |
| `046ef76` | The review workflow: two reviewers and a chair, or one reviewer |
| `bab22b2` | Each stage's message names the stage once |

**Through a real engine over stdio** (`apps/engine/test/review.test.ts`, the loopback stub playing each role):

| Case | Shown |
|---|---|
| A council review | 3 requests. Both reviewers read the same message, byte for byte, and neither saw the other's report; the chair saw both. The report is bound to the plan's id and version and both fingerprints. Findings got their ids, and each basis was read from its references: an unknown reference was dropped, and a finding resting only on an address was relabelled as an assumption. Agreements and dissent name their findings and reviewers. Usage and the budget record are kept |
| The single panel | 1 request, on the same message as the council's reviewers; no chair |
| No material issues | A review with a summary and no findings is complete |
| Unusable answers | A reply in text, an empty review, or a form refusal: the stage fails `malformed`, the chair isn't asked, 2 requests are made, and the other report is kept |
| The chair fails | Both reports kept; `run.failed` names the chair |
| A fast failure beside a slow success | The run waits for the slow reviewer and keeps its report: 2 requests |
| Cancel | No further request. The finished review is kept, and the report reads cancelled by the time the run ends |
| The engine killed mid-review | After a restart: interrupted. The finished review is kept; the request that was out "may have been sent"; nothing is sent again |
| Usage not reported | Totals null, with the estimate kept apart |
| Refusals before any request | A window too small for the chair at its largest, a packet over its limits, no key, no consent, no model |
| Bindings | A wrong fingerprint refused before any request; a request id reused for another version refused; the same request returns the same run |
| Isolation and masking | A general plan's review sent a project preference is refused. An override is said to be one. A key in the plan is never sent, and is masked in the report. Mastra's records never hold the plan |

- **In process** (`review-units.test.ts`, `run-budget.test.ts`):
  - **Normalisation:** ids, the first eight findings, references, the basis, clipping, masking, and an empty review
    told from a valid one.
  - **Prompts:** the role on each first line; preferences by scope and intent.
  - **Estimates:** the whole request, tool definitions included.
  - **Sizes:**
    - the largest realistic packet fits the request window and the council's budget, with about 31,900 tokens per
      reviewer and 45,500 for the chair;
    - absurd paths are refused before any request;
    - a worst-case report, in characters of three bytes each, stays well under the store's 256 KB.
  - **The run:** both reviewers in flight at once; the chair sent in its reserved room after reviewers reported far
    over their estimates; a late reviewer stopped at its deadline; nothing sent when the budget can't hold every
    request.
  - **The budget:** reservations all or nothing; underestimation recorded; missing usage; time held back for the
    chair; cancel and the deadline.
- **Explain and repository chat** (`explain.test.ts`, `chat.test.ts`):
  - with 30,000 tokens reported per request, the answer is forced at the 4th request (`run-budget`);
  - with 50,000 and a refused answer, the run ends `budget-exhausted` after 3 requests and sends nothing more.

**Checks (20 October)**
- `pnpm verify`: domain 43, engine 259, desktop 181. All passed.
- `test:e2e` (the built app): 33 passed. 1 was skipped, because it applies only to a packaged app. The context view
  now shows the run's budget.
- `pnpm stage:runtime all`: the protocol 7 runtime's smoke test passed on linux-x64, and win-x64 was cross-staged.
- `rpc.ts`, a real engine on homes under `~/.nivra-dev-track-a`, against a scratch stub:

| Run | Requests | Outcome |
|---|---|---|
| Council | 3 | complete; the same request id again returned the same run, with no new request |
| Single | 1 | complete |
| A reviewer answering in plain text | 2 | incomplete; "The risks review couldn't be used: it answered in plain text…" |
| A project's plan without consent | 0 | `sharing-refused` |
| A wrong fingerprint | 0 | refused before any request |
| A fast failure beside a slow success | 2 | incomplete; the slow review kept; usage unknown; the failed request counted at its estimate |

- **Not run yet:** `verify:windows`, which needs a turn on the shared Windows folders.

### Plan reviews in the window (D31, NIV-39)

Track A's third checkpoint (A2, NIV-22): commits on `feature/niv-39-review-ui`, stacked on A1. It is the release point
for the shared files Track B's NIV-44 waits on.

| Commit | What |
|---|---|
| `16da342` | Workspace v2: reviews as run links, bound and frozen |
| `33937c8` | The host: preview, start only as previewed, and keep a report only when it is bound to its review |
| `c90e14c` | The window: the dialog and the cards; the review e2e; seeded plans for the packaged and Windows checks |

**The workspace** (`workspace-store.test.ts`):
- **The migration.** A v1 file, made with v1's own schema and the store's functions, moves to v2 with every row and
  every v1 schema object as they were. v1's migration text is pinned by its hash.
- **The triggers refuse:**
  - a review on a turn's run;
  - a review of another conversation's plan, or of a version or fingerprint the plan isn't;
  - any change to what a review was bound to, and a second report;
  - a run link changing its workflow or its conversation.
- **One open run per conversation,** turns and reviews together. Every stop path sees the review; the conversation's
  turns, and so its history, don't.
- **Deletion:** deleting a conversation leaves none of a report's text in the file.

**The host, with real engines** (`host.test.ts`; the stub plays each role, and the gated fixture engine holds a start):

| Case | Shown |
|---|---|
| A general plan's review | The preview lists exactly the personal preferences that apply. Another project's own preference isn't sent, and neither is the conversation. 3 requests. The kept report's binding and fingerprints equal the preview's. The host's store and the plan are unchanged, and a task made from the plan is ready without a review. After an edit, v1's report stays byte-equal and says the plan is at v2; reviewing v2 makes a second review |
| The preview bound to the start | An edited preference, a deleted one, sharing turned off, and a fingerprint no preview gave: each refused, with nothing sent or stored, and the next preview shows the change. From a fresh preview, the review sends the project's own preferences as they are now, the README reference, and no path of the project's. Once the project is removed, preview and start are refused |
| A reviewer fails | Incomplete: the risks report kept, the chair skipped, 2 requests, nothing resent |
| Cancel while running | The conversation is held: a message is refused, and the preview says why. The cancelled report is kept; a message is then answered. 2 review requests in all |
| Stopped while being sent | Cancelled by the person, or by sharing turned off, as soon as the engine answers; its run cancelled once |
| A quit, or a killed engine | After a restart: interrupted, with what the engine saved and its stages marked; nothing sent again |
| A lost answer | Found by its request id and kept as complete; sent once |
| A report bound to something else | The review's end is unknown, and nothing of the report is kept |
| Deleted while running | The run stops. The workspace keeps no review, run link or plan, and none of the plan's text |
| Credentials | A version holding the saved key is refused before anything is stored. A key a reviewer echoed is masked, and no file under the profile or the engine home holds it |

- **In process** (`reviews.test.ts`):
  - **The packet:** the scope and commit; each reference once, in order; none for a general plan; assumptions and
    paths masked.
  - **Refusals:** too long, the saved key, a token, over a limit, each in words that say what to do.
  - **The preview's fingerprint** moves with each part it binds, and only with them.
  - **The report check** refuses each field of the binding that differs.
  - **The notes** say how a review ended, and that nothing was resent.
- **The window** (`e2e/review.spec.ts`, the built app against the stub, 10 tests):
  - **No key:** a seeded plan's preview (the version, the scope, the counts, what isn't sent, the cost), then
    "Failed" before any request, saying what to do;
  - **A general plan:** "Complete" with three stages, findings "From the plan", the synthesis's "Agreement isn't proof",
    the line saying a review approves nothing, and usage with the run budget. The plan and the preference were sent,
    and the conversation wasn't;
  - **A stale preview:** refused, the new preference shown, nothing sent;
  - **A failed reviewer:** "Incomplete", with its stages; Review again ends "Complete";
  - **Cancel:** the composer and Review… held, then "Cancelled"; the next message is answered, with no further review
    request;
  - **A killed engine:** unresolved, then "Interrupted" after Restart; nothing resent;
  - **A project's plan:** consent asked in the dialog; the reference shown as "E1 · README.md:1 · historical", its
    finding an assumption; no path of the project's sent;
  - **An edit to v2:** every card says the plan moved on, and the dialog offers v1 and v2;
  - **A relaunch:** every review read back equal; nothing sent;
  - **Deletion:** the dialog says the reviews go and what each engine keeps; they go.

**Checks (21 October)**
- `pnpm verify`: domain 43, engine 259, desktop 199. All passed.
- `test:e2e` (the built app): 43 passed. 1 was skipped, because it applies only to a packaged app.
- `test:packaged`: 24 passed. The 20 skipped need the test endpoint switch, which a packaged app ignores. The review
  checks that apply there ran: a seeded plan's review with no key, a relaunch and a deletion.
- `rpc.ts`: not run again, because the engine didn't change.
- **Not run yet:** `test:windows`, with its new check of a plan seeded by the staged `node.exe`. It needs a turn on the
  shared Windows folders, after `pnpm dev:win --no-launch`.

### Council evaluation (D32, NIV-40)

Track A's fourth checkpoint (A3, NIV-22): commits on `feature/niv-40-council-eval`, stacked on A2. It is evidence from
five short synthetic plans, one run per arm, not a general claim about councils.

| Commit | What |
|---|---|
| `66a85ed` | The evaluator, offline: five frozen plans, the rubric, the protocol, scoring and the batch |
| `1210c54` | How to run it |
| `6fe7fe4` | From Nate's review: model, route and sampling checked before any inference request; every wait bounded |
| `be14fc8` | Nate labels the sheet, as chosen at the freeze |
| `f8d440e`, `196cad1` | The docs and the request for approval's wording |

**Offline** (`apps/engine/test/council-eval.test.ts`, 16 tests, a real engine against the stub):
- **The frozen inputs:**
  - the five plans pass the packet's own schema;
  - both arms get the same packet, with no preferences, no path and no repository;
  - the protocol's limits are the engine's;
  - the approval digest is pinned.
- **The rubric:** every known defect matches its positive examples and none of its negatives, and nothing matches
  the control's.
- **The scoring:**
  - each known defect counts once per fixture and arm, however many findings name it;
  - novelty is judged only where no known defect is named;
  - the control's correct outcome is a substantive "no material issues", told apart from an incomplete review;
  - every edge of the decision rule is tested.
- **The batch:**
  - exactly 20 requests in the protocol's order;
  - a reviewer's 500 kept and never retaken;
  - a batch killed mid-review resumed by request id, with nothing sent again;
  - the deadline and the 60-minute cap held.
- **Before any inference request:** another model, another sampling or another endpoint each stops the batch with
  not one inference request.
- **A run that keeps running after it is cancelled:** kept as unresolved within its bound, the batch stopped, and it
  is never sent again on resume.

**The paid batch** (approved on 21 October: digest `c3b9225a9c41e4c9cde2a90c029682796886817f463e7e5286eab23082fc6683`,
revision `196cad1`, a committed tree).
- **When and where:** 20:28:37 to 20:30:25 UTC, in
  `~/nivra-acceptance/council-eval-20261020T202836Z-196cad1/` (0700). The key came from a file outside the repository
  (0600).
- **The outcome:** every check before an inference request passed. No stop rule fired, and nothing was retried or
  retaken.

| Fixture | Arm | Run | End | Requests | Time | Tokens in / out |
|---|---|---|---|---|---|---|
| F1 | single | `16a748c5-4f9f-4146-b650-70d85fab316f` | succeeded, complete | 1 | 6.0 s | 1,405 / 647 |
| F1 | council | `df1a6af7-063c-416a-b012-ef96ccaffba0` | succeeded, complete | 3 | 16.1 s | 5,160 / 1,979 |
| F2 | council | `d8635dc5-e495-4aca-adbe-2c19b3df0c86` | succeeded, complete | 3 | 16.3 s | 5,360 / 2,268 |
| F2 | single | `2ad6eb27-8022-4ceb-acee-49c5e5274405` | succeeded, complete | 1 | 8.6 s | 1,504 / 772 |
| F3 | single | `fe7b2f8b-5132-465e-a49b-813d4bd7575a` | succeeded, complete | 1 | 6.5 s | 1,369 / 749 |
| F3 | council | `2686320e-ea94-4fa5-ae42-afe89e9887ba` | succeeded, complete | 3 | 12.1 s | 4,954 / 1,946 |
| F4 | council | `617184bd-9a4d-46dc-99c9-5fa210980ad7` | succeeded, complete | 3 | 12.6 s | 4,903 / 2,039 |
| F4 | single | `52a48f69-70cd-499b-aa83-1201ab759d85` | succeeded, complete | 1 | 9.0 s | 1,383 / 673 |
| F5 | single | `333b24c9-df75-4325-bc43-24a425f41440` | succeeded, complete | 1 | 2.0 s | 1,427 / 188 |
| F5 | council | `52244ab8-0927-42ef-94dc-6450ed3a55b7` | succeeded, complete | 3 | 4.6 s | 4,306 / 489 |

**The labels, v1.**
- **Who:** proposed with AI assistance, then reviewed and approved by Nate as v1.
- **What was copied:** each of the 55 rows was checked against the sheet the batch wrote (item, order, finding and
  every other field outside the label). Only the seven label fields were copied.
- **When:** v1 was frozen, read-only, and its hash recorded (`labels.v1.json`) before scoring rebuilt the arm mapping,
  which was never written down. The script that checked and froze it is kept beside it, as `freeze-labels.ts`.
- **Hashes:**
  - the sheet the batch wrote (`sheet.original.json`): `479d7f3f57e60731095c55c72eca6711f5968327193404852c788bea2aeaeb8a`;
  - v1 (`sheet.v1.json`, the same bytes as the approved file): `a899ab9a8a4b6387b6c2de2bc87ba1f40d8d318be128ebca4434b633ee025c95`;
  - the scores (`scores.v1.json`): `f945c5e2d040c6e26f884a8496a1a9b1df73b2cec90c21a0b7564894954062d9`;
  - the decision (`decision.v1.md`): `c72c3bbe6a3fe1e6650dd8a077a4cb5f3d680cd028fc4cf51553925be2cdb5f1`.
- **A later correction** keeps v1 and makes a v2 the same way, with its own hashes and whether the decision changed.

**Scores** (`pnpm council:eval --score`, offline, from v1):

| | Single reviewer | Council |
|---|---|---|
| Known defects found, of 12 on F1–F4 | 9 (F1 1, F2 2, F3 3, F4 3) | 11 (F1 3, F2 2, F3 3, F4 3) |
| Useful novel findings, distinct | 8 | 9 |
| Unsupported findings | 0 | 1 (U1, the architecture reviewer on F3) |
| False alarms on the control | 0 | 0 |
| The control reviewed as sound, substantively | yes | yes |
| Complete runs | 5 of 5 | 5 of 5 |
| Findings raised | 17, each a distinct known defect or useful point | 35 (architecture 14, risks 21), of which 15 repeat another |
| Actionable findings | 17 of 17 | 35 of 35 |
| Median latency ratio | | 1.90 |
| Median token ratio | | 3.35 |

- **The decision, by the frozen rule: adopt.** Every adopt rule held, and no defer rule did.
- **Three adopt rules held exactly at their edge:**
  - known defects, 2 above (adopt needs 2);
  - known defects plus useful novel findings, 3 above (needs 3);
  - unsupported findings, 1 above (allows 1).

  The whole known-defect margin comes from F1.
- **The automatic pass alone** credits the single reviewer with F2's provider-timeout defect: 10 against the
  council's 11.
- **The limitations** are D32's: one run per arm, the labels' provenance, actionability that didn't discriminate,
  authoring by the council's builder, and an unscored chair.

### The review of PR 10: five fixes and two follow-ups (Track A)

Nate's review of PR 10 (21 October) held the merge on five P2 findings and two smaller follow-ups. Each fix has a
regression test, and each test failed with its fix taken out. The reproductions use offline stubs; no paid call ran. The review didn't establish that the v1 result is wrong, and scoring v1 again under
the fixed scorer gives the same bytes (below).

| Finding | The fix | Its regression test: with the fix, and without it |
|---|---|---|
| 1. A refused budget reservation didn't stop the next model request (`explain/reading.ts`) | The next request's room is held where the loop decides to go on, and admitted just before the request is sent. A refusal at either point sends nothing. A request is held for its step's time or what is left, whichever is less, so D22's deadlines still decide time. A refused admission ends the call through Mastra's tripwire, before the request, and prints nothing | `run-budget.test.ts`. The review's case, 60 s and 50,000 tokens a request in a 200 s run: 4 sent, and the budget records 4 requests and 200,000 tokens (without the fix: 1 and 50,000). An admission refused after its hold: 1 sent and 1 recorded (without: 16 sent) |
| 2. Trimming the chair's answer could hide unaddressed findings (`review/answers.ts`) | `unaddressed` is worked out from what is kept | `review-units.test.ts`: findings named only in a ninth agreement, a fourth position or a seventh dissent entry are listed (without: only the one named nowhere) |
| 3. A restarted evaluator could pass a stop condition (`council-eval/batch.ts`) | A resumed batch checks the protocol's stops again on every run its journal kept | `council-eval.test.ts`: an authentication failure whose stop was lost. Resumed, the batch sends nothing more and writes the stop again (without: it went on) |
| 4. Invalid labels inflated the scores (`council-eval/score.ts`) | A label must have its seven fields, each null or an allowed value. A finding names only its own plan's known defects, each once, and a field that doesn't apply stays null. `--score` names each problem and scores nothing, and `scoreBatch` refuses such a sheet | A misspelled defect, another plan's defect, two wrong values and a summary's defects: 5 problems. The command refuses a misspelled defect (without: no problem was found, and the command scored the sheet) |
| 5. Scoring didn't enforce the frozen approval digest (`council-eval.ts`) | `--score` refuses a batch run under another digest, as `--resume` does | A protocol with one threshold changed: refused, and `scores.json` unchanged (without: rescored) |
| Follow-up: the 60-minute cap left some waits out | The cap counts every wait from the engine's start: the engine's start, its doctor, and for each run the model listing, its start, its windows and reading its record. A run is started only if all of these, each at its limit, could end within the 60 minutes, and every wait is cut to the time left. Only stopping the engine comes after, in at most 15 s | A run whose windows alone would fit, but not with the waits around it, isn't started (without: it started, and sent 4 requests) |
| Follow-up: this record named four PRs | One PR, 10, carries A0 to A3 | (docs) |

- **What changes beside the fixes:**
  - **A run whose time is gone** between two requests now ends as a timeout. It used to end as one without an answer.
  - **The input-budget failure** gives the real figures. It used to say "needed about 0 tokens, and about 0 were left".
  - **The request for approval's worst case:** with every run and every wait at its limit, a batch would need 74.0
    minutes, so it would stop before its last runs. It used to say 52.5 minutes, windows only. The paid batch's runs
    took 1.6 minutes.
  - **The evaluator stops an engine that fails to initialize,** rather than leaving it running.
- **v1 stands.** The fixed `--score` ran on a copy of the evidence (the journal, the runs and the v1 sheet). Its
  `scores.json` (`f945c5e2…62d9`) and `decision.md` (`c72c3bbe…b5f1`) are the same bytes as `scores.v1.json` and
  `decision.v1.md`. v1's labels pass the new checks with no problem: they are the checks `freeze-labels.ts` made
  before v1 was frozen. Nothing in the evidence folder was written.
- **Not covered by a test:** that no wait goes past the cap. The pre-run reserve is tested; the cut to the time left
  is checked by reading the code, because testing it would need a slow engine and an hour-long clock.

**Checks (21 October)**
- `pnpm verify`: domain 43, engine 282, desktop 199. All passed.
- `rpc.ts`, a real engine on homes under `~/.nivra-dev-track-a`, against a scratch stub:

| Run | Requests | Outcome |
|---|---|---|
| Explain | 3 | succeeded; the run's budget records 3 requests and 3,000 tokens, as reported |
| Explain, 50,000 tokens reported a request, with a refused answer | 3 | `budget-exhausted`: "the next model call needed about 50,052 tokens, and about 9,868 were left" |
| Council review, the chair naming one finding only in a ninth agreement | 3 | complete; 8 agreements kept, 1 dropped; that finding and one named nowhere are unaddressed |

- `pnpm stage:runtime all`: the linux-x64 runtime's smoke test passed (self-check, then `initialize` and shutdown
  over stdio), and win-x64 was cross-staged.
- **The Windows turn.** First, a read-only look found no Nivra process on Windows and nothing of Track B's running.
  - `pnpm verify:windows` (A1's check, on the runtimes just staged): 22 of 22 passed on Windows. That covers the native
    and WSL engines, the Visual C++ runtime shipped beside the addon, cancel, stop, a kill and Restart, and an engine
    dying with its parent. `~/.nivra` was unchanged, and the run's own WSL home was removed.
  - `pnpm dev:win --no-launch`, then `test:windows` (A2's check): 11 of 11 passed. Among them, a seeded plan's review
    on Windows shows what it would send, is refused on the native engine before any request with no key, and is kept
    across a relaunch.
- `test:e2e`, the built app: 43 passed and 1 skipped, the one that applies only to a packaged app. The explain runs
  against the stub are among those passed.
- **Not rerun:** `test:packaged`, since no packaging, main-process or preload code changed.

### Track A completion record (NIV-22)

Prepared 21 October 2026, at `196cad1` with this record's docs commit, and brought up to date after the review of PR 10
(above). **The parent stays open:** item 8 isn't met yet (below).

| NIV-22 acceptance item | Evidence | Where it stands |
|---|---|---|
| 1. Two reviewers, the same frozen packet, neither seeing the other's report; the two roles | A1: `review.test.ts` (byte-identical messages, each blind to the other). Live: five council runs, all complete | Evidenced |
| 2. A chair keeps finding ids, evidence, assumptions and dissent; agreement is no proof; a missing reviewer gives an incomplete review, never approval | A1: dissent, a failed chair, a fast failure beside a slow success, unusable answers. A2: the cards' "Agreement isn't proof" and "Incomplete" (`review.spec.ts`). The review of PR 10: a finding named only in a part dropped for the limits is unaddressed | Evidenced |
| 3. ModelClient reused; scoped context; aggregate limits and cancellation; at most three calls; no hidden retries | A1: `run-budget.test.ts`, `review-units.test.ts`, `review.test.ts` (cancel, deadline, no resend); real-engine council: 3 requests. Live: 20 requests for 10 runs | Evidenced |
| 4. A shared budget guard for explain and repository chat; estimates apart from reported usage; unknown stays null | A1: explain and chat over stdio (`run-budget`, `budget-exhausted`); the context view's run budget. The review of PR 10: a request goes only with its room held and admitted, so the budget records every request sent | Evidenced |
| 5. A report saved in its conversation, bound to the plan version and context; a revision makes a new review; nothing replayed; evidence never overwritten | A2: workspace v2's triggers; host tests (a stale version's report byte-equal, a quit and a kill interrupted, the lost answer, a mismatched binding kept nowhere); `review.spec.ts` (relaunch) | Evidenced |
| 6. Five synthetic plans with a sound control, against the same-input single reviewer, frozen before live calls | A3: *Council evaluation* above; D32. The review of PR 10: labels validated, scoring only under the batch's digest, and v1 scored again with the same bytes | Evidenced: adopt, at its edge |
| 7. Reports inform a person; they never change readiness, memory, patches or external tickets | A2: a task is ready without a review; the store and the plan unchanged by a review; the cards' copy | Evidenced |
| 8. Every child and the original requirements have reviewable evidence before the parent is ready for review | Each checkpoint's section above | Not yet: see what is missing |

**Platform matrix, as run:**

| Check | A0 | A1 | A2 | A3 | The review's fixes |
|---|---|---|---|---|---|
| `pnpm verify` | passed (domain 38, engine 226, desktop 181) | passed (43, 259, 181) | passed (43, 259, 199) | passed at `196cad1` (43, 275, 199) | passed (43, 282, 199) |
| `test:e2e`, the built app | 33 passed, 1 skipped (packaged only) | 33 passed, 1 skipped | 43 passed, 1 skipped | not affected | 43 passed, 1 skipped |
| `test:packaged`, Linux | 21 passed, 13 skipped (the test endpoint) | not required | 24 passed, 20 skipped (the test endpoint) | not affected | not affected |
| Real engine | `rpc.ts`: the regression, the key and plain-text canaries | `rpc.ts`: council, single, refusals, a fast failure | the engine didn't change | the paid batch | `rpc.ts`: explain, an input budget used up, the chair's ninth agreement |
| `pnpm stage:runtime all` | passed | passed (protocol 7) | not rerun: the engine didn't change | not affected | passed |
| `verify:windows` | not required | run later, with the fixes | n/a | n/a | 22 of 22 passed |
| `test:windows` | n/a | n/a | run later, with the fixes | n/a | 11 of 11 passed |

**What is missing before the parent is ready for review:**
- **PR 10's merge.** One PR carries all four checkpoints, A0 to A3. It was pushed and reviewed, and the review's findings
  are fixed (above). Nate merges it, and NIV-26, NIV-27, NIV-38, NIV-39 and NIV-40 are accepted with it.
- **Track B's handoff:** after NIV-39 merges, the shared-file handoff for NIV-44.

**Limitations the parent carries:**
- **D29:** the engine's text before `initialize` (startup `engine.fatal`, the supervisor's log tail), and Mastra's own
  validation errors about id-only step data.
- **D30:** input budgets are estimates, never ceilings. Two concurrent requests on a low-tier key can draw a 429,
  which leaves the review incomplete.
- **D31:** older builds refuse a v2 profile.
- **D32:** its limitations, above.
- **A follow-up, NIV-46:** the engine creates Mastra's database files readable by others (0644). `nivra.db` is 0600.
  The development home is 0755, so other local users can read `~/.nivra-dev/mastra.db*`.

### Nebius execution session, B1 (D33, NIV-41)

Track B's first checkpoint, offline: D28's pattern A behind the execution contract, with every request inside its
deadline. On `feature/niv-41`, from `dc48874`:

| Commit | What |
|---|---|
| `c9c6755` | Every request, POST and DELETE included, ends by its caller's deadline, and no late answer is taken |
| `1e065e3` | The execution contract, extended for sessions that run elsewhere; `Local` refuses what coding work needs |
| `fc82fa1` | The Nebius execution session: one operation per step, with the state moving only on what was kept |
| `0505da3` | The review of the first draft: closing's budget, torn journal tails, the scan's limit, image counts, a late answer, a listener |
| `5597249` | The review of PR 7: closing's deadline cuts off a cancel already under way |
| `fa6ce29` | An independent check of that fix: a stop closing cut off promises no retry, and closing's timer keeps the process alive until it fires |

**The P3, before and after.** These three cases were run against the code at `dc48874`, in a throwaway script that was
then deleted:

| Case | At `dc48874` | Now |
|---|---|---|
| The cap 1 ms away | The spawn's POST and the cancel's DELETE were sent with `timeoutMs` 30000 | Nothing is sent, and `SandboxNotSentError` says so; the cancel is journaled unresolved |
| An answer 3 s after a 2.5 s deadline | Taken: `SUCCESS` | A deadline error; a late spawn answer is only stopped |
| A journal whose last line a crash cut short | Unreadable (`SyntaxError`), so cleanup couldn't run | The torn line is left out, and its spawn stays uncertain |

**What the tests show**, all offline, with the fake service or a loopback server:

| Area | Tests | What they cover |
|---|---|---|
| Deadlines (`nebius-sandbox.test.ts`) | 8 new, besides the 44 the probe had | A POST or DELETE with 1 ms or 1,999 ms left isn't sent; writes get the time left, not 30 s; late answers; an over-cap answer isn't asked for again; a 250 ms minimum between retries; a spawn refused before sending is journaled as not sent; the probe's uploads keep to its deadline; a torn journal (cut off before the next entry) and a damaged one; a redirect answering a spawn is uncertain |
| The real transport (`nebius-transport.test.ts`) | 6 | A GET and a POST with no headers, and a body that stops partway, end at their 300 ms deadline; an answer over its cap is refused by its declared length, or cut off as it streams; nothing is sent with under 1 ms left; a spawn whose POST reached the server but got no answer is uncertain, never "not sent" |
| The contract (`session-contract.ts`) | 6 for each backend | Output and exit code without a shell; a time limit; a cancel; the output cap; a missing program never a success; a second close gives the same report |
| `Local` | 11 of its own | Process trees and background groups; input and byte output; its budget and signal; a close kept to its budget; it refuses isolation, a snapshot and a command thrown away |
| The session (`nebius-session.test.ts`) | 37, besides the contract | See below, and the reviews' findings after it |

The session's tests:
- **What it claims and sends.** Every operation has networking off. Only the prepare step carries the snapshot.
  Environments hold only the command's own variables and the correlation id. Nothing sent holds the key, the project
  id or a host path, and the upload is the snapshot's bytes exactly.
- **Refusals, with nothing sent.**
  - Sessions: the network not denied; no snapshot, an oversized one, or one with the wrong hash; a bad workspace; a
    cancelled run; no credentials.
  - Commands: a relative program; a folder outside the workspace; Nivra's own variable or a bad name in the
    environment; the key or project id; input or byte output; an over-long timeout; one that doesn't fit the time left;
    a second command while one runs; more operations than a session may start.
- **The state.**
  - Each persisted command's image carries on, and a disposable one leaves the state alone.
  - A failing exit code is a result, not an error.
  - A persisted command with no usable image, with an image id that isn't one, that timed out, or that a signal ended
    leaves the session stale. The next command and any download are then refused, and nothing ran on the older image.
  - An expired image means the state is lost, with no second upload and no restart from the base image.
  - Output cut by the service, or by the command's cap, is reported.
  - A download is bounded, and a missing file is "not found".
- **Lost and late answers.**
  - A lost spawn answer is found and followed, with one spawn.
  - One that can't be found is never sent again; nothing more runs, and closing looks once more.
  - A spawn answered after the deadline is only stopped.
  - A `Retry-After` past the deadline gives the command up for closing to stop.
- **Closing.**
  - One budget includes stopping the command under way.
  - Its deadline cuts off a request still under way, a cancel sent before closing began included, with no signal
    needed. The operation stays journaled, and the next pass stops it.
  - A second close gives the same report and sends nothing.
  - "Stopped" is told from "had already ended".
  - An operation that never stops is reported unresolved, within the budget.
  - Retention is counted from the journal.
  - Closing never rejects, even when every request fails.
- **An open that fails after something was sent closes itself.** That covers a hash that doesn't match, a listing that
  differs, a failed prepare, and an upload cut off (counted as possibly stored).
- **Recovery.**
  - The scan uses no network.
  - One pass settles what an earlier engine left. A pass that runs out of budget, or that a shutdown stops partway,
    leaves the rest for the next.
  - An operation still queued ten hours after its 60 s timeout stays unresolved, and is stopped once the service lists
    it again.
  - A damaged journal is reported.
- **The prepare script,** run with this machine's `sh` and GNU `tar`, prints the digest `listingDigest` computes for the
  same files. They include:
  - a link and an executable;
  - a UTF-8 name, a space and an empty file;
  - names whose `LC_ALL=C` order differs from a locale's (`B.txt`, `a-b`, `a_b`).

**The independent review of the first draft (`fc82fa1`)** found six gaps. Each was reproduced against that commit
with the reviewer's scripts, and fixed in `0505da3` with a regression test. The same scripts were run again after the
fix:

| Finding | At `fc82fa1` | Now |
|---|---|---|
| 1. A stop the person's cancel began before closing | `close({budgetMs: 5000})`, its signal aborted at once, took 60,000 ms | The stop reads closing's deadline afresh and closing's signal stops it: 0 ms |
| 2. A journal whose last line a crash cut short | The next entry was written straight after the fragment, so the journal scanned as damaged for good, and the recovery pass rejected, leaving the other journal untouched | The next entry cuts the fragment off first; each journal's pass is caught on its own |
| 3. 500 settled journals sorting before one with open work | The scan found none | The scan filters first, and a session that closes with nothing open moves its journal into `settled/` |
| 4. An image first seen by closing | 2 images kept, 1 counted | 2 counted |
| 5. A command whose answer came as its run was cancelled | Reported "not started" while it ran; the next command was refused as "may have reached the sandbox" | `ExecUncertainError`, the session unsettled, and closing stops it |
| 6. A long-lived run signal | 12 listeners left after 12 sessions | 0 |

The review also led to these changes:
- a redirect answering a spawn is uncertain;
- a throwing `onStart` is given back only once its command has settled;
- signal numbers are read as Linux's on every platform;
- `Local`'s close keeps to a budget;
- a cancellation before the prepare step says why.

It found no defect in the prepare script or in `listingDigest`'s order.

**The review of PR 7 (21 October)** found one more gap in closing. It was reproduced offline, and fixed in `5597249`
with a regression test, which fails on the code before the fix:

| Finding | At `b423e90` | Now |
|---|---|---|
| A stop's cancel request sent before closing began, its connection still waiting | It kept the time it was given when sent, up to 30 s. In the review's reproduction, `close({budgetMs: 50})` took 424 ms; with the connection held open, closing was still waiting after 5 s | Closing's deadline cuts it off, as its signal does. The operation is reported unresolved and stays journaled, and the next pass stops it |

An independent check of the fix found no defect in it. With no signal and a 50 ms budget, closing ended in 53–56 ms with a cancel, an operation read or a cleanup search held, and with a poll wait under way; budgets of 0 and −10 ended at once. It found two smaller things, fixed in `fa6ce29`:
- once closing had cut a stop off, the command's error still said closing would try again, which it then can't. It now says the operation stays journaled for the next recovery pass;
- the timer was unref'd, so with nothing else waiting the process could end with closing pending. It now keeps the process alive until it fires.

**Checks**
- `pnpm verify`: 483 passed (domain 36, engine 266, desktop 181), none skipped. The baseline at `dc48874` was 419.
- After main was merged in (`b423e90`) and the review of PR 7's fix (`5597249`, then `fa6ce29`): `pnpm verify` 589 passed (domain 43, engine 347, desktop 199), none
  skipped. A real engine answered `doctor` and ran `hello` again.
- `pnpm probe:sandbox --plan` prints the same steps and limits. Its deadline line now says that every request, POST and
  DELETE too, ends by the 20 minutes.
- A real engine through `rpc.ts`, on its own home `~/.nivra-dev-track-b`, before the review's fixes and again after
  them:
  - `doctor` answered;
  - a `hello` run succeeded, every step through `Local`'s session included.
- **Not run:**
  - the Windows and packaged checks: no target, supervisor, staging, main or preload code changed;
  - any live Nebius call: B1 needs none. B3's approved recipe is the first.

**Limits**
- **Not wired into the engine or the app.** No run uses the session yet (B4).
- **Not shown live yet** (B3's run will show them):
  - that busybox runs the prepare script as this machine's tools do;
  - the service's answer for an expired image (404 or 410 is assumed);
  - the upload API's size limit (the cap is 8 MiB).
- **Usage** is kept raw, and null when absent. No cost is turned into money.

### Commit snapshots and validated patches, B2 (D34, NIV-42)

Track B's second checkpoint, offline: one commit's own bytes into a sandbox, and a checked patch out, bound to where it
may go by one hash. On `feature/niv-42`, stacked on B1 (`a53fd36`):

| Commit | What |
|---|---|
| `07a6972` | One tar format both ways, written exactly and read back strictly |
| `0eaaa4c` | Commit snapshots from the commit's own objects, refusing uncommitted work and unsafe content |
| `f027403` | Validated patches from a sandbox's result, bound to their destination by one hash |
| `3957da5` | The review of the first draft: clashes with left-out files, split indexes and hidden edits, exact names, deep paths, the bound policy, refusal codes |
| `b6be5b7` | The report gives each step's provider status and usage, raw and null when none |
| `4ec832f` | The review of PR 8: a vault value inside base64 refuses the snapshot and the patch |
| `b167766` | An independent check of that fix: broken encodings joined up, one layer down read too, and a URL-safe case that tests URL-safe |
| `eb76f9c` | The second review of PR 8: an encoding's breaks taken out in one pass, so a file of spaces can't freeze the engine |

**Nate's three asks of the plan, shown.**

| Ask | Test | What it shows |
|---|---|---|
| Every file's content scanned before upload; an unsafe snapshot refused, never redacted; a secret that isn't in the vault | `snapshot.test.ts`, "refuses a commit holding a private key, a token Nivra was never given, or a value from its vault…" | One refusal names three files and their kinds: `src/config.ts` (a private-key block and a GitHub-shaped token), `assets/blob.bin` (an AWS-shaped key between NUL bytes) and `notes.md` (a vault value). No archive is made, and the refusal quotes none of the values. Without the vault's values, the key and the token alone still refuse it. Since the review of PR 8, a vault value with no shape of its own, base64-encoded in a `deployment.yaml`, refuses it too |
| The deny rules again on returned changes | `patch.test.ts`, "refuses secrets by name and by content…" | A new `.env` holding `HELLO=world`, and a new `config/credentials.json` holding `{}`, are refused by name |
| A subfolder of a larger repository, round trip | `patch.test.ts`, "takes only the picked folder of a larger repository…" | Only `apps/web`'s two files are archived. All three of the patch's headers are under `apps/web/`. `git apply --check` and `git apply` pass from the top level of a fresh clone, which then differs in exactly those three paths. The top level's `.gitattributes` holds for the folder's files |

**The dirty check runs nothing a repository configures.** The repository in the test sets marker scripts for clean,
smudge, process, textconv, an external diff, fsmonitor, hooks, a pager and gpg. The check then runs on a touched
file, a racily clean file (the index older than the files) and an edited one, and the edited one is refused. No marker
ran, and the checkout, `.git` included, kept every name, mode, size, time and byte. A plain `git status` on the same
repository ran fsmonitor, clean and process.

**The first draft wrote to the person's `.git`, and a test caught it before it was committed.** Its patch store read the
repository's objects through `objects/info/alternates`:

| Case | First draft | Now |
|---|---|---|
| A mode change (`run.sh`, 100644 to 100755) | `apply --cached` wrote `run.sh`'s blob again, and git refreshed the time of the copy it found in the repository, `.git/objects/85/ba14…` | The store holds nothing of the repository, which is only read: every name, mode, size, time and byte is unchanged |

**What the tests show**, all offline, against real repositories made in the temp folder:

| Area | Tests | What they cover |
|---|---|---|
| The tar format (`tar.test.ts`) | 6 | Our archives, extracted by GNU tar; GNU tar's gnu and ustar archives read back, and its posix (pax) header refused by name; an archive laid out as busybox writes one; a set of malformed headers, in either order; a deep archive read in time linear in its paths |
| Path rules (`workspace-rules.test.ts`) | 3 | A commit's paths that can't be written anywhere; what a new path must also satisfy; git's own files; byte order; case and Unicode folding |
| Snapshots (`snapshot.test.ts`) | 22 | See below |
| Patches (`patch.test.ts`) | 18 | See below |
| Proposals (`proposal.test.ts`) | 6 | Canonical JSON; every binding field changes the hash; the policy taken from the patch, and other rules refused; deletions first in the report, with no file content and bounded output; each step's provider status and usage, null when none; the verifier |

The snapshot's tests:
- **Exact bytes from the commit, never the working tree.** CRLF and a file with no final newline are kept, and so is
  a file whose working copy git converted to CRLF. Binaries, executables, links, a UTF-8 name and a path over 100 bytes
  are covered. The archive, extracted by the real prepare script, lists to the snapshot's digest.
- **Left out and counted:** secret-named files, output, a submodule, and the engine home inside the repository. A
  folder inside the engine home is refused, and so is a home that holds the repository. Picking `.ssh` makes nothing
  sendable.
- **Refused:**
  - tracked changes, staged, unstaged or deleted, with untracked and ignored files left out;
  - a real partial clone (`--filter=blob:none`);
  - a repository with no commits, and a baseline that isn't HEAD;
  - over each limit;
  - crafted `GIT~1` and newline paths, with the index and the working tree following the crafted commit;
  - a git older than 2.18;
  - after the review: a split index, before git reads it; assume-unchanged and skip-worktree files; a newline in the
    picked folder's path; a committed path that isn't UTF-8; a filter driver whose name isn't UTF-8, which never runs.
- **Also:**
  - only the picked folder, with its paths relative to it;
  - a SHA-256 repository;
  - Git LFS pointers named;
  - the same fingerprint for the same commit and folder, and another when either changes;
  - git's own words kept out of a refusal's message;
  - keys and tokens found in UTF-16, inside base64, as PGP blocks and from a key's first line, while a public
    certificate and an image in base64 pass;
  - after the review of PR 8, a vault value with no shape of its own, found inside base64:
    - at each of its 3 alignments, and mid-way through a long text that is wrapped and indented;
    - broken up by escaped line breaks in JSON, a shell's line continuations, string literals joined with `+`, or
      JSON's escaped slashes;
    - two layers down, as a dockerconfigjson secret keeps a registry's auth;
    - URL-safe and unpadded, with URL-safe characters in it, and in UTF-16LE;
    - in a run too short to be decoded.

    Without the vault's values none of them is found, and a commit holding one is refused. A token is found in
    wrapped base64 split inside its encoding, while words that joined up would read as a key aren't taken for one.

The patch's tests. The sandbox's machine is stood in for by the real prepare and collect scripts, with this machine's
tools, and every patch is applied in a fresh clone from its top level:
- An add (with a path over 100 bytes), an edit, a delete, a mode change and a binary edit. The clone ends with the
  result tree exactly, and dependency output never leaves the workspace.
- An empty change gives an empty patch.
- **Refused:**
  - a new link (one leading out of the workspace), a retargeted link, and a file and a link swapped. Deleting a link
    is allowed;
  - a path with `..`, a hard link, a pipe, a file the archive skipped while its listing names it, and a download that
    isn't what the guest wrote;
  - reserved, short-name, forbidden-character and case-colliding new names. A repository's own `aux.c`, and its
    `README` and `readme`, can still be edited;
  - a new `.env` or `credentials.json`, a token, a vault value (as it is, or in base64), an edited `.gitattributes`, a
    deleted `.gitmodules`, LFS pointers edited or added, and a file under a submodule. No refusal quotes a secret;
  - CRLF where `.gitattributes` keeps it out, and a change of a file's own style;
  - each limit, and a baseline commit that is no longer there.
- **Left out and listed:** new generated output.
- **The checkout stays exactly as it is** while the patch is built, even when it moved on and is dirty.
- **Also:** names git quotes (`"` and `\`), a file and a folder that swap places, and a SHA-256 repository.
- **Line endings, as rules:** text, eol, text=auto and nothing said. Only new bytes are held to them: a mode change,
  or CRLF the commit already held, never refuses.
- **After the review:**
  - new paths that clash with what the snapshot left out: under a left-out `.env`, over a left-out `dist/`, over a
    submodule's folder and over the engine home on disk;
  - a name with a line break, named as such;
  - a deep result checked in time linear in its paths, the number of changes first.

**The independent review of the first draft (`f027403`)** found eight gaps and two concerns. Each was reproduced
against that commit with the reviewer's scripts and run again on the fix, `3957da5`, which adds a regression test for
each:

| Finding | At `f027403` | Now |
|---|---|---|
| 1. A new path that clashes with a left-out file or folder | A file `dist` over a left-out `dist/index.js`, with `src/a.ts` edited, was proposed. In a fresh clone `git apply --check` passed, then `git apply` exited 128 and left `src/a.ts` deleted. `.env/notes.md` under a left-out `.env`, and a file `libs` over submodule `libs/foo`, did the same | Each is refused, naming the clash. The engine home on disk counts too |
| 2. A newline in the picked folder's path | Picking `a\nb` gave the prefix `a`, and the sibling's `one.txt` | Refused: the folder's path holds a control character |
| 3. A committed path that isn't UTF-8 | `caf\xE9.txt` became `caf�.txt`, and its patch failed in a clone | Refused, naming the path |
| (Found next to 3) A filter driver whose name isn't UTF-8 | Never switched off: the snapshot ran the repository's filter, then was taken | Refused before git status runs, and the filter never runs. A plain git status runs it |
| 4. Device names followed by spaces | `con .txt`, `aux .h` and `NUL  .js` were accepted. Git for Windows refuses them | Refused |
| 5. A deep result | 7,000 files 505 folders deep: `readTar` took 7,095 ms and `findChanges` 10,511 ms, both on the event loop | 144 ms and 186 ms. The number of changes is checked first |
| 6. A split index | The dirty check refreshed `.git/sharedindex.<id>`'s time | Refused, from the index's own bytes, with nothing in `.git` changed |
| 7. Assume-unchanged and skip-worktree files | Edits to them were hidden, and the snapshot was taken | Refused, saying what to run |
| 8. The policy version | A patch made under version 7 was bound as version 1, and passed the verifier | The policy is taken from the patch, and other rules are refused |
| 9. *(Concern)* What the upload scan missed | A token in UTF-16, a key in a Kubernetes secret's base64 and a PGP private key: no kind found | Each is found, and a public certificate still passes |
| 10. *(Concern)* Refusal text | Messages quoted git's stderr and an absolute path | A code on every refusal. git's words are kept in a detail that never leaves the engine, and no message holds an absolute path |

It also led to two smaller changes:
- a byte-order mark at the start of a name or link target is kept;
- a failure in the tar test compares bytes cheaply.

The newline-name refusal used to blame a hard link; it now names the line break.

**The review of PR 8 (21 October)** found one more gap in the scan. It was reproduced offline, and fixed in `4ec832f`
with regression tests, which fail on the code before the fix:

| Finding | At `0de634c` | Now |
|---|---|---|
| A vault value inside base64 | Looked for only as it is and in UTF-16. A synthetic value with no recognised shape, base64-encoded in a `deployment.yaml`, was archived, and a returned change holding one was proposed | Looked for by its encodings too, wherever it sits and however it is wrapped. Both are refused, naming the path, never the value or its encoding |

An independent check of the fix found no defect in its matching. 62,640 brute-force cases were found: lengths 12–40,
all three alignments, wrapped at several widths with indentation and CRLF, URL-safe, and UTF-16LE. 40,001 real files
from the pnpm store gave no new refusal. It found where the fix still fell short, all fixed in `b167766`:
- a value two layers of base64 down, as in a dockerconfigjson secret, was missed. Decoded runs are now searched for
  the vault's values too;
- only whitespace joined a broken encoding up. Escaped line breaks, a shell's line continuations, string literals
  joined with `+` or a comma, and JSON's escaped `/` now join it too;
- the URL-safe test case held no URL-safe character. It now uses a value whose encoding does;
- the 12-byte floor applied to each encoding. It now applies to the value.

Runs decoded from the joined-up text are read for shapes too, so a token in wrapped base64 is found. Breaking each of
these in turn fails its own test case. On 4 MiB files the scan takes 39 ms (random binary) to 195 ms (wrapped base64).

**The second review of PR 8 (22 October)** found that joining up could freeze the engine, at `30ad9f8`. It was fixed in
`eb76f9c`:

| Finding | At `30ad9f8` | Now |
|---|---|---|
| A long run of spaces after a quote | The breaks were taken out by one regular expression, whose join of quoted strings put a `\s*` either side of an optional `+` or `,`. After a quote and a run of spaces with no closing quote, it backtracked over every way to split the run. A valid JSON file of 128 KB took over three seconds, against 1 ms before the join, and a 2 MiB file, within the per-file limit, would take minutes. The scan is synchronous, so it blocked the engine's answers and cancellation | `withoutBreaks` takes out the same matches by reading forward once. The quotes' join can match only one way, so nothing is tried twice |

- **The same result:** 20,000 generated texts, made of the characters the expression reads, come out exactly as the
  expression gave them, with `\s`'s own whitespace.
- **Bounded:** the review's 128 KB file, and three 2 MiB files at the size limit, are scanned in well under a second
  each (the four took 257 ms in all). They run in a process of their own, with a 20 s limit.
- **With the old expression put back,** that process was stopped at 20 s, and the test failed rather than hang the run.

**Checks**
- `pnpm verify`: 536 passed (domain 36, engine 319, desktop 181), none skipped. Before the review's fixes it was 524,
  and B1 ended at 483.
- After main was merged in, with B1's fixes from the review of PR 7 (`0de634c`, `7377b8d`, `2f1e9bd`), and the review
  of PR 8's fix and its check (`4ec832f`, `b167766`): `pnpm verify` 644 passed (domain 43, engine 402, desktop 199), none skipped. A real engine answered
  `doctor` and ran `hello` again.
- After PR 7 merged into main (`091cf4c`, merged here in `4396879`, which changed nothing) and the second review's fix
  (`eb76f9c`): `pnpm verify` 646 passed (domain 43, engine 404, desktop 199), none skipped. A real engine answered
  `doctor` and ran `hello` again.
- A real engine through `rpc.ts`, on its own home `~/.nivra-dev-track-b`, before the review's fixes and again after
  them:
  - `doctor` answered;
  - a `hello` run succeeded, on a throwaway repository.
- **Not run:**
  - the Windows and packaged checks: no target, supervisor, staging, main or preload code changed;
  - any live Nebius call: B2 needs none. B3's approved recipe is the first.

**Limits**
- **Not wired into the engine or the app.** No run takes a snapshot or proposes a patch yet (B3 puts them together, B4
  wires them in), and nothing applies one (NIV-8).
- **Not shown on busybox yet:** the collect step's `find -prune`, `tar -T` and padded `wc`. This machine's GNU tools ran
  it; B3's live run will show busybox.
- **Only git 2.43 was run.** The minimum, 2.18, comes from the flags used.
- **Recorded simplifications (D34):**
  - case collisions are refused on every target;
  - attributes come from the committed `.gitattributes` files only;
  - a checkout smudged by Git LFS is refused as changed;
  - a repository that commits test keys is refused;
  - a split index, and files marked for git not to look at, are refused rather than checked another way.
- **Detection is by pattern:** a password in a URL isn't recognised.
- **Inside base64, a shape is found one layer down only,** in a run read from where it starts, on one line or joined up
  across lines. A token two layers down, or in a run that starts mid-way through other letters, isn't found. A vault
  value is found two layers down, wherever it sits, unless it is under 12 bytes.
- **For NIV-8:** `git apply` isn't atomic in a working tree (finding 1). Applying must check every added path's place
  first, and leave the checkout as it was if it fails.
- **"Exactly as it is"** means every name, kind, mode, size, modification time and byte, `.git` included. Access times
  aren't compared.

### Nebius sandbox check, B3 (D35, NIV-43)

Track B's third checkpoint: the prescribed path from snapshot to proposal, offline with a fake guest, then live once
on Nebius through the real adapter. On `feature/niv-43`, stacked on B2:

| Commit | What |
|---|---|
| `7e55c0d` | The prescribed path, snapshot to proposal through the real adapter, on a byte-exact fixture, with the offline scenarios |
| `a074951` | The live check, `--plan` printing its bounded recipe for approval |
| `87a6f93` | The independent review of the first draft: eight gaps and three concerns, each reproduced against `a074951` and fixed |
| `c962c94`, `181456e`, `a1622ed` | Main (Track A's PR 10), then the fixes from the reviews of PRs 7 and 8, merged down the stack, each cleanly |
| `6267895` | Main after PR 7's merge, and the second review of PR 8's fix, merged down cleanly |
| `a162108` | The review of PR 9: the live check saves the patch and the report as they were bound |

**Offline** (`prescribed.test.ts`, 17 tests, with the fake guest in `test/fake-guest.ts`):
- the whole recipe proposes exactly the fixed edit, its report telling each step truthfully, each spawn sent once, and
  the checkout unchanged;
- without the edit, the check fails truthfully, and nothing is proposed;
- a lost answer is found by its correlation id, and nothing is sent twice;
- when the sandbox no longer holds the workspace's state, the run stops, with no second upload and no restart from the
  commit;
- the person's cancel stops the step under way, and nothing more runs;
- an unknown start is never sent again, stays visible, and is settled from the journal by the next engine;
- an operation the sandbox never stops is left unresolved within closing's budget, with what the provider keeps;
- refusals send nothing: a backend that isolates nothing, a commit holding a token, a checkout that has moved on;
- the review's regressions:
  - a fault while reading the result back ends as an outcome with cleanup's record;
  - a failed open is told apart (cancelled, or uncertain);
  - a prescribed stop counts from when its command is seen running;
  - the network step passes only with loopback alone and both attempts failing for want of a network;
- the approved fixture's baseline, archive and listing are the pinned ones;
- the real edit and check scripts, run on this machine's `sh` from any folder, do what the fake guest does.

**The independent review of the first draft (`a074951`)** found eight gaps and three concerns. Each was reproduced,
then fixed in `87a6f93` with a regression test. The worst:
1. the network verdict passed with a network: an HTTP 403 from a host it had reached, or no `wget` at all;
2. a download fault after the paid operations escaped as a throw, losing the result and cleanup's record;
3. a failed open read "failed" whether it was cancelled or its start was unknown;
4. a prescribed stop could count a command still pending.

**The live recipe** was printed by `node apps/engine/scripts/sandbox-check.ts --plan` and posted for approval on NIV-43,
then updated to `a1622ed` after the reviews of PRs 7 and 8. It covers:
- **the data:** a fixture of 14 entries and 487 bytes, baseline `b04b10a`;
- **the upload:** its tar, 18,944 bytes, sha256 `7e575cbb…77a`;
- **the image:** `alpine:3.20`;
- **the operations:** 8, each of 60 s or less, with networking off, then 7 minutes for closing.

Nate approved it on 21 October, with his credentials in a file of mode 600 outside the repository.

**Attempt 1,** 21 October at 11:38:53 UTC, at `a1622ed`:
- the account reads passed;
- the upload (`POST /sandboxes/v1/files`, the tar as `application/octet-stream`) was answered **HTTP 500**, so the
  session never opened: 0 of 8 operations ran, and nothing was downloaded;
- the outcome was `failed`, stop `sandbox-failed` at `open`. The 3 checks that could run passed: the fixture's checkout
  unchanged, `~/.nivra` unchanged, and cleanup leaving nothing unresolved;
- the request matched the documented contract, which lists no size limit and no 500. D28's uploads through the same
  method were 642 bytes of text, and this was the first binary body;
- the adapter never resent the upload, and counted it as possibly stored;
- evidence: `~/nivra-acceptance/sandbox-check-2026-10-21T113851685Z/`.

**The rerun Nate approved,** 21 October at 18:20:05 UTC (22 October locally), at `a1622ed`, with the same plan,
printed again and compared. Outcome `proposed`, and **20 of 20 checks passed**:

| Check | What the run gave |
|---|---|
| The run proposed a change | `proposed` |
| The prepare step's listing matched the snapshot's | the session opens only when the digests match |
| The edit kept its changes | exit 0, persisted, SUCCESS |
| Network denied by behaviour | interfaces: `lo` alone; `example.com`: "wget: bad address"; `104.20.23.154`: "Network unreachable" |
| busybox's version recorded | BusyBox v1.36.1 (2025-11-23 14:32:18 UTC) |
| The passing check passed | "PASS: Hello, Nivra" |
| The failing check failed, told apart from the operation | exit 1, with the operation's SUCCESS |
| A timeout told apart from success | timed out, exit -1, SIGKILL, with the operation's SUCCESS |
| A prescribed stop, once seen running, seen to stop | CANCELLED, after 6,474 ms |
| The collect step's listing matched its archive | taken only when they match |
| Networking off for every spawn | 8 spawns, none with networking on |
| Each operation sent once | 8 spawns for 8 operations |
| The proposal is bound to the fixture's folder and commit | verified |
| The patch holds exactly the fixed edit | `old.txt` deleted, a file added under the long path, `data.bin` and `src/greet.sh` edited, and `tool.sh` made executable |
| The bound report holds what happened | prepare, edit, network, check, failing check, timeout, stop, collect |
| `git apply --check` passes on a fresh clone | exit 0 |
| The applied patch gives the bound result tree | `6168c5d…` against `6168c5d…` |
| The fixture's checkout is unchanged | every name, mode, size, time and byte |
| The release engine home (`~/.nivra`) is unchanged | every name, mode, size and time |
| Cleanup left nothing unresolved | 1 stopped, 0 already ended, 0 unresolved |

- **Recorded, not judged:** the service ran each step in `/workspace`, as asked.
- **The proposal:** hash `a64cf783…5273`, a 1,334-byte patch, with its binding (project, target, destination, baseline,
  both trees, fingerprint, policy, and the patch's and report's digests) in `proposal.json`.
- **The service's own figures,** kept raw: each step's usage includes a `cost` whose unit the service doesn't document.
  7 of the 8 operations reported one, summing to 0.000759. The stopped one reported none, which stays unknown. It is
  never converted to money.
- **What Nebius keeps,** from the journal: 1 upload, 3 images and 8 operation records from the rerun, and at most one
  upload from attempt 1. Images are kept for 180 days, and no API deletes uploads, operation records or logs.
- **Evidence:** `~/nivra-acceptance/sandbox-check-2026-10-21T182005478Z/` (0700). It holds the result, the report, the
  patch, the proposal, cleanup's record, the checks and the journal. After each run, a check found neither credential
  in it, nor in the run's log.
- **The saved patch and report aren't the bound bytes,** as the review of PR 9 found. The check wrote the patch through
  its text writer, which added a newline (1,335 bytes saved for 1,334 bound). It wrote the report pretty-printed
  (14,997 bytes for 9,759). Without the newline the saved patch hashes to `patchSha256`, and the canonical form of the
  saved report to `reportSha256`. The review reproduced both, as did a check here, so the result stands. Since
  `a162108` the check saves the bound bytes exactly, with the report's readable copy in `report.readable.json`.

**The credentials.** Nate's were in a git-ignored `.env`, with the key under another name. For each run, a script
wrote a mode-600 copy, under the names the check reads, into the session's private scratch folder, without printing
either value. Each copy was shredded after its run.

**Checks**
- `pnpm verify`: 663 passed (domain 43, engine 421, desktop 199), none skipped, at `a1622ed`.
- A real engine through `rpc.ts`, on `~/.nivra-dev-track-b`: `doctor` answered, and a `hello` run succeeded.
- The live run, as above: attempt 1 failed at the upload, and the approved rerun passed 20 of 20 checks.
- After PR 7's merge, the second review of PR 8's fix, and the evidence saved as bound (`6267895`, `a162108`):
  `pnpm verify` 666 passed (domain 43, engine 424, desktop 199), none skipped. A real engine answered `doctor` and ran
  `hello` again. `--plan` still prints exactly the approved recipe.
- **Not run:**
  - the Windows and packaged checks: no target, supervisor, staging, main or preload code changed. B4 ran both on the
    path wired in;
  - a fresh network control: D28's is reused, as approved.

**Limits**
- **One passing run:** timings and the upload's reliability weren't measured more than once. Attempt 1 shows an upload
  can fail on the service's side.
- **An upload answered with a server error isn't retried** (D33), so a transient 500 ends a check. Retrying an upload,
  whose worst case is a duplicate file, is left for a later decision.
- **The fixture is synthetic and tiny:** a real repository's upload wasn't measured live.
- **`git apply --check` ran on a fresh clone,** never on a person's checkout: applying is NIV-8's.
- **The live run was from Linux (WSL) only.**

### Sandbox check, B4 (D36, NIV-44)

Track B's fourth checkpoint, offline: the prescribed path (D35) wired into the engine and the app as a sandbox check,
behind upload consent of its own. On `feature/niv-44`, stacked on B3 (`a1622ed`), after NIV-39's handoff:

| Commit | What |
|---|---|
| `d4245bd` | The engine and the domain: protocol 8, the `sandbox` workflow, the preview, the report, recovery on the engine's lifecycle |
| `aa44fa6` | The host: upload consent of its own, the consent races around `runs.start`, the project id kept like the key, the IPC |
| `9e974b5` | The window: the project id in Settings, and the sandbox check's preview, consent, progress and report |
| `e9ad7fa` | The docs: D36, this evidence, the check's notes and the architecture rows |
| `a04af11` | The independent review's six findings, below |
| `69c47b1`, `8bc0d04` | The review in D36 and this evidence; the Windows checks |
| `7a70fab` | The independent check of those fixes: five more, below |
| `60285b3` | The check in D36 and this evidence |
| `d5b225e` | Nate's review of `60285b3`: the window's recovery line, and a stop that works taking back one that didn't, below |
| `3478e9b` | PR 9's branch merged in: main after PR 7 merged, the second review of PR 8's fix and the review of PR 9's |
| `6094155` | NIV-34 item 10: `verify:windows` runs sandbox checks from Windows through the WSL engine, and a Linux test rehearses them, below |

**NIV-44's criteria, shown:**

| Criterion | Where | What it shows |
|---|---|---|
| The adapter through the owning engine, with typed contracts; the renderer sends project ids only | `packages/domain/test/sandbox.test.ts`, `sandbox-engine.test.ts`, `ipc-wiring.test.ts` | `runs.start`'s `sandbox` branch takes a checkout, the project and target it is bound to, and a preview's fingerprint. It takes no command and no key, and refuses another workflow's context. Every call is a named preload function, checked by sender and by zod |
| Secrets through `initialize` and `secrets.update` only; never in inputs, events, journals or the guest | `sandbox-engine.test.ts`, "runs a check on the production adapter…"; `host.test.ts`, "keeps the two opt-ins apart…" | Every request carries the key and project id in headers, and no body carries either, or the engine's home. The run's events hold neither. After the host shuts down, no file under its folder holds either |
| Upload consent of its own, off at first, in all four combinations, with the scope and retention shown first | `host.test.ts`, "keeps the two opt-ins apart in all four combinations…"; `sandbox.spec.ts` | Both start off. A check uploads once only with `cloudExecution`, and an explanation starts only with `modelContext`, in every combination. The window's dialog shows the commit, the files and bytes, what's left out and what Nebius keeps, and says it is separate from Token Factory |
| Revocation blocks transfers and cancels owned work; races checked again before dispatch; what stays reported | `host.test.ts`, eleven tests | Refused before any engine starts; never sent when withdrawn while the engine starts, the engine's store holding no run; one check of a project at a time; cancelled as soon as an in-flight `runs.start` answers; a lost answer found by its request id and stopped, with `runs.start` sent once; an error answer with no record said to have sent nothing, in the engine's words; a found check whose stop fails kept known; a check that can't be read still stopped; a stop that fails said to have failed, in the notice and the note; a running check's operation asked to stop, its report saying what Nebius keeps; a removed project's check stopped |
| The deterministic path through a real engine: routing, consent, bounded results, cancellation, uncertain submission, restart reconciliation, unresolved cleanup | `sandbox-engine.test.ts`, 12 tests | Below |
| Named IPC, a narrow UI, existing run reporting; no task execution | `sandbox.spec.ts`; the Run button's existing test | The check's progress is the run's own events. Run stays unavailable |

**The real engine tests,** a stdio engine with the production adapter against the stand-in in
`test/stub-sandboxes.ts`:
- **A preview** sends nothing, and refuses a commit holding the vault's own key in base64, naming the file. A commit
  that only names the project id isn't refused.
- **A whole check:**
  - one upload, and three operations (prepare, probe, collect), each with networking off;
  - the report is bound to the preview's fingerprint: outcome `unchanged`, the probe's busybox line, nothing unresolved, one upload kept;
  - the session's journal moves to `settled/`.
- **Refusals with nothing sent:** no upload consent; no key and project id; a commit changed since its preview; the same request id with another preview.
- **One check of a project at a time:** a second start is refused and never recorded, a repeated request gets its run, and once the first has ended the project is checked again. The first request, repeated while the next check goes, still gets its own run.
- **A failure before the session** (no git on the engine's PATH) ends with a final report in the git stop's words, and nothing sent.
- **Git failing after the upload** (a wrapper that fails `fast-import` alone): the report and the run's failure say the commit was uploaded and nothing was proposed, never that nothing was sent.
- **A cancel:** the probe's operation is asked to stop, the run ends cancelled, and cleanup's record counts one stopped.
- **An uncertain spawn:**
  - the probe's answer is lost and the operation is hidden;
  - it is never sent again, and the report lists it as unresolved, in cleanup's own words;
  - a later engine on the same home, with no credentials yet, lists the journal with no network and waits;
  - given the credentials, its pass finds the operation and stops it, replaying nothing.
- **A pass that ends while a check goes,** its stop held by the stand-in until the check's probe is out: the journal it settled leaves the list, saving the key again starts no pass on it, and nothing is reported left open.
- **A journal removed by hand** before the credentials arrive: no pass runs on it, nothing is sent, and with nothing open the pass reads idle.
- **An engine killed mid-check:** the next engine reads the check as interrupted, and its pass stops the operation it left running.

**Through `rpc.ts`,** on `~/.nivra-dev-track-b`, against the stand-in on 127.0.0.1:
- `doctor` answered;
- `sandbox.preview` of a throwaway repository gave 2 files, 3,584 bytes from its commit;
- a whole check succeeded with outcome `unchanged`. The stand-in saw nine requests, each with the credentials in headers: one upload, three operations with networking off, three reads, and two downloads.
- After the review's fixes, and again after the check's, the same, with the same nine requests; `sandbox.status` then listed nothing open.

**The independent review of the first draft,** by an agent that took no part in writing it, on 21 October. It left the
worktree untouched and reproduced each gap with its own script before reporting it:

| Finding | At `e9ad7fa` | After `a04af11` | Shown by |
|---|---|---|---|
| 1. Two starts of one project at once | Both uploaded and probed. Turning uploads off stopped one; the other stayed `EXECUTING` | The second is refused before the first waits: one upload, one probe, stopped by one DELETE. The engine refuses a second run of the project too | `host.test.ts`, "starts one check of a project at a time…"; `sandbox-engine.test.ts`, "runs one check of a project at a time…"; `sandbox.spec.ts` presses Allow twice |
| 2. A pass that ends while a check goes | The journal it settled stayed listed. Saving the key again started a pass on it, which reported "couldn't be settled, and may still be running" | The pass's list drops what it settled, and what was moved aside: no second pass, nothing reported | `sandbox-engine.test.ts`, "never looks again at a journal…" |
| 3. Host paths that should be states | Turning uploads off threw before any cancel when the run couldn't be read, and so did the view. A found check whose stop failed was searched for again, and could end up lost | An unreadable check is taken as going and stopped, and reads as `unknown`. A found check stays known, with the failure in its note | `host.test.ts`, "treats a check it can't read…", "keeps a found check known…" |
| 4. Words beyond what was shown | "nothing left out: 1 file…"; "was stopped. What it uploaded stays" for a check still being sent; "couldn't stop them all" with no pass run; a check with no git read as interrupted | "left out, and never sent"; "is being stopped. Anything it uploaded stays"; the line follows the pass, read again while one runs; a failure before the session saves its own report | `sandbox-engine.test.ts`, "ends a check that fails before its session…"; the rest by reading |
| 5. The project id | Reached children's environments. A Terraform file naming it was refused as holding a secret | Stripped with the provider variables. Only the key refuses a commit | `units.test.ts`, `wsl.test.ts`, and the preview test |
| 6. A claim and a test | A comment said consent could change between the steps. "Never sends one withdrawn while its engine starts" would have passed had `runs.start` been sent | The comment says what holds. The test reads the engine's store, which holds no run | `host.test.ts`, "refuses a check while uploads are off…" |

- **Each fix undone alone fails its test:**
  - without the host's claim, both starts were fulfilled;
  - without the engine's refusal, the second start went through;
  - with a failed stop sent round the search again, as before, no note came;
  - with an unreadable check not taken as going, or the view not catching, the calls rejected;
  - without the run step's report, it read `interrupted`;
  - without the pass's list fixes, `open` stayed 1;
  - without the engine's words, the note said only that there was no record.
- **Also found sound** by the review: D29's words, the secrets' paths, the strict context, the preview's binding, the
  finder's store check and stdin order, recovery's exclusion of a live session's journal, shutdown, early cancels, the
  scan's cost and the IPC checks.

**The independent check of those fixes,** by another agent, on 21 October at `a04af11`. It changed no worktree file:
its experiments ran on a copy. All six fixes held, and it found five more gaps:

| Finding | At `a04af11` | After `7a70fab` | Shown by |
|---|---|---|---|
| 1. Git failing after the upload | With `fast-import` failing, the report and the run's failure said "Git couldn't be run on this checkout, so nothing was sent", after one upload and three operations | Words chosen by where the check stopped. After the upload: "Git failed while Nivra checked what came back from the sandbox, so nothing was proposed. Your commit was uploaded…" | `check.test.ts`, "says nothing was sent only for a stop before the upload…"; `sandbox-engine.test.ts`, "never says nothing was sent once the commit was uploaded…" |
| 2. A stop that fails | Turning uploads off was refused, yet the notice and the note said the check was being stopped. A refused removal's note said the project had been removed | The notice and the note follow an accepted stop. A failed one says so in both, and a refused removal says the project is still in the list | `host.test.ts`, "says a check couldn't be stopped when its stop fails…", "says a check whose late answer can't be stopped…", "keeps a found check known…" |
| 3. A start beside an unreadable check | Refused as "still going" | Refused, saying the last check can't be read now | `host.test.ts`, "treats a check it can't read as going…" |
| 4. A repeated request | Refused while another check of the project went, though its run existed | The engine looks the request id up first, so a repeated request gets its run, ended or not | `sandbox-engine.test.ts`, "runs one check of a project at a time…" |
| 5. The filter for a journal moved aside | Removing it left every test green | A journal removed by hand is never looked at, and with nothing open the pass reads idle | `sandbox-engine.test.ts`, "never looks at a journal removed…" |

- **Each of these fixes undone alone fails its test.** Without the filter, a pass ran on the removed journal and
  reported "Something Nivra started in a sandbox couldn't be settled, and may still be running".
- **A risk that remains,** named by the check and true before B4's fixes too: after a check is lost (its start's
  answer never found), the engine refuses the next start while the lost run goes, and the window can't cancel a run it
  never learnt. That run ends at its own time limit, or when its engine restarts.

**Nate's review of `60285b3`,** on 21 October. It confirmed the words after the upload, the repeated request and the
host's stops, with 31 focused tests passing, and found what the window still got wrong:

| Finding | At `60285b3` | After `d5b225e` | Shown by |
|---|---|---|---|
| The window's line about what earlier sessions left open | Read when the window opened, and again only while a pass already ran: saving the key and project id could start and end a pass while it still said "Nivra stops them once your key and project id are set" | The projects page counts saves of either credential, Settings counts each once the engines have it, and the sandbox check reads the status again on each, then follows a running pass to its end | `sandbox.spec.ts`, "saving the key and project id settles what an earlier session left open…": a first session leaves a probe open; a second, on the same engine home, shows it waiting; saving both through Settings sees the line go and the operation stopped. With the refresh undone, the line stays |
| A stop that works after one that failed (minor) | The "couldn't stop" words stayed in the check's note and the project's notice | A stop accepted later replaces the note. The notice says the check is being stopped while uploads are off, and goes once they are on. The window's Cancel reads the projects again | `host.test.ts`, "says a check couldn't be stopped when its stop fails…" and "keeps a found check known…". With the clearing undone, both fail |

**The sandbox path from Windows (NIV-34 item 10),** by the offline route Nate chose on 22 October. `verify:windows` now
ends its WSL part with ten sandbox checks (`6094155`):
- **The host:** `Host`, the class Electron's main process wraps, runs in the harness on Windows.
- **The engine:** the WSL engine that host starts, given `--sandboxes-url`.
- **The stand-in:** one for Nebius Sandboxes, on loopback in the distribution. `verify-windows.ts` runs it, and the
  harness asks it one thing at a time over its own stdio (`scripts/stand-in.ts`). Nothing reaches the network.

On Windows at `6094155`, all ten passed, on Ubuntu:
1. The stand-in runs in the distribution the engine runs in, and answers.
2. A folder inside Ubuntu, picked as Windows names it (`\\wsl.localhost\Ubuntu\home\odin\.nivra-verify\sandbox ü%#`),
   is added for Ubuntu's engine.
3. With uploads off, the host refuses a check, and nothing reaches the stand-in.
4. A whole check:
   - outcome `unchanged`, bound to the preview of the repository's HEAD, with the probe's busybox line;
   - one upload and three operations, each with networking off;
   - every request carried the test key and project id in its headers, and no body held either, or the engine's home.
5. A cancel: the probe's operation stopped, and cleanup counted 1 stopped and none unresolved.
6. Uploads turned off during a check: it was cancelled, the notice said what stays with Nebius, and the next check
   was refused with nothing more sent.
7. A submission whose answer was lost: the check ended `uncertain`, the probe was sent once, and its journal stayed
   open.
8. A second host on the same records, without the credentials: the engine listed the journal with no network, and its
   pass waited.
9. The credentials saved: one pass stopped the operation, leaving nothing unresolved or open, and sent no operation or
   upload again.
10. The engine's own refusal of a check whose context doesn't allow uploads, with nothing sent.

**Rehearsed on Linux first.** `test/sandbox-checks.test.ts` runs checks 2 to 10 through the same host and channel,
against an engine that stands in for a distribution's, so a mistake in them shows before a Windows turn. Each of six
mutations fails it:
- the host's consent check;
- the engine's consent check;
- the host's stop when uploads are turned off;
- the stand-in holding the probe;
- the stand-in losing its answer;
- recovery when the credentials are saved.

**Checks**
- `pnpm verify`: 699 passed (domain 48, engine 440, desktop 211), none skipped, at `d5b225e`, as at `7a70fab`: the new host checks extend tests already counted. It was 694 after the review's fixes and 687 before them, and B3 ended at 663.
- `pnpm verify` at `6094155`: 704 passed (domain 48, engine 443, desktop 213), none skipped. It was 702 at `3478e9b`, after PR 9's branch merged in; the rehearsal and the WSL target's extra arguments add two.
- `test:e2e`: 46 passed, 1 skipped (explain's packaged-only test), at `d5b225e`; 45 passed before it, after each round of fixes. The window's tests are in `e2e/sandbox.spec.ts`. The first presses Allow twice and sees one upload, and the third is the saving sequence above.
- `test:packaged`: 24 passed, 23 skipped, at `d5b225e`, after the runtime was staged again (`stage:runtime linux-x64`) and `package:dir`; 22 skipped before it. The skips are the three sandbox window tests and Track A's twenty, which need the test endpoint switch a packaged app ignores. The same at `6094155`, with the runtime staged again for the merged scan.
- **On Windows,** each time after `stage:runtime all`. The first turn was at `69c47b1`, and the second at `d5b225e`, coordinated just before with Track A's session, which had no Windows check running and held off until it was told the turn was over. Each time:
  - `verify:windows --skip-stage`: 22 of 22 checks passed, on the native engine and on the WSL engine driven by a real Windows process. The release's `~/.nivra` was as it was, and the run's own WSL home was removed;
  - `test:windows`: 11 passed, against the build `dev:win --skip-stage --no-launch` copied;
  - no tracked file under `apps/` or `packages/` was written while they ran, checked by each file's size and time before and after.
- **The third turn, at `6094155`,** for item 10: Nate approved it, and it was coordinated with Track A's session the same way:
  - `verify:windows --skip-stage`: 32 of 32 passed, the 22 earlier checks and the ten sandbox checks above. `~/.nivra`'s 8 entries were unchanged, and the run's own WSL home was removed;
  - `test:windows`: 11 passed;
  - nothing tracked was written while they ran.
- **`rpc.ts`** at `3478e9b`, after the merged scan: a whole check against the stand-in, with the same nine requests and networking off. `6094155` changes no engine code.
- **Not run:** any live call: B4 makes none. B3's approved rerun passed through the same adapter and `runPrescribed` (D35, above), and its evidence is reused here only where the bytes and path match: a check's own probe recipe hasn't run live.

**Limits**
- **Not run live.** The stand-in follows the documentation and D28's live runs. B3's approved run (D35) is the live evidence for the adapter and the prescribed path a check runs; a check, with its own probe, hasn't run live.
- **One check of a project at a time,** kept by the host and the engine, and the host keeps a project's last check for the session only.
- **A check proposes nothing,** so nothing here reads or keeps a patch: that comes with NIV-7 and NIV-8.
- **No button settles what earlier sessions left open.** A pass runs when the credentials are handed to the engine: at its start, or when the key or project id is saved.
- **From Windows, through the WSL engine, against the stand-in only.** The native Windows engine's sandbox path isn't
  covered, and nothing is claimed for it. The Windows app's window isn't driven through a check: a packaged build
  ignores the test endpoint switch. No check has run live from Windows.

### Track B completion record (NIV-34)

Prepared 22 October 2026, at `d4cc99b` (B4's branch, holding B1 to B3), with this record's docs commit. Brought up to
date at `6094155`, after PR 7 merged, the reviews of PRs 8 and 9, and item 10's Windows checks. **Every item is now
evidenced,** item 7 for the prescribed commands Track B runs. PRs 8, 9 and 11 wait for Nate's merges (below).

| NIV-34 acceptance item | Evidence | Where it stands |
|---|---|---|
| 1. The operation and image lifecycle modelled explicitly; routing kept out of model prompts; intent journaled before dispatch; uncertain submissions reconciled without running anything twice | B1 (D33): one operation per step, with state carried by the images each leaves. `ExecResult` carries no operation or image id. The intent is fsynced before the send, and a lost answer is found by its correlation id. Tests: `nebius-session.test.ts` (an uncertain spawn sent exactly once), `prescribed.test.ts`, and `sandbox-engine.test.ts` (an uncertain spawn settled by a later engine). Live (B3): 8 spawns for 8 operations | Evidenced |
| 2. Monotonic remaining deadlines for every request, body read, upload, download and wait, POST and DELETE included; no late result taken; cleanup on a finite budget of its own, honest about what stays unresolved | B1: `nebius-sandbox.test.ts`, `nebius-transport.test.ts` and `nebius-session.test.ts`. The review of PR 7: closing's deadline cuts off a cancel already under way (`5597249`, `fa6ce29`). Live (B3): within the 10 + 7 minute bounds, 1 stopped and 0 unresolved | Evidenced |
| 3. The adapter selected through the engine that owns the files, with minimal typed and validated contracts; the renderer sends ids, never host paths or credentials | B4 (D36): protocol 8's `sandbox` branch. Tests: `packages/domain/test/sandbox.test.ts`, `ipc-wiring.test.ts` and `sandbox-engine.test.ts`. Every IPC call is named, and checked by sender and by zod | Evidenced |
| 4. Credentials in the existing secure host storage and the engine's memory transport only; never in workflow inputs, events, logs, journals or the guest | B4: after the host shuts down, no file under its folder holds the key or the project id (`host.test.ts`). Every request carries them in headers, and no body does (`sandbox-engine.test.ts`). Neither reaches a child's environment. B3: neither credential was in either live run's evidence or log | Evidenced |
| 5. Model-excerpt consent apart from per-project upload consent, both off at first, in all four combinations; revocation stops new transfers and tries to cancel; retained artefacts described honestly | B4: `host.test.ts`, the four combinations and eleven revocation tests: before, during and after `runs.start`, a lost answer, stops that fail, and an unreadable check. `sandbox.spec.ts` covers the window. The notice, the report and the dialog give what Nebius keeps | Evidenced |
| 6. The workspace built from one explicit commit, with the deny rules; dirty and untracked work refused or handled, never lost; no host credentials, preferences or engine home, and no git worktree | B2 (D34): a snapshot reads commit objects only. Tracked changes are refused, untracked files are left out and listed, and the deny rules and the engine home's exclusion apply. Every blob's content is scanned, and an unsafe snapshot is refused, never redacted. The review of PR 8 added the vault's values inside base64. Tests: `snapshot.test.ts`. Live (B3): the prepare digest matched the snapshot's listing | Evidenced |
| 7. Networking off for model-controlled commands; resource, output and time limits and cancellation enforced as far as the backend guarantees; a missing capability refuses the run, with no silent switch | B1: `networking: false` on every spawn, output caps, timeouts and cancels. `Local` refuses `isolatesFilesystem`, and `prescribed.test.ts` refuses `Local` with nothing sent. Live (B3): network denied by behaviour, a timeout told apart from success, and a stop seen to stop | Evidenced for prescribed commands. Model-controlled commands come with NIV-7. CPU and memory limits aren't claimed: the backend doesn't guarantee them |
| 8. A complete patch extracted, new and deleted files included; downloads bounded; paths, links, modes, case collisions, line endings, secrets and generated output validated; unsupported forms refused | B2: `patch.ts`, `tar.ts`, `workspace-rules.ts`; `patch.test.ts`, `tar.test.ts`, `workspace-rules.test.ts`; the review of `f027403`'s eight gaps. Live (B3): the patch held exactly the fixed edit (an added file, a deleted one, two edits and a mode change), and the collect listing matched its archive | Evidenced |
| 9. Patch bytes, hash, report, destination and baseline bound; untrusted paths and archives can't escape extraction; available usage told apart from unknown | B2: `proposal.ts`, with `verifyProposal` refusing a wrong baseline, destination or hash (`proposal.test.ts`), and the bounded tar reader (`tar.test.ts`). Live (B3): the proposal bound and verified. Usage is kept raw: the stopped operation's usage is null, and the `cost` figures (7 of 8 reported) are never turned into money | Evidenced |
| 10. The real-engine deterministic path shows routing, consent, results, cancellation, restart and uncertainty reconciliation, and cleanup; Linux and Windows-to-WSL behaviour established; native Windows claimed only with evidence | B4, on Linux: `sandbox-engine.test.ts` (12 tests over stdio, on the production adapter against the stand-in), and `rpc.ts` runs on `~/.nivra-dev-track-b`. From Windows, at `6094155`: `verify:windows`'s ten sandbox checks drive the host on Windows and the WSL engine against the stand-in in the distribution. They cover routing, both consents, a whole check, a cancel, uploads turned off, an uncertain submission, and restart and recovery. All ten passed: 32 of 32 checks in all. `test/sandbox-checks.test.ts` rehearses them on Linux | **Linux and Windows-to-WSL: evidenced,** offline, against the stand-in. Native Windows: nothing claimed |
| 11. Every B1 to B4 criterion and the affected verification evidenced before the parent is ready for review; a standalone harness or probe isn't enough | Each checkpoint's section above. PR 7 merged (`091cf4c`); PRs 8, 9 and 11 are ready for review | Evidenced. The merges are Nate's |

**Platform matrix, as run:**

| Check | B1 | B2 | B3 | B4 |
|---|---|---|---|---|
| `pnpm verify` | 589 passed (43, 347, 199), at `206b3fc` | 646 passed (43, 404, 199), at `9f26b5e` | 666 passed (43, 424, 199), at `60b7081` | 704 passed (48, 443, 213), at `6094155` |
| `test:e2e`, the built app | not affected | not affected | not affected | 46 passed, 1 skipped (packaged only) |
| `test:packaged`, Linux | not affected | not affected | not affected | 24 passed, 23 skipped (the test endpoint) |
| Real engine | `rpc.ts`: `doctor`, `hello` | `rpc.ts`: `doctor`, `hello` | `rpc.ts`: `doctor`, `hello` | `rpc.ts`: a whole check against the stand-in, nine requests |
| Live | none | none | attempt 1 failed at the upload (HTTP 500); the approved rerun passed 20 of 20 | none |
| `pnpm stage:runtime all` | not affected | not affected | not affected | passed |
| `verify:windows` | not affected | not affected | not affected | 22 of 22 passed, at `69c47b1` and `d5b225e`; 32 of 32, with the sandbox checks, at `6094155` |
| `test:windows` | not affected | not affected | not affected | 11 passed, at `69c47b1`, `d5b225e` and `6094155` |

**What remains:** the merges, which are Nate's. PR 7 merged as `091cf4c`; PRs 8, 9 and 11 follow, in stack order.
After each merge, Linear should be checked for NIV-34 being closed by mistake.

**Limitations the parent carries:**
- **D33:** CPU and memory limits aren't claimed. An upload answered with a server error isn't retried, so a transient
  500 ends a check, as the first live attempt showed.
- **D34:** detection is by pattern; case collisions are refused on every target; a checkout smudged by Git LFS reads as
  changed; inside base64, a shape is found one layer down only.
- **D35:** one passing live run, on a tiny synthetic fixture, from Linux; `git apply --check` on a fresh clone only.
- **D36:**
  - a check proposes nothing, and nothing here applies a patch (NIV-8);
  - one check of a project at a time;
  - no button settles what earlier sessions left open;
  - a lost check can't be cancelled from the window;
  - a check's own probe recipe hasn't run live;
  - from Windows, the sandbox path is shown through the WSL engine against the stand-in, not through the native engine,
    the window, or a live call;
  - the project id is masked in what the engine stores, like every vault value.

### Research of saved-plan assumptions: NIV-45 completion record (D37, D38)

Prepared 23 October 2026, after R3's live run, at `main` `8110e0a`.
- **R1** (PR 13, `471b29a`) built research offline and ran the live check twice in process.
- **R2** (PR 15, `a49a4b8`) wired it into the engine, the host and the window (D37).
- **R3** (PR 16, `8110e0a`) corrected its wording (D38), closed three UI gaps, and ran the demonstration once through
  the real app.

This is R3's focused app acceptance, not a repeat comparable with R1: two assumptions, chosen because both decide
whether the plan works.

| NIV-45 acceptance item | Evidence | Where it stands |
|---|---|---|
| 1. The plan identity and version, assumptions, scope and research limits frozen; the result bound to them; later edits can't change a run under way | The packet (plan text, assumptions with their origin, queries, sites, scope) is digested canonically, and the preview's fingerprint binds it with both permissions. Start sends exactly the previewed selection, and the engine refuses a packet that isn't the one fingerprinted. Tests: domain `research.test.ts` ("takes the plan version and the packet's fingerprint…", "changes with a query, a site, an assumption's origin or the scope"); `research-units.test.ts` ("refuses a packet that isn't the one fingerprinted…"); host ("…or the plan moved on"); e2e (an edit, a late preview answer, or an edit during a permission's save, each clears the preview). Live (R3): the preview's fingerprint was the approved one, and the run's packet digest was the approved `1cd35b2a…` | Evidenced |
| 2. A focused Tavily adapter behind a small provider-neutral retrieval contract; no new framework or package | `apps/engine/src/research/retrieval.ts` (the contract) and `tavily.ts` (Search, then Extract of Search's own addresses), R1. No dependency added | Evidenced |
| 3. Numeric budgets before live work (at most 3 searches and 5 extracted pages a run, as product limits); reported usage kept apart from estimates and unknowns | `RESEARCH_LIMITS`: 3 searches, 3 extracts over 5 pages, 15 passages, 1 model request, 240 s with retrieval stopping at 90 s, and the model held to the smaller of 150 s and the time left (D37). Credits are as Tavily reported them, null when it didn't, never 0. Tokens are as reported, beside the run's estimated budget (D30). Tests: `research-run.test.ts` ("never sends a fourth search…", "stops retrieval at its cutoff…", "never lets the model's time pass the run's deadline…", "keeps credits unknown…, never 0"). Live: R1 4 and 4 credits; R3 3 of at most 4 | Evidenced |
| 4. Permission for Tavily queries apart from model-context and workspace-upload consent; the exact outgoing queries shown; private text, names, paths and credentials not included by default; unsafe queries refused, not masked | `webResearch` is app-wide and off until the person turns it on, apart from a project's sharing and its uploads (D37). The preview lists exactly what goes to Tavily and to Token Factory, and the wording matches the code (D38, pinned word for word in `research.spec.ts`). Queries holding a saved key, a credential shape, an address, a path, a cited path, a project's name or folder, an email address or a private host are refused by kind, never masked (domain `research.test.ts`; the engine checks again). A project's queries start empty | Evidenced |
| 5. Credentials in the host's secure storage and the engine's memory transport only; retrieved content untrusted, never instructions | `TAVILY_API_KEY` is kept like the Nebius key, and handed over only in `initialize` and `secrets.update` (D8). Changes to the secrets file run one at a time (`c786d13`). The key travels in a header only, and is masked in what the engine keeps ("sends Tavily only the approved queries…", "…masks both keys in what it keeps"). Passages are made plain and framed with the request's code, so page text can't pose as instructions ("frames each passage…"). Live (R3): no credential shape in the evidence, the profile or the engine's home, 77 files read; a Token Factory key has no shape the scan could see | Evidenced |
| 6. Cancellation, deadlines, partial source failures and restart or uncertain-run handling visible and bounded, with no hidden replay; reports reopen after a restart; project isolation; deliberate deletion and retention | Stops carry their own cause and token, the newest wins, and a failed one is taken back and shown (R2, `c786d13`, `research-cancel.spec.ts`). Tests cover: a cancel during Search or Extract; one search refused while the other goes on; an engine killed mid-Extract or mid-model-call, reading as interrupted and never resent; a lost start found by its request id; a relaunch keeping the report and both versions. A run's context reaches research alone. Deleting a conversation stops its research and keeps nothing of it in the workspace. The engine's report is kept and can't be deleted yet, and every place that asks for consent says so (D38) | Evidenced, except that the engine can't yet delete its reports (disclosed in the copy) |
| 7. Evidence cards and supported, contradicted or unresolved outcomes beside proposed amendments; a source mismatch or a missing version match stays unresolved | The card keeps four things apart: the model's conclusion, the quotations found, the quotations not found, and the assessments that couldn't be used (e2e "research of a general plan keeps…apart"). Unresolved is shown under a stated rule: no valid quotation, a version no cited source names, or quotations on both sides (`research-units.test.ts`). Amendments are offered only for a contradiction with valid quotations, or as a fixed note for an unresolved assessment | Evidenced |
| 8. Missing Tavily credentials or an outage disable only the optional research action; chat, plan-only council review and execution stay available | Without a key the preview blocks Start, saying why ("blocks Start research with the first reason that applies"). A Tavily that can't be reached fails research alone, asks the model nothing, and the conversation goes on (host). Council review and execution have no path through Tavily | Evidenced for research and chat. Council review and execution don't depend on Tavily at all |
| 9. Offline tests cover a useful contradiction, a supported assumption, insufficient or conflicting sources, citation-to-excerpt mapping, private-data canaries, consent revocation, cancellation, limits and stale plan versions | `research-run.test.ts`: the contradiction and the supported assumption; nothing readable; an unusable answer; the cutoff and the deadline. `research-units.test.ts`: quotations checked against the passage each names; quotations on both sides kept unresolved. `research-engine.test.ts`: a plan canary kept out of events, logs and every store, read while the engine runs. Host and e2e: permissions withdrawn, cancels, and a plan that moved on | Evidenced |
| 10. The real-engine, UI, packaged and Windows checks for the surfaces changed; any live acceptance under a separately approved, bounded recipe, recording the actual requests, usage and limits | Real engine: `research-engine.test.ts` over stdio, and `rpc.ts` against stand-ins (R2). UI: `research.spec.ts`, `research-cancel.spec.ts`, `research-journey.spec.ts`. Packaged: 27 passed. Windows: `verify:windows`'s five research checks through the WSL engine (37 of 37), `test:windows` 12 of 12, and four rehearsals of the live script. Live: R1's two runs in process, each under its own digest; R3's run through the app under `fdde7a81…` (below) | Evidenced |
| 11. A plausible upgrade plan with a known wrong compatibility assumption: retrieval exposes the missing requirement, the person inspects the source and saves an amended version; whether the evidence improved the plan recorded, not URL counts | R3's live run, below. Both wrong assumptions were contradicted from the official 3.12 release notes. Nate checked the page himself and saved v2. His judgement: the evidence improved the plan, "but its just a simple example" | Evidenced, through the Windows app and its WSL engine, on one simple example |

**R3's live run (23 October, 07:33 to 07:49 UTC).** Approved by Nate under digest
`fdde7a81807e2fd67919334c7a24eed03412072ef5781ccc71139b5471441a9b`. The recipe was posted on NIV-45 after a passing
rehearsal from the same frozen build. The approval is claimed, run 1.

- **Build:** frozen from `8110e0a`, a clean tree, the app built from it. Nivra.exe `fd783774…1406`, app.asar
  `a332582f…dc62`, WSL runtime `c7dddc0b…1c54` (`af5c48c5666be22e`).
- **Route, as shown:** a profile of its own, then `wsl:Ubuntu` in a home of its own, on the project `kestrelyard`
  (commit `21bdbdc`). The engine reported that home on linux; the native Windows engine never ran.
- **The plan,** seeded with no model call: "Move the build image from Python 3.11 to 3.12. The image creates a fresh
  virtual environment with python -m venv /opt/venv, then builds the wheel inside it with python setup.py bdist_wheel,
  installing nothing else into it first. setup.py keeps importing distutils.core."
  - A1: "distutils is still in Python 3.12's standard library"
  - A2: "Python 3.12's venv still pre-installs setuptools" (R1's A3, now naming 3.12)

  Each query was the assumption's own words; the sites preferred were docs.python.org and peps.python.org.
- **Steps:**
  1. Nate pasted both keys into Settings.
  2. The script gave research's permission and the project's sharing, each through its own dialog.
  3. The preview showed exactly the two queries and the sites, with the approved fingerprint.
  4. The approval was claimed and Start pressed once.

| Request | State | Pages asked / read | Credits (as reported) | Time |
|---|---|---|---|---|
| search-A1 | answered | | 1 | 1.8 s |
| search-A2 | answered | | 1 | 3.4 s |
| extract-A1 | answered | 3 / 3 | 0 | 0.6 s |
| extract-A2 | answered | 2 / 2 | 1 | 0.9 s |
| model | answered | | | 3.9 s |

- **Totals:** complete in 8.8 s; 3 Tavily credits; `nvidia/nemotron-3-super-120b-a12b`; 5,484 input and 595 output
  tokens, both reported; 1 model call. Nothing failed, nothing was retried, and nothing was set aside.
- **Pages read:**
  - "What's New In Python 3.12" on docs.python.org, found first for both queries;
  - for A1, two community pages: software.codidact.com and Stack Overflow;
  - for A2, a GitHub issue.

  Every quotation the model cited came from the docs.python.org page.
- **A1: contradicted,** 2 of 2 quotations found in their passages:
  - "Of note, the `distutils` package has been removed from the standard library."
  - "gh-95299: Do not pre-install `setuptools` in virtual environments created with `venv`."

  Suggested amendment: "Update the plan to install distutils via setuptools or use an alternative build system."
- **A2: contradicted,** 2 of 2 quotations found:
  - "gh-95299: Do not pre-install `setuptools` in virtual environments created with `venv`."
  - "Remove the bundled setuptools wheel from `ensurepip`, and stop installing setuptools in environments created by
    `venv`."

  Suggested amendment: "Modify the plan to install setuptools explicitly after creating the venv (e.g., run `pip
  install setuptools`)."
- **The person's part:** Nate opened the address himself and found the quotations there ("they are valid i checked").
  He saved v2 from the research: v1's text with A1's suggestion added under "From web research". v1 stayed unchanged,
  and v2 became the latest.
- **After the go-ahead:**
  - the app was closed and relaunched on the same profile and home;
  - the plan versions and the research were unchanged, and the window showed "Plan · v2", the original beneath it, and
    "Saved as v2 from this research.";
  - both keys were removed from the profile;
  - `~/.nivra` and `~/.nivra-dev` were unchanged.

  Failures recorded: none.

**Nate's judgement, against the rubric, in his words:**
1. Was the evidence about Python 3.12? "Yes"
2. Official or community? "Official"
3. Did each found quotation support its conclusion? "Yes"
4. Was each conclusion warranted? "Yes"
5. Did the evidence support the amendment? "Yes"
6. Did the saved amendment improve the plan? "Yes but its just a simple example"
7. Were the four distinctions readable? "Yes i think so we can improve this flow later after we lay groundwork"

**Recorded alongside, not judged:**
- **A1's second quotation** is about venv and setuptools, not distutils. It was found in the source, which proves
  where its words came from; A1's conclusion rests on the first quotation.
- **v2 keeps v1's text** and adds one suggestion. The step "installing nothing else into it first" and both assumptions
  are still in it, and A2's more concrete suggestion (install setuptools after creating the venv) wasn't added. Research
  saves one version only; a later edit would be an ordinary revision.
- **A separate plan** with v1's text was also saved from the same answer at 07:43. It isn't linked to the research.
- **The card's screenshot** was taken just before the window refreshed, so it shows "Researching". The full report is
  in `report.json`.

**Evidence:**
- R3's run: `~/nivra-acceptance/research-r3-live-20261023T073352Z-8110e0a` (0700). It holds the recipe, the report,
  the run's events, both plan listings, check.json, the log and screenshots.
- Its rehearsal: `research-r3-rehearsal-20261023T072752Z-8110e0a`.
- R1's two runs: `research-check-20261022T074430Z-aa3a81b` and `research-check-20261022T081246Z-f9d690b`, kept
  unchanged.
- No credential appears in any of them.

**R1's live check, for the record** (in process, through `research-check.ts`, not the app):
- **Run 1,** 22 Oct 07:44 UTC: 4 credits, 4,685 and 1,050 tokens, 10.2 s. All three assessments came out "not
  assessed", because none named its assumption. The matching rules were fixed before run 2.
- **Run 2,** 08:12 UTC: complete in 7.9 s, 4 credits, 4,945 and 1,012 tokens. A1 contradicted (3 of 3 quotations
  valid), A2 supported (1 of 2), A3 contradicted (1 of 1). Its caveats are on NIV-45.

**Checks, as run:**

| Check | R2 (PR 15) | R3 (PR 16) |
|---|---|---|
| `pnpm verify` | 60, 263, 515 | 60, 267, 515 |
| `test:e2e`, the built app | passed in full once two stale assertions were fixed (1 skipped, packaged only); research.spec 9 of 9 | 61 passed, 1 skipped; the research specs 16 of 16 after every fix |
| `test:packaged` | 26 passed | 27 passed, both switches shown ignored |
| `verify:windows` | 37 of 37, five research checks | not affected (no target, supervisor or staging change) |
| `test:windows` | 12 of 12, twice | 12 of 12, twice |
| Real engine | `rpc.ts` against stand-ins | the live script's rehearsals, four passed |
| Live | none (R1's two runs before it) | one approved run through the app, above |

**Limits:**
- **Platform:** from Windows, research is shown through the WSL engine only; nothing is claimed for the native Windows
  engine. On Linux it is shown offline, against stand-ins.
- **One run, one example:** R3 is one live run of one simple plan, and its judgement says so. It doesn't measure how
  often research helps, or how it fares on harder questions.
- **What a check proves:** a found quotation proves where its words came from, not that they support the conclusion.
  The model's assessment stays the model's, and the person judges it.
- **Retention:** the engine keeps every report and can't delete it yet.
- **Keys:** the credential scan can't see a Token Factory key. The engine's offline tests check that no key value
  reaches its stores.
- **The flow:** Nate's own note on readability: "we can improve this flow later after we lay groundwork". The broader
  research and memory work stays with NIV-33.

### Task run, checkpoint 1 (D39, NIV-7)

The execution milestone's first checkpoint, offline but for one approved live probe: one ready task's brief run by one
worker in a Nebius sandbox, judged by acceptance cases it can't edit, its change proposed and kept exactly. On
`feature/niv-7-worker`, from `main` at `3440f93`:

| Commit | What |
|---|---|
| `b49720e` | Explicit deadlines after the work, hooks on the prescribed path (work, verify, finish), close before the patch, proposal binding v2 |
| `60a7a81` | The worker, the acceptance harness, the toolchain probe, the workspace copy and their time, against a guest that really runs commands |
| `867497b` | The live toolchain probe's recipe and script, rehearsed offline |
| `0245fac` | Protocol 10, the `task` workflow, engine migration 4, a slot of its own, the run's one deadline, the recovery guard over tasks |
| `b8ad942` | The host and the window: acceptance cases in briefs, the bound Run preview, consents asked in place, attempts, the run's card |
| `5f0323d` | The independent review's findings in the engine: fixed words for refusals, cases naming the files they run, an uncertain final check ending the run, the report fitted to its store, the reserve counting start requests |
| `5aa7e0e` | The review's findings in the host and the window: every stop tried, a turned-down stop sent again, the case-file warnings, the consent wording |
| this record | D39, the development notes, and this section |
| `e17960a`, `b3dc652` | Nate's review of PR 18: a script a case names in quotes is named, and a command whose files can't be read is said to be unclear, in the preview and on the run's card |
| the review's record | D39's *Why*, and *Nate's review of PR 18* below |

**NIV-7's criteria (scope of 20 October), shown:**

| Criterion | Where | What it shows |
|---|---|---|
| An immutable native brief with its project, baseline and scoped context; no tracker | `packages/domain/test/task.test.ts`; `task-engine.test.ts`, "refuses without model sharing…"; `host.test.ts`, "previews what keeps a run from starting…" | A run carries the brief in memory and its version and digest in its input; a brief that isn't the one named is refused before anything is sent. The snapshot's fingerprint binds the commit the preview showed; a commit that moved since is refused before the upload. A start whose preview changed (a brief edit, a consent) is refused by the host |
| One worker and one task at a time; tools only in the sandbox workspace, never the checkout or `Local` | `task-engine.test.ts`, "runs one task at a time on its own slot…"; `host.test.ts`, "runs one task at a time…"; `task-worker.test.ts` | A second task is refused on the engine and in the host, and recorded nowhere; a repeated request gets its run. The worker's reads are the engine's copy, and its writes and runs are Nebius operations; the checkout is unchanged, every name, mode, size, time and byte, `.git` included |
| Bounded steps, output and time, with usage; credentials in engine memory, outside model inputs and guests | `task-run.test.ts` (the deadline), `task-timing.test.ts`, `task-worker.test.ts` (each budget), `task-engine.test.ts` | Each budget used up is refused and the run goes on to collect. The deadline cuts the session and close, and a patch left no time fails after close. Every Nebius request carries the key and project id in headers only, and no body holds either; the model's requests never hold the key; a write naming the project id is never sent |
| Real progress, verification results and the validated patch; worker success isn't acceptance | `task-engine.test.ts`, "runs the worker on the production adapter…"; `task-run.spec.ts` | Progress events, each case's and check's verdict, the worker's account kept apart, the proposal bound and kept exactly, read back as text. A change is verified only when every case passed, and a run that changed nothing never is |
| Denied actions, failing checks, cancellation, provider failure and lost observation, with no duplicate submission | `task-worker.test.ts`, `task-timing.test.ts`, `task-engine.test.ts`, `host.test.ts` | Writes outside the rules, input that doesn't match a tool's schema, and calls past a budget are refused before anything is sent, and the run goes on; a write naming the project id never leaves. A replaced repository check, an exit before the assertions, and a case exiting 127 on purpose all fail the case; a missing program stops the run before the model. The person's cancel stops the operation under way, during the work or the final checks, and nothing is proposed; turning a consent off stops the run, even when another of the project's runs can't be stopped, and a stop the engine turns down is said and sent again. Token Factory failing partway leaves the worker stopped, the change collected and judged, and the failed request not sent again. A write or a final check whose start's answer was lost is never sent again, and the run ends uncertain; a lost run start is found by its request id; a repeated request gets its run; a restart replays nothing |
| Linux and Windows-to-WSL first; native Windows proven before it is claimed; no commit, push, PR or deployment | `task-engine.test.ts` and `task-run.spec.ts` (Linux); `host.test.ts`, "Host: task runs…" (a Windows host on a stand-in WSL target) | Shown on Linux through a real engine and the built window. Windows-to-WSL is shown by the host's tests, which run as a Windows host on a stand-in WSL target; through the real Windows app it waits for the Windows turn below. Windows itself is refused by the host and the engine, and recorded nowhere. Nothing commits, pushes or applies: the change is kept with the run |

**The live toolchain probe (26 October, 13:00 UTC, approved by Nate),** at `867497b`: 10 of 10 checks passed, in five
operations with no model (prepare, the applet list, one write, the case, collect), each sent once and every one with
networking off. Busybox listed 304 applets, `sh`, `printf`, `sha256sum`, `tar`, `sed`, `awk` and `diff` among them, and
not `git`, `node` or `python3`. The 32,768-byte write came back byte for byte (`c1d588a0…`), the case saw it in the next
operation, and collect gave exactly the fixture plus the write. The fixture's checkout and `~/.nivra` were unchanged,
and cleanup left nothing unresolved. Nebius keeps the write's content in its operation record (`metadata.args[7]`).
Evidence: `~/nivra-acceptance/task-probe-2026-10-26T130001539Z/`.

**Through `rpc.ts`,** after the review's fixes, on `~/.nivra-dev-track-b`, against the stand-ins on 127.0.0.1:
`task.preview` of the fixture gave 2 files, 3,072 bytes from `0af8b007…`, the programs `.` and `/bin/sh`, and
`greet.sh` as the file case 1 runs. A whole run succeeded with a 622 s work window and 578 s kept: proposed, every
acceptance case passed, case 1 naming `greet.sh` beside its pass, the change exactly the fix (`greet.sh`, 256 bytes),
nothing left unresolved, and a 4,296-byte report. Nebius kept 1 upload, 3 images and 7 operation records, and the
fixture's checkout was unchanged.

**Checks:**
- `pnpm verify`: 926 tests (domain 66, desktop 276, engine 584) at `5aa7e0e`, none skipped.
- The built app (`test:e2e`, under `xvfb-run`): 63 passed, 1 skipped, `explain.spec.ts`'s test that only a packaged app
  can run. `task-run.spec.ts` writes an acceptance case into a brief, gives both consents in the Run preview, which
  names the file case 1 runs, runs the task to its end, and reads what Nivra found: every case and check passed,
  `greet.sh` named beside case 1, the change as text, cleanup's record, and the checkout untouched.
- The packaged app (`test:packaged`, on the `--dir` build with a runtime staged from this code): 27 passed, as for
  R3, and 37 skipped: the tests that need the stand-in switches a packaged app ignores, `task-run.spec.ts` among them.
- **Mutation checks:** each rule below was broken on purpose, and its test failed every time (34 of 34):
  - the run: native Windows not refused, model sharing or the brief's digest not checked, a second task accepted on
    one engine, tasks sharing the shared slots, a reused request id with another task's input accepted, the recovery
    guard over checks only;
  - time: the session, close or the patch not cut by the run's deadline, the reserve without start requests;
  - the verdict: a task's change verified without a change, a case's changed files not named, a missing output stream
    read as empty, a workspace path or a function probed as a program;
  - stops: a final check sent after a cancel, a cancel during the final checks stopping only at the patch, an
    unsettled final check still proposing, a refused write recorded as a step;
  - what is kept and said: a proposal holding a vault value kept, a proposal kept masked, another attempt's proposal
    accepted, a report not fitted to the store or not masked, a cut leaving half a character, a proposal that wasn't
    kept still reported, a stop after the upload saying nothing was sent, the worker's own runs counted before the
    upload, a refusal's own words reaching the model;
  - the host: a task run's stop skipped when the check's or an explanation's stop failed, an offline engine's run
    blocking removal, a turned-down stop never sent again.

- **The Windows turn** (approved by Nate, 26 October): `pnpm dev:win --no-launch` built `b994bea`, and `test:windows`
  passed 12 of 12 on that build: the window, both engines, the workspace kept across relaunches, quitting leaving no
  engine, and `~/.nivra` unchanged. None of them drives a task run: that is checkpoint 3's. Targets, the supervisor and
  staging didn't change, so `verify:windows` wasn't called for.

**Nate's review of PR 18 (27 October)** found one more, reproduced there. A case that named its script in quotes
(`/bin/sh 'check.sh'`) named no file. So a worker that rewrote `check.sh` to print the expected output passed, verified,
with no warning. Fixed in `e17960a` and `b3dc652` (D39, *Why*):
- `task-worker.test.ts`, the regression: the worker rewrites `check.sh` to `echo ok`, and the case `/bin/sh 'check.sh'`
  comes back passed and verified, with `check.sh` named beside it. A case and a check whose command can't be read
  (`/bin/sh -c "$(cat check.sh)"`) are marked unclear once the worker has changed a file, and not when it changed
  nothing.
- `task-engine.test.ts`: the preview over stdio names `check.sh` for the quoted case and marks the unreadable one
  unclear. `host.test.ts` reads both fields through the host from a real engine. `task-scripts.test.ts` holds 30
  commands: quoted, mixed, nested and unreadable.
- The domain reads a preview or report saved before this as not unclear.
- The fix was broken three ways on purpose, and a new test failed each time:
  - quotes read as characters again;
  - nothing ever unclear;
  - unclear with nothing written.
- `pnpm verify` at `b3dc652`: 929 tests (domain 66, desktop 276, engine 587), none skipped.
- The built app: 63 passed, 1 skipped (the packaged-only test). The card's unclear wording has no window test of its
  own.
- The Windows turn and the packaged checks weren't repeated. Only the engine's reading of commands and the window's
  wording changed: not targets, the supervisor, staging, or main-process or preload behaviour.

**Not shown yet:**
- **One live worker run,** and the packaged journey through the Windows app: checkpoint 3 (NIV-35), each with its own
  approval.

### Apply and the result view, checkpoint 2 (D40, NIV-8, NIV-13)

The execution milestone's second checkpoint, offline: a verified proposal approved by its hash and applied by the
engine that owns the checkout, every original moved aside and kept, every end said file by file, and the window that
decides on it. On `feature/niv-8-apply`, stacked on checkpoint 1 (`f0c960d`). Built in parallel: the writer and the
engine's calls here, revalidation, the kill tests, the host and the window each by a helper in a worktree of its own,
against a contract committed first, then reviewed and merged.

| Commit | What |
|---|---|
| `3b085a0` | The plan and refusals revalidation and the writer share |
| `2785609` | The apply writer, its journal (engine migration 5) and its fault tests |
| `a85efeb`, `923b9ce` | Revalidation, then refusing what it can't read as a filesystem problem and finding names exactly |
| `1569e11` | An apply killed at every step, then reconciled |
| `54d4377`, `ccd6cf3` | Protocol 11's apply, the service, reconciling at start |
| `b842c21` | `rpc.ts` applies a finished run's proposal |
| `3d46a93`, `897bc8f`, `1f6ccfd` | Tests the mutation checks asked for |
| `bfefb24` | The contract between host and window |
| `4903fcd`, `0012e80`, `4491a2b` | The window: the decision, the apply file by file, the runs list, and its journey |
| `18e00c3`, `da220d3`, `b8dc600` | The host: workspace migration 4, the five calls, their tests |
| `3ce9962` | The runs list from the workspace, with no engine |
| `d698dc7` | R3's journey compares its concurrent searches in either order |
| `0c13808`, `751ef51`, `d1daef5`, `dc6168b`, `6362895` | The review's engine findings: claims on arrival, the lock, missing files' originals, the view's bounds, idempotent settling, line endings, unverified changes |
| `7021b89`, `7017ea5`, `17ca434` | The review's host and window findings: lost settle answers, Keep as is, deleting, the card's copy, a partial apply through the window |
| this record | D40, AGENTS.md's agent write rules, the development notes, and this section |

**NIV-8's remaining scope (20 October), shown:**

| Criterion | Where | What it shows |
|---|---|---|
| Approve the exact validated patch hash, destination, owning engine and baseline; reject changes to any binding; revalidate immediately before a serialised apply | `apply-revalidate.test.ts`; `task-engine.test.ts`, "refuses an apply that isn't the approved proposal…"; `host.test.ts` (approve refused for another hash, an unverified change) | Another hash, attempt, engine or brief is refused as `proposal`; a moved HEAD as `baseline-moved`; an edited checkout as `uncommitted`, all writing nothing. Applies run one at a time on an engine, each claimed, revalidated and written in one go |
| Record intent before writing; recover an interrupted apply as applied, not applied or unknown; never replay a write or claim success while the state is unknown | `apply-writer.test.ts`, `apply-kill.test.ts`, `apply-service.test.ts` | The intent is kept with synchronous FULL before anything of the person's is touched. A child killed at each of the apply's 52 calls (and in rollback) reconciles writing nothing, every original kept, and restores to the commit; an engine started after a kill settles the apply from the disk (partial), and one killed before its intent reads as interrupted. Nothing is replayed |
| Rejection leaves the checkout untouched; only the owning engine applies; the worker works only in its workspace | `host.test.ts` (reject), `task-apply.spec.ts` | A rejected change sends nothing: the checkout and the git folder are untouched. The host never writes repository files: `task.apply` goes to the engine on the attempt's own target and home |
| Persist and reconcile remote operation references; a disconnected client isn't cancellation | D33, D39 (checkpoint 1) | Unchanged here: the sandbox session's journal and recovery |
| Cancel owned child work and report usage and masked failures; pending-approval behaviour across a restart chosen and tested | `host.test.ts` (read back after a restart, sent once), `apply-service.test.ts` | A proposal waiting for a decision survives a restart; an approval made before one is never resent: the host asks `task.applyStatus`, and an apply its engine never recorded is taken back in the engine's words |
| Distinguish task state, run status, provider operation status, command exit and user acceptance | `host.test.ts`, workspace migration 4 | The worker handing in, Nivra's verification, the change applied, and the person's acceptance are kept apart; a task is completed only on acceptance |

**NIV-13's scope (20 October), shown:**

| Criterion | Where | What it shows |
|---|---|---|
| A task's attempt history, the exact patch and changed files, the brief's version, the checks and evidence | `task-apply.spec.ts`, `task-run.spec.ts` | Every run listed newest first with its brief version, outcome, decision and apply, from the workspace; each card shows the change as text, each case's and check's verdict, and the apply file by file |
| Passed, failed, not run and unknown kept apart; partial evidence after a cancel or failure | checkpoint 1 (`task-run.spec.ts`), `task-apply.tsx` | Verdicts as in checkpoint 1; an apply that stopped says each path's place and where it stopped |
| Approval controls identify the exact patch and baseline | `task-apply.spec.ts` | Approve shows the change's hash and commit, and sends that hash |
| A revision is another attempt under the same task; accepting an applied change is distinct from the worker's success | `host.test.ts` (revision), `task-apply.spec.ts` | A revision's note becomes a new brief version, and the next run is a new attempt; acceptance completes the task, the worker's handing in never does |
| Reopen after a restart with durable routing and honest unavailable states | `host.test.ts` (restart), `TaskApplyView.unresolved` | The workspace keeps each attempt's outcome and decision; an apply whose engine can't be read says so, and is never resent |

**Checks:**
- `pnpm verify`: 980 tests (domain 66, desktop 284, engine 630) at `6362895`, none skipped.
- The built app (`test:e2e`): 67 passed and 1 skipped (`explain.spec.ts`'s test that only a packaged app can run).
  Among them the apply journeys: `task-apply.spec.ts` (approved, applied and accepted; rejected; a revision asked)
  and `task-apply-partial.spec.ts` (a change applied in part, only Restore offered while a file is moved aside,
  restored, then dismissed).
- The packaged app (`test:packaged`, a runtime staged from this code): 27 passed and 41 skipped, the tests that need the
  stand-in switches.
- `rpc.ts` against the stand-ins: a run's proposal applied (`greet.sh` changed, unstaged), accepted (the recovery
  folder and the lock removed, the change kept), and applied again refused as a duplicate. Since Nate's review of PR 19,
  accepting keeps the original (below).
- **Mutation checks:** 58 of 58 apply rules broken on purpose each failed a test (three scripts):
  - the writer and service, 28: the move-aside check, both no-replace links, restore's two guards and its memory of
    another program's save, the read back, the same-filesystem check, another engine's lock and a refusal's own lock,
    folders Nivra didn't make, accepting a changed copy, a missing file's original, keeping with a file moved aside,
    reconciling at start and the folders it names, an interrupted claim, a queued apply's status, a repeated request,
    a repeated settle or restore, a duplicate apply, an unverified change, the view's bounds, a moved HEAD, native
    Windows;
  - revalidation's 24, the line-ending rules among them;
  - the kill tests' 6.
  Two rules, the last-moment check of what is moved aside and the rename that puts back a folder, each stand behind the
  other, so neither alone fails a test. The host's own pass caught 9 of 10, the tenth a second route to the same
  follow-up.
- **The independent review (27 October):** five findings shown by its scripts and several smaller ones, all fixed
  with a test each (D40, *Why*). Its own verdict: no version of a person's file was destroyed in any scenario it ran.

**Nate's review of PR 19 (27 October)** found four more, each reproduced there, then fixed with a test each (D40,
*Why*). They were built in parallel, as before: the engine's fixes here, the host's by a helper in a worktree of its
own, then reviewed and merged. PR 18's fix was merged in (`4fde8bd`).

| Commit | What |
|---|---|
| `40df5f8`, `7c46ae7` | Every folder an apply touches held open from `/` down, only to pass through, and written through; a moved folder rolls the apply back; rollback and restore report a path behind a link as unknown |
| `ea36e33` | Settling keeps every copy that isn't a second name for the file in place, the originals among them |
| `0c5e636` | A settle or restore saved before it is sent, and read back whenever its engine comes online |
| `85bd441` | A task's brief and repository held until its change is settled; accepting an older brief's change doesn't complete the task |
| `6736a9a`, `9928802` | The card's copy (the originals stay; a moved folder in plain words), and the tests that expected copies removed |
| this section | D40, AGENTS.md's agent write rules, the development notes |

- **A folder swapped for a link** (`apply-writer.test.ts`): the reviewer's case and more. In every one the folder or
  copy outside is untouched.
  - In the repository, swapped before the apply holds its folders: refused as `changed-since`, nothing written.
  - Swapped just before the link: the new file lands in the folder that was checked, and the apply rolls back there
    (`docs-moved/old.md` is the original again, `orig-0` kept). The result is unknown with the failure
    `check folders: moved`, never applied.
  - Swapped while rollback takes a file back, before a later restore, or midway through one: the original goes back
    into the folder it came from, or the path is left alone. Each reads unknown.
  - A folder above the repository swapped for a link to a copy of it: refused before the intent; just before the
    link, rolled back in the real folder and read as unknown.
  - An apply under a folder it may pass through but not read applies. A system without `/proc` is refused, writing
    nothing.
- **The held descriptor** (`apply-service.test.ts`), the reviewer's regression:
  - an editor opens `README.md` before the apply, and the change is applied and accepted;
  - the editor then writes and fsyncs through its descriptor;
  - the save lands in `orig-0`, which still has a name, and the checkout keeps the change.
  The old release removed the whole folder, and the test fails against it.
- **The host** (`host.test.ts`):
  - a settle whose answer is held when Nivra stops is read back by a new host once its engine is online: accepted,
    the task completed, nothing offered, and `task.dismiss` sent once;
  - an apply settled elsewhere is read again when its engine restarts;
  - with a change applied, revising the brief and moving the task are refused;
  - a change made for an older brief is accepted and settled, the task isn't completed, and the card says why;
  - a real engine's accepted apply leaves exactly `orig-0` in the recovery folder.
- **On a real engine through `rpc.ts`** at `7c46ae7` (the stand-ins, `~/.nivra-dev-track-b`):
  - a run proposed a verified change;
  - a shell opened `greet.sh` read-write, then the change was applied: unstaged, with `new-0` and `orig-0` in the
    recovery folder;
  - it was accepted: `new-0` was removed as a second name, `orig-0` was kept, and the lock was gone;
  - the shell then wrote through its descriptor: the save was in `orig-0`, and `greet.sh` kept the change;
  - applying again was refused as a duplicate.
- **Mutation checks** on the new code:
  - the writer and service: 35 of 35, each failed a test. New among them: a name built from the root instead of
    through the folder held open, the root opened by its whole path, folders held open for reading, a folder opened
    through a link, no check for a moved folder before the result, rollback reporting through a moved folder, a
    missing `/proc` not refused, and accepting removing an original that isn't the file in place;
  - the kill tests: 6 of 6;
  - the host: 14 of 15, with five new rules for the review's fixes, each caught. The fifteenth, dropping the follow-up
    after a lost apply answer, has a second route, as in the first pass: reading the attempt starts the same
    follow-up.
- `pnpm verify` at `7c46ae7`: 992 tests (domain 66, desktop 288, engine 638), none skipped.
- The built app (`test:e2e`): 67 passed and 1 skipped (the packaged-only test), the apply journeys among them.
- The packaged app (`test:packaged`, a runtime staged from this code): 27 passed and 41 skipped, the tests that need the
  stand-in switches.
- **The Windows turn** (approved by Nate, 27 October): `pnpm dev:win --no-launch` built `7567415`, and `test:windows`
  passed 12 of 12 on that build. It covered the window, both engines, the workspace (its migration 4 among them) kept
  across relaunches, quitting leaving no engine, and `~/.nivra` unchanged. None of them drives an apply: that is
  checkpoint 3's. Targets, the supervisor and staging didn't change, so `verify:windows` wasn't called for.

**Nate's follow-up review of PR 19 (27 October)** confirmed the anchoring and both host fixes, and that the reproduction
of a save after acceptance keeps `orig-0`. It found one more: removing a second name from the recovery folder isn't
safe. An editor's atomic save can replace the checkout file between the check and the unlink, and the copy is then the
last name of a file a program still has open. Fixed in `110d308`: settling removes nothing but the lock and an
empty recovery folder (D40).
- **The regression** (`apply-service.test.ts`):
  - a program opens `README.md` before the apply;
  - the first link fails, so the apply rolls back, `README.md`'s original is in place again, and its copy in the
    recovery folder is a second name for it;
  - an editor renames a new file over `README.md` the moment dismissing looks at that copy, or right after;
  - the program then saves through its descriptor.
  The save is in `orig-0`, with one link left, and `README.md` holds the editor's save. Against the previous release
  the test fails as the review showed: no link left, and `orig-0` gone.
- The tests that expected Nivra's own copies removed at settlement now expect every copy kept: the service's, the
  engine's over stdio, the host's on a real engine, and the apply journey in the built app.
- **On a real engine through `rpc.ts`** at `110d308`: a shell held `greet.sh` open through apply and accept. Both
  `new-0` and `orig-0` stayed after acceptance and the lock went, the shell's later save was in `orig-0`, and
  `greet.sh` kept the change. Applying again was refused as a duplicate.
- **Mutation checks:** the writer and service, 36 of 36, each failed a test. New among them: settling removing the
  copies it kept (caught by the acceptance regression and by this one), and settling removing a missing file's
  original.
- `pnpm verify` at `110d308`: 993 tests (domain 66, desktop 288, engine 639), none skipped.
- The built app (`test:e2e`): 67 passed and 1 skipped (the packaged-only test).
- The packaged app (`test:packaged`, a runtime staged from this code): 27 passed and 41 skipped, the tests that need the
  stand-in switches. The Windows turn wasn't repeated: settling and the card's wording changed, not targets, the
  supervisor, staging, or main-process or preload behaviour.
- The review's full run had one failure, `sandbox-checks.test.ts`, which passed alone. It is Track B's rehearsal of
  `verify:windows`, unchanged here, and it races under load: it cancels once the stand-in has received the probe's
  request, not once the engine has its answer, so a cancel in between rightly reads as uncertain. Its fix belongs to
  that harness, with a Windows turn of its own.

**Not shown yet:**
- **A partial or unknown apply through the host on a real engine:** getting one takes a crash mid-write, so the host's
  partial, restore and keep tests run on the gated engine, and the writer's own tests and the kill tests show the real
  thing.
- **One live worker run, and the packaged journey through the Windows app:** checkpoint 3 (NIV-35).

### A project's environment (D41, NIV-49)

The 48-hour delivery's first step: one pinned Node and pnpm environment, prepared inside Nebius from a commit's
manifests, and task runs that start from it, with baseline checks before the model and frozen files. On
`feature/niv-49-host`, from `main` at `8ae8779`. Built in parallel: the session's compressed snapshot and its listing
(a helper, `fix/niv-49-session`), the host and the window (a helper, against protocol 12's contract committed first),
and the engine here; then an independent review.

| Commit | What |
|---|---|
| `6bd38d1` | The preparation and an image import, each journaled as one operation |
| `8560a82`, `c9c214b` | The snapshot uploaded gzip-compressed with limits a real repository fits; a prepared image's `node_modules` left out of the session's listing |
| `af22748`, `9fb57a2` | The feasibility probe, its recipe and an offline rehearsal; the install log's end only, and long operations read every 5 s |
| `c49713b`, `5c8ca8c` | Protocol 12's contract: the environment, its preview, a brief's baseline selections and frozen files |
| `f18d52a` | The preparation as a run of its own, journaled, bound to its project |
| `ed210d6` | A task run from a prepared environment, its baseline before the model, its frozen files |
| `898fdfd`, `7b05299` | Patterns matched against the whole output, and compiled on their own first; `rpc.ts` prepares; a second layout through a real engine |
| `20b1c7a` | A task run's report keeps the bounds it ran under |
| `5c4fd21`, `bd36983` | The apply hold, for recovery checks through the real engine (unpackaged only) |
| `a465d7d`, `88b066c`, `68e7693` | The host: workspace migration 5, the brief's new parts and the run fingerprint's v2, the four calls |
| `26bcbb2`, `41fa8bc` | The window: the Environment section, the brief's form, the run preview and card |
| `c5529ba` | The independent review's nine findings |
| `c491eed`, `80608bc` | Tests the criteria and mutation checks asked for: the baseline's time, and an environment from another project |
| `6ca70ca` | Nate's review of PR 23: baseline output masked in the proposal's report, one rule for filters, and a run's start claimed only from evidence |
| this record | D41, `AGENTS.md`'s boundary rule, the development notes, this section, and the stale lines in this file and `system-architecture.md` |

**NIV-49's criteria, shown:**

| Criterion | Where | What it shows |
|---|---|---|
| The account's image and preparation path, by an approved, bounded recipe | The feasibility run, 27 October 15:00 SGT (recipe `5c937f1d…`) | 15 of 15 checks in 85 s. Nebius had no public Node 22 image, so `node:22.23.4-alpine3.24` was imported (12 s) into the project, untagged; the preparation installed SHE-65's filtered workspace with pnpm 11.5.3 (125 packages, 7.7 s). Evidence: `~/nivra-acceptance/env-probe-2026-10-27T070042901Z/` |
| Dependencies prepared inside the boundary from pinned versions and frozen inputs; network declared; no host `node_modules` or credentials in the image | `environment-inputs.test.ts`, `environment-engine.test.ts`, `nebius-sandbox.test.ts` | The inputs are the commit's manifests, lockfile and workspace file, read from Nivra's own snapshot: `.npmrc` stays here, and output folders never leave. The stand-in received exactly those. The preparation is the one operation with networking on, and the preview says so; a layout that needs its sources to install is refused, naming the file |
| Reuse through Nivra's own session and overlay: dependencies survive, the source is the commit's, a fresh run inherits nothing | The feasibility run; `task-environment.test.ts` | Live, the session started from the prepared image matched the commit's listing with `node_modules` left out, ran the toolchain and the baseline, and collect gave exactly the commit. Offline, a run starts from the prepared image itself, every time; nothing a run leaves becomes the environment |
| The image's identity, platform and inputs bound into the preview, run and proposal; tags aren't identity | `task-environment.test.ts`, `host.test.ts`, the real engine through `rpc.ts` | The image's id, the inputs' digest, the Nebius project's hash, Node, pnpm and arch travel in the run's input and its report, and the run preview's fingerprint v2 binds them. A commit whose manifests changed, or credentials for another project, are refused before anything is sent. Nivra never tags an import |
| Worker and checks offline; exclusions can't hide a source change; worker writes can't alter dependencies | `task-engine.test.ts`, `task-worker.test.ts`, `task-environment.test.ts`, `nebius-session.test.ts` | Every task operation runs with networking off. Output folders are left out of the listing and collect at any depth, and any other difference refuses the session or the result. Writes into `node_modules`, to a frozen file or to a manifest the environment was prepared from are refused before anything is sent |
| The real baseline checks before inference; a missing tool stops clearly; a reproduced bug told apart from inability to run | The feasibility run; `task-environment.test.ts` | Live: SHE-65's regression failed with five AssertionError lines, as its brief expects, and the data (227 passed, 4 skipped) and domain (1,122) suites passed. Offline: a selection that doesn't give what the brief expects stops the run with no model request, naming it and why; the toolchain probe still stops a run whose program is missing |
| Baseline operations in the limits and reservations; final verification and cleanup keep their allowance | `task-environment.test.ts`, `task-engine.test.ts` | The baseline joins the operation count and the preview's bounds. After 300 s of baseline the worker's window shrinks by that much and the reserve stays whole, so collect and both final checks run; with no room left, the next selection isn't started and the run stops for time before the model |
| A second, small pnpm layout works offline with no change to Nivra | `environment-engine.test.ts`, `environment-inputs.test.ts` | A single-package repository with no workspace file is prepared the same way, through a real engine, as the workspace is |

**Checks:**
- `pnpm verify` at `7237e04`: 1,064 tests (domain 75, desktop 307, engine 682), none skipped; at `f3fa984`, the code
  first reviewed here, 1,066 (domain 75, desktop 307, engine 684); at `6ca70ca`, with `main` merged in and Nate's
  review fixed, 1,070 (domain 75, desktop 308, engine 687), none skipped.
- The built app (`test:e2e`) at `7237e04`, and again at `6ca70ca`: 69 passed and 1 skipped (`explain.spec.ts`'s
  packaged-only test), among them `environment.spec.ts`: the Environment section, the brief's form, the preview and
  the card.
- The packaged app (`test:packaged`, a runtime staged from this code) at `7237e04`: 27 passed and 43 skipped, the tests
  that need the stand-in switches a packaged app ignores.
- The real engine through `rpc.ts`, against the stand-in: an environment prepared; a task preview bound to it; an
  environment with another inputs digest, or from another Nebius project, refused at the task preview.
- **Mutation checks:** 24 of D41's rules broken on purpose, one at a time; 23 each failed a test:
  - the preparation's networking, the steps' networking (with the guard that refuses it removed, and with it kept),
    the manifests' digest checked in the worker, the project's binding, the environment's inputs held from the
    worker, output folders left out of the listing;
  - the baseline: a mismatch ignored, its output or its exit code not compared, its time guard, the reserve;
  - the review's: the preparation's slot, `pnpm:devPreinstall`, the upload's hash, a lost import searched for, the
    journal read after settling, a missing journal moved, a changed frozen file verified (`verifiedWith`);
  - Nate's review: baseline output unmasked in the proposal's report, an exclusion filter refused, a filter starting
    with `-` taken, a start claimed with no operation run.
  The twenty-fourth, the frozen files' comparison after collect, stands behind integrity, which refuses any change Nivra
  didn't write first: no run reaches it with integrity whole, so breaking it alone fails no test. `verifiedWith`'s
  unit test shows a changed frozen file is never verified. The project's binding and the baseline's time had no test
  until these checks (`80608bc`, `c491eed`).
- **The independent review** (27 October) found nine problems; each is fixed with a test that fails with its fix
  undone (D41).
- **The Windows turn:** `pnpm dev:win --no-launch`, then `test:windows`, 12 of 12 passed on the Windows build of
  `3a56d75` (this branch's code, with NIV-35's tests on top). Targets, the supervisor and staging didn't change, so
  `verify:windows` wasn't run.

**Not shown here:** a task run from the environment with the real model. That is NIV-35's live run, with its own
recipe.

### A task's journey and recovery through the real host and engine, offline (NIV-35)

The packaged journey's offline half: the steps the live run takes, and the recovery cases, on the built app with the
production engine against the stand-ins, reached through the unpackaged-only switches. On `feature/niv-35-recovery`,
stacked on `feature/niv-49-host`.

| Commit | What |
|---|---|
| `1a087bb` | A task run's recovery through the real host and engine |
| `8dba58b` | A task's whole journey from a prepared environment, through the window |
| `f094ad1` | The live run's script, `scripts/task-live.ts` |
| `31245a6` | Nate's review of PR 24: the run's preview checked against the recipe before Start, every file of the frozen build hashed, and cleanup apart from the checkout |
| `4bf14f7` | The recipe lists what the person checks in the proposal that its tests can't show |
| this record | The development notes and this section |

**NIV-35's criteria, so far:**

| Criterion | Shown offline | Still to show |
|---|---|---|
| One small change and its regression check through the UI, concurrency one, no tracker | `task-journey.spec.ts`: a task made from a saved plan, run from the prepared environment with its baseline and frozen file, verified, approved by its hash, applied and accepted; `task-apply.spec.ts` (D40): a task written directly | The live run on SHE-65, through the packaged Linux app |
| Reject leaves the checkout untouched; a revision is another attempt under the task | `task-apply.spec.ts` (D40) | Nothing more offline |
| Failed commands, provider failure, cancellation, engine loss and restart; NIV-25's shutdown | `task-recovery.spec.ts`: a cancel while the worker waits on the model, with nothing new sent after it; an engine killed while an operation goes, read as interrupted after Restart, its operation stopped by the recovery pass; a quit while an operation goes, timed at 115 ms, the run read as interrupted after a relaunch. Failed commands and provider failure: D39's engine tests (`task-worker.test.ts`, `task-engine.test.ts`) | The live run's own failures, if any, as found |
| Stale approvals refused; crashes around the apply reconcile without reapplying | `task-recovery.spec.ts`: a checkout edited after the run, then one moved to another commit, each refused in the engine's words with nothing written; an apply held before its new file is linked in, its engine killed, read back as partial after Restart, and restored. `apply-kill.test.ts` (D40) kills the writer at every call | Nothing more offline |
| Linux and Windows-to-WSL evidence naming the packaged revision and backend | Not offline | The live Linux run from the release candidate; Windows to WSL needs its own recipe and approval |
| The result, the checks run, duration, usage and remaining work; acceptance apart from run success | The card (D39 to D41), in the journey | The live run's record |

**NIV-25:** quitting while a task run's operation goes closed the app in 115 ms here (134 ms in an earlier run), and
the run read as interrupted after a relaunch, its operation stopped. That is this case only: NIV-25's own case, a held
hello run, isn't retimed here.

**Checks:**
- `pnpm verify` at `f31086a` (this branch, with `main` merged in through the environment's branch): 1,067 tests
  (domain 75, desktop 307, engine 685); at `31245a6`, with Nate's review fixed on both branches, 1,075 (domain 75,
  desktop 313, engine 687), none skipped. The five new desktop tests are `task-live-checks.test.ts`, and each fails
  with its check undone.
- The built app (`test:e2e`) at `f31086a`, and again at `31245a6`: 75 passed and 1 skipped (`explain.spec.ts`'s
  packaged-only test), among them `task-journey.spec.ts` and the five tests of `task-recovery.spec.ts`. The quit took
  115 ms, then 120 ms.
- `--cleanup` with a task file that doesn't exist now stops only at the missing freeze; before, it failed reading the
  task.
- The packaged app: these specs skip there, since a packaged app ignores the switches they need;
  `test-switches.test.ts` shows it ignores the apply hold too.
- The Windows turn: 12 of 12 on the Windows build of `3a56d75`, this branch before `main`'s test and docs changes
  were merged in.

### Mission foundation (D42, NIV-52)

Track B's first part, landed on its own so that Track C (NIV-53) builds on the same seam before the shared cut:
missions in the workspace, the shared context contract, and the one context check. On `feature/niv-52-foundation`,
from `main` at `c854b50`. Nothing in the window creates a mission yet; the mission review and its window follow in
their own PR.

| Commit | What |
|---|---|
| `4aa1aa6` | The domain contract: missions, bindings that carry titles, the mission review's packet, the specialist catalogue |
| `6a09497` | Workspace migration 6, the mission store, the context check, the conversation guards, the seeds |
| `ac01522` | The coach's catalogue entry in Track C's own words (NIV-53, comment `32ce2944`) |
| `bca7110` | The packaged and Windows store specs expect v6; migration 5's text pinned now that 6 follows it |
| `64fc1c3` | D42, the development notes and this section |
| `2b61660` | A stored composition reads back without the checks made when it was composed, so an old report stays readable; a composition's profiles must be its packet's |
| `1c27882` | The independent review's fixes: a finding stays its review's mission's, bound or not; version numbers compared; the binding parsed before it is read; the v5 to v6 migration tested |
| `8d14d80` | The record brought up to date with the review and the checks at `1c27882` |
| this record | The packaged rerun on this branch's head, and Windows validation moved to the final candidate (Nate, 28 Oct) |

**What it shows:**

| Point | Where | What it shows |
|---|---|---|
| A mission's versions are immutable, and saved only from the version the person read | `missions.test.ts` | An edit made from v1 after v2 exists is refused; an UPDATE of a stored version is refused by a trigger; the latest reads back exactly as saved |
| A task is in one backlog at most, within the limit, and leaving it changes nothing about the task | `missions.test.ts` | `already-here`, `in-another-mission`, `backlog-full` (at 50) and `gone` are told apart; a removed or deleted task's place goes; the task row is unchanged |
| A mission's conversation is never the person's | `missions.test.ts`, `host.test.ts` | It isn't listed. A trigger refuses a mission on a project's conversation or on one with messages. Sixteen conversation and plan calls refuse it and its review plans; nothing is written and no engine starts |
| Deleting a mission takes its versions, backlog, review plans and reviews, and leaves its tasks | `missions.test.ts` | Once its conversation goes, no mission row or seeded review is left; both tasks are still there, in no backlog |
| What was sent is bound by version and by title | `mission.test.ts` (domain) | `bindingDigest` is pinned, and changes with a title, a version, the order, the mission, the findings or the profiles; duplicates, malformed or foreign references and a task without its title are refused |
| The context check names a mission change and a membership removal while the brief stays as it was | `missions.test.ts` | `mission-changed` (v1 to v2) and `membership-removed` (taken out, or moved to another mission), the brief untouched each time; a finding bound without its mission still reports its task leaving that mission, and one bound to a task it doesn't name is refused; wrong version numbers and a binding with a task twice are caught |
| A rename is caught, though it makes no brief version | `missions.test.ts` | `title-changed` with one brief version; a later brief version adds `brief-changed`, each in the person's words |
| A stale suggestion saves nothing inside its transaction, while hand edits go on | `missions.test.ts` | The coach's pattern (check, then the next brief version, in one `workspace.tx`) is refused after a mission edit and writes nothing; a hand edit then saves v2 |
| The coach's view of a task's mission names only findings about that task | `missions.test.ts` | Of three seeded findings, a task gets the two naming its reference, another task its one; a brief edit shows as a change; out of the backlog, a task gets no mission and no findings |
| The mission review's packet keeps D30's text limit, and sends acceptance case names only | `mission.test.ts` (domain), `missions.test.ts` | A packet over 20,000 characters is refused, never shortened; a case's command and expected output never enter it |
| Older profiles move to v6 with every row, and every earlier table, as they were | `workspace-store.test.ts` | v1, v2, v4 and v5 files migrate with their rows and their tables' schemas unchanged (v5's with an environment's preparation); a v5 file gets no mission and keeps its conversations listed; a newer schema is refused, naming v6 |

**Checks:**
- `pnpm verify` at `6a09497`: 1,103 (domain 87, engine 687, desktop 329), none skipped. The baseline at `c854b50` was
  1,075 (75, 687, 313).
- The built app (`test:e2e`) at `ac01522`: the app, workspace and review specs, 27 passed. A run started at 22:48 SGT
  was killed by the machine's out-of-memory crash and isn't counted.
- The packaged app (`test:packaged`, after `stage:runtime linux-x64` and `package:dir`) at `ac01522`: 26 passed and
  49 skipped (they need the stub switch a packaged app ignores); `workspace-store.spec.ts` failed only on its schema
  pin, fixed in `bca7110`, where that spec then passed against the same packaged build (1 passed).
- `pnpm verify` at `bca7110`: 1,103 (domain 87, engine 687, desktop 329), none skipped.
- Reviews: a helper's review of `4aa1aa6` found that a stored composition could stop reading under a later renderer
  (`2b61660`). An independent review of the whole diff found that a finding bound without its mission escaped the
  membership check, and that version numbers and the binding's own shape went unchecked (`1c27882`). Each fix has a
  test that fails without it.
- `pnpm verify` at `1c27882`: 1,107 (domain 88, engine 687, desktop 332), none skipped.
- The packaged app again on this branch's own head, `8d14d80` (Nate asked for it before the merge): 27 passed and 49
  skipped (the stub switch), none failed. `workspace-store.spec.ts`, whose schema pin failed at `ac01522`, passed.
- The built specs weren't run again after `ac01522` on this branch: `2b61660` and `1c27882` change the composition
  reader, the context check, tests and a seed's comment, and no window or IPC code. The mission review PR's built run,
  at a commit holding all of this branch's code, passed every spec (83 passed, 1 packaged-only skipped).
- **Not run on this branch: `test:windows`**, which AGENTS.md asks for when the main process changes (the guards). By
  Nate's decision (28 Oct, 01:44 SGT), Track B's own Windows turn is deferred: one Windows staging and test run on the
  final candidate containing Tracks B and C covers it, in Track A's candidate step. Windows validation is pending on
  that candidate. Nothing here changes a target, the supervisor, staging or the preload, so `verify:windows` isn't
  needed for this branch.

### Task readiness coach (D43, NIV-53)

Track C: what a task's brief is missing, worked out without a model; the task readiness coach, one bounded call when
the person asks; and only the changes the person ticks, saved as the next brief version from the version the coach read.
On `feature/niv-53` (PR 27), from `main` at `c854b50`, with Track B's foundation (D42, PR 26) merged in up to `23dd16b`,
as it then landed on main (`fc1c98a`).
No tracker, repository or mission is needed.

| Commit | What |
|---|---|
| `31a482f`, `b20f813` | The guidance rules and their fixtures; the domain contract (packet, rendering, fingerprint, input, bounds, report, the shared input estimate) |
| `85dde71` | An edit keeps the revision it started from, and a refused save keeps its text (Nate's review of the plan) |
| `a59c3d7` | A task's attempts are its runs only |
| `c7362bf` | The coach's panel and the field diff, props only |
| `0a33d8d` | The coach's profile comes from D42's catalogue |
| `e7e0e4e` | The host's packet, preview, report check, change views, saved changes and stale words; the coachings store |
| `8db0dc2` | The engine's coach: instructions, answers, one request, the workflow |
| `83c0f28` | Workspace migration 7 (coachings); migration 6's text pinned |
| `bd832ba` | The coach as a run of its own: protocol 13, the engine's registration, `sameCoach`, `rpc.ts` |
| `1a0e39e` | The host's coach block, the bridge, and the task page's mount |
| `aafff6b`, `8c28913` | The host's tests; a v5 upgrade moves on to v7 |
| `d5f74e7` | The window's end-to-end spec |
| `7f0755c` | The independent review's fixes, and the tests it asked for |
| `d6ab221` | A question's Update waits while the title is being edited, in the end-to-end spec |
| `95f5f99` | A rename while Start is still working out what to send refuses it; a binding naming a finding twice is refused (the review's race, tested) |
| `d2f76be` | Nate's review of PR 27, finding 1: a preview is bound to the task's project and the engine target it would run on |
| `3e303c8` | Nate's review of PR 27, finding 2: a rewording names its own list's item (C for a criterion, A for an assumption) |
| `8f72b01` | Nate's review of PR 27, the window: the choices stay when a preview is refused, at most three findings, and a completed task offers no editor or save |
| `2322853` | AGENTS.md: the narrow suggestion rule (D43) |
| this record | D43, the development notes and this section |

**What it shows:**

| Point | Where | What it shows |
|---|---|---|
| What is missing, without a model, proportionately | `task-guidance.test.ts`, `task-coach.spec.ts` | A vague task gets its specific gaps; an empty one its goal and criterion; a clear small one "No basic gaps detected." with its caveat; at most three that could help, the rest counted; nothing asks for a repository |
| The preview is exactly what is sent, and sends nothing | `coach.test.ts` (domain), `host-coach.test.ts`, `task-coach.spec.ts` | One renderer makes the text; a preview makes no request, not even a model listing; case commands and outputs never appear |
| Start is bound to the preview | `host-coach.test.ts`, `coach.test.ts` | A rename, a new preference or a brief edit between preview and Start refuses it, with nothing sent, and so does a rename that lands while Start is still working out what to send; a finding ticked twice is refused before anything is stored; a task moved from a project on the local engine to one on WSL, with the same brief and packet, has its old preview refused before any engine starts, and a new one starts on WSL; the pinned fingerprint changes with the project and the target |
| A rewording names its own list's item | `coach-answers.test.ts` | A1 in a change to the criteria, and C1 in a change to the assumptions, are set aside and counted, both ways; a mixed change keeps its own items; bare numbers and the list's own letter are kept |
| One listing and one request, never more | `coach.test.ts` (engine), `coach-units.test.ts`, `task-coach.spec.ts` | Each Start makes one model listing and one forced request; a malformed, cut-off, refused, 429, 500 or timed-out answer makes exactly one; saving makes none |
| Consent, credentials and model are checked before anything goes | `host-coach.test.ts`, `coach.test.ts` (engine) | A project without sharing is blocked; a removed project is refused; a value that is now a key, already in the brief, is refused by naming the part; a model the policy can't force, or another than the one named, gets no inference request |
| The packet stays in memory | `coach.test.ts` (engine) | A private canary in the brief is in neither the stored input, the events, `mastra.db` nor the engine's log; the run's title names the brief version only |
| A reused request id is refused with any other input | `coach.test.ts` (engine) | Each part changed in turn (brief version, binding, packet, preferences, profile, allowed model) is refused, and starts no run |
| Only the ticked changes are saved, as the next version | `host-coach.test.ts`, `task-coach.spec.ts` | Two of three changes saved as v2; checks, cases, baseline, frozen files, sources, policy, state and runs unchanged; a second save of the answer is refused |
| A stale answer saves nothing | `host-coach.test.ts`, `task-coach.spec.ts` | With the brief unchanged, a rename or a move to another repository refuses the save; so does a manual save after the answer, and an answer from another version of the coach, each in plain words |
| Both or neither | `host-coach.test.ts` | A fault between the new version and the applied mark leaves neither; neither save awaits inside its transaction |
| A masked change can't be saved, and the state is the person's | `host-coach.test.ts` | A proposal holding the key is kept masked and can't be ticked or saved; a ready task stays ready |
| A coaching never stands in for a task's run | `workspace-store.test.ts`, `host-coach.test.ts` | Attempts are runs only; an undecided proposal still shows Review and blocks a run beside a newer coaching |
| Stops and guards | `host-coach.test.ts` | Moving or deleting a task while the coach answers is refused; sharing turned off, or the task's project removed, stops the coaching, with nothing sent again |
| Restart | `host-coach.test.ts`, `task-coach.spec.ts`, `coach.test.ts` (engine) | A report stays readable and savable after a restart, and its applied mark after another; a coaching left open by a quit reads back as interrupted; a start whose answer was lost is found by its request id and sent once; an engine killed mid-request reads back as interrupted, with nothing resent |
| The editor keeps its base | `task-coach.spec.ts` | An edit started before another save, then refreshed, is refused with its text kept and the conflict shown; Update FIELD keeps an open draft and focuses the field, and waits, saying why, while the title is being edited |
| Suggested checks are text | `task-coach.spec.ts` | The check copies with the keyboard (read back from the clipboard) and never joins the brief |
| The window offers only what can work | `task-coach.spec.ts`, `coach-shared.test.ts` | With three of four seeded findings ticked, the fourth can't be ticked, and a note says why; a finding that can't be sent (it holds the saved key) is refused with the choices still there to untick; a completed task's coaching offers neither Update FIELD nor Save, with the editor's reason; the window's findings limit is the domain's |
| The coach reaches nothing else | `task-coach.spec.ts` | No sandbox request, no web search, no task run; the checkout's `git status` is empty |
| Migration 7 | `workspace-store.test.ts`, `coach-store.test.ts` | A v6 file moves to v7 with every row as it was; every trigger refuses what it should; a stored binding that can't be read back still lists, cancels and settles, and blocks only the save |

**Checks on the updated code** (after Nate's review of PR 27, at `2322853`; the code as at `8f72b01`):
- `pnpm verify` at `2322853`: 1,198 (domain 98, engine 717, desktop 383), none skipped.
- The built app (`test:e2e`, the whole suite) at `2322853`: 86 passed, 1 skipped (`explain.spec.ts`, packaged only).
  The coach's spec passed 11 of 11, and also on its own at `8f72b01`.
- The packaged app (`stage:runtime linux-x64`, `package:dir`, `test:packaged`) at `2322853`: 28 passed, 59 skipped (the
  stand-in switches a packaged app ignores).
- `test:windows` at `2322853`, in a Windows recheck coordinated with Track A (28 Oct, 03:24 to 03:27 SGT). It ran under
  the shared lock, after `stage:runtime all` and `pnpm dev:win --no-launch`, once no Nivra or Electron was found running
  on Windows. 12 passed (`windows.spec.ts` 8, `workspace-windows.spec.ts` 4), none failed or skipped, and `~/.nivra`
  was as it was. This covers Track C's branch alone: candidate 3's combined build of Tracks B and C still needs its own
  Windows validation, in Track A's candidate step.
- A real engine through `apps/engine/scripts/rpc.ts` at `2322853`, against a loopback stub: the same four coachings as
  before, each with the expected listings and inference requests (1 and 1, 1 and 1, 0 and 0, 1 and none).
- Mutations at `2322853`: 21 of 22 caught, the two new guards included (the preview's project and target, and the item
  letter). The miss is the same backstop as before.
- Nate's review of `e69137c` ran `pnpm verify` there (1,196 passed, none skipped). Its two P2 findings and two UI
  follow-ups are fixed in `d2f76be`, `3e303c8` and `8f72b01`; each finding's test fails with its guard removed.
- **Not run: a live coaching.** Its helper now uses an approval once, claimed before the first request, and its tests
  cover repeated, simultaneous and interrupted launches. The recipe and its digest go to Nate for approval separately.

**Checks on the code before Nate's review of PR 27** (up to `e69137c`; earlier evidence, not rerun on the updated code
except where the list above says so):
- `pnpm verify` at `95f5f99`: 1,196 (domain 98, engine 716, desktop 382), none skipped. At `4e78000`, before the last
  two test commits: 1,194 (98, 716, 380). The baseline at `c854b50` was 1,075 (75, 687, 313), and Track B's foundation
  at `1c27882` 1,107 (88, 687, 332).
- An earlier run, at `aafff6b`, failed one test: Track B's v5 upgrade test named v6 as the latest schema. `8c28913` has
  it expect the latest, now v7, with every row as it was.
- The built app (`test:e2e`, the whole suite) at `d6ab221`: 84 passed, 1 skipped (`explain.spec.ts`'s check that only a
  packaged app ignores a switch). Among them, the coach's spec passed 9 of 9, and the execution specs (`task-run`,
  `task-apply`, `task-apply-partial`, `task-journey`, `task-recovery`) 12 of 12. `95f5f99` adds host and unit tests only.
- The packaged app (`test:packaged`, after `stage:runtime linux-x64` and `package:dir`) at `95f5f99`: 28 passed and 57
  skipped (they need the stand-in switches a packaged app ignores). The coach's three that need no stand-in passed: with
  no key, the preview shows what the coach would read and the engine refuses before any request; a project's task
  without sharing sends nothing; the coach reached no sandbox, web search or task run, and left the checkout as it was.
- A real engine through `apps/engine/scripts/rpc.ts` at `95f5f99`, on homes of its own under `~/.nivra-dev-niv53`,
  against a loopback stub: a valid answer (1 listing, 1 request, read back complete with `runs.coach`); a malformed
  answer (1 and 1, failed with its diagnostics); a packet whose fingerprint isn't the one named (0 and 0); a model the
  policy can't force (1 listing, no inference request). A cancel isn't in it: the engine's in-process test cancels while
  the request is out.
- Mutations at `95f5f99`, each guard broken alone and its tests run: 19 of 20 caught. Not caught alone: the refusal when
  the applied mark can't be set. In the same transaction a second save is refused first (the coaching reads as applied,
  and the brief isn't at the version it read), and a trigger refuses a second mark, so the guard stays as a backstop.
  Earlier, at `d5f74e7`, the end-to-end spec caught the editor's captured revision broken.
- Reviews: an independent review of `d5f74e7` found three things:
  - a finding ticked twice, sent through the bridge, could wedge the task and its project;
  - a removal stop, a lost start reply and a coaching open across a restart had no host test;
  - a race in Start, Update FIELD working over a save or another edit, and copy that claimed more than it showed.
  They are fixed in `7f0755c`, `d6ab221` and `95f5f99`. With its guard removed, the test for the finding ticked twice,
  the binding check, the race and the removal stop each fails (above).
- `test:windows` at `a8c9905` (the code as at `95f5f99`), in one offline Windows turn that Nate approved and Track A
  cleared (28 Oct, 02:42 to 02:45 SGT). It ran under the shared lock, after `stage:runtime all` and
  `pnpm dev:win --no-launch`, with no Nivra running on Windows and no engine from a test or release home in WSL
  beforehand. 12 passed (`windows.spec.ts` 8, `workspace-windows.spec.ts` 4, the store at v7), none failed or skipped.
  This includes the check that the release's WSL home, `~/.nivra`, was as it was. This turn tests Track C's branch on
  its own; the combined build of Tracks B and C still needs its own validation, on candidate 3. Nothing here changes a
  target, the supervisor or staging, so `verify:windows` isn't needed.
- **Not run: a live coaching.** A recipe is prepared, and not approved. The stand-ins prove the contract, not the coach's
  quality.

### Mission reviews (D44, NIV-52)

Track B's mission review, on D42's foundation: a mission written with no repository, a backlog and its board, a review
of up to five selected tasks by the council's specialists, findings that open the task, and stale reports. On
`feature/niv-52`, on the foundation (#26), and integrated with `main` after the coach (#27) merged. The engine mode was built in parallel by a helper on
`feature/niv-52-engine`, from the foundation's contract commit, then merged; then an independent review.

| Commit | What |
|---|---|
| `d3ff4c6` | The engine's mission mode (by the helper, from `4aa1aa6`): the packet union, the seam, the profiles' instructions, references and set-aside findings, rejected output, the model enforced before inference |
| `36b1038` | The host: the composition, refusals, the whole-packet credential check, the preview fingerprint, start in one transaction, the mission's calls and IPC |
| `fcb38e0` | The window: missions, backlog, selection, the exact preview, reports whose findings open the task, the board; `missions.spec.ts` |
| `f46f658` | The live check's recipe, its public synthetic fixture and its offline tests (not run live) |
| `7745c6e` | A mission on Windows in `workspace-windows.spec.ts`: its backlog, its preview refused with no key on the native engine, kept across a relaunch |
| `4ad3526` | The review button's own test id; a test of the start's context check inside its transaction |
| `b5fcbd7` | The preference export test's words restored after a text replacement in `36b1038` changed them |
| `51d2e68` | The independent review's engine fixes: the mission's own form, a message that masking would change refused, an unknown basis an assumption, empty findings counted apart |
| `9cfe752` | Its host and window fixes: a key across two parts refused naming both, an unreadable report's version unknown, the card's words |
| `61b4193` | Its live check fixes: the forms bound in the recipe, the model held only when every answer named it, engine homes checked by containment |
| `a46fe7c` | Nate's review of #25: the live check's approval is used once, claimed atomically and kept, whatever `--out` or `--home` says |
| `ca44e48` | The claim's place said as it is: before the checkout is checked, the key is read or anything is sent |
| `65094d7`, `1be62b3`, `9427884` | Merges of the foundation, bringing its review fixes (`2b61660`, `1c27882`) and its record |
| `ff9bba5` | `main` merged in, with the foundation (#26) and the coach (#27): both tracks' calls, the expected API as their union, and the coach's D43 and record before this one |
| `4440a57` | Protocol 14 and D44, after the coach's 13 and D43: the version, its six pins, this decision and this record |
| this record | D44, the development notes and this section |

**NIV-52's flow, shown:**

| Point | Where | What it shows |
|---|---|---|
| A mission with no repository, saved in versions; a backlog; a board of its states | `missions.spec.ts`, `host.test.ts` | Written, refused without an outcome, edited to v2; three tasks added by title; the board's Draft column holds them; a mission's conversation isn't listed |
| Up to five selected tasks, previewed exactly | `missions.spec.ts`, `mission-review.test.ts`, `host.test.ts` | The reviewers' message starts with the preview's text, byte for byte, then the preferences; it names T1 and T2, counts the other task without its title, lists the three profiles and versions, up to 3 calls, and what isn't sent. More than five, twice, outside the backlog, gone or linked to a repository are refused, nothing sent |
| Version and title binding; start only as previewed | `mission-review.test.ts`, `host.test.ts` | The fingerprint changes with a rename, a brief, the mission, a preference and the order; a start after a rename is refused and sends nothing |
| Packet limits, no silent truncation | `mission-review.test.ts`, `mission.test.ts` | Three 9,500-character contexts are refused naming the size and the longest task; two fit |
| Credentials over the whole packet | `mission-review.test.ts` (desktop and engine), `host.test.ts` | A key in a task's context or title, the mission's outcome, or a preference refuses the preview, naming the part, never the value. A private key's first line in T1's goal and its last in its acceptance criteria, or in a preference, is refused naming both parts; a first line alone isn't. The engine refuses such a message before the listing, with no request |
| Two reviewers and a chair, at most three calls; references validated | `mission-review.test.ts` (engine), `host.test.ts`, `missions.spec.ts` | Exactly the three requests; each reviewer is sent the mission's own form, which asks for `T1, T2, ...` and nothing the plan review's does, its definition pinned with the instructions; findings keep T-refs, `mission` and `backlog`; foreign references dropped and counted; a basis other than "plan" or "assumption" becomes an assumption |
| Rejected output isn't a clean review | engine tests, `host.test.ts`, `missions.spec.ts` | Two findings naming T7 and E1 fail the stage as malformed with "2 findings named nothing in the selection"; the review is incomplete; the chair is skipped; the model's references aren't repeated. Findings sent with the wrong keys (no title, no detail) are counted apart, never as over the limit, and a reviewer of only those fails its stage the same way |
| A sound selection may get no findings | engine tests, `missions.spec.ts` | Complete, with "Raised nothing material. That isn't an approval" |
| The model enforced before inference | engine tests, `mission-review-live.test.ts` | A packet naming a model the listing lacks fails with no chat request; the live script's stub run holds the approved model, fails its evidence when an answer names another, and calls it unknown, never held, when the answers name none. Its recipe binds the forms with the instructions; an engine home inside `~/.nivra` or `~/.nivra-dev` is refused before the key is read |
| One approval is one paid run | `mission-review-live.test.ts` | Of six launches started together with one approval, exactly one claims it (its own process, in the claims folder) and the other five stop before any key is read or evidence made. A launch killed after claiming leaves its claim; a relaunch with another `--out` and `--home` is refused; `--plan` moves on to run 2's digest. Both fail with the claim removed |
| Findings open the existing task editor; a hand edit saves | `missions.spec.ts` | T1's chip opens Store runs' page; Edit brief saves v2 |
| Stale reports, readable | `host.test.ts`, `missions.spec.ts` | After a brief edit and a rename, the report names both changes and keeps its findings |
| Persistence across restart | `host.test.ts`, `missions.spec.ts` | Reopened after a restart and a relaunch: every review, its stale lines and the board, with nothing sent again |
| Saved-plan review unchanged | the engine's plan-mode tests, `council-eval.test.ts`, `review.spec.ts` | Unchanged and passing; the council-eval approval digest is still `c3b9225a…` |
| No execution, uploads or external writes | `missions.spec.ts`, `host.test.ts` | Only the council's requests reach the stub; no task leaves draft; no run starts |

**Checks:**
- `pnpm verify` at `61b4193`: 1,147 (domain 90, engine 710, desktop 347), none skipped. At `1be62b3`, before the
  independent review's fixes: 1,142. The foundation at `1c27882` had 1,107; main at `c854b50`, 1,075.
- The built app (`test:e2e`, every spec) at `61b4193`: 83 passed and 1 skipped (`explain.spec.ts`'s packaged-only
  test, which skips outside a packaged app). The missions spec's 8 tests passed among them.
- The packaged app (`test:packaged`, after `stage:runtime linux-x64` and `package:dir`) at `61b4193`: 31 passed and 53
  skipped (the 49 skipped on main and the foundation, and 4 missions tests that need the stub switch a packaged app
  ignores). The missions spec's other 4 passed packaged: a mission and its board, a repository-linked task refused,
  the preview refused with no key before any request, and deleting a mission.
- A real engine (`rpc.ts`, a fresh home under `~/.nivra-dev-niv52`) at `61b4193`, against a loopback stub: a three-task
  mission review completed with exactly three chat requests; a private key split across T1's goal and its acceptance
  criteria was refused in the context step, before the listing, with no request. The engine helper's run at `d3ff4c6`
  showed a named model the listing lacks refused with no chat request.
- An independent review by a fresh agent at `1be62b3` found four defects and eight smaller points, all fixed in
  `51d2e68`, `9cfe752` and `61b4193`. Each fix has a test that fails without it; three were shown by undoing the fix.
- Nate's review of #25 (28 Oct): one finding, the live approval reusable, fixed in `a46fe7c`. `pnpm verify` there:
  1,150 (domain 90, engine 713, desktop 347), none skipped. The two claim tests fail with the claim removed. After the
  wording fix in `ca44e48`, the live check's tests again: 10 passed. Only the live script and its test changed since
  `61b4193`, so the built and packaged runs above still stand for the app.
- **Not run on this branch: `test:windows`**, which AGENTS.md asks for when the main process or preload changes. By
  Nate's decision (28 Oct, 01:44 SGT), one Windows staging and test run on the final candidate containing Tracks B and
  C covers it, in Track A's candidate step, including `workspace-windows.spec.ts`'s mission test (`7745c6e`). Windows
  validation is pending on that candidate. Nothing here changes a target, the supervisor or staging, so
  `verify:windows` isn't needed for this branch.
- **On the integrated code, `4440a57`** (Nate asked for the checks after `main` was merged in):
  - `pnpm verify`: 1,241 (domain 100, engine 743, desktop 398), none skipped.
  - The built app, every spec: 94 passed and 1 skipped (the same packaged-only `explain.spec.ts` test). The missions
    spec's 8 tests and the coach spec's 11 passed among them.
  - The packaged app, after `stage:runtime linux-x64` and `package:dir`: 32 passed and 63 skipped. The skips are the
    53 skipped before and the coach spec's 10, all needing the stub switches a packaged app ignores.
  - A real engine through `rpc.ts`, on protocol 14, against a loopback stub: a three-task mission review completed with
    exactly three chat requests; a key split across two parts was refused in the context step, with no request.
- **Not run: the live check.** Nate deferred it until after the integration. Its recipe and digest for the revision
  to be tested are printed apart from this record, since a digest bound to a commit can't be written into it. The
  digest printed at `68a49df` is withdrawn. No paid call was made.

### NIV-35's live runs, and the candidates they ran on (D46, D47)

The live packaged journey on SHE-65, on Linux, each run approved by Nate by its recipe's whole digest. Evidence is
credited to the exact build it ran on: no run below is evidence for a later candidate. These runs used an unpublished
revision of Nate's own public repository, including frozen acceptance tests: this record names its files and hashes,
never the unpublished changes or the frozen tests.

**The candidates** (version 0.2.0, unpublished; each built once by `pnpm release:candidate`, with `pnpm verify`
inside it, then checked file for file against its build-info and frozen before use):

| Candidate | Commit | What it adds | deb | zip | build-info |
|---|---|---|---|---|---|
| 1 | `570dd14` | Version 0.2.0; the task model rule (D46) | `8c33d15babccc77c79dd9593cb793ea7c452ae09d67129872b618f2e3623742c` | `ba17bd774132e95ca7e084aa9733a9031f1115b95ac73e7006a5fddc4b54b50e` | `c44a978d73784914f3af22839529556f474053263d91a551deeecce6d451aeed` |
| 2 | `77558d9` | Search, the allowances raised together and told (D47's first half) | `22b142a66586649fdfc098b2f84bde146516498f2f8e0a952f78bffa7d478cc6` | `ff43e88a21ffdf78bf95da8f18cf0d75b130543ed9ea4adaaba1d76494d9a544` | `1327104795be397e0400c57b2623f00e51f60f2f9494ba9b2e9fd281c591e7dd` |
| 3 | `c99fe9d` | Each request's whole answer's time, the engine's fetch (D47); D42 to D44 from main; staging that matches the packager | `e022ed4fb3c009999a50eb0782f8e35c049c655f67c89f04e331ee5622b1b2d1` | `0f385b638be6992909da286a835daaac50786ad276e74b0c911fd9644950484a` | `2e0724a3216c25b9a86dbd2f2fe24a0c2c7ef8efe619723ccb9e0345248a4019` |

Checks on each, at its own commit:
- Candidate 1: verify 1,078 (domain 75, engine 689, desktop 314), none skipped; the correspondence check 18 of 18;
  the rehearsal on the frozen build; `test:packaged` 27 passed and 49 skipped (the stand-in tests); the built e2e 75
  passed and 1 skipped; `verify:windows --zip` 37 of 37; `test:windows` 12 of 12.
- Candidate 2: verify 1,093 (75, 704, 314), none skipped; the correspondence check 18 of 18; the rehearsal;
  `test:packaged` 27 passed and 49 skipped; the built e2e 75 passed and 1 skipped; `verify:windows --zip` 37 of 37;
  `test:windows` 12 of 12. Mutations: 18 of 18 caught.
- Candidate 3: verify 1,279 (100, 779, 400), none skipped. Staging left out only undici's empty
  `lib/llhttp/.gitkeep`, which the packager never copies, and the check that what was packaged is what was staged
  passed for both runtimes (Linux `243e80bf38451c39`, Windows `982edbd3e39bd053`). The correspondence check 18 of 18;
  the rehearsal on the frozen build (3,943 files, `df85337178b9…`); `test:packaged` 32 passed and 63 skipped, with the
  build hashed again afterwards and unchanged; the built e2e 94 passed and 1 skipped; `verify:windows --zip` 37 of 37;
  the zip as Windows' `tar.exe` extracts it holds the built `Nivra.exe` and `app.asar`, byte for byte; `test:windows`
  13 of 13. Mutations, on its change at `986f50c`: 23 of 24 caught, and the one missed changes no behaviour.

**The live runs** (each one preparation and one task run; nothing retried; each window's keys removed and both homes
checked unchanged afterwards):

| Run | Candidate | Digest approved | When (SGT, 28 Oct) | Outcome |
|---|---|---|---|---|
| 1 | 1 | `494869740e251708f04fc3b2dd9957c41874e0fbf1b328b0bb7779c7f6c9939a` | 01:48 to 01:52 | Unchanged. The worker used all 12 requests finding its way and handed in with no write. |
| 2 | 2 | `9a3061b2969e242228773440737f521f2cfb1bb581a8f2764ff44dd6a35433f3` | 03:12 to 03:17 | Unchanged. Six requests found and read the code in 18 s; the seventh had no answer at 150 s, so the attempt ended for time, with no hand-in and no write. |
| 3 | 2 (its recipe's second run) | `761f963bf547aecb6a3481ee91a716bae45938e290db3ab7b53204af169814c9` | 03:26 to 03:35 | Proposed, not verified: case 1 failed with the same five SHE-65 assertion errors as the baseline. The eleventh request had no answer at 150 s. Nate rejected proposal `fcacce1dd2c701b466e513a9e0b2e7cecfa88510bc9518fa7743eba264a7958c` at 08:12:41. |
| 4 | 3 | `fa9c532399cd03df6b43c3f23cf9c44ad349951385b781418a363580abba2017` | 18:20 to 18:32 | Proposed, and verified by the acceptance cases alone. The configured acceptance suites passed, but the repository typecheck failed with three new errors. An AI review identified the broken caller before Nate's decision. He rejected proposal `8a689c333e771ffca51c9267de1916a436f2419dd870082c4028535e2829b6e7` at 18:48:10, and his checkout remained unchanged. Not a fix. |

- **Each run:**
  - The preparation was real: images `e3caf555-4e63-446c-87d5-0d2854c0e02f`, `1981de1c-7489-4275-bfa8-e6f05d1a343f`
    and `d2278a86-7d3b-4f8b-a872-844eaed4a162` for runs 1 to 3; run 4's is in its evidence.
  - The model was `nvidia/nemotron-3-super-120b-a12b`.
  - Baselines A, B and C came out as the brief expects.
  - The frozen files came back unchanged.
- **Usage, as reported:**
  - Run 1: 133,304 input and 2,062 output tokens.
  - Runs 2 and 3: unknown, since one request in each never reported. Run 3's ten reported requests come to 157,697
    and 3,935.
  - Run 4: 436,012 input and 7,395 output tokens, all 20 requests reported.
  - Cost: never reported, so it isn't shown.
- **Run 3's timing, from the engine's events:**
  - Requests 8 and 9 wrote code: 1,573 tokens in 85.7 s and 634 in 58.5 s. Request 4 had given 580 in 3.8 s.
  - The 11th request's 150 s, and 11.7 s that the record doesn't account for, ran from 19:31:38.118Z to 19:34:19.856Z.
- **Run 4's timing:** a work window of 1,939 s, with 730 s kept for collect and the final checks. Its longest request
  answered 3,086 tokens in 156.1 s and completed, past the 150 s at which runs 2 and 3 stopped. The worker handed in
  when the input budget had room for the hand-in only.
- **What isn't known:** whether runs 2 and 3's last requests were producing long answers or were held up before they
  began. Requests aren't streamed, and a stopped one reports nothing. A request held for candidate 3's full 830 s
  hasn't been seen: run 4's longest took 156.1 s.
- **Run 4's review, what its cases couldn't show:** the change added a parameter to the function that reads earlier
  bests and converted each earlier load into it, but left the one existing call as it was. When it runs, that
  parameter is missing, so a load in the same unit would be converted anyway and give wrong records. SHE-65's
  acceptance tests all mix units, so they passed. The repository typecheck caught it: three new errors in
  `completion.ts` (TS2339, TS2322 and TS2554, the last at the unchanged call). Repository checks are reported and
  never decide (D39), so the change counted as verified. Recorded as NIV-67: verification that counts required
  repository checks.
- **Reject, shown live:** after the Rejects of runs 3 and 4, `git status` and `git diff` of the checkout were empty,
  and it stayed at `0341b253` on `nivra/she-65-baseline`. After run 4's there was no stash and no recovery folder
  either.
- **Evidence:** `~/nivra-acceptance/task-live/live-20261027T174800Z`, `…191225Z`, `…192632Z` and
  `…20261028T102049Z`, each with the recipe, the previews, the attempt, the final views and the stores: copied with
  their WAL for runs 1 to 3, and for run 4 as the closed app left them, its final views captured off-screen from a
  copy. A shape scan of each, outside its profile and engine home, found no credential; a Token Factory key has no
  shape, so Nate checks for his key himself.

**Offline, for candidate 3's change (D47):**
- Node 24.21.0's own fetch: a reply at 285 s came back, and one at 310 s failed at 301.2 s with
  `UND_ERR_HEADERS_TIMEOUT`.
- Through a real engine process at `672cd12`, with the stand-ins:
  - a reply 310 s after the request was received, the step recorded at 310.1 s, and the run proposed;
  - a cancel 5 s into a held request ended the run as cancelled at 5 s.

**NIV-35's criteria, now:**

| Criterion | Shown | Still to show |
|---|---|---|
| One small change and its regression check through the UI | Offline (above); live runs 1 to 3 reached the proposal, unverified; run 4's proposal passed every acceptance case, but the repository typecheck failed and review found the broken caller, so it was rejected | A verified SHE-65 change, approved by its hash, applied by its engine and accepted, on the packaged build |
| Reject leaves the checkout untouched | Offline, and live after runs 3 and 4 | Nothing more |
| Linux and Windows-to-WSL evidence naming the packaged revision and backend | Linux: runs 1 to 4, on candidates 1 to 3, with Nebius Sandboxes | Windows to WSL live needs its own recipe and approval; native Windows refuses task runs (D39, D41) |

### Project-driven environments, PR 2 (D48, NIV-55, NIV-58, NIV-59)

A project's own recipe prepared in Nebius and used by its task runs, through the engine, the task touch points, the
host, the store and the window, offline. On `feature/env-node`, stacked on PR 31 (`feature/env-recipe`, the recipe
contract and Node's resolver, with both of Nate's reviews of it fixed), with main `ab82e91` merged in through it. An
independent review of the engine half came before the host half, and Nate's second review is fixed here.

| Commit | What |
|---|---|
| `f1ffabf` | The recipe's preparation: `environment.resolve`, the inspect step before any upload, the bootstrap and frozen install, the builds pnpm reports, readiness offline, the verified record; protocol 16 |
| `ff62fbf` | Task runs from a recipe's environment: sessions from its image with its task variables, setup files held and digested after collect, environment-missing; a tracked file is source wherever it is |
| `7fc1ac3` | The independent review's twelve findings, each with a test |
| `2d3e875` | The store: a recipe's setup and environment, D41's as legacy, workspace migration 8 for an acceptance of missing builds |
| `a158563` | The host: resolve, prepare with choices, readiness, legacy, fingerprint v3 |
| `a433abd` | The window's calls: `resolveEnvironment`, `prepareEnvironment(choices)`, `acceptMissingBuilds` |
| `b61d95c` | The environment panel, the run preview and card; the journey shared by the e2e test and the live run |
| `1e5043f` | The live run's recipe kind v2 |
| `4ee0749`, `3f97abd`, `3426c83` | The stand-ins list the workspace as readiness does; a chosen version kept as the person's; the environment e2e journey through the recipe panel |
| `39f0d30` | The panel says plainly why a preview's recipe differs from the environment prepared |
| `f069d22`, `14868f2`, `040c09a` | PR 31's head merged in: with main `a902bc8`; then with Nate's review of PR 31 fixed (`63c9467`); then with main `ab82e91` (`9fbb673`) |
| `665716e` | Nate's second review: a setup file that is a link is refused at the task preview and before a run sends anything |
| `de135f2` | Nate's answer on the wording: a preparation stopped by a rule for what task runs send says so, after the file it names |
| `06c9e3a` | PR 31's head with its second review fixed (`f80ea3e`, brace expansion's work limited) merged in |
| `d3ca694` | Main `0ac03d3` (PR 31 merged) merged in, with no file changed: its tree is `06c9e3a`'s |
| this record | D48, `AGENTS.md`'s boundary rule, the development notes and this section |

**What it shows, offline:**

| Criterion | Where | What it shows |
|---|---|---|
| Another ordinary Node project prepares with no code written for it | `environment-recipe-engine.test.ts`, `host.test.ts` | A pnpm workspace on the Node its `.nvmrc` pins and an npm project on another Node, with the npm its image bundles, go through the same flow and nothing in Nivra names either |
| Missing declarations, conflicts and incompatible requirements | `environment-node.test.ts` (PR 1), `host.test.ts`, the window | A labelled default, a choice the person makes (never made for them), or a refusal that says what to do; a chosen pnpm that differs from the pin is installed with npm, where corepack can't swap the pin back in |
| A setup failure, told in Nivra's words | `environment-recipe-engine.test.ts`, `environment-prepare.test.ts` | An install that fails keeps nothing and keeps its log's end; a known failure (ERESOLVE, a lockfile out of step, unapproved pnpm builds) says what to change; an image that doesn't hold the recipe's Node or libc stops before any upload; a readiness check that fails offline keeps nothing |
| No installs during tasks or checks | `environment-recipe-engine.test.ts`, `task-environment.test.ts` | Readiness confirms pnpm reads the switches that stop installs before a run and version changes; every task command carries them, with corepack's downloads off |
| Builds the policy didn't run are found before an environment is ready | `environment-recipe-engine.test.ts`, `host.test.ts`, `environment-store.test.ts` | pnpm's own report (10.1 and later), or npm's install scripts under ignore-scripts; no task run starts until the person accepts it without them, for that verified record, or prepares again |
| Requested and verified identity bound to runs | `task-recipe-engine.test.ts`, `tasks.test.ts`, `host.test.ts` | Fingerprint v3 binds both digests, the image, the setup files, the Nebius project and the target; a different verification makes a new record and a new fingerprint |
| Tracked files are never hidden by an output folder's name | `snapshot.test.ts`, `patch.test.ts`, `prepared-image.test.ts`, `task-environment.test.ts` | A tracked `dist/` is sent, editable, and its new files enter the change; an untracked one's are generated; a commit that tracks files in a folder its environment leaves out is refused before anything is sent. The secrets deny list and the engine-home exclusion are unchanged, inside such folders too; the preferences store is the host's own and never in a commit Nivra reads |
| D41's records | `environment-store.test.ts`, `host.test.ts`, `workspace-store.test.ts` | Read as legacy, "Prepared by an earlier version of Nivra. Prepare it again to use it.", and never a run's environment; migration 8 keeps every row |
| A setup file is a file when a run starts (Nate's second review) | `task-recipe-engine.test.ts`, `task-environment.test.ts` | A commit whose package.json is a link to a file named `{}`, whose setup digest matches an environment prepared from a package.json holding `{}`, is refused at the task preview ("This commit's "package.json" is a link…") and before a run sends anything (nothing run, no model request) |
| A preparation's refusal names its stage | `environment-recipe-engine.test.ts` | A credential-shaped string or a file over 2 MiB stops `environment.resolve` with the file named and "Task runs send the whole commit, and this one can't be sent: … Preparing the environment would upload only its setup files, but no task run could start from this commit, so Nivra doesn't prepare it either." Other refusals keep their words |
| Setup files read as the package managers write them (PR 31, with Nate's review) | `environment-node.test.ts`, `environment-releases.test.ts` | Workspace patterns with brace lists and `?`; lockfile entries in either YAML style; a chosen version checked against the project's Node and lockfile as a pin is; each pnpm 10 build setting from the version that reads it, where it reads it. A pattern or an entry Nivra can't read is refused, never passed over |

**Through a real engine** (`apps/engine/scripts/rpc.ts` at `040c09a`, offline, in a home of its own under
`~/.nivra-dev-niv55`; nothing installed, no repository script run): `environment.resolve` on nine local repositories,
each a clone at its commit. Two are ready. humin (`1712af4`) resolves to Node 24.22.1 from its `engines.node` (`>=20`)
and Nivra's labelled default of pnpm 11.28.9, recipe digest
`cd775674cff7867acf6ae5be8c30bdf6bb5be6e115cd93c8022c4d0582aac322`. valhalla-fitness (`3c3c5d7`), a pnpm workspace of
six packages, resolves to Node 22.23.4 from its `.node-version` (`22`) and its packages' ranges, and pnpm 11.5.3 from
its `packageManager`, with esbuild's build allowed, recipe digest
`6c0d7474c67c4877f0d4c51651ca15d4f4ff6fd81e5fc225a7dc54580f0eb0a3`. Seven are refused, each saying what to do: three
because test files hold credential-shaped strings (sentiment-hound, hird-orchestration and Nivra itself), two because
one file is over the 2 MiB Nivra sends (xc-mvp, portfolio-website), and two because they have no lockfile (nivra-sample,
nivra-demo-timer). These are resolutions, what preparing would send; nothing was prepared. The answers are in
`~/nivra-acceptance/niv55/survey-040c09a/`, and the same nine gave the same answers at `39f0d30`, before PR 31's fixes.

**Checks**, at `06c9e3a`, the code this records, under the shared lock:
- `pnpm verify`: exit 0, 1,396 tests passed (domain 105, engine 883, desktop 408), none failed, skipped, cancelled or
  todo, and all three typechecks clean.
- The built app's end-to-end suite under xvfb: 94 passed and none failed; 1 skipped, `explain.spec.ts`'s "a packaged app
  ignores the test endpoint switch…", which runs only against a packaged app.
- `test:packaged`, after `stage:runtime linux-x64` and `package:dir`: 32 passed and none failed; 63 skipped, each
  needing a test-only switch (a stand-in endpoint or engine) that a packaged app ignores by design: task-coach 10,
  research 9, workspace 7, review 7, task-recovery 5, explain 5, missions 4, task-apply 3, sandbox 3, research-journey
  2, research-cancel 2, environment 2, and task-run, task-journey, task-apply-partial and d20 one each.
- Neither `~/.nivra` nor `~/.nivra-dev` changed during them.
- Mutation checks on the guards: `mutate-pr36-review.mjs` (sha256
  cfb26adc08607067b6e1e11858a5d67786711c3be9efd5cc24142114302a3b04), 3 of 3 caught; `mutate-pr2b.mjs` (sha256
  93b22612432ab78547bfddd4ac8e6ce84a36acadbc7d8b31e2261214108f184e, its two targets on the lines this review changed
  updated), 22 of 23 caught, the one missed ("a changed setup file still verifies") unreachable through a run;
  `mutate-pr2c.mjs` (sha256 5b6858ccb5e9a1d414388a51bb039e22f00c5f998ea0ba68891fcbfa574bb405), 14 of 14 caught at
  `040c09a`, with no host or window change since.
- Each fix of Nate's second review was first shown failing on the code before it: the preview was ready and the run
  proposed a change after 9 commands and 4 model requests (`~/nivra-acceptance/niv55/pr36-symlink-before-fix.log`); the
  wording test failed on the old words (`pr36-stage-wording-before.log`).
- The Windows checks (`verify:windows`, `test:windows`), approved by Nate on this revision: at `d3ca694`, whose tree is
  `06c9e3a`'s with main merged in: `stage:runtime all`, then `verify:windows --skip-stage`, 37 of 37 checks passed on
  Windows (the native and WSL engines); `dev:win --skip-stage --no-launch`, then `test:windows`, 13 passed, none
  skipped, none failed; no `Nivra.exe` was left running, and nothing under `~/.nivra` changed.

**Still to show:** the live checks, each on Nate's approval of its own recipe and digest (`task-live.ts`'s recipe kind
v2): L1 a pnpm workspace on Node 22, L2 an npm project on the default Node, L3 an install that fails. L2's planned
repository, portfolio-website at `e981144`, holds five files over the 2 MiB a task run sends for one (three demo videos,
`game-ui-update.html` and a 2.4 MB test fixture; the refusal names the first it meets), so Nate chose another npm
repository, preflighted offline. A candidate: tj/commander.js at `ba6d13ddb4243e5913367734f8c159089ffe7834` resolves
ready at `06c9e3a`: Node 24.22.1 from its `engines.node` (`>=22.12.0`), the npm that Node bundles, `package-lock.json`
format 3, `npm ci`, registry.npmjs.org only; recipe digest
`29cefc6366d725dd17f58f78e3dab1c3c021cde653b9a480f8fc8fef2fca80ce` (`~/nivra-acceptance/niv55/l2-preflight/`), to be
computed again by `task-live.ts` on the build that runs it. PR 3 (source-dependent setup, system
packages, Debian) is a decision for Nate.

### The shared monthly budget's ledger, PR 1 (D49, NIV-66)

Lane C's PR 1 for NIV-57: the budget's contract, the host's ledger, its guard and the six calls the budget screen and
the evaluation harness will both use. Backend only, and nothing spends through it yet. On `feature/budget-ledger`, from
`main` at `a902bc8`. Tested at `cb422f2`: Nate's findings at `529321d` and both of his choices, with main at `9b9728a`
merged in. The commit after it adds only docs.

| Commit | What |
|---|---|
| `5ed855a` | The contract and today's price list; the ledger (migration 8 then; 9 since main took 8), the guard, the host's block and the six calls; the tests; the schema pins move to 8 (now 9) |
| `b796823` | The first independent review's fixes, each with its test |
| `42c9c47` | The second independent review's fixes, each with its test |
| `40b7564` | D48 (now D49), AGENTS.md's rules, the development notes and this record, with the checks at `42c9c47` |
| `bb451ee` | Nate's review of `40b7564`: a lost history's restriction holds through its recovery month, with regression tests |
| `662efbc` | Main (`ab82e91`) merged in |
| `529321d` | D48 and this record for the recovery-month fix, with the checks at `662efbc` |
| `0c4a71c` | Main (`b795bec`, PR 36) merged in: the budget takes workspace migration 9 and D49 |
| `0ee515a` | Nate's review of `529321d`: the guard keeps the latest established month; his choice (b): a dollar budget the price list can't keep is refused |
| `e4ba2d6` | Guard records from before months were kept are read, recovery and all; the host's records of the month tested |
| `45223d4` | His choice (b) on the price-list rule: with the budget off, a model the list doesn't have is admitted, counted and unpriced |
| `6574aee` | Main (`9b9728a`, PR 37) merged in |
| `4b28fe0` | The independent review's points: the guard's month never goes back, old records keep their protection, listings must be free for a dollar budget |
| `cb422f2` | Each layer of the guard's month pinned by its own test |

NIV-66's checkpoints, as this PR leaves them:
- **Checkpoint 1, the contract:** done. Money in integer micro-units, rounded up per request; presets as starting
  points; immutable policy versions, which can turn the budget off; grants, journal rows and seals; months; recovery;
  and a summary that shows unknown money as null, never 0.
- **Checkpoint 2, the ledger:** its core is done: one synchronous transaction per grant, release only on affirmative
  evidence and only on the ledger the guard verified, journal rows worked out again, months only on the provider's
  clock or the person's word, and the guard. The reconciler and the engine's journal come with PR 2a.
- **Checkpoint 3, every paid activity:** not started. Model calls come with PR 2a, Tavily and Nebius with PR 2b.
- **Bounds, currency and listings:** not established, so no budget in dollars can be set: today's mode is "Budget off,
  existing per-run limits apply".

Nate's finding at `40b7564`, and its fix in `bb451ee`: a backup from an older month, put back, took the new history's
restriction to that old month, and confirming the real month bypassed it. The restriction then held through the
recovery month. Its regression tests stand, now taking the guard's month as their evidence (below).

Nate's finding at `529321d`, and its fix in `0ee515a`, `e4ba2d6` and `4b28fe0`: the recovery month still came from
clocks. His case: the ledger entered November and was spent in; the computer's clock moved back to October, and a
policy saved then wrote October's time into the guard's last record; October's backup was put back and wait or zero
left was chosen; once provider time established November again, a grant was admitted. The month was the latest of the
ledger's, the computer's and the guard record's time, and all three said October. Now every guard record keeps the
latest month the ledger established, never earlier than one the guard has read or written and never read from a
clock; a recovery carries it; and the new history's restriction, and its records, hold through it (D49). A guard record
from a review build before months were kept falls back to the clocks that build read, and the guard catches up with
the ledger's month at the next start. Its regression tests:
- `budget-guard.test.ts`, "the latest month a lost history established, kept by the guard whatever the computer's
  clock says", on real files:
  - his case, the computer's clock moved back (November spent in, a policy saved at October's time, October's copy put
    back), and the provider's clock ahead of the computer's (November opened and spent in with every guard record
    written at October's time). Each runs with a wait, nothing left, and a finite allowance with Nebius operations, and
    each is refused once the provider's clock shows November again with the computer's still in October: a wait for a
    model call and a Nebius operation; nothing left as "pool" and "counted"; a finite allowance once it is used up. All
    are freed in December;
  - a second loss after the recovery, from a copy holding neither November nor the first loss, with each choice: only
    the guard remembers November, and the restriction holds through it;
  - a guard lost after the recovery, rebuilt from the new history's ledger, still names November;
  - the guard never names an earlier month than one it has read or written, record by record, and reads back the
    latest month any whole record named; a record written before months were kept is read, recovery and all.
- `budget-store.test.ts`: the recovery month's tests take the month the guard kept; "never takes a month from a clock"
  (a month the lost history never reached is its own); the fallback for records with no month; the latest month the
  ledger established.
- `host-budget.test.ts`: the month the host records, with the computer's clock run 70 days ahead; and the guard catching
  up with a month opened after its last record.
- Shown failing on `529321d`'s logic (its `budget-store.ts`, `budget-guard.ts` and domain `budget.ts`, with the new
  tests and the new lookup standing in as "no month"; `~/nivra-acceptance/niv57/regressions-on-529321d-logic.log`): the
  three cases fail where Nate's did, with a model call and a Nebius operation "granted" once November is established
  again, and the old guard keeps no month.

Nate's choice (b), with the fix: a budget in dollars that can't be enforced is refused clearly, with no other policy put
in its place. `setPolicy` takes the price list new grants are priced with, and sets a budget in dollars only when the
list's currency, every model's bounds and free listings are established. Otherwise the call is refused, saying which is
missing and what to do; nothing is saved, and the budget in force stays as it was. Turning the budget off stays the
person's own choice, and the grant-level refusals stay. Today's list establishes none of the three, so the app refuses
every budget in dollars today. Its tests:
- `budget-store.test.ts`, "a budget in dollars": refused with today's list (the exact words, nothing written); refused
  with one model's bounds missing (naming it), with the currency missing, and with listings unknown or charged; set
  with a test list, its grants kept within it; never turned off or switched to counts alone when a change can't be
  kept, with the grant-level refusal still in place; counts alone as the person's own choice.
- `host-budget.test.ts`: refused through the host with today's list, saving and recording nothing, with the summary
  naming the gaps and the budget off still available; a budget saved under a test list kept as it was when a change is
  refused with today's list, and turned off only by the person.
- `budget-api.spec.ts` (built and packaged): refused through `window.nivra` with today's list; the budget off; a month
  confirmed by its label and kept across a relaunch; a damaged history blocking every change.
- Three of the store's five failed on `529321d`'s logic ("Missing expected exception"); the two that passed there
  describe what the old code already did.

Nate's choice (b) on the price-list rule, in `45223d4`: with the budget off, a call to a model the price list doesn't
have is admitted, written and counted, its requests and reported tokens recorded, and its money unknown, never 0. Under
a dollar budget it is refused by name. Money the person set after a loss still holds it. Its tests, in
`budget-store.test.ts`: Nemotron 3.5 Super VL admitted with the budget off, through a journal and the summary; with a
listed model beside it; off again after a dollar budget; refused by name under a dollar budget; and refused after a
loss with money left.

The independent review of `0c4a71c..e4ba2d6` found nothing blocking; its points are fixed in `4b28fe0` and `cb422f2`
(above). One is named rather than fixed: deleting the guard after a loss was found, before it was resolved, clears the
recorded recovery (D49's known limits).

Passes, at `cb422f2`, one at a time under the shared lock:
- `pnpm verify`: 1,527 passed (domain 125, engine 883, desktop 519).
- Built e2e (`test:e2e`, under `xvfb-run -a`): 95 passed, `budget-api.spec.ts` among them.
- Packaged (`stage:runtime linux-x64`, `package:dir`, then `test:packaged`): 33 passed, `budget-api.spec.ts` among them.
- `test:windows`, after `pnpm dev:win --no-launch`, in the Windows turn on this revision (29 Oct, 00:52:57 to 00:55:10
  SGT, each step taking the lock as it queued, from this lane's worktree): 13 passed (`windows.spec.ts` 8,
  `workspace-windows.spec.ts` 5), among them `windows.spec.ts:224`, "the release's WSL home, ~/.nivra, is as it was,
  and this run's own home goes". `tasklist` showed no `Nivra.exe` before the turn or after it, and fingerprints of
  `~/.nivra` and `~/.nivra-dev` (each file's name, size and modification time) were the same before and after. The
  Windows suite has no budget test of its own: it shows that the Windows build, with these main and preload changes,
  passes the suite it has.
- Mutations, each of the PR's 87 safety claims broken alone and its test file run: 87 of 87 caught. Five were caught
  only by a deeper layer, a trigger or schema check refusing the write before an assertion could: a grant that may
  have been sent released, an interrupted seal settling, a grant's day going back, and the provider's clock or the
  person opening the current month again.

Skips, apart from the passes, at `cb422f2`:
- `pnpm verify`: none.
- Built e2e: 1, `explain.spec.ts:197`, "only a packaged app ignores the switch": it runs only in the packaged project.
- Packaged: 63, each a test that needs a test switch a packaged app ignores, as the JSON report gives them.
- `test:windows`: none.
- Not run, and not needed: `verify:windows`, since nothing here changes a target, the supervisor or staging; and
  `rpc.ts`, since there is no engine change. No live check: nothing here sends anything.
- Not shown: a budget screen. The calls are proven through the built, packaged and Windows app's `window.nivra`, not
  through a screen; the packaged user journey needs its own check once NIV-56's design is built.

Earlier runs:
- At `662efbc` (the head Nate reviewed as `529321d`): verify 1,381 passed; built e2e 95 passed, 1 skipped; packaged 33
  passed, 63 skipped; `test:windows` 13 passed; mutations 62 of 62.
- At `42c9c47`: verify 1,375 passed; built e2e 95 passed, 1 skipped; packaged 33 passed, 63 skipped; `test:windows` 13
  passed; mutations 56 of 56.
- At `5ed855a`: verify 1,342 passed; built e2e 95 passed, 1 skipped; packaged 33 passed, 63 skipped; mutations 23 of 23.
- At `b796823`: verify 1,363 passed; built e2e 95 passed, 1 skipped; packaged 33 passed, 63 skipped; mutations 43 of
  43 (the first run caught 40: three trigger tests failed for the wrong reason and were rewritten).
- A first built e2e run at `42c9c47` was started with `pnpm exec playwright` instead of the package script, and 29
  tests failed on "Engine stopped"; it was rerun through `pnpm test:e2e`, as every other run was.
- Mutations during this round: 76 of 76 before `e4ba2d6`; 78 of 78 at `e4ba2d6`; 80 of 81 at `45223d4` (an
  equivalent mutant of two redundant guards, made one condition); 84 of 87 at `4b28fe0` (three masked by the guard's
  two layers, each then pinned by its own test).

Reviews:
- An independent review of `5ed855a` found three blocking holes and eight significant ones, all fixed in `b796823`.
- A second independent review, of `b796823`, found two blocking holes and four significant ones, all fixed in
  `42c9c47`.
- A third, of `0c4a71c..e4ba2d6`, found none blocking; its points are fixed or named above. D49 lists all three.

### Workspace package selection (D52, NIV-55, PR 43)

What an environment installs, chosen in the window: the whole project, workspace packages ticked in the list the
engine sends (npm and pnpm), or pnpm selectors under Advanced. On `feature/env-scope` (PR 43), with main `c2c1bb2`
merged in, after Nate's review of its plan (29 Oct). Offline: the engine resolves setup files and the sandbox is a
stand-in, so these show commands, refusals and preparations' records, not a real filtered install.

| Commit | What |
|---|---|
| `0ba335c`, `b7fb263` | PR 43 as it was: typed pnpm selectors, and the journey typing them |
| `f70b6eb` | Main `c2c1bb2` merged in (one import conflict, both lines kept) |
| `12f7aa3` | The uncommitted draft's fixes, run for the first time: `--fail-if-no-match`, the empty-match words, the host's selector words, the new shell's navigation in the specs |
| `e996493` | The domain: the packages scope, the selection and its refinement, the workspace's facts, protocol 17 |
| `f33bd44` | The lockfile readers and the resolver: what each manager's install reaches, from recorded links; the checked releases and settings |
| `2b33615` | The sandbox's check of npm's workspace arguments; the preparation's marker and its check of the image's npm |
| `35b95d1` | Facts on any refusal after the workspace was read |
| `f82bca5` | The window's picker, the root's switch, Advanced; the host's words; the gated engine |
| `bf8e384` | The journey ticks packages and opens Advanced (for Track A's review) |
| `fca5958`, `0d92919` | The e2e specs for both managers, and the live run's recipe test |
| `6883c76`, `89f5ac1` | The independent review's findings, and one test's types |
| `194ed76`, `035f091` | D52, the development notes and this section, then the full round's counts |
| `9787c2e` | Nate's review of `035f091`: npm's peers followed as npm follows them (none with legacy-peer-deps), npm/cli 9847's extra packages found where they arise, and ignore-scripts' missing builds counted from what a chosen install takes in |
| this record's update | D52's wording for those three, and the checks on `9787c2e` |

**What it shows, offline:**

| Criterion | Where | What it shows |
|---|---|---|
| The whole project is unchanged for npm and pnpm | `environment-node.test.ts`, `environment-recipe-engine.test.ts`, both e2e specs | The same arguments and preparations as before; no selection on its recipe |
| Packages chosen by name and folder, no syntax | `environment.spec.ts`, `environment-scope.spec.ts` | The list from the engine's facts, ticked; Preview off while nothing is ticked; pnpm selectors only under Advanced |
| What the chosen packages and the root reach is installed and said | `environment-node.test.ts`, `environment-workspace.test.ts`, both e2e specs | From recorded links: aliases and relative references by where they link, a same-name registry package not counted, the root's links counted when it installs (always for pnpm), a workspace reached through a registry package (npm); each package listed in the preview and the recipe |
| Each manager's chosen install, on its own | `environment-node.test.ts`, `environment-recipe-engine.test.ts`, `environment-scope.spec.ts` | pnpm by exact name and npm as `./FOLDER`, root on and off for npm, sent to the stand-in exactly as previewed, scope and selection kept with the environment; npm's peers as npm follows them, none with legacy-peer-deps; npm/cli 9847's extra packages named; with ignore-scripts, only the builds the chosen install takes in counted as missing |
| One package, several, empty, removed and unknown | `environment-node.test.ts`, `environment.test.ts`, both e2e specs | One package offers only the whole project, with the reason; an empty choice refused by the domain and the host; a removed or unlisted package refused by name and flagged until unticked; 21 in all refused |
| Releases and settings that can't do it are said | `environment-workspace.test.ts`, `environment-node.test.ts` | Each checked range at its boundaries, majors 12 out; a hoisted linker on pnpm 9 and 10, a lockfile per package, links left out, filter in pnpm-workspace.yaml, deep links, npm's omit, include and other install strategies; each refusal says what to pin or change; a lockfile from pnpm 11.28.0 to 11.28.5 warned about on every scope |
| Frozen lockfiles, inside the boundary | `nebius-sandbox.test.ts`, `environment-recipe-engine.test.ts` | Only the fixed argument forms pass the sandbox's check, near misses refused; an image's unchecked npm stops before any upload; a passed-over filter keeps no environment |
| A change needs a fresh preview; a mismatch is refused | `environment.spec.ts`, `host.test.ts` | A tick clears the preview and keeps the list; fingerprints crossing scopes refused either way; a recipe that doesn't install the scope chosen refused by the window and the host |
| Choices kept, per project, after a restart | `environment.spec.ts`, `host.test.ts` | `page.reload` restores a saved packages choice and a saved selectors choice (Advanced open); two projects keep their own |
| Older recipes keep their meaning and digest | `environment.test.ts`, `nebius-sandbox.test.ts` | Pinned digests of a whole and a selected recipe from `c2c1bb2`; older argument forms still pass |

**Through a real engine** (`apps/engine/scripts/rpc.ts` at `0d92919`, offline, in `~/.nivra-dev-env-scope/rpc`; nothing
installed, no repository script run; the answers are in `~/nivra-acceptance/env-scope/rpc/`):
- valhalla-fitness at `3c3c5d7` (pnpm 11.5.3, six packages): the whole project is ready; apps/web and a selector are
  refused, because pnpm 11.5.3 isn't a checked release, with the releases to pin.
- The same setup files pinned to pnpm 11.28.9 (a modified copy): apps/web installs with data, domain, tokens and
  workout-share, reached through the lockfile's links, and the root.
- humin at `1712af4`, one package: the whole project only, with each other way's reason.
- An npm-workspaces fixture (built for this, not a real project): web with data, root off; with data and lint, which
  the root links, root on; a selector refused in npm's words.

**Checks** at `9787c2e`, the code after Nate's review of `035f091`, one at a time under the shared lock:
- `pnpm verify`: exit 0, 1,661 tests passed (domain 131, engine 924, desktop 606), none failed, skipped, cancelled or
  todo, and all three typechecks clean.
- The built app's end-to-end suite under xvfb: 128 passed and none failed; 1 skipped, `explain.spec.ts`'s "only a
  packaged app ignores the switch".
- The real-engine resolutions again (`~/nivra-acceptance/env-scope/rpc/`; the ones at `0d92919` kept in `rpc-0d92919/`):
  the same answers, but for humin's refusal of chosen packages, which since `6883c76` also says to choose the whole
  project.
- `test:packaged` and `test:windows` carry from `89f5ac1`: `9787c2e` changes only engine code, and no packaging, main or
  preload file.
- Mutations: 17 of 17 caught, the 14 before and three for the review's findings.

**Checks** at `89f5ac1`, before Nate's review, one at a time under the shared lock:
- `pnpm verify`: exit 0, 1,657 tests passed (domain 131, engine 920, desktop 606), none failed, skipped, cancelled or
  todo, and all three typechecks clean.
- The built app's end-to-end suite under xvfb: 128 passed and none failed; 1 skipped, `explain.spec.ts`'s "only a
  packaged app ignores the switch".
- `test:packaged`, on the electron-builder `--dir` output after `stage:runtime all`: 58 passed and none failed; 71
  skipped, the tests whose test-only switches a packaged app ignores. A first packaged run, before this worktree had
  staged a runtime, failed 25 tests on "Engine failed": it isn't counted.
- Windows, after `stage:runtime all` and `dev:win --no-launch`: `test:windows` 13 passed, none failed or skipped; no
  Nivra.exe was left running, `~/.nivra` was unchanged, and candidate 3's files read the same before and after.
- Not run: `verify:windows`, since no target, the supervisor or staging changed.
- A first `pnpm verify`, at `194ed76`, stopped at the engine's typecheck on one test's fixture types; `89f5ac1` types
  them, and nothing else changed.
- While working: each step's own test files and the three typechecks, as each commit says.

Mutations: 14 of 14 caught (`~/nivra-acceptance/env-scope/mutate.mjs`), at `0d92919` and again at `6883c76`.

Reviews: an independent review of `0d92919` found no high-severity defect and twelve smaller ones; ten are fixed in
`6883c76`, the npm pass-over is answered by the lockfile cross-check, and the docs are this record. Nate's review of
`035f091` held it for three P2 findings, each fixed in `9787c2e` with a regression test.

### Deferred to a later milestone (kept, not dropped)

| Test | Required result |
|---|---|
| New project | Relevant confirmed defaults are proposed without being entered again. |
| Approved writes | Shown by *Apply and the result view, checkpoint 2* above: a change reaches a checkout only as an approved, checked proposal, applied by its own engine, never replayed. |

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


## NIV-66 companion prerequisite — local review candidate, 29 October 2026

Base: `5a6606aa22a97a32136c6fbf9e67022e90846f13`, with an uncommitted prerequisite diff in
`/tmp/nivra-niv66-companion`. Protocol 18; host workspace 10. The saved recovery, counts-only, price-list and
model-journal work was reused without modifying its original worktrees. No dependencies were added or removed.

- `pnpm verify`: passed, 135 domain + 643 desktop + 960 engine tests (1,738), no skips.
- Built app `budget-api.spec.ts` and `budget-usage.spec.ts`: 4 passed. The window sets a companion-only monthly request
  allowance, preserves it over restart and keeps unsupported dollar policies refused.
- Request tests cover cross-target reservations, duplicate root grants, relabelled extensions, unknown/unpriced inference,
  complete versus interrupted seals and effective recovery remainder. Usage regressions count uncertain token usage once.
- Real HTTP stand-ins verify scalar and nested SDK token usage, including cached input and reasoning without duplication.
- Money/token ceilings and wider feature integration are not claimed. Disconnected target grants remain held until their
  engine connects. No live provider or sandbox call was made.

Review patch, logs and exact source-tree/patch hashes are in `/tmp/nivra-delivery-review`; they identify the local diff,
not a published revision. Generated runtime/app outputs are ignored and are not part of either review patch.


## NIV-68 companion — local review candidate, 29 October 2026

Base: `5a6606aa22a97a32136c6fbf9e67022e90846f13` plus the NIV-66 prerequisite, all local and uncommitted. Protocol 19;
host workspace 12. No commit, push, merge, tool installation for a user project, scaffolding or live paid test occurred.

- `pnpm verify`: passed, 135 domain + 667 desktop + 970 engine tests (1,772), no skips. The final renderer-only active-panel
  annotation was subsequently checked by desktop typechecking and the affected built journeys.
- A broad built-app run passed 133 tests, skipped one conditional case and found two environment-selection failures:
  preserved hidden project panels shared the active panel's test identity. After correcting that identity, the complete
  affected `companion.spec.ts` and `environment-scope.spec.ts` files passed all 10 tests. The broad run was not repeated.
- The final narrow companion uses native client-area screenshots at zoom, checks visible child bounds, and passes with
  no sideways overflow. Restart clears the temporary composer; native missions/tasks, knowledge and guide settings remain.
- Packaged Linux app: 41 passed, 18 existing conditional tests skipped, across app security/bridge, companion, budget,
  shell, workspace, environment and coach checks. Unpackaged-only model/gated fixtures were not represented as packaged
  provider evidence. `package:dir` and Linux/Windows runtime staging passed.
- `pnpm dev:win --no-launch`, then `test:windows`: 14 passed. The added Windows bridge case verifies keyless planning,
  idempotent mission/task saves, scoped knowledge edit/forget and allowance retention without starting an engine.
- `pnpm verify:windows`: 37/37 native/WSL checks passed. Its isolated WSL home was removed and the release home was unchanged.
- `apps/engine/scripts/rpc.ts repository.inspect`, with its own temporary home, returned actual Git/HEAD/tracked-state facts
  and shut down without calling providers or running repository scripts.
- Host/engine canary tests scan stores, SQLite/WAL, Mastra, artifacts and logs after success, provider/malformed/hostile
  errors, cancellation and crash/restart. Synthetic prompt/reply markers do not persist; selected structured outcomes do.
  Forgotten knowledge and earlier dialogue cannot reach the next turn. The production companion gate was enabled only
  after these checks and guarded-grant tests passed; explicit user requests, credentials and sharing are still required.
- Scoped knowledge reaches the task coach through its previewed contract and provenance references; no coding-worker
  knowledge integration is claimed. Conservative conflict detection cannot prove arbitrary prose conflict-free.

The two stacked patches and validation logs are in `/tmp/nivra-delivery-review`. Other agents, research and sandbox work
are outside the companion request allowance. No monthly token limit, dollar ceiling, all-service accounting or live
provider acceptance is claimed.

## NIV-66 review correction — explicit month confirmation, 29 October 2026

The review of PR 44 at `7622442` found that an exhausted, settled companion allowance had no Settings action to
establish the next month. Companion requests now shows the host's established month and computer month, with the
existing guarded confirmation action. Saving a limit or refreshing usage never advances the month. Recovery keeps
confirmation disabled; old outstanding grants and their late usage remain attached to their original month.

- Budget-store and host-budget tests: 98 passed, no skips.
- Final built `budget-api.spec.ts` and `budget-usage.spec.ts`: 6 passed. Real-ledger offline fixtures exhaust and settle
  a previous month, confirm the displayed later month, check the guard after reload and refuse a recovery bypass.
- Tests start no engine or paid inference for the month-confirmation journeys. Companion AI request coverage and
  existing money-policy refusals are unchanged. Broader verification results accompany the PR update.

## NIV-68 review corrections — scope, dialogue and Settings, 29 October 2026

The review of PR 45 at `8643db4` found four companion defects, corrected on its own branch above the NIV-66 month fix:

- A task or mission's engineering preference stays knowledge at that native scope. Project/personal defaults require
  appropriate broader scope; bare "my default" and "always" do not broaden a task. Host tests and a real engine with a
  loopback provider verify that a second task receives neither the note nor a new project default.
- A changed context epoch is checked against the same turn's answered epoch and fresh host context before discarding
  the dialogue. Own saves preserve the reply; external edits/forgetting still invalidate it. Session/request identities
  reject stale context reads and duplicate results from earlier turns.
- End replaces the local dialogue and composer before awaiting cancellation, with a warning in the new empty buffer if
  cancellation cannot be confirmed. A late answer cannot repopulate the retired buffer.
- Settings selects the task's host-resolved project for the detour and restores the previous sidebar scope and work on
  return. Tests cover an earlier project A selection and General while the task belongs to B, including B's actual
  diagnostics controls. A removed origin or reassigned task still refuses the return.

- Independent NIV-66 `pnpm verify`: 135 domain + 644 desktop + 960 engine tests (1,739), no skips.
- Integrated `pnpm verify`: 135 domain + 679 desktop + 970 engine tests (1,784), no skips. Both full runs passed with
  bounded CPU affinity; test assertions, deadlines and skips were not weakened.
- Focused host/knowledge/privacy checks: 29 passed, including the real-engine task-preference isolation regression.
- Final built `companion.spec.ts`, `companion-lifecycle.spec.ts` and `environment-scope.spec.ts`: 17 passed. The seven
  new lifecycle cases also passed as a separate run. Independent NIV-66 built budget journeys: 6 passed.
- Final Linux packaged subset: 50 passed, 18 existing conditional cases skipped, including the new lifecycle and guarded
  month-confirmation fixtures. Windows development package build and its full UI project: 14 passed. Runtime staging
  also passed. No target, supervisor or staging source changed; the native/WSL harness was not repeated for this correction.

An earlier unbounded full run was stopped after timeouts while other suites were active. An initial direct
`pnpm exec playwright` run omitted the absolute Node executable source engines need (5 failures, 1 not run, 11 passed);
the complete affected files then passed through the normal `test:e2e` package script. These attempts are retained as
failed/aborted evidence. The full built-app suite was not repeated; packaged coverage is the named subset above.

No paid calls were made. The companion-only allowance, explicit turn/sharing requirements and stated exclusions remain
in force. No newer planning work is included in either review branch.

## NIV-69: reviewed task planning and the shared request allowance (29 October 2026)

Candidate: local uncommitted work on `main` at `5a6606a`, integrated with the existing NIV-68/NIV-66 changes. This is
local implementation evidence, not a merge or release claim. The changed application/domain source manifest is kept
at `.artifacts/niv69/source-manifest.json`; its SHA-256 fingerprint is
`6f3665f0a2e23ece680115b431dad768f6605f7040a98d4e5c321c8b7b509645`.

Implemented behaviours:

- Both entry routes use the same durable planner and allowance. The companion transfers an explicitly reviewed brief,
  never its dialogue. Repository-free/manual planning needs no key, Git, prepared environment or external tracker.
- Proposals hold constructive challenge, decisions and uncertainty, a bounded impact assessment and at most five
  editable items. Native source/brief/attempt versions and saved item mappings are bound. Changed decisions or evidence
  make advice provisional/stale; existing active tasks, pending results and saved briefs are not rewritten. Knowledge
  bindings use the exact request retrieval, including inherited mission notes, rather than a parallel selection.
- Selected drafts, first briefs, optional mission membership, provenance and receipts commit atomically. Repeated and
  concurrent saves do not duplicate work; failures roll back; deleted results are never recreated. Omitted prerequisites
  remain visible. Human criteria do not become commands or Ready state.
- Repository-enabled AI binds current sharing consent/epoch, rechecks after engine startup and requires a fresh permit
  before each inference. Revocation/removal cancels and rejects late results. Commit/file/search/inventory freshness is
  checked before using observed advice. An answer with no observations can still save drafts while its engine is offline.
- The Companion and planning pool keeps the prior limit, month, usage and reservations through an appended guarded policy.
  Feature rows and combined totals count actual inference once. Eight is a maximum; a reduced finite grant protects one
  final answer and explains missing exploration. Unknown outcomes stay counted. Other services and dollar ceilings are
  not claimed.

Verification receipts (working directory: this repository):

| Check | Evidence |
| --- | --- |
| Full source verification | `env TMPDIR=/var/tmp taskset --cpu-list 0-3 pnpm verify`: 136 domain, 695 desktop and 983 engine cases passed (1,814 total), with no skips or failures. `.artifacts/niv69/verify-final.log` |
| Final planning regressions | 23 host/transport/native-host cases passed, including offline unassessed saves, inherited mission-note edits/forgetting rejecting late results, and unrelated-scope changes remaining valid. `.artifacts/niv69/planning-final.log` |
| Engine planner | Ten real-stdio/mocked-provider cases, three evidence cases, and an isolated `rpc.ts planning.validateEvidence` check passed. These include current sharing permits, lower grants, early final answers, context saturation, uncommitted source edits, cancellation, privacy and no replay. |
| Built app | All 138 applicable cases passed across the full run and corrected contract-expectation rerun; one existing packaged-only case skipped. Final focused planning/budget run passed 6/6. `.artifacts/niv69/built-all`, `built-corrections` and `built` |
| Packaged app | Earlier full run: 68 passed, 71 existing stand-in-only cases skipped. Corrected frozen-build planning/IPC run: 9/9 passed, including source-plan navigation, keyboard newlines, selected tasks, dependency discard protection and companion handoff. `.artifacts/niv69/packaged-all` and `packaged-final` |
| Native Windows and WSL engines | Final staged runtimes passed 37/37 checks, including runtime loading, cancellation and unchanged release-home checks. `.artifacts/niv69/targets-windows-retry.log` |
| Native Windows UI | Corrected source: 15/15 passed, no skips or failures; source/installed/native-Windows hashes matched before and after. `.artifacts/niv69/windows-ui-final` and `windows-build-identity-bound.json`. |

The final Windows UI run was launched only after source and installed `app.asar` matched SHA-256
`adec059e1537b99a500362c151e870006b17d298e00ee865b478317b45cd4c6e` (3,553,186 bytes), with the planning bridge,
planning schema and source-plan action present. Native PowerShell independently verified the same bytes before and after the run. The complete receipt is
`.artifacts/niv69/windows-build-identity-bound.json`; earlier candidate receipts remain separate.

Earlier failed attempts are retained. Managed sandbox restrictions prevented Electron/loopback/staged self-checks;
those were rerun with approved execution permission and Chromium sandboxing retained. An ambient read-only `/tmp/.git`
invalidated the plain-folder fixture, so the full check used `/var/tmp` rather than weakening its assertion. Excessive
parallel test load caused timing failures; bounding CPU affinity changed worker count without skipping checks or
extending deadlines. Exact bridge/schema expectations were updated for the new authorised API and v13 migration. An
older Windows archive at the shared dev location caused three stale-binary failures; that run is not acceptance for
this candidate. The target harness's first cache-replacement attempt also failed; its retry passed all 37 checks.

The source and new files were reviewed for scope, credentials, generated output and cross-project leakage; whitespace
checks passed. Generated evidence is ignored under `.artifacts/`. No new dependencies, paid provider calls, commits,
pushes, deployments or external tracker mutations occurred. Mocked tests establish mechanics and safeguards, not live
model planning quality or exhaustive semantic impact coverage; token/input estimates are not provider billing ceilings.


## NIV-69 PR integration after the prerequisite merges (29 October 2026)

The publication candidate is on `feature/niv-69-reviewed-planning`, based on main `ac2d574` after PRs #44 and #45
merged. The NIV-69 patch was applied relative to the initial companion checkpoint, preserving the later guarded month
confirmation, task-scoped preferences, dialogue lifecycle and Settings-return fixes. The PR contains only the NIV-69
increment; the original dirty checkout was preserved. D55 remains the merged preference-scope decision, and planning is
D56. This checkpoint supersedes the earlier uncommitted candidate as evidence for the PR.

Validation in `/tmp/nivra-niv69-pr`, without live paid providers:

| Check | Result |
| --- | --- |
| `env TMPDIR=/var/tmp taskset --cpu-list 0-3 pnpm verify` | 1,826 passed: 136 domain, 707 desktop, 983 engine; zero skipped or failed |
| Built planning, budget and companion lifecycle | 15 passed; includes explicit month confirmation/recovery and all seven merged lifecycle cases |
| Packaged app, planning, budget and companion lifecycle | 21 passed; zero skipped or failed |
| Windows UI after `pnpm dev:win --no-launch --skip-stage` | 15 passed; zero skipped or failed |
| Windows archive identity | Source, installed and native PowerShell SHA-256 matched before and after: `8efa08fcbb06333261e99d40621e2b9b2b92d20e7e7ab0e6f1f912637d2240a9`, 3,556,750 bytes |
| Engine/runtime evidence | Engine and domain production sources are byte-identical to the preceding validated NIV-69 candidate; its real-stdio, isolated RPC and 37/37 Windows/WSL target checks carry forward |
| Scope and hygiene | 52 changed/new files; no generated artefacts or new credential literals staged; diff whitespace checks passed |

Local receipts are under this worktree's ignored `.artifacts/niv69-pr/`: `verify.log`, `built.log`, `packaged.log`,
`windows-build.log`, `windows-ui.log` and `windows-build-identity.json`. The earlier candidate's receipts remain in the
original checkout. Tests retained Chromium sandboxing, isolated native/WSL profiles and the release-home protections.
No dependency changes, live model-quality evaluation, paid calls, deployment or merge is authorised by publication.

## NIV-69 PR review corrections (30 October 2026)

PR #46 is held as a draft for re-review. This checkpoint corrects the seven P2 findings against `34f2937`; the older
passing receipts above do not establish these corrected behaviours. The frozen production-source manifest is
`.artifacts/niv69-review/source-manifest.json` (261 files), fingerprint
`7602a2c3c08c4c22d3eb77f8cdfa727da9190308cd12d35dae9891fbb46e3eb2`.

1. Commentary alongside list/read/search calls remains exploratory; only a response without exploratory tools is parsed
   as a text final proposal. Structured final submission and invalid-final refusal remain enforced.
2. Model input and host bindings use the same bounded task/selected-mission/project knowledge selection. A busy
   project cannot crowd out all mission notes. Editing or forgetting either included scope rejects pending results;
   foreign-project records remain excluded.
3. Engine and host share the same merger for overlapping/consecutive inclusive ranges. Citations spanning consecutive
   reads save successfully; unread gaps and inconsistent hashes/revisions are refused.
4. Partial saves require an explicit Review remaining tasks step. It creates another reviewed version even when the
   content is unchanged, while the existing one-save-per-version and receipt protections remain enforced.
5. Every new companion handoff receives a fresh planner identity; assigning a saved ID to that same form preserves its
   identity. Two successive handoffs replace an already open unsaved form with their reviewed briefs.
6. If first proposal validation fails after brief creation, the UI retains the record ID and unsaved edits. Correcting
   and retrying updates that record instead of creating another.
7. First creation and navigation within the window preserve task selection. The selection cache remains transient;
   durable planning content and task provenance retain their existing storage rules.

Fresh verification in `/tmp/nivra-niv69-pr`, with local/loopback stand-ins and no paid calls:

| Check | Result |
| --- | --- |
| `env TMPDIR=/var/tmp taskset --cpu-list 0-3 pnpm verify` | 1,832 passed: 136 domain, 711 desktop, 985 engine; zero skipped or failed |
| Focused host/runner regressions | 26 passed; the new initial reproductions failed against the original code, then passed after correction |
| Engine planning and citation regressions | 42 passed, including real-stdio prose/tool responses, text final JSON, consecutive reads and unread-gap refusal |
| Real engine through `rpc.ts` | Current tracked-file evidence accepted; a changed hash rejected, using an isolated temporary home |
| Built app under Xvfb | 19 passed across app security/bridge, planning and companion lifecycle |
| Linux packaged app under Xvfb | 24 passed across app, planning, shared-budget recovery and companion lifecycle; zero skipped or failed |
| Fresh runtime staging and Windows/WSL harness | Staging smoke checks passed; 37/37 harness checks passed, including unchanged release-home checks |
| Native Windows UI | 15 passed; zero skipped or failed, after rebuilding and copying the corrected development package |
| Native Windows archive identity | Source, installed and native PowerShell hashes matched before and after: `feee40687c5be73fd61effc581b0539780ced63c510098fef1b19d7ae8d52998`, 3,559,924 bytes |

Receipts are in this worktree's ignored `.artifacts/niv69-review/`, including `host-before.log`, `host-after.log`,
`verify.log`, `built-xvfb.log`, `packaged.log`, `rpc.json`, `stage.log`, `targets-windows.log`, `windows-ui.log` and
`windows-before.json`/`windows-after.json`. The initial focused UI attempt passed five cases and failed one fixture
because its handoff panel was already open; the fixture now checks its expanded state before toggling. All six
planning cases then passed, followed by the broader built and packaged runs. No production test was skipped or
weakened to obtain these results.

The original checkout was left unchanged. No dependencies, schema, IPC surface, budget policy, paid-provider scope or
execution authority changed. These checks establish offline mechanics and platform integration; live planning quality
and exhaustive semantic impact coverage remain unassessed. The PR stays on hold and has not been merged.

## Required repository checks and trustworthy approval (NIV-67, D57) — 30 October 2026

**Candidate:** local, uncommitted changes on `ac2d57421b63c1e28d64d9271d9f286deca721bf` (main). The source/test diff
SHA-256 is `c8a40e6a3181368775a17a2c428e31367433cc267058d44bc5a04a71ab7dcda7`: `git diff --binary -- apps packages`,
followed by each sorted untracked source/test path, NUL, byte length, NUL and bytes. Documentation and ignored build
output are excluded. The local receipt and copied logs are in `.cache/niv67/verification.json` and its folder.

**Shown:** every repository check in a new brief is required. Before-change observations remain separate from explicit
baseline assertions. Passing acceptance with a newly failing typecheck is unverified; both-sides failures are not
waived; failed-before/passing-after may verify. Missing/unknown final results, missing integrity evidence and zero
acceptance cases cannot verify. Command identities, bounded output and all structured results survive report fitting.
The maximum allowance is 25 operations; comparisons consume the existing worker window, preserving final/cleanup time.

The approval button uses the engine's validation of the intact proposal-bound report. Applying independently repeats
admission. A fitted report altered to `verified: true` cannot enable admission or apply. Historical bytes and recorded
verdicts remain unchanged; complete all-pass version-3 evidence is admitted only with its digest-bound original brief,
without inventing before-change results. Insufficient evidence or an originally unverified result requires a new
explicitly started run. Reject and Request revision remain available; there is no required-check override.

| Check | Evidence |
| --- | --- |
| `pnpm verify` | 139 domain + 685 desktop + 984 engine tests = 1,808 passed; zero failures/skips. All typechecks passed. |
| Final `pnpm typecheck` | Passed, including renderer, main and E2E types. |
| Focused engine execution checks | 89 passed across 12 suites; includes the missed fifth argument and mixed/same-unit kg/lb fixtures, uncertain dispatch, comparison bounds and reserve protection. |
| Trusted admission/apply checks | 16 focused tests and 17 real-engine task tests passed; included malformed/legacy evidence, altered bound bytes and a forged fitted verdict. Included in the full suite. |
| Real engine through `apps/engine/scripts/rpc.ts` | Stand-ins only: four model requests; baseline check failed, final case/check passed, report version 4 verified, hash-bound admission eligible. Disposable home cleaned up. |
| Affected built task journeys | Seven passed: required-check regression and direct host approval refusal with untouched checkout; successful apply/accept; reject/revision; prepared-environment and preview/report journeys. |
| Linux runtime staging | Protocol 21, runtime `639004f8f5c04de8`; real-engine initialisation/shutdown smoke passed. |
| Windows runtime staging | Protocol 21, runtime `aa65b931bba8d0a5`; native validation followed in the Windows UI project. |
| Linux `package:dir` + `test:packaged` | Build passed; full packaged project: 74 passed, 72 conditional tests skipped, no failures. Task stand-in journeys are built-app evidence because packaged apps ignore endpoint overrides. |
| `pnpm dev:win --no-launch --skip-stage` + `test:windows` | Development build/copy passed; all 14 Windows tests passed without skips, including native/WSL routing, release-home invariance and disposable WSL-home cleanup. Existing current staging was reused. |
| Diff/untracked review | Scope and credential-shape review completed; no new credential-shape flags or generated tracked files. `git diff --check` passed. |

Earlier attempts are not passing evidence: the managed-sandbox full run was aborted after fixture engine-start failures;
a direct host check passed outside it. An initial unrestricted full run failed one old preview-fingerprint expectation,
which was corrected before the full passing rerun. Initial direct Playwright runs failed before task execution because
`pnpm exec` omitted the absolute Node executable; all affected files passed through the supported `test:e2e` script.

No target, supervisor or staging source changed, so `verify:windows` was not repeated; the Windows UI project and
staged-runtime checks above are the stated platform evidence. No live models or paid services were used. The owned
TypeScript/unit fixtures establish Nivra's gate, not SHE-65's production correctness or NIV-35's live acceptance.
PR 46 / NIV-69 is not integrated into this checkout: it reserves protocol 20 and D56. This change uses 21 and D57;
whichever lands second must reconcile the combined contracts and advance the protocol as needed. No commit or push
was made, and the historical submission/release evidence above is preserved.

### PR candidate after NIV-69 integration — 30 October 2026

The publishing candidate integrates merged PR 46 (`67a12de62d9d828093b4e26af60ada4af2f4cb71`) with the NIV-67
implementation (`889d17e80b8061a6df4769863a46dff5f7f2194c`) in source commit
`ffc4961e34258bbf09c249f7ac8b29dd5302b814`. Protocol 21 now contains both planning and task-admission contracts;
D56 and its historical protocol-20 evidence are retained. The earlier local candidate above is pre-integration
evidence, rather than the final publishing candidate.

The source/test diff SHA-256 against merged main is
`3e4b0fd66147ad7165e0aeed3951fda8eb11fbe4f9fccf134a5ac0054990387e`
(`git diff --binary 67a12de -- apps packages`). The final follow-up commit records this validation only.

| Integrated check | Result |
| --- | --- |
| `pnpm verify` | 140 domain + 717 desktop + 999 engine = 1,856 passed; no failures/skips; all typechecks passed. |
| Built task and planning journeys | All 13 passed, without skips: `test:e2e --project=built task-run.spec.ts task-apply.spec.ts task-journey.spec.ts planning.spec.ts`. |
| Both runtime stages | Passed; Linux `11cc8692f95ffa3f`, Windows `3fa1aab9100d0621`. These are rebuilt combined runtimes, not the earlier protocol-21 artifacts. |
| Real engine through `rpc.ts` | Stand-ins passed again: version-4 evidence, failed-before/passing-final check and eligible hash-bound admission. |
| Windows development build and UI | Build/copy passed; all 15 Windows/native/WSL tests passed without skips, including NIV-69 planning save/resume and the release-home guard. |
| Linux packaged build and UI | Build passed; 80 packaged checks passed, 72 conditional cases skipped, no failures. Task stand-in journeys remain built-app evidence. |

Local integrated receipts and logs are retained under `.cache/niv67/`, including `integrated-verification.json`.
No live/paid validation was used. SHE-65 production correctness and NIV-35 live acceptance remain separate.

### PR 47 review corrections — 30 October 2026

Follow-up to the review of `cd5a8e040c14043d8ccadd10f9dde76f1e8d5c58`. The source/test diff SHA-256 is
`ca10bde86472d4520673d623b47aeff07e03939b2d77cb45b892027153c816e6`
(`git diff --binary cd5a8e0 -- apps packages`). Local receipts/logs are in `.cache/niv67/review-fixes/`.

- Legacy check names match the historical harness exactly: commands longer than 80 UTF-16 code units use the first
  77 followed by `...`. Full original-brief digest checks and exact row identities remain; arbitrary prefixes and a
  different brief with the same clipped label are refused. Tests cover 80, 81 and 103 characters.
- Pre-recipe version-3 reports may omit `environmentRef` and `setup` when there was no prepared environment. Either
  prepared-environment field still requires affirmative unchanged setup evidence; absent, null or unknown evidence
  is refused. Version-4 reports still require explicit fields. The real-engine regression seeds a separate authentic
  legacy run/proposal, reads and admits it after restart, applies it by hash, and preserves the original newer proposal.
- Before-change observations render independently of final rows, with recorded labels, commands when the original
  binding is available, reasons and both output streams. Missing/mismatched/ambiguous final evidence stays unavailable;
  no before-only result implies verification. The recovery journey proves cancellation leaves these records visible
  with zero final rows and no approval action.

Validation: `pnpm verify` passed all 1,862 tests (140 domain, 720 desktop, 1,002 engine), no skips/failures, including all
main/renderer/E2E typechecks. The focused engine checks passed 23 tests, and focused UI checks passed 33. All 11 built
journeys in `task-recovery.spec.ts`, `task-apply.spec.ts` and `task-run.spec.ts` passed through the supported `test:e2e`
script. The real engine through `rpc.ts` passed against local stand-ins again. `git diff --check` and scope/credential
review passed; no new credential-shape flags or generated tracked files.

An earlier built attempt in the agent runner failed before task execution because localhost binding was denied
(`EPERM`: three setup failures, eight dependent cases not run). The same complete affected files passed from the
current full-access runner. No tests were skipped or weakened to accommodate that failure.

Packaged/Windows suites were not repeated for this follow-up: no packaging, main-process, preload, target or supervisor
source changed. Their earlier results above remain evidence for their labelled revisions. No paid validation was
performed, protocol 21 is unchanged, and the PR remains unmerged for re-review.

## Private engine database files and safe legacy repair (NIV-46, D58) — 30 October 2026

Source verified locally at `a65c3379fe1249529b828765c54ffd992c4ec18b`, published unchanged as
`8d5a91555e9cfa40016419f58099d39bd21fa63d`. Both commits have Git tree `36d95ec45b85923a77bef729abc66b60f8d4429e`, based on main
`f0de67b9259111b7a9299bcc687037f99c51cb4d`. Publication through the connected GitHub app changes commit metadata,
not file content. Subsequent changes in this PR are documentation only. Implementation is
isolated in the `feature/niv-46` worktree; no runtime-version, schema or dependency changes are included, and no host,
preload or renderer source changed.

| Scenario | Evidence and observed result |
| --- | --- |
| Creation-time privacy, an early gate | A disposable Linux/x86-64 ptrace harness stopped every traced Node/libuv thread at syscall boundaries. All 44 successful database/sidecar creation opens observed under umask 022 and 000 were 0600 immediately on syscall return, before the tracee could execute a userspace chmod. Both database families, WAL, SHM, rollback journals and recreation were observed. |
| Ongoing driver and workflow lifecycle | The driver gate runs before Mastra schema initialisation, checks active writes and recreates WAL/SHM/rollback journals twice for each driver/mask. Real-engine fixtures inspect all data files after a no-provider hello, clean restart and forced-stop recovery. Prior completed history survives. |
| Legacy 0755 homes, 0644 files | Real driver processes leave WAL or hot rollback journals by SIGKILL. Descriptor repair preserves every fixture file's inode and content hash before driver opening; actual startup then repairs the legacy modes and recovers the committed record, excluding the uncommitted change. Main database inodes and the home's 0755 mode remain unchanged. |
| Unsafe files and paths | Symlink, hard-link, directory and FIFO cases cover all eight recognised names. Startup returns `home-unusable` within its five-second guard; outside sentinel bytes, modes and change times remain unchanged. Separate descriptor-race tests reject a regular file swapped for a FIFO or symlink before chmod. An already-present FIFO is never opened; the swapped-FIFO open must have `O_NONBLOCK`. |
| Unsafe homes and recovery prerequisites | Shared-writable homes, symlinked homes/ancestors and unexpected ownership refuse. Orphan WAL data remains intact without manufacturing a new main database. A filesystem that ignores chmod refuses rather than reporting private files. |
| Failure and exclusive ownership | Injected EPERM during repair releases the Nivra lock, permitting a later engine to start. Failure after LibSQL initialisation closes its client and the lock. A second process returns `locked` without changing the live owner's data hashes, modes or change times, including deliberately broadened Mastra files; the owner still answers. |
| Remaining home files | The hello fixture preserves pre-existing notes and executable runtime modes. The existing sandbox-engine fixture inventories every generated data file recursively, including its settled journal, against local stand-ins. Secret/preference canaries and protocol purity remain covered. |
| Self-check and platforms | Self-check works without inspecting even an unsafe named home. Both staged runtimes build; Linux staged self-check/start/stop and the native Windows/WSL harness pass. Native Windows retains its ACL behaviour; POSIX modes do not establish Windows privacy. |

Final validation on the implementation revision:

- `pnpm verify`: all typechecks and **1,909 tests passed** (140 domain, 720 desktop, 1,049 engine), zero failures/skips.
- `node --test test/database-privacy.test.ts test/engine.test.ts` from `apps/engine`: **62 passed**, including all
  47 new privacy regressions, zero failures/skips. The sandbox inventory also passes in the full suite.
- `pnpm verify:windows`: **37/37 passed**, including native Windows and WSL startup, shutdown, cancellation and restart.
  Its release-home guard found all eight entries unchanged and removed its disposable WSL home.
- The real engine through `apps/engine/scripts/rpc.ts`: no-provider hello succeeded, every generated database file
  present after exit was 0600, and a second invocation retained the succeeded run. The disposable home was removed.
- The explicit creation-time trace passed on the same source revision. Local ignored receipts are under
  `.artifacts/niv46/` in the implementation worktree; the ptrace harness is evidence tooling, not a new test dependency.

An extra focused run launched alongside the full suite exceeded three five-second process-startup guards (symlink,
FIFO and hard-link cases) and failed. The full suite passed, and the unchanged complete focused command then passed
when run alone. No deadline was extended and no test was skipped, removed or weakened. Keep focused and full runs
separate when reproducing their results.

No real release/development home was opened for migration, and no paid provider/cloud calls were made. Existing
installations are repaired only when their owning engine next starts normally. Packaged Electron/UI suites were not
repeated: no packaging, main-process, preload, target or supervisor source changed. Permissions do not provide
isolation from the same OS user/root, and unsafe homes are refused rather than recursively repaired. Protocol 21 and
all stored-content restrictions remain in force; NIV-62 remains separate. This evidence does not authorise merging.

## NIV-71: confirmed preferences in coding runs (30 October 2026)

Implemented on `feature/niv-71` in the separate `nivra-orchestrator-niv71` worktree, based on refreshed main `f0de67b`.
The tested implementation revision is `cb73a1be4182b215ad244cc6b668a78e42d5a730`; the original checkout is not the
implementation workspace. The production/runtime-helper manifest covers 265 files at
`.artifacts/niv71/source-manifest.json`, fingerprint
`a9ab246f7c6e821e4dd05a64346a88a964752a4b02f5e530a82cdd5441241ffb`.

The task preview shows confirmed personal/current-project preferences with scope and intent, plus bounded temporary
choices. The host binds both digests, screens credentials, rechecks after asynchronous prerequisites and passes the
accepted snapshot to the actual worker. Its requests retain that frozen context; subsequent attempts receive current
records. Relevant edits, deletion, supersession or changed choices require another preview; another project's edits
remain valid. New requests require both digests and explicit context, while historical input stays readable. The CLI
also refuses omitted preference/choice context rather than silently manufacturing an empty snapshot.

Choices survive Preferences, including a return through the task list, in window memory. Refused/failed starts before
acceptance retain them; explicit preview cancellation, switching tasks and accepted Start clear them. They never change
the brief, saved profile or draft persistence. Credential checks cover recognised shapes and exact saved-key values,
and the worker checks again before each request, including hand-in, for a vault change during the run. Refusals never
echo those values. Required checks and engine admission remain authoritative even when a preference asks to waive them.

Verification uses synthetic credentials and local/loopback stand-ins, with no paid provider calls:

| Check | Result |
| --- | --- |
| `env TMPDIR=/var/tmp taskset --cpu-list 0-1 pnpm verify` | 1,870 passed: 141 domain, 724 desktop, 1,005 engine; zero skipped/failed |
| Focused domain contracts | 141 passed, including mandatory new-request digests, explicit empty context, canonical choices and historical reads |
| NIV-71 host regressions | 4 passed; captured actual worker requests, confirmed scope isolation and frozen context across requests, verified the next attempt's current records, checked asynchronous stale starts and credential refusals, and scanned engine/Mastra/workspace persistence for private canaries |
| Engine/worker/scheduler focus | 64 passed before the final per-request credential guard; the final worker suite then passed 32/32, including the new dynamic-vault guard and actual multi-request/hand-in prompt construction |
| Final built app under Xvfb | 17 passed across task run/apply/journey, all three preference/choice cases and companion lifecycle; zero skipped/failed |
| Final Linux packaged app under Xvfb | 27 passed, zero skipped/failed, across app security/bridge, task preferences, planning, shared-budget recovery and companion lifecycle |
| Fresh final runtimes and Windows/WSL harness | Runtime staging smoke checks passed; final harness passed 37/37, including release-home protections |
| Native Windows UI | 15 passed, zero skipped/failed, after rebuilding/copying the final development package |
| Native Windows identity | Source, installed and PowerShell hashes matched before and after for app.asar, the Windows engine bundle and the Linux runtime tarball; app.asar SHA-256 `94186e9b2eed0d6bb3b077e8da42b60c84095c422ebb3bb562b2be5a2c6366a0`, 3,579,949 bytes; Windows runtime content hash `8b1c429a753f9a7b` |
| Real engine through rpc.ts | Explicit context produced both safe digests and the expected no-sharing refusal without private-text persistence; omitted preferences/choices were refused before engine startup |
| Final typechecks | Workspace typechecks and the final CLI/engine typecheck passed |

Receipts are ignored under `.artifacts/niv71/`: `verify.log`, `host-new-2.log`, `worker-final.log`, `built-reviewed-final.log`, `packaged-reviewed-final.log`, `stage-final.log`, `targets-windows-final.log`, `windows-ui-final.log`,
`windows-before.json`/`windows-after.json`, `rpc-final.json` and the named typecheck logs. Earlier candidate receipts
remain separate.

A final preference test initially assumed that external brief edits automatically refresh the task page; the existing
page refreshes on actions. Its corrected scenario explicitly exercises the stale Start refusal and Refresh preview,
retaining the choices and admitting no run. Initial contract-transition attempts exposed fixture mismatches, which were corrected without changing production
requirements. An overlapping focused-host/full-suite attempt exhausted available WSL memory and hit timing failures;
the redundant focused run and overloaded verification were stopped, with logs retained in `desktop-focused.log` and
`verify-overloaded.log`. The final source verification uses lower CPU affinity to reduce worker concurrency, with the
same assertions, deadlines and complete test set. The first Windows harness attempt also failed to replace its
disposable runtime cache under memory pressure; fresh-runtime retries passed. No test was skipped or weakened to
obtain a passing result.

No dependency, database schema, model, approval boundary or budget authority changed. NIV-46's database-permission
work remains separate. These checks establish input construction, lifetime, privacy and integration mechanics; they
do not establish live-model preference compliance or an ability to prevent model-authored paraphrases under D22.

Coordination with NIV-46 PR #48 was checked at `165a776fdd914308c15f8e2ad996c4663e7d0878`. Its six source/test
files were overlaid unchanged onto NIV-71 `dd9ce48` in a disposable detached worktree. The combined source passed
141 engine tests covering database privacy, stdio, sandbox lifecycle, task execution, proposal application and the
worker, plus all four NIV-71 host regressions and the engine typecheck, with zero failures/skips. Receipts are
`combined-source.json`, `combined-engine.log`, `combined-host.log` and `combined-typecheck.log` under the ignored
evidence directory above. This rehearsal covers focused source integration; the full source/UI/platform counts
above refer to the independent NIV-71 implementation.

The source/test paths are disjoint. A merge-tree rehearsal found conflicts only in the three append-only docs:
`acceptance.md`, `decisions.md` and `development.md`. Whichever PR lands second must retain both sets of additions.
NIV-46 keeps D58 and NIV-71 uses D59. This PR stays based on main `f0de67b` and carries no NIV-46 implementation;
neither PR was merged for the rehearsal, and the disposable checkout was removed afterwards.

### PR #49 review follow-up (30 October 2026)

The three P2 findings against `8650034` are corrected. The final implementation is
`261777da68eb63f2e5b8f2b8fc24366da24017a0`, including main `8fb205541f70ba922146367a395aa45401a60014`
and its merged NIV-46 changes. Each current-main document remains a byte-for-byte prefix of the merged document;
D58 remains database privacy and D59 remains coding-run context. Protocol 22 is still the next version after main's
21. No dependency or authorisation boundary changed.

- A failed preview keeps its choices editor available: correct a blank choice or remove a duplicate, refresh, and
  retain the other choices. Loading/error content has a distinct test identifier from a completed preview, so journey
  helpers wait for the consent prompts before trying Start.
- Each setup of the Preferences-return effect starts its replacement preview. StrictMode cleanup invalidates the
  earlier request without suppressing its replacement; generation checks reject late results.
- Both context-refusal branches save a finished `refused` report before throwing, with closed `context-mismatch`
  and `context-credentials` codes and fixed recovery messages. Tests change saved key values after the check step
  and after model listing, covering preferences and choices, and separately inject mismatched context at those
  steps. Each leaves a finished refusal, no proposal, no model inference/execution, and no private value in the
  result/report. Real-stdio and RPC readback also verify both finished refusals at the initial check.

Final checks, using synthetic credentials and stand-ins:

| Check | Result |
| --- | --- |
| `env TMPDIR=/var/tmp taskset --cpu-list 0-1 pnpm verify` | 1,921 passed: 141 domain, 724 desktop, 1,056 engine; zero failures/skips |
| Final workspace typechecks | Passed; repeated after the renderer's loading/ready selector correction |
| Built and development UI | 22 passed: 18 built task/preference/application/companion journeys and 4 Preferences-return cases served by Vite with React's development runtime and StrictMode |
| Fresh Linux packaged app | 28 passed across app security/bridge, planning, budget recovery, companion lifecycle and all 4 preference cases |
| Fresh runtimes and Windows/WSL harness | Staging smoke checks passed; 37/37 harness checks passed, including the unchanged release home and disposable-home cleanup |
| Fresh native Windows UI | 15 passed after `pnpm dev:win --no-launch --skip-stage`; zero failures/skips |
| Native Windows build identity | Source, installed and native PowerShell hashes matched before/after for app.asar, the Windows engine and Linux runtime; app.asar SHA-256 `340d1c83c04a53f0d0cf76d4682a70f46ebd2a0030184c460bdd34915ccdcea8`, 3,580,674 bytes; Windows runtime content hash `cdf5d126f8c33756` |
| Real engine through `rpc.ts` | Both context refusals read back as finished `refused` reports, no echoed synthetic saved value, no inference/execution |

Receipts are ignored under `.artifacts/niv71-review/`: `verify.log`, `typecheck-final.log`,
`built-development-final.log`, `packaged-final.log`, `stage.log`, `targets-windows.log`, `windows-ui-final.log`,
`windows-before.json`/`windows-after.json` and `rpc-refusals.json`. The 318-file production/helper manifest is
`source-manifest.json`, fingerprint `6d2967280b35ebbac126339a4f6b96547ae7d051623798dfdfeaa3547034732b`.
The complete diff/untracked files were inspected, with no generated output or credential-shaped production addition.
The original checkout is clean at `8fb2055`. Implementation changes stayed in the separate NIV-71 worktree.

Earlier attempts are retained separately: an old stop-code count assertion was updated along with explicit parsing
checks for both new codes; direct Playwright invocation lacked the package script's absolute Node path; and the new
invalid-choice test initially reused the prior test's stale brief, correctly triggering return refusal. The supported
script and a freshly opened task isolate validation. The broader journey exposed the loading/ready selector collision
above; it was corrected before the final UI/package runs and repeated workspace typechecks. An initial RPC fixture
included a field outside TaskBrief and was correctly refused before startup; the corrected fixture gave the reports
above. No assertion/deadline was weakened and no test was removed or skipped to obtain the final passes.

No paid calls ran. This evidence establishes these edge cases and their integration without adding a live-model
preference-compliance claim. The PR remains for re-review; these results do not authorise merging it.

## Council evaluation late cancellation and truthful timeout evidence (NIV-48) — 30 October 2026

Source verified locally at `86d91b9e11163a563d5ac575125894daa6d6e823`, published unchanged as
`a0e9dea714defaea97976d8cee83c43cc6828af1`. Both have Git tree `033043a0ee5e407a515f0002d39801610876e33d`,
based on main `8fb205541f70ba922146367a395aa45401a60014`. Publication through the connected GitHub app changes commit
metadata, not files. Later changes in this PR are documentation only.

The implementation is confined to the council evaluation batch script and its tests, in the separate `feature/niv-48`
worktree. There are no engine-runtime, host/preload, preferences, task worker, budget-ledger, queue, UI, dependency or
model-migration changes. Protocol 21, frozen fixtures and the approval digest are unchanged.

| Scenario | Evidence |
| --- | --- |
| One polling turn misses both run windows | A fake clock advances beyond cancellation and give-up while hard batch time remains. Exactly one intent and one bounded cancellation call occur; no fresh reconciliation wait is opened. The result remains unresolved with unknown request usage, an accurate late-cancellation note and no next arm. |
| Original ordering restored | Before the fix, the new stdio regression failed with zero cancellation entries instead of one. A separate mutation of the fixed source, putting give-up before cancellation, reproduced the same failure. Source bytes were restored exactly; all 18 new deadline cases then passed. |
| Earlier cancellation, rejected request or lost acknowledgement | Deterministic RPC traces show no duplicate intent/request and no retry. The note distinguishes acknowledgement from an unacknowledged outcome; neither establishes termination by itself. |
| Journal consumes available time | Dispatch uses the remainder after the journal callback: 100 ms in the partial-consumption case. If the journal exhausts the batch allowance, intent is retained and no RPC starts. |
| Hard deadline reached or crossed | At and after the cap, no further cancellation/collection RPC starts. The preceding summary remains available, status stays unknown and request usage stays null. A fractional-millisecond remainder starts no manufactured 1 ms request and does not falsely claim full expiry. |
| Collection expires between reads or a later read fails | Each read checks the same fixed allowance. Prior summaries and a 500-event page are retained; no subsequent page/report call is started after exhaustion. Incomplete evidence is reported and stops the batch rather than becoming a successful or zero-usage record. |
| Ordinary completion/cancellation and unresolved resume | Existing real-engine/stdio tests pass against loopback stand-ins. The ordinary cancelled run proceeds to the next arm; the stuck-run test retains its watchdog, numeric bounds, journal order and resume/no-resend assertions. The new late-wake stdio case likewise records one run start across resume. |

Final verification on the implementation revision:

- Engine typecheck passed.
- Focused `test/council-eval.test.ts`: **36/36 passed**, including all 18 new deadline cases, no failures/skips.
- After the expected ordering-mutation failure and byte-for-byte restoration, the **18/18 deadline cases passed**.
- One final `pnpm verify`: all typechecks and **1,927 tests passed** (140 domain, 720 desktop, 1,067 engine), with
  zero failures, cancellations or skips.
- The full diff and untracked-file review found only the intended script, tests and documentation. No dependency,
  frozen-input, protocol or generated-output changes are included.

Ignored receipts are under `.artifacts/niv48/` in the implementation worktree: `regression-before.log`,
`regression-after.log`, `ordering-mutant.log`, `final-deadline-cases.log`, `focused.log` and `verify.log`.
The failing before/mutation checks are intentional evidence that the regression detects missing cancellation; they
are not passing production runs.

Desktop E2E, packaged and Windows checks were not run because this change is script/test-only. No paid evaluation,
real provider call, credential provisioning or real release-home operation was performed. Existing candidate builds and
evidence remain untouched. This implements the cancellation cleanup independently of NIV-71 / PR 49; merging remains
with Nate.

### PR #50 integration with current main (30 October 2026)

Merged main `60c121667db3ee22912ee3717db1d871d48ee83b` into the reviewed NIV-48 head
`f825f827391e6399987d8d0890599de292b941f1`, producing combined revision
`00f875f5b0bf70900f1158d99a14491c1688e28f`. Only `acceptance.md` and `development.md` conflicted. Each resolution
contains current main's complete document followed by the complete NIV-48 additions from the reviewed head, with
neither ticket's documentation removed or rewritten. This receipt is appended after verification.

The council script and its test remain byte-for-byte identical to `f825f82`. Relative to current main, the only
non-document changes are still `apps/engine/scripts/council-eval/batch.ts` and `apps/engine/test/council-eval.test.ts`.
Engine-runtime, desktop, preload, domain, dependency, staging and packaging files match main. The combined revision
uses protocol 22 from NIV-71; the preceding protocol-21 receipt describes the earlier standalone NIV-48 revision.

Verification of the combined revision on Node 24.21.0 and pnpm 10.4.1:

- Focused `test/council-eval.test.ts`: **36/36 passed**, zero failures/skips, including the late-cancellation,
  partial-evidence and unresolved/no-resend cases. It ran before the full suite.
- `env TMPDIR=/var/tmp taskset --cpu-list 0-1 pnpm verify`: all typechecks and **1,939 tests passed**
  (141 domain, 724 desktop, 1,074 engine), zero failures, cancellations or skips.
- The real engine through `apps/engine/scripts/rpc.ts`: keyless `doctor` and `hello` passed in a disposable home,
  using a disposable repository and no sharing consent. Provider credential variables were removed from the child
  environment, and the disposable home/repository were removed afterwards.
- All 545 tracked non-document files retained their frozen hashes throughout verification. Manifest fingerprint:
  `852dd8138179795dc66ec498de0330421d8ddb8aa00ae0bbbd11b8dd3610920c`.

Ignored receipts are under `.artifacts/niv48-integration/`: `focused.log`, `verify.log`, `rpc-smoke.json`,
`rpc-doctor.log`, `rpc-hello.log`, `source-manifest.json` and `documentation-resolution.json`. The final diff and
untracked files were inspected; no generated output, dependencies or credential material were added.

Desktop UI, packaged and Windows checks were not repeated for this script/test/documentation integration: their
runtime sources are identical to current main. No paid provider/cloud calls ran and no checks were weakened or
skipped to obtain a passing result. PR #50 remains unmerged for the person to review this combined revision.

## NIV-25: held hello shutdown, 30 October 2026

**Finding.** The minute-long observation was a rehearsal artefact. The rehearsal first deliberately killed an
engine during a 60 s hello hold. SIGKILL bypassed that engine's cleanup, leaving its fixture child alive. A later
`app.close()` waited for that orphan even though the active run, its engine and the app had already stopped.
On the retained installed `ead56e8` deb, the app process exited in 84 ms but `app.close()` took 59,463 ms. On a new
installed deb built from clean main `a9dbc309efc842cbf31cf29bf669f12a1589da72`, those measurements were 471 ms and
58,318 ms. A fresh held-run quit on that same build took 100 ms. These diagnostic measurements distinguish process
exit from the automation wait; they do not turn the orphan from the deliberately killed engine into a successful
cleanup.

**Change.** Only the rehearsal and its tests change. Before killing its engine, it captures the hello child's pid,
start time, owner, parent and process group. It then cleans up that fixture in `finally`, checking its identity before
signalling the group and refusing a changed identity. The later `app.closed-run` check now requires the expected
cancellation message and a quit within D4's 5 s + 2 s graces. Application shutdown, execution backends, IPC, protocol,
dependencies and packaging sources are unchanged; no general cleanup guarantee after SIGKILL is added.

**Installed Linux deb evidence**, with fresh profiles and engine homes, no key and no model calls:

| Case | Quit times |
|---|---|
| Fresh app, 60 s hello holding, three repetitions | 176, 145, 153 ms |
| Cancel, graceful restart, engine kill with fixture cleanup, then quit during another hold, three repetitions | 126, 205, 164 ms |
| Full `accept:live --platform linux --session rehearsal`, three sessions | 171, 190, 162 ms |

Every focused repetition persisted `cancelled` with "Cancelled: the app asked it to stop", left no queued/running
rows or live app, engine or tracked hold child, and retained one start after relaunch. All eight applicable criteria
passed in each full rehearsal; each recovery record is `restored` and its profiles were deleted. The installed app
matched the package and runtime hashes. The original 0.1.0 installation was restored afterwards, with its original
`app.asar` hash and a clean `dpkg --verify` result. The release engine home was never selected.

The test package's SHA-256 is `1b49bb56de1187c4fe89510185ed2533c7bdc3bdd0eb52e80695b6f65189ae9c`;
its `app.asar` is `7d0ee4870c9b84e93c7858d31c7b234b39d94a56e724f05511bee29f3feb44fe`, and its Linux
runtime is `65f9561b43bb5ebf` (protocol 22). The app was built from clean main before the uncommitted harness change;
the harness's separate source fingerprints and commands are in `.artifacts/niv25/receipt.json`.

**Verification:** `taskset -c 0-3 pnpm verify` passed all typechecks and **1,944 tests** (141 domain, 729 desktop,
1,074 engine), with no failures, cancellations or skips. An initial unrestricted run hit existing timeout failures
under heavy concurrency and was stopped; the complete bounded-affinity rerun passed without changing checks or
deadlines. The focused acceptance tests passed 12/12, including a real engine kill, orphan cleanup, cancellation and
no replay. The packaged `app.spec.ts` passed 6/6, and a keyless hello through `apps/engine/scripts/rpc.ts` succeeded.
Windows checks were not repeated for this Linux rehearsal fix: no application runtime, target, supervisor, staging,
main-process or preload source changed.

Ignored diagnostic traces, the six focused repetitions, package metadata, verification logs and the installation
restoration receipt are in `.artifacts/niv25/`. The full rehearsal records are under
`~/nivra-acceptance/niv25-20261030/`, in sessions `20261030T075657Z`, `20261030T075837Z` and `20261030T080033Z`.

**PR #51 review correction, after `416275b`.** A child can disappear between the state read and the owner read,
including during post-SIGKILL polling. Before refusing an identity mismatch, cleanup now reads the state again:
absence completes cleanup, while a process still present remains refused. Three deterministic regressions cover
disappearance before signalling, disappearance while polling after one signal, and a replacement at the same pid
after the owner read fails. Both disappearance cases failed before the correction; the replacement remains refused
without being signalled.

The focused acceptance tests passed **15/15**. `taskset -c 0-3 pnpm verify` passed all typechecks and **1,947 tests**
(141 domain, 732 desktop, 1,074 engine), with no failures, cancellations or skips. Receipts are in
`.artifacts/niv25-review/`. Packaged and Windows checks were not repeated for this script/test correction; application
runtime sources are unchanged, and the preceding packaged checks and rehearsal timings remain evidence from the
reviewed implementation rather than new runs.

## NIV-70: task discussion, activity and multimodal context (30 October 2026)

Implemented from main `60c1216`, reusing NIV-69 Planning and NIV-71's frozen coding context; combined verification
includes current main `a9dbc30`. The change adds
native task discussion/reference storage, projected activity, exact frozen source manifests across task Companion,
Planning and coding, typed image transport and bounded text-only PDF extraction. Coding first receives guarded
host-ledger grants with its existing 23 productive requests and reserved hand-in; it remains outside the
Companion/Planning monthly request allowance. No sandbox accounting or budget policy was redesigned.

[The NIV-70 receipt](niv-70-verification.md) records limits, negative/recovery cases, packaged/Windows evidence and
the final candidate identity. Model requests in verification use explicit local stand-ins. Live provider image
understanding is unassessed and requires separate approval. No paid calls, merges or Linear updates ran. Publishing
the PR and its reviewer comment was explicitly requested separately.

### PR 52 review corrections and current main — 30 October 2026

The four review findings at `77e96a3` now have regression coverage: incremental exclusion from oversized discussion,
private-file cleanup before task metadata deletion, a persistent removed-attachment cleanup retry, and retained
accepted Planning results with stale advice after reference changes. Current main `5b9b635` is integrated, preserving
NIV-25's implementation/tests and both acceptance additions.

All typechecks and **1,979 tests passed** (144 domain, 754 desktop, 1,081 engine). The affected built and packaged
Electron suites each passed **15/15**; freshly staged Windows engine checks passed **39/39**, and the freshly copied
Windows app passed **16/16**, including native private-task-file deletion. All of these corrected-candidate runs
finished with zero failures or skips. The keyless real-engine RPC check passed as well.

[The review-fix receipt](niv-70-verification.md#pr-52-review-fixes-and-current-main-integration--30-october-2026) records
the frozen source manifest, failure/retry evidence, commands and limits. No paid calls or live visual probe ran; PR 52
remains unmerged for re-review.

## NIV-28: bounded window startup visibility, 30 October 2026

The main window now shows on `ready-to-show` or after a five-second fallback. The startup controller is attached
before maximisation and renderer loading. Showing the window, beginning to close it or destroying it cancels the
timer and removes the startup listeners; late readiness cannot reopen it. The delayed path also checks whether the
window has already been shown or destroyed. Bounds, zoom, theme, renderer security and engine lifecycle rules are
unchanged.

This work is isolated on `feature/niv-28`. It began on main `5b9b635`; when PR 52 merged during verification, the
patch was carried onto main `f1eaf4770dd8e5b3cd44340ed4131496455526e2` and the combined candidate was verified again.
The helper and its deterministic tests retained their original hashes. No dependency, domain, preload, IPC or engine
change is part of this diff.

| Evidence on the combined candidate | Result |
|---|---|
| Deterministic startup-controller tests | 7/7 passed: normal readiness, missing readiness at five seconds, another show path, close, closed, destruction and already visible/destroyed windows; late readiness and delayed showing remain cancelled |
| `taskset -c 0-3 pnpm verify` | All typechecks and 1,986 tests passed: 144 domain, 761 desktop, 1,081 engine; no failures, cancellations or skips |
| Built Linux `test:e2e e2e/app.spec.ts`, under Xvfb | 7/7 passed, including native `BrowserWindow.isVisible()` |
| Full Linux `test:packaged`, under Xvfb | 88 passed, 72 existing packaged-project skips, no failures; no skip was added for this change |
| Freshly staged `verify:windows --skip-stage` | 39/39 passed on Windows, including native and WSL engines and the unchanged release-home check |
| `dev:win --skip-stage --no-launch`, then full `test:windows` | 17/17 passed, including native-window visibility, relaunches and cleanup |

Both runtimes were freshly staged before reusing them with `--skip-stage`. The Linux packaged app and the Windows
copy retained their expected hashes throughout their checks. The Linux `app.asar` SHA-256 is
`93d51acf65e91f00cb4eae18b4de18fe5f854450b173f380d4066abb61232c58`; the Windows development-channel
`app.asar` is `8dfc70082bb2080216fb3102aaf894963605c24ffc1150c260c072d9de6bf586`. Their runtime hashes
are `e8d44378d308555b` (Linux/WSL) and `bb435c7b18f3f686` (Windows), protocol 23.

An initial built smoke invocation through direct `pnpm exec playwright` lacked the package script's Node-path
configuration and failed engine startup. The documented `test:e2e` launcher passed 7/7 under Xvfb without changing
tests, deadlines or runtime configuration. The initial-main receipts are kept separately from the combined runs.
Commands, source fingerprints, results and build identities are under `.artifacts/niv28/`; the combined receipt is
`receipt.json`. No live model/provider calls ran, and no generated output is included in the change.

**Original GNOME acceptance remains pending.** No active GNOME Wayland guest was available, and the archived VM's
SSH endpoint was unreachable. The ordinary Xvfb/WSLg and Windows checks do not establish the locked-screen case.
That check must launch the packaged app while the GNOME session is locked, wait beyond five seconds, unlock and
verify that the window appears and is interactive without restarting or manually showing it. NIV-28 remains open;
the PR is opened for code review with this limitation stated.

## NIV-10: explicitly confirmed personal defaults (30 October 2026)

Implemented on `feature/niv-10`, in a separate worktree created from main `f1eaf47`.
D62 supersedes the promotion deferral in D23; the delivered management/export/import and coding-context work is
reused. The original NIV-60 worktree is not changed by this implementation.

| Behaviour | Evidence |
| --- | --- |
| A confirmed entered, imported or suggestion-derived project preference can supply a separately confirmed personal default; even a project decision becomes a default, with its original preserved | `preferences.test.ts` checks the complete original record and independent personal fields; the built and packaged UI reviews both entered and retained suggestion records |
| The source must still be confirmed, at the reviewed revision, and belong to an available project | Pure tests cover stale, replaced, deleted, unconfirmed and personal sources. Host tests hold the secret read while an edit, replacement, deletion or project removal lands; every save is refused without a further store change |
| Concurrent submissions and identical trimmed personal wording save once, including at capacity | Pure and host tests check the returned record, creation flag, count and preference revision. The UI reports an existing default without another revision |
| Only independently confirmed personal wording reaches another project | Real-engine host checks cover both targets and restart/edit/delete freshness. Captured loopback model requests exclude the source's text, citation path, repository path, preference id, run id and HEAD. The Windows UI checks a native source and actual native/WSL engine receipts |
| Review starts blank, shows historical evidence, and requires confirmation of the personal wording | Built and packaged UI tests inspect origin, project intent, evidence and the blank field. Cancel, Escape, leaving the mounted Settings section and reload discard the draft without saving |
| Credentials and unreadable saved-key checks prevent saving | Host tests and both Linux UI builds check refusals, unchanged records and errors that never echo a key; the packaged UI exercises the strict secret-store read |

Verification, using Node 24.21.0 and pnpm 10.4.1:

- `pnpm verify`: **1,986 passed**, zero skipped (144 domain, 761 desktop, 1,081 engine); all typechecks passed.
- `xvfb-run -a pnpm --filter @nivra/desktop test:e2e e2e/preferences.spec.ts e2e/app.spec.ts`: **19 passed**, zero skipped.
- `pnpm stage:runtime all`: passed. Linux runtime `e8d44378d308555b` passed self-check and stdio initialise/shutdown;
  Windows runtime `bb435c7b18f3f686` was cross-staged and then used by the Windows app checks.
- `pnpm --filter @nivra/desktop package:dir`, followed by `xvfb-run -a pnpm --filter @nivra/desktop test:packaged`:
  **91 passed, 72 skipped**. These are the existing harness skips for cases unavailable in a packaged app; all four
  new promotion UI scenarios ran and passed.
- `pnpm dev:win --no-launch --skip-stage` (using those freshly staged runtimes), followed by
  `pnpm --filter @nivra/desktop test:windows`: **17 passed**, zero skipped. The release WSL home was unchanged and
  the test's own engine home was removed.

The first full verification attempt exceeded the existing five-second refusal deadline in two unchanged engine
database-privacy tests (hard link and directory at `nivra.db-wal`) while other validation was running. Their separate
file passed **47/47**, followed by the complete passing `pnpm verify` above, with no test or engine change. An initial
UI attempt was stopped after a test setup failed to reselect its project after reload; the corrected setup and final
UI runs are recorded above. No skips or relaxed assertions were added.

Logs, a source manifest and the inspected dialog screenshot are kept locally under `.artifacts/niv10/`. Verification
used no live provider calls. No persistence migration, engine protocol, target/supervisor/staging source, dependency,
worker or budget policy changed. Personal wording is manually reviewed; these checks do not claim semantic removal
of private details that a person independently chooses to type into that wording.

### PR integration with main — 30 October 2026

Main `7f7e26f` (NIV-28) is integrated at `16277e9`. Both acceptance histories are retained; the promotion change is
unchanged. Fresh checks on the combined code passed all typechecks and **1,993 tests** (144 domain, 768 desktop,
1,081 engine), with zero failures or skips. The affected built UI suites passed **20/20**; a fresh Linux package
passed the full packaged suite, **92 passed and 72 existing skips**; the freshly copied Windows app passed **18/18**.
All four new promotion UI scenarios ran in both Linux builds, and the Windows promotion scenario ran on the actual
native and WSL engines. The existing staged runtimes were reused because engine, domain and lockfile content is
unchanged. No live provider calls ran. Combined-candidate logs and the source manifest are under `.artifacts/niv10/pr-*`.

## Reliable coding on larger tasks (NIV-60, D63) — 30 October 2026

The implementation extends targeted edits, guarded coding grants and the shared host request ledger. New previews
default to a maximum of 64 working requests plus one reserved hand-in; time/context may stop work sooner. Monthly
coding coverage is explicitly saved, with separate recovery acknowledgement where required. Boundary counters and
deadlines remain cumulative, and late capacity replies cannot restart cancelled, submitted or finalising work.

[The NIV-60 verification record](niv-60-verification.md) separates deterministic enforcement, desktop checks and the
prepared A1/B1/C1 real-task evaluation. Deterministic stand-ins pass 65 requests, 33 required writes and the old input
allowance, while separate exhausted-pool/failed-guard cases retain final checks. These do not establish model quality
or a useful larger-task result. NIV-60 remains open pending the independent real-task acceptance evidence.

## NIV-53 completion acceptance runner — 30 October 2026

The [NIV-53 verification record](niv-53-verification.md) describes the isolated Windows desktop runner, shared
offline UI journey, selected-save/restart checks and final output-limit regression. It is based on latest fetched
main `06dc05a`, with local uncommitted acceptance tooling; its source and frozen build hashes are recorded.

`pnpm verify` passed 1,997 tests with no skips; the focused coach UI suites passed 12/12, the final two acceptance
cases 2/2, real-engine RPC's four cases passed, and the freshly built Windows suite passed 18/18. The Windows
preview rehearsal read no key and pressed no Start. No production API, prompt, dependency or allowance changed.

**The one live coaching failed.** Coach v2 on `nvidia/Nemotron-3.5-Super-VL` reported 2,410 input and 4,000 output
tokens and `finishReason: length`, with no usable structured answer. The original v1 brief and Draft state stayed
unchanged, with no coding attempt. Reopening retained the failed coaching and started no engine; the key was
removed and the exact-key scan passed. No paid retry was made and no live selective save was reached.

**NIV-53 remains open:** useful live coaching and the resulting reviewed brief improvement are still unproved.
Offline selective-saving evidence does not replace that acceptance. Visible subtasks remain a separate follow-up.

### Coach response-budget correction (D64)

The separately requested next allowance is 8,000 completion tokens. Context admission reserves that full amount,
with at most 56,000 estimated input tokens under the existing 64,000-token ceiling. The preview and recipe agree;
other workflows retain their limits, and the coach retains its concise validated form, 150/180-second deadlines,
cancellation and one request without retries. Reasoning usage is retained as an optional reported subset of output,
never added to the total; missing remains null, including when the SDK supplies an unreported zero.

Fresh checks passed 2,000 unit tests, 13 built coach UI cases, four real-engine RPC cases and 18 Windows cases.
The targeted packaged coach suite passed its no-key case and skipped 12 cases requiring unpackaged-only stand-ins;
the final packaged preview explicitly asserted the 8,000-token wording. The original 12 evidence files remain
byte-identical. [The verification record](niv-53-verification.md) gives the receipts and updated recipe location.

No second paid attempt ran. Current-main inspection at `033b600` confirmed that the coach also lacks host-ledger
grant admission. The initial paid check should have been deferred under D49. The helper now refuses paid mode until
that separate integration is verified. NIV-53 remains open; budget sizing and passing offline tests do not establish
live coaching quality or satisfy grant admission.

### PR candidate on current main

The NIV-53 code candidate `b87dd6a` is rebased onto `033b600`, including NIV-60/PR #54. Both acceptance histories and
decisions are retained. Fresh combined checks passed all typechecks and **2,034 tests** (144 domain, 1,103 engine,
787 desktop), with no failures or skips; built coach UI **13/13**, four real-engine RPC cases, fresh packaged coach
checks **1 passed, 12 stand-in-only skips**, and fresh Windows/native/WSL UI **18/18**. The final documentation record
changes no runtime code. All 12 failed-run evidence hashes still match; no new paid run was made. The historical
frozen recipes do not identify the rebased PR candidate. Host-ledger admission and a newly frozen useful live coach
journey remain necessary before closing NIV-53; NIV-52 remains assessment-only.
