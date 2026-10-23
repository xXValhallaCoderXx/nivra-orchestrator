// R3's journey through the window (D37, NIV-45), shared by its offline e2e and research-live.ts, so the live run takes
// no step for the first time. It drives the window as a person would and reads it through the bridge, with string
// expressions, since scripts are compiled without the DOM's types (as in live-ui.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "@nivra/domain";
import type { Locator, Page } from "@playwright/test";
import type { PlanView, SettingsView } from "../src/shared/ipc.ts";
import type { ResearchPreview, ResearchView } from "../src/shared/research.ts";
import { sleep, waitFor } from "./live-ui.ts";
import { DEMO_SEED, DEMO_SITES, demoPacket } from "./research-demo.ts";

const arg = (value: unknown) => JSON.stringify(value);
const call = <T>(page: Page, expression: string) => page.evaluate(expression) as Promise<T>;
const conversationId = DEMO_SEED.ids.conversationId;

/** The selection the journey makes: both of the plan's assumptions, each query its own words, and the sites. */
export const DEMO_SELECTION = {
  assumptions: DEMO_SEED.assumptions.map((query, index) => ({ from: { kind: "plan" as const, index }, query })),
  sites: { mode: DEMO_SITES.mode, hosts: [...DEMO_SITES.hosts] },
};

export const researchOf = (page: Page) => call<ResearchView[]>(page, `window.nivra.listResearch(${arg(conversationId)})`);
export const plansOf = (page: Page) => call<PlanView[]>(page, `window.nivra.listPlans(${arg(conversationId)})`);

/** Opens the demonstration's conversation and waits for its plan. */
export async function openDemo(page: Page): Promise<void> {
  await page.getByTestId("nav-planning").click();
  await page.getByTestId("nav-conversation").filter({ hasText: DEMO_SEED.question }).click();
  await page.getByTestId("conversation-title").filter({ hasText: DEMO_SEED.question }).waitFor();
  await page.getByTestId("plan-version").first().waitFor();
}

/** Opens the research dialog and picks both of the plan's assumptions, each query its own words, and the sites. */
export async function pickDemo(page: Page): Promise<void> {
  await page.getByTestId("plan-research-open").click();
  for (const assumption of DEMO_SEED.assumptions) await page.getByRole("checkbox", { name: assumption, exact: true }).check();
  // A project's queries start empty; each button fills its own row, then hides.
  for (const _ of DEMO_SEED.assumptions) await page.getByTestId("research-use-words").first().click();
  const queries = await page.getByTestId("research-query").evaluateAll((fields) => fields.map((field) => (field as unknown as { value: string }).value));
  if (JSON.stringify(queries) !== JSON.stringify(DEMO_SEED.assumptions)) throw new Error(`The queries read ${JSON.stringify(queries)}, not the assumptions' words.`);
  await page.getByTestId("research-sites").fill(DEMO_SITES.hosts.join(" "));
}

/**
 * Previews, and gives what the preview says research waits for, each through its own dialog: research's permission,
 * then the project's sharing. The dialog previews again by itself once each is saved. Anything else that keeps research
 * from starting is an error, in the preview's own words.
 */
export async function previewAllowing(page: Page, log: (line: string) => void): Promise<void> {
  await page.getByTestId("research-preview-button").click();
  for (let round = 0; round < 3; round++) {
    const state = await waitFor(
      async () => {
        // The permission buttons are rendered inside the blocked notice, so the notice is read first, then them.
        const blocked = page.getByTestId("research-blocked");
        if (await blocked.isVisible()) {
          if (await blocked.getByTestId("research-allow-web").count()) return "web";
          if (await blocked.getByTestId("research-allow-sharing").count()) return "sharing";
          return `blocked: ${await blocked.innerText()}`;
        }
        const start = page.getByTestId("research-start");
        if ((await start.isVisible()) && (await start.isEnabled())) return "ready";
        return null;
      },
      30_000,
      "the preview",
    );
    if (state === "ready") return;
    if (state.startsWith("blocked: ")) throw new Error(`The preview can't start research. ${state.slice(9)}`);
    if (state === "web") {
      log("The preview asks for research's permission: turning it on through its dialog.");
      await page.getByTestId("research-allow-web").click();
      await page.getByTestId("research-permission-allow").click();
    } else {
      log("The preview asks for the project's sharing: allowing it through the research consent.");
      await page.getByTestId("research-allow-sharing").click();
      await page.getByTestId("research-consent-allow").click();
    }
    await waitFor(async () => !(await page.getByTestId(state === "web" ? "research-allow-web" : "research-allow-sharing").isVisible()), 30_000, "the permission to be saved");
  }
  throw new Error("The preview still waits for something after research's permission and the project's sharing were given.");
}

