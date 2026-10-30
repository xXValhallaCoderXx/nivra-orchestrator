# NIV-72: branding and development-content cleanup

Base: main `10afaee3`, on the isolated `feature/niv-72` worktree. The chosen direction is charcoal with green actions,
with internal Hello controls removed from both development and release UI. This is a renderer presentation change;
the host, preload, engine, ledger, dependencies and packaging configuration are unchanged.

## Changed surfaces and copy audit

- The shared theme supplies charcoal surfaces, green primary actions, selection and keyboard focus, with separate
  semantic outcome colours. The existing IBM Plex fonts, type scale and appearance persistence remain.
- Sidebar and narrow header share the N mark. The companion launcher keeps its original compact footprint. Buttons, input boundaries, tabs, navigation,
  cards and dialogs use the same tokens. Page columns and action groups follow the space left by the companion.
- Advanced diagnostics no longer mounts **Hello run**, **Run hello**, the hold-duration selector or its timeline.
  Its introduction now describes the useful setup and sandbox checks. Doctor, connection checks and sandbox checks
  remain available.
- Home's ready-engine tooltip says **The engine for this project is ready.** Target, repository path and actionable
  engine failures remain; versions, architecture, Node and internal data locations remain in Advanced diagnostics.
- Brief history replaces raw JSON with the same read-only fields as the current brief, including cases, baseline
  checks and frozen files. Historical provenance and execution policy remain available in a readable disclosure,
  and fields marked for revalidation remain identified. Values remain literal text, including text resembling markup.
- The audit found no further app-owned fixture/demo labels or ticket references to remove from ordinary screens.
  Source comments and invisible test hooks are not visible product copy. No user projects or tasks were filtered.
- Required checks, failures, skipped checks, baseline comparisons, approval and upload disclosures, unknown usage,
  budget limits, provenance and truthful **test endpoint** labels remain. Evidence disclosures were not redesigned.

## Palette and accessibility

| Token | Light | Dark |
| --- | --- | --- |
| Canvas | `#F6F7F6` | `#111513` |
| Surface | `#FFFFFF` | `#1A201C` |
| Text | `#171C19` | `#F2F5F3` |
| Secondary text | `#4D5951` | `#B6C1BA` |
| Muted text | `#5F6E64` | `#96A69B` |
| Primary action | `#8FCB50` | `#8FCB50` |
| Text on primary action | `#142011` | `#142011` |
| Selection | `#E9F4DE` | `#233321` |
| Focus | `#37691D` | `#A5DD70` |
| Control border | `#78867C` | `#78867C` |

The primary action text/fill pair computes to 8.70:1. The window check also measures actual rendered action, body,
muted sidebar, disabled-control and focused-input colours in each scheme, rather than assuming token values reached
the controls. Light muted text is 4.73:1 even on the sidebar and selected surfaces.
Selection retains words, weight and `aria-current`; outcomes retain their existing labels and marks.

## Automation and evidence

The Hello engine workflow and existing typed bridge remain. The app, preferences, shell and Windows checks start
internal diagnostic runs through `startHello` and read their events/status through the bridge. They retain checks
for the received preference fingerprint, owned engine, held child, cancellation and quitting. The live acceptance
and interruption observers use the same facilities; they no longer claim a visible Hello timeline as evidence.
The interruption observer still checks the engine failure and Restart action in the UI.

No paid calls or live cloud execution are required for this presentation work. Built-app model journeys use the
existing explicit loopback stubs; packaged tests retain their existing skips for facilities a packaged app refuses.

Commands ran from the isolated worktree on WSL/Linux x64 with Node 24.21.0 and pnpm 10.4.1. Windows checks drove
real Windows processes, both the native and WSL engines, and isolated test homes.

| Check | Result and evidence |
| --- | --- |
| `pnpm verify` | Passed: domain 144, desktop 789, engine 1,112; 2,045 total, no skips. `verify-candidate.log`. |
| Final desktop typecheck | Passed all three desktop TypeScript projects. `typecheck-final.log`. |
| Built and packaged main journeys | 150 passed, eight existing packaged skips, across 158 cases. `ui-candidate.log`. |
| Final branding and discussion/history, both projects | 16 passed, no skips. Includes historical plan provenance and execution policy. `ui-handoff.log`. |
| `test:windows`, after `dev:win --skip-stage --no-launch` | 18 passed. Fresh-profile Hello absence, native/WSL run ownership, preferences, cancellation, shutdown and release-home preservation. `ui-windows-handoff.log`. |
| Runtime staging and unpacked packaging | Linux self-check and stdio smoke passed; both runtimes staged; Linux and Windows unpacked development builds succeeded. |
| Visual capture | 34 matching before/after images. No document or main-page horizontal overflow in the 17 final captures. |

The handoff renderer is `index-C3WdtV9R.js` with `index-0Dj5xKkl.css`, built in development channel and exercised both
unpackaged and packaged. The exact source/asset hashes accompany the screenshot archive in `candidate.json`:
code fingerprint `129bfde42e07792f0ee15832ada9061d2c999da591a6bbdc9d6d2c56eb55f799`.

The root verification and 158-case journey receipts are carried from this branch's working tree based on
`10afaee3`, before the final history-only metadata disclosure. The final typecheck and 16-case built/packaged check
cover that addition, and the final Windows run uses the rebuilt handoff renderer. No clean-commit or live-model
acceptance is inferred from earlier working-tree checks.

Exploratory full-suite runs are not recorded as passes: they exposed an old Dark-colour assertion, an assertion
sampling the companion's padding transition, and a review cancellation regression after enlarging the launcher.
The baseline's review journey passed 10/10; retaining the launcher's original footprint restored the candidate's
10/10 result. The corrected, subsequent journey runs above passed. The exact screenshot gallery was regenerated
from the final renderer.

The eight packaged skips retain existing refusals for model-stub/development-only journeys. No tests were removed
or newly skipped. `verify:windows` (the target harness), destructive distribution interruption and paid/live
acceptance were not run; target/supervisor/staging source did not change. The migrated live/interruption observers
are typechecked; their live scripts are not claimed as exercised here.

The original Windows development build and data were preserved before checks and restored afterwards. The release
WSL home was checked unchanged by the Windows journey. Disposable visual profiles were removed, and the original
`feature/niv-60` checkout remained clean.

## Visual handoff

The ignored `apps/desktop/.artifacts/niv72/index.html` gallery compares before/after Home, project Home, task,
companion, Preferences, Connections and Budget in light and dark. Before images come from a separate clean build
of `10afaee3`; after images use the candidate's built renderer. Each uses a fresh profile, an empty fixture
repository and a manually created fixture brief. No image represents a live model answer or successful coding run.

Desktop capture is 1440 × 1000; additional captures cover a 1024 px window with companion open and an 820 × 900
window at 150% zoom (547 CSS px). Finite layout transitions finish before screenshots. The gallery and generated
build/test files are kept outside the committed source. The archive is attached to
[NIV-72](https://linear.app/sentiment-hound/issue/NIV-72/refresh-nivra-branding-and-remove-development-only-ui-clutter)
as **NIV-72 — Before and after screenshots**; download it and open `index.html` for the offline gallery.

For NIV-50, capture the selected build's **Nivra companion**, task preview/review and **Advanced diagnostics** screens.
Hello controls are no longer part of the product journey. This ticket does not regenerate a release candidate,
record a video, update submission claims or merge the PR.
