// R3's journey through the window (D37, NIV-45), shared by its offline e2e and research-live.ts, so the live run takes
// no step for the first time. It drives the window as a person would and reads it through the bridge, with string
// expressions, since scripts are compiled without the DOM's types (as in live-ui.ts).
import type { Page } from "@playwright/test";
import type { PlanView } from "../src/shared/ipc.ts";
import type { ResearchPreview, ResearchView } from "../src/shared/research.ts";
import { waitFor } from "./live-ui.ts";
import { DEMO_SEED, DEMO_SITES } from "./research-demo.ts";

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

/** Presses "Start research" once, and returns the research it started. */
export async function startOnce(page: Page): Promise<ResearchView> {
  const before = new Set((await researchOf(page)).map((research) => research.id));
  await page.getByTestId("research-start").click();
  return waitFor(async () => (await researchOf(page)).find((research) => !before.has(research.id)) ?? null, 30_000, "the research to be recorded");
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