/** What the window's preview shows of the queries and sites, which must be the demonstration's exactly. */
export async function previewShown(page: Page): Promise<{ queries: string[]; sites: string }> {
  const queries = await page.getByTestId("research-preview-query").allInnerTexts();
  const sites = await page.getByTestId("research-preview-queries").locator("li").last().innerText();
  const expected = DEMO_SEED.assumptions.map((assumption, index) => `A${index + 1}: ${assumption}`);
  if (JSON.stringify(queries.map((query) => query.trim())) !== JSON.stringify(expected)) throw new Error(`The preview shows ${JSON.stringify(queries)}, not ${JSON.stringify(expected)}.`);
  if (sites.trim() !== `Sites to prefer: ${DEMO_SITES.hosts.join(", ")}`) throw new Error(`The preview's sites read "${sites.trim()}".`);
  return { queries, sites: sites.trim() };
}

/** The preview of the demonstration's selection, as the host works it out now (no network): what Start is bound to. */
export const hostPreview = (page: Page) => call<ResearchPreview>(page, `window.nivra.prepareResearch(${arg(DEMO_SEED.ids.planId)}, ${arg(DEMO_SELECTION)})`);

/** Presses "Start research" once, and returns the research it started; a refusal is an error in the dialog's words. */
export async function startOnce(page: Page): Promise<ResearchView> {
  const before = new Set((await researchOf(page)).map((research) => research.id));
  await page.getByTestId("research-start").click();
  return waitFor(
    async () => {
      const refused = page.getByTestId("research-error");
      if (await refused.isVisible()) throw new Error(`Start research was refused: ${await refused.innerText()}`);
      return (await researchOf(page)).find((research) => !before.has(research.id)) ?? null;
    },
    30_000,
    "the research to be recorded",
  );
}

/** Every event of a run, page by page. */
export async function eventsOf(page: Page, runId: string): Promise<{ status: string; events: RunEvent[] }> {
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const next = await call<{ events: RunEvent[]; next: number; status: string }>(page, `window.nivra.runEvents(${arg(runId)}, ${after})`);
    events.push(...next.events);
    if (!next.events.length || next.next === after) return { status: next.status, events };
    after = next.next;
  }
}

/** Removes both keys from the profile, through the calls Settings' own buttons make, and checks they are gone. */
export async function removeKeys(page: Page): Promise<void> {
  await call(page, "window.nivra.setNebiusKey(null)");
  await call(page, "window.nivra.setTavilyKey(null)");
  const settings = await call<SettingsView>(page, "window.nivra.getSettings()");
  if (settings.nebiusKey !== "none" || settings.tavilyKey !== "none") throw new Error("A key is still saved in the profile: remove it in Settings.");
}

/** Follows research to its end, saying each status once. */
export async function followToEnd(page: Page, id: string, timeoutMs: number, log: (line: string) => void): Promise<ResearchView> {
  let last = "";
  return waitFor(
    async () => {
      const research = (await researchOf(page)).find((candidate) => candidate.id === id);
      if (!research) throw new Error("The research is no longer listed.");
      if (research.status !== last) log(`Research: ${(last = research.status)}.`);
      return research.status === "submitting" || research.status === "running" ? null : research;
    },
    timeoutMs,
    "the research to end",
  );
}

/** Waits for the version the person saves from the research: the plan's v2. */
export async function amendedVersion(page: Page, timeoutMs: number): Promise<PlanView[]> {
  return waitFor(async () => {
    const plans = await plansOf(page);
    return plans.some((plan) => plan.version === 2) ? plans : null;
  }, timeoutMs, "the amended version to be saved");
}

