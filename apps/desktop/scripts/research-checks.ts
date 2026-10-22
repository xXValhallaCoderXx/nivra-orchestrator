// Research through a WSL distribution's engine, as the window drives it (D37): the host's own path, from a Windows
// host, for a plan from a conversation about a project inside the distribution. The permission refusing before anything
// is sent, a whole run, and what reached Tavily and Token Factory: stand-ins on loopback in the distribution
// (research-stand-ins.ts), asked through the stand-in channel (stand-in.ts). Nothing reaches the network, and no real
// model is called. verify:windows runs these on Windows against a real distribution, and a test runs them here against
// an engine standing in for one's.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SecretName } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import type { RunResult } from "../src/main/targets/process.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import type { WslDiscovery } from "../src/main/targets/wsl-discovery.ts";
import type { ResearchSelection } from "../src/shared/research.ts";
import { RESEARCH_QUERY, type ResearchSeen, type StandIn } from "./stand-in.ts";

export interface ResearchSetup {
  /** The distribution's engine target, which reaches the stand-ins. The host is given no other. */
  target: ExecutionTarget;
  discovery: WslDiscovery;
  /** The host's own engine target, never started here. */
  local: ExecutionTarget;
  /** Runs a program in the distribution, from `/`. */
  inDistro: (args: string[], timeoutMs?: number) => Promise<RunResult>;
  /** A folder of this run's own for the host's records, emptied first. */
  root: string;
  logsDir: string;
  stub: StandIn;
  /** Runs one named check, records it, and says whether it passed. */
  check: (name: string, body: () => Promise<string>) => Promise<boolean>;
  log: (line: string) => void;
}

