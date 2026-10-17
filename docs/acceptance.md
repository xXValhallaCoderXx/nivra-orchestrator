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
| Repository conventions vs personal defaults | Repository B's conventions win over a confirmed personal default. | The answer reports where the repository differs from a confirmed preference, and the repository wins: passing offline (D22). Live on B: run, with the result recorded privately in NIV-6, because B is private. Overrides and full precedence: NIV-11. |
| Explicit override | A task-specific choice wins without changing the stored profile. | Pending |
| Context isolation | Project A's project-only records and files never reach project B's requests. | Passing for the run's context (D21) and for model requests, files included (D22); offline. See below. |
| Changed or deleted preference | The next request uses the edited preference, or none after deletion. | Passing for the run's context, including after an app restart (D21), and for model requests (D22), offline. See below. |
| Consent | No repository-derived material leaves the machine without that project's `modelContext` consent. `cloudExecution` stays off and unused. | Passing offline, including consent withdrawn while a run starts, waits or runs (D22; see below). |
| Cancellation and restart | The app reports the true state. An interrupted run ends as `run.interrupted` and is never replayed. | Passing at the engine level and for explain runs (`pnpm verify`). |
| Failure reporting | Each of these is reported clearly, with no silent retry: invalid key, unavailable model, rate limiting, timeout, malformed tool results, network failure, sharing refusal. | Passing offline against a stub, except timeouts, which are tested in-process with short deadlines (D22; see below). |

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
    preference the run wasn't given is turned down.
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

  No key, and consent off, made no request at all. The engine's log never held the question. Each request is recorded
  once: a first request that fails is one event, and a success followed by a failure is two. A cancel before any
  request, or between two, records none.
- **Budget and time.**
  - With a small context length, the answer was forced early.
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
  the app (revision 0)". The preference contrast itself is still to run.

A real engine driven through `apps/engine/scripts/rpc.ts`:
- with no key, and with consent off, the run was refused each time with no request;
- against the stub, the run succeeded with 2 of 2 citations checked, its route recorded as `loopback-test`.

*Still pending:*
- a public pair of repositories for showing the preference contrast in the demonstration: B's live results are
  recorded privately in NIV-6;
- the stronger provider probes with a real key;
- an explanation that reaches Token Factory from the native Windows engine.

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
  
  *Seen passing 2026-10-17 through the real UI (`test:windows`, 5/5).* The zip carries both runtimes.
- **Packaged Linux app** (`electron-builder --dir`): the same flow on the local target through the real UI, plus the
  preference handoff (`test:packaged`, 11/11). *Seen passing 2026-10-17.*
- **Actionable refusals and guidance** for:
  - no WSL, or an outdated WSL;
  - WSL with no distribution, or only Docker Desktop's, or only WSL 1 ones;
  - a WSL listing that fails;
  - WSL1, `docker-desktop`, a musl distribution, ARM64, a distribution never opened;
  - a network share;
  - missing git.
  
  *Covered by unit tests with captured tool output; not yet seen on a machine that has them.*
- **Installed deb** on Ubuntu 24.04, launched without changing AppArmor: the same flow on the local target. *Not yet
  run: installing needs sudo.*
- **Token Factory** reached from both the WSL and the native engine: models listed and one Nemotron call made
  (Settings → Check Token Factory, on each target).
  - *Seen once, 17 October, with Nate's key:* 28 models, five of them NVIDIA's. Nemotron 3 Super called the tool and
    answered in 2,249 ms (964 tokens in, 65 out). It honoured required tool choice, and a forced tool when it was the
    only one offered. Rate-limit headers were present, and `/models` gave no context length.
  - Which engine answered wasn't recorded, so reaching both is still pending.
- **Clean machine:** the Windows zip runs native hello on a VM or Windows Sandbox with no Visual C++ redistributable
  installed. *Not yet run.*

## Hackathon submission checklist

The dated checklist, with a source link for each requirement, is in [submission.md](submission.md) (NIV-15).