/**
 * After a relaunch: every plan version and the research exactly as they were, and the window showing v2, the original
 * beneath it, and the research that made it. Returns what it checked, for the evidence.
 */
export async function checkKept(page: Page, before: { plans: PlanView[]; research: ResearchView[] }): Promise<string[]> {
  const plans = await plansOf(page);
  const research = await researchOf(page);
  if (JSON.stringify(plans) !== JSON.stringify(before.plans)) throw new Error("The plan versions changed across the relaunch.");
  if (JSON.stringify(research) !== JSON.stringify(before.research)) throw new Error("The research changed across the relaunch.");
  await openDemo(page);
  const version = await page.getByTestId("plan-version").first().innerText();
  if (version.trim() !== "Plan · v2") throw new Error(`The plan shows "${version.trim()}" after the relaunch.`);
  await page.getByTestId("plan-earlier-toggle").first().click();
  const earlier = await page.getByTestId("plan-earlier").first().innerText();
  const original = before.plans.find((plan) => plan.version === 1)!.text;
  if (!earlier.includes(original.split("\n")[0]!)) throw new Error("The original version isn't shown beneath v2 after the relaunch.");
  const amended = await page.getByTestId("research-amended").first().innerText();
  if (amended.trim() !== "Saved as v2 from this research.") throw new Error(`The research card reads "${amended.trim()}" after the relaunch.`);
  return [
    `${plans.length} plan versions and ${research.length} research run(s), unchanged`,
    `the window shows ${version.trim()}, the original version beneath it, and "${amended.trim()}"`,
  ];
}

/** What `runApproved` needs from where it runs: the live script on Windows, or the offline e2e. */
export interface ApprovedRun {
  /** The window as it is now; a relaunch replaces it. */
  page(): Page;
  /** The evidence folder, where the person's files are looked for: go-close (close, relaunch, check) and stop (end). */
  evidence: string;
  log(line: string): void;
  save(name: string, value: unknown): void;
  shot(locator: Locator, name: string): Promise<void>;
  /** Closes the app, and waits until its engines have stopped. */
  close(): Promise<void>;
  /** Opens the app again on the same profile and engine home, and returns its window. */
  relaunch(): Promise<Page>;
  /** What is wrong with the route now (the native engine running, say), or null when it is as approved. */
  routeProblem(): Promise<string | null>;
  /** The approved packet's digest, which the research must be bound to. */
  packetDigest: string;
}

export interface ApprovedOutcome {
  research: ResearchView | null;
  amended: PlanView[] | null;
  kept: string[];
  keysRemoved: boolean;
  /** Each step that failed, in its own words; the run's evidence says what happened anyway. */
  failures: string[];
}

const open = (research: ResearchView) => research.status === "submitting" || research.status === "running";

/** Polls `check` until it gives a value, or `stopped()` says to stop (then null). */
async function until<T>(check: () => Promise<T | null>, stopped: () => boolean): Promise<T | null> {
  for (;;) {
    if (stopped()) return null;
    const value = await check().catch(() => null);
    if (value !== null) return value;
    await sleep(500);
  }
}

/**
 * Presses "Start research" once, and sees the run through, with nothing able to throw out of it: each step that fails
 * is recorded, and the rest still happen. It follows the research to its end; saves its report, events and
 * screenshots; hands the window to the person, who amends and saves v2, and only watches for it; waits for the go-ahead
 * to close, never closing on its own while the research is open; relaunches and checks what was kept; and removes the
 * keys.
 */
