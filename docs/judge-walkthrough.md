# Judge walkthrough and access decision

**Draft, 30 October 2026.** These labels were checked against source at
`75b38e07ca191cb79b16468d95941a21c47fe1c8`. A submission build, its measured timings and free judge access remain
pending. Recheck these instructions on the selected build before publishing them. The current public v0.1.1 build
has its own older instructions; it does not contain the execution features described here.

## Short route: explain the public sample

This route needs Token Factory inference access, with a supported NVIDIA model. It needs neither a Nebius project
id nor Sandboxes access. **Check Token Factory** makes paid diagnostic calls; it is optional before Explain.
Judge-funded API access has not been established as meeting the free-testing requirement.

1. Download the selected release's test build and `SHA256SUMS`, then check its hash as the
   [README](../README.md#install-a-test-build) describes. Record the release version and source commit shown there.
   The selected release URL is pending; a historical candidate is not the published submission build.
2. Clone the optional public MIT [onboarding sample](https://github.com/xXValhallaCoderXx/nivra-sample) and check out
   `bbf62893cb699c6994cca9fa7219b66f87f5a30d`, using the README's commands. No dependencies need installing.
   On Windows, keep the clone inside a WSL distribution and select its folder through `wsl.localhost`.
3. Start Nivra. In the project switcher, choose **Add project…**, then that folder. Its engine runs on the system
   holding the folder. There is no target selector.
4. Open **Settings → Connections**. Enter the key provided by the agreed access arrangement in **Nebius API key**,
   then **Save**. Keep credential entry out of footage. The arrangement and private delivery instructions are pending;
   no owner's development key is supplied.
5. If a diagnostic is needed, press **Check Token Factory** with that project selected. It lists models and makes
   up to six inference requests within 150 seconds. Its result proves only that access check, not a useful explanation
   or Sandboxes access. Do not repeat it just for a better recording.
6. Open **Home → Explain this project**, then press **Explain** and allow model sharing when asked. Read the answer
   and open a citation: it identifies the file and lines the model was shown. That is evidence of what it read,
   not proof that its conclusion is correct. Selected-build duration: pending measurement.
7. When finished, remove the key in **Settings → Connections**. Remove the project id there too if it was saved.

Missions and draft briefs can also be edited without a model. Paid mission reviews and coaching are excluded from
this walkthrough until their own grant integration and useful live acceptance are established on the chosen build.

## Separate route: sandbox check

This route additionally needs the id of the key's Nebius project, with Sandboxes access enabled. An inference check
does not prove these permissions. This check runs Nivra's fixed diagnostics, not a full coding task.
The check uses `spawn`, `spawn_disposable`, `list` and `cancel`; preparing a task environment additionally needs
permission to import its image. Confirm the advertised model is listed for the dedicated judging credentials.

1. With the public sample selected, save **Project ID, for Nebius Sandboxes** in **Settings → Connections**.
2. Open **Settings → Advanced diagnostics → Sandbox check**, then **Preview the check**. Review the exact commit,
   included files, omissions, limits and retention before sending anything.
3. Press **Upload and check**, then **Allow uploads for this project** if asked. This permission is separate from
   sharing with Token Factory. The fixed check runs with networking off: at most eight operations, each command up
   to 60 seconds, ten minutes in all, then up to seven minutes for cleanup. These are bounds, not measured durations.
4. Inspect every step and cleanup's result. A refusal, failure, uncertainty or incomplete cleanup stays visible as
   that result; nothing is applied to the checkout. Linux historical execution and Windows stand-in routing evidence
   are distinguished in the [evidence table](submission-evidence.md).

Nebius retains uploads and operation records, including what a command wrote, without a deletion API. Images are
kept for 180 days. Shared project credentials can expose that project's uploaded content to their holders; use the
public sample and keep personal repositories out of a shared judging project.

## Full task limits

A public reproduction of the historical full task is deferred. The plain-file onboarding sample has no advertised
coding-task brief. Do not install its dependencies or run repository checks on the host to imitate sandbox evidence.
For a person's own JS/TS repository, follow the README's [task prerequisites](../README.md#running-a-task-on-your-own-repository):
supported npm/pnpm setup, environment preparation inside Nebius, a saved brief and its previewed checks and limits.
The **Environment** page offers **The whole project** or **Chosen workspace packages** before **Preview the preparation**
and **Prepare**. Preparation alone has networking on.

On current source, every acceptance case and required repository check must pass, with complete frozen/setup
integrity evidence, before the engine can admit approval of the exact proposal. A previous passing case does not
waive a final failed typecheck. Historical candidate 3's rejection remains its own older result; it does not demonstrate
the newer enforcement. Native Windows tasks are refused; live Windows-to-WSL task execution remains unproved.

## Access options for Nate

The [official rules](https://nebiusglobalaihackathon.devpost.com/rules) require free access for testing through the
judging end: **24 December 2026, 04:00 SGT**. The options below are proposals, not established arrangements.

| Option | Model and sandbox permissions | Cost and availability owner | Still needed |
|---|---|---|---|
| Dedicated judging project and key, entered in the local app (recommended) | Token Factory with the advertised model; Sandboxes permissions too if that route is offered | Nate funds and monitors use, maintains access through the judging end, and replaces exposed credentials | Create separate credentials; confirm project access, key expiry, balance/credit expiry and beta availability; deliver privately; test the selected build with those credentials under an approved recipe |
| Maintained remote desktop test installation | A native Nivra installation with dedicated judging credentials and a disposable public-sample profile | Nate supplies the session and service costs and keeps it reachable through judging | Establish a usable judge login and session, privacy boundaries and concurrent access; test the advertised journey; no such installation is currently evidenced |
| Judges bring their own paid credentials | Their own inference and, if needed, Sandboxes-enabled project | Judges would bear service costs | Obtain organiser confirmation that this satisfies the stated free-access requirement; owner-key J0/J1 probes do not establish it |

Before finalising, record the chosen option, exact build, routes tested, access result, private credential-delivery
method, service-cost owner and availability owner. Credential values belong only in the agreed private delivery;
never put them in this file, the release, video or public Devpost text. No new access check or paid call is approved
by this document. Nate publishes and submits unless separately delegated.