/** Test keys: what the host hands the engine, and what the stand-ins are checked for. */
const KEYS = { NEBIUS_API_KEY: "verify-windows-research-model-key-0123", TAVILY_API_KEY: `tvly-dev-verify-windows-${"r".repeat(16)}` };
const AWKWARD = "ü%#";
const SELECTION: ResearchSelection = { assumptions: [{ from: { kind: "typed", text: "distutils is still in Python 3.12's standard library." }, query: RESEARCH_QUERY }], sites: null };
const OFF = "Research queries to Tavily are turned off. Turn them on, then start again.";
const OPEN = ["submitting", "running"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => T | Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export async function researchChecks(setup: ResearchSetup): Promise<void> {
  const { target, check, stub, inDistro } = setup;
  const distro = target.descriptor.distro ?? "";
  rmSync(setup.root, { recursive: true, force: true });
  mkdirSync(setup.root, { recursive: true });
  const keys: { current: Partial<Record<SecretName, string>> } = { current: KEYS };
  // The host as Electron's main process makes it, with this run's targets.
  const host = new Host({
    targets: { local: setup.local, discoverWsl: async () => ({ discovery: setup.discovery, targets: [target] }) },
    store: new HostStore(join(setup.root, "nivra.json")),
    workspacePath: join(setup.root, "workspace.db"),
    logsDir: setup.logsDir,
    client: { name: "windows-harness", version: "0" },
    credentials: async () => keys.current,
    platform: "win32",
    log: setup.log,
  });
  host.init();
  const seen = () => stub<ResearchSeen>("research-requests", { tavilyKey: KEYS.TAVILY_API_KEY, modelKey: KEYS.NEBIUS_API_KEY });
  let conversationId = "";
  let planId = "";
  const planned = () => {
    if (!planId) throw new Error("no plan was saved");
    return planId;
  };

  try {
    await check("wsl research: a project inside the distribution, picked as Windows names it, is added for its engine, with sharing on", async () => {
      const made = await inDistro([
        "/bin/sh",
        "-c",
        'set -e; d="$HOME/.nivra-verify/research $1"; rm -rf "$d"; mkdir -p "$d"; cd "$d"; printf "# Build image\\nPython 3.11\\n" > README.md; git init -q -b main; git add -A; git -c user.name=t -c user.email=t@nivra.invalid commit -q -m init; pwd',
        "sh",
        AWKWARD,
      ]);
      const repo = made.stdout.trim().split("\n").at(-1) ?? "";
      if (made.code !== 0 || !repo.startsWith("/")) throw new Error(`could not make the repository: ${made.stderr.trim()}`);
      const picked = `\\\\wsl.localhost\\${distro}${repo.replace(/\//g, "\\")}`;
      const result = await host.addPicked(picked);
      if (result.status !== "added") throw new Error(result.status === "refused" ? result.reason : `the folder wasn't added (${result.status})`);
      if (result.project.targetId !== target.descriptor.id) throw new Error(`added for ${result.project.targetId}, not ${target.descriptor.id}`);
      await host.setSharing(result.project.id, true);
      const conversation = host.createConversation({ kind: "project", projectId: result.project.id });
      conversationId = conversation.id;
      return `${picked} on ${result.project.targetLabel}`;
    });
    await check("wsl research: a plan saved from the project's conversation, answered through the distribution's engine", async () => {
      if (!conversationId) throw new Error("no conversation was started");
      await host.sendMessage(conversationId, "Plan the move to Python 3.12");
      const answer = await waitFor(
        () => {
          const view = host.conversation(conversationId);
          const turn = view.turns.at(-1);
          if (turn && !OPEN.includes(turn.status) && turn.status !== "answered") throw new Error(`the turn ended ${turn.status}: ${turn.note ?? "no note"}`);
          return turn?.status === "answered" ? (view.messages.filter((message) => message.role === "assistant").at(-1) ?? null) : null;
        },
        180_000,
        "the turn's answer",
      );
      const plan = await host.savePlan(conversationId, answer.id);
      planId = plan.id;
      return `plan v${plan.version}`;
    });
    await check("wsl research: with research off, the preview says so, starting is refused, and nothing reaches Tavily", async () => {
      const before = await seen();
      const preview = await host.prepareResearch(planned(), SELECTION);
      if (preview.blocked !== OFF) throw new Error(`blocked: ${preview.blocked ?? "nothing"}`);
      const refused = await host.startResearch(planned(), SELECTION, preview.expected).then(
        () => null,
        (error: Error) => error.message,
      );
      if (refused !== OFF) throw new Error(`started, or refused otherwise: ${refused ?? "it started"}`);
      const after = await seen();
      if (after.searches !== before.searches || after.research !== before.research) throw new Error("a request was sent");
      return refused;
    });
    await check("wsl research: a run through the distribution's engine sends the approved query to Tavily with its key, the plan to the model, and keeps a complete report", async () => {
      await host.setWebResearch(true);
      const before = await seen();
      const preview = await host.prepareResearch(planned(), SELECTION);
      if (preview.blocked) throw new Error(preview.blocked);
      const started = await host.startResearch(planned(), SELECTION, preview.expected);
      const research = await waitFor(
        () => {
          const view = host.research(conversationId).find((item) => item.id === started.id);
          return view && !OPEN.includes(view.status) ? view : null;
        },
        180_000,
        "the research to end",
      );
      const report = research.report;
      if (research.status !== "answered" || report?.outcome !== "complete") throw new Error(`it ended ${research.status}: ${research.note ?? "no note"}`);
      const a1 = report.assessments.find((assessment) => assessment.assumption === "A1");
      const found = a1?.citations.filter((citation) => citation.valid).length ?? 0;
      if (a1?.model !== "contradicted" || found !== 1) throw new Error(`A1 was ${a1?.model ?? "missing"} with ${found} quotations found`);
      const after = await seen();
      const searches = after.searches - before.searches;
      if (searches !== 1 || after.queries.at(-1) !== RESEARCH_QUERY) throw new Error(`Tavily got ${searches} searches, the last for "${after.queries.at(-1) ?? ""}"`);
      if (!after.tavilyKeyed) throw new Error("a Tavily request didn't carry exactly the Tavily key");
      if (after.tavilyLeaking || after.modelLeaking) throw new Error(`${after.tavilyLeaking} Tavily requests held the plan or the model's key, and ${after.modelLeaking} model requests held the Tavily key`);
      if (after.research - before.research !== 1) throw new Error(`the model got ${after.research - before.research} research requests`);
      return `complete: A1 contradicted with ${found} quotation found; ${searches} search and ${after.extracts - before.extracts} extract to Tavily, 1 request to the model; ${report.usage.credits ?? "unreported"} credits as reported`;
    });
  } finally {
    await host.shutdown();
  }
}