export async function runApproved(io: ApprovedRun): Promise<ApprovedOutcome> {
  const failures: string[] = [];
  const attempt = async <T>(what: string, step: () => Promise<T>): Promise<{ value: T } | null> => {
    try {
      return { value: await step() };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      failures.push(`${what}: ${why}`);
      io.log(`${what} failed: ${why}`);
      return null;
    }
  };
  const asked = (name: string) => existsSync(join(io.evidence, name));
  const stopAsked = () => asked("stop");

  const started = (await attempt("Pressing Start research", () => startOnce(io.page())))?.value ?? null;
  let research: ResearchView | null = null;
  if (!started) io.log(`Nothing more is pressed: the window is yours. Create the file go-close or stop in ${io.evidence} to end.`);
  else {
    if (started.packetDigest !== io.packetDigest) failures.push(`The research is bound to packet ${started.packetDigest}, not the approved ${io.packetDigest}.`);
    research = (await attempt("Following the research", () => followToEnd(io.page(), started.id, 15 * 60_000, io.log)))?.value ?? null;
  }
  if (research) {
    const report = research.report;
    io.save("research.json", research);
    io.save("report.json", report);
    io.log(
      `Research ended: ${research.status}, report ${report?.outcome ?? "none"}. Model ${report?.route?.model ?? "unknown"}; credits ${report?.usage.credits ?? "not reported"}; tokens ${report?.usage.model.inputTokens ?? "unreported"} in, ${report?.usage.model.outputTokens ?? "unreported"} out; ${report?.elapsedMs ?? "?"} ms.`,
    );
    const runId = research.runId;
    if (runId) await attempt("Saving the run's events", async () => io.save("events.json", await eventsOf(io.page(), runId)));
    await attempt("The card's screenshot", () => io.shot(io.page().locator(`[data-testid="research"][data-research-id="${research!.id}"]`), "card.png"));
    await attempt("Saving the plan versions", async () => io.save("plans-before.json", await plansOf(io.page())));
  }

  let amended: PlanView[] | null = null;
  if (research) {
    io.log(`Over to you: read the card, open an address to check its page, then press Amend, edit the amended version and save it. I only watch for v2. To end without saving, create the file stop in ${io.evidence}.`);
    amended = await until(async () => {
      const plans = await plansOf(io.page());
      return plans.some((plan) => plan.version === 2) ? plans : null;
    }, stopAsked);
    if (amended) {
      io.save("plans-after.json", amended);
      const original = amended.find((plan) => plan.version === 1)!;
      const unchanged = original.text === demoPacket().planText && original.latest === 2;
      if (!unchanged) failures.push("v1 isn't as it was seeded, or v2 isn't its latest version.");
      io.log(`v2 saved: ${amended.find((plan) => plan.version === 2)!.id}. v1 is ${unchanged ? "unchanged, with v2 the latest" : "not as it was seeded"}.`);
      const named = (await attempt("Reading the research again", () => researchOf(io.page())))?.value.find((candidate) => candidate.id === research!.id);
      if (named?.amended?.version !== 2) failures.push("v2 wasn't saved from this research: its card doesn't name it.");
      await attempt("The plan's screenshot", () => io.shot(io.page().getByTestId("plan").first(), "plan-v2.png"));
    } else io.log("Ended without an amended version.");
  }

  io.log(`Waiting for the go-ahead to close the app: create the file go-close in ${io.evidence}.`);
  await until(async () => (asked("go-close") || stopAsked() ? true : null), () => false);
  // Never closed while the research is open, unless the person said stop.
  await until(async () => ((await researchOf(io.page())).some(open) ? null : true), stopAsked);
  const before = (await attempt("Reading what must be kept", async () => ({ plans: await plansOf(io.page()), research: await researchOf(io.page()) })))?.value ?? null;
  let kept: string[] = [];
  if (await attempt("Closing the app", () => io.close())) {
    if (await attempt("Relaunching the app", () => io.relaunch())) {
      if (amended && before) kept = (await attempt("Checking what the relaunch kept", () => checkKept(io.page(), before)))?.value ?? [];
      for (const line of kept) io.log(`After the relaunch: ${line}.`);
      if (amended) await attempt("The relaunched plan's screenshot", () => io.shot(io.page().getByTestId("plan").first(), "relaunched.png"));
    }
  }
  const keysRemoved = (await attempt("Removing the keys", () => removeKeys(io.page()))) !== null;
  if (keysRemoved) io.log("Both keys are removed from the profile.");
  const route = (await attempt("Checking the route again", () => io.routeProblem()))?.value ?? null;
  if (route) failures.push(route);
  await attempt("Closing the app", () => io.close());
  return { research, amended, kept, keysRemoved, failures };
}
