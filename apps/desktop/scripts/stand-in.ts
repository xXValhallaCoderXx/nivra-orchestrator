// The stand-in for Nebius Sandboxes in verify:windows (D36). verify-windows.ts runs it on loopback in the distribution,
// and the harness on Windows asks it one thing at a time over the harness's own stdio: a command goes out on stdout
// (`@stub <command> <json>`), and its answer comes back on stdin (`@stub ok <json>`, or `@stub error <why>`).
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import type { TavilyStub } from "../../engine/test/stub-tavily.ts";
import type { Stub, StubRequest } from "../../engine/test/stub-token-factory.ts";

/** What reached the stand-in so far, as `requests` answers. */
export interface Seen {
  total: number;
  uploads: number;
  spawns: number;
  /** Spawns of a check's probe. */
  probes: number;
  /** Spawns that didn't ask for networking off. */
  networkingOn: number;
  deletes: number;
  /** Whether every request carried exactly the key and project id asked about, in its headers. */
  credentialed: boolean;
  /** Requests whose body holds the key, the project id or the engine's home. */
  leaking: number;
  /** Whether each probe's operation, oldest first, was cancelled. */
  probesCancelled: boolean[];
}

export type StandIn = <T = null>(command: string, arg?: unknown) => Promise<T>;

/** The harness's side: asks through `output`, and reads each answer from `input`. */
export function standInClient(input: Readable, output: Writable, timeoutMs = 15_000): StandIn {
  let waiting: ((answer: string) => void) | null = null;
  createInterface({ input }).on("line", (line) => {
    const answered = waiting;
    if (!line.startsWith("@stub ") || !answered) return;
    waiting = null;
    answered(line.slice("@stub ".length));
  });
  return async <T = null>(command: string, arg: unknown = null): Promise<T> => {
    if (waiting) throw new Error(`the stand-in was asked "${command}" while it was still answering`);
    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = null;
        reject(new Error(`the stand-in for Nebius Sandboxes didn't answer "${command}" within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      waiting = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      output.write(`@stub ${command} ${JSON.stringify(arg)}\n`);
    });
    if (!answer.startsWith("ok ")) throw new Error(`the stand-in couldn't do "${command}": ${answer}`);
    return JSON.parse(answer.slice("ok ".length)) as T;
  };
}

/** verify-windows.ts's side: does what one command (a `@stub` line, without it) asks of `stub`, and returns the answer line. */
export function answerStandIn(stub: SandboxStub, text: string): string {
  const [command = "", ...rest] = text.split(" ");
  try {
    return `@stub ok ${JSON.stringify(control(stub, command, JSON.parse(rest.join(" ") || "null")) ?? null)}`;
  } catch (error) {
    return `@stub error ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A check's probe: its argv names it (`/bin/sh -c <probe> nivra-probe …`). */
const isProbe = (args: readonly string[]) => args.includes("nivra-probe");

function control(stub: SandboxStub, command: string, arg: unknown): unknown {
  const { guest } = stub;
  const { service } = guest;
  if (command === "normal") {
    guest.override = () => undefined;
    return null;
  }
  if (command === "probe-waits") {
    guest.override = ({ args }) => (isProbe(args) ? { waits: true } : undefined);
    return null;
  }
  if (command === "probe-uncertain") {
    // The next probe's operation is made, its answer is lost, and it is beyond the search window for now.
    let armed = false;
    guest.override = ({ args }) => {
      if (!isProbe(args) || armed) return undefined;
      armed = true;
      service.dropNextSpawnAnswer = true;
      service.hideNextSpawn = true;
      return { waits: true };
    };
    return null;
  }
  if (command === "list-all") {
    service.hidden.clear();
    return null;
  }
  if (command === "requests") {
    const { key, project, home } = arg as { key: string; project: string; home: string };
    const spawns = stub.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances");
    const networking = (body: string) => (JSON.parse(body) as { networking?: { enabled?: boolean } }).networking?.enabled;
    const seen: Seen = {
      total: stub.requests.length,
      uploads: stub.requests.filter((request) => request.path === "/v1/files").length,
      spawns: spawns.length,
      probes: spawns.filter((request) => request.body.includes("nivra-probe")).length,
      networkingOn: spawns.filter((request) => networking(request.body) !== false).length,
      deletes: stub.requests.filter((request) => request.method === "DELETE").length,
      credentialed: stub.requests.every((request) => request.authorization === `Bearer ${key}` && request.project === project),
      leaking: stub.requests.filter((request) => [key, project, home].some((value) => request.body.includes(value))).length,
      probesCancelled: service.operations.filter((operation) => isProbe((operation.body["args"] as string[] | undefined) ?? [])).map((operation) => operation.cancelled),
    };
    return seen;
  }
  throw new Error(`the stand-in has no command "${command}"`);
}

// ---- research (D37) ----
// verify-windows.ts runs stand-ins for Tavily and Token Factory beside the one for Nebius Sandboxes
// (research-stand-ins.ts), and the harness asks what reached them over this same channel: `@stub research-requests`.

/** What the research checks' plan says, and the query they approve for its assumption. */
export const RESEARCH_PLAN = "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils.";
export const RESEARCH_QUERY = "Python 3.12 distutils standard library";

/** What reached the research stand-ins so far, as `research-requests` answers. */
export interface ResearchSeen {
  searches: number;
  extracts: number;
  /** The queries Tavily searched for, oldest first. */
  queries: string[];
  /** Whether every Tavily request carried exactly the Tavily key asked about. */
  tavilyKeyed: boolean;
  /** Tavily requests holding the plan's text or the model's key. */
  tavilyLeaking: number;
  /** The model's research requests, and the conversation's turns. */
  research: number;
  turns: number;
  /** Model requests holding the Tavily key. */
  modelLeaking: number;
}

/** A request to the model for research: the assessment's tool is offered. */
export const isResearchRequest = (request: StubRequest) => JSON.stringify(request.body?.tools ?? []).includes("submit_research");

/** verify-windows.ts's side for research: answers one `research-…` command (a `@stub` line, without it). */
export function answerResearch(stands: { tavily: TavilyStub; model: Stub }, text: string): string {
  const [command = "", ...rest] = text.split(" ");
  try {
    if (command !== "research-requests") throw new Error(`the research stand-ins have no command "${command}"`);
    const { tavilyKey, modelKey } = JSON.parse(rest.join(" ") || "null") as { tavilyKey: string; modelKey: string };
    const calls = stands.tavily.calls;
    const searches = calls.filter((call) => call.path === "/search");
    const seen: ResearchSeen = {
      searches: searches.length,
      extracts: calls.filter((call) => call.path === "/extract").length,
      queries: searches.map((call) => String(call.body?.["query"] ?? "")),
      tavilyKeyed: calls.every((call) => call.authorization === `Bearer ${tavilyKey}`),
      tavilyLeaking: calls.filter((call) => call.raw.includes(RESEARCH_PLAN) || (modelKey !== "" && call.raw.includes(modelKey))).length,
      research: stands.model.chats().filter(isResearchRequest).length,
      turns: stands.model.chats().filter((request) => !isResearchRequest(request)).length,
      modelLeaking: tavilyKey === "" ? 0 : stands.model.requests.filter((request) => request.raw.includes(tavilyKey)).length,
    };
    return `@stub ok ${JSON.stringify(seen)}`;
  } catch (error) {
    return `@stub error ${error instanceof Error ? error.message : String(error)}`;
  }
}
