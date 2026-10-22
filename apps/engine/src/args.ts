import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

/** How the engine was started. Everything arrives as arguments, never as environment variables (D3). */
export interface EngineArgs {
  home: string;
  instanceId: string;
  /** How long the host may stay silent before the engine stops; 0 turns the watchdog off (development). */
  heartbeatMs: number;
  /** Tests only: a stub of Token Factory on this machine, in place of the real one (D22). Null in normal use. */
  tokenFactoryUrl: string | null;
  /** Tests only: a stub of Nebius Sandboxes on this machine, in place of the real one (D36). Null in normal use. */
  sandboxesUrl: string | null;
  /** Tests only: a stub of Tavily on this machine, in place of the real one (D37). Null in normal use. */
  tavilyUrl: string | null;
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export const DEFAULT_HEARTBEAT_MS = 30_000;

export function readArgs(argv: readonly string[]): EngineArgs {
  let values: { stdio?: boolean; home?: string; instance?: string; "heartbeat-ms"?: string; "token-factory-url"?: string; "sandboxes-url"?: string; "tavily-url"?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        stdio: { type: "boolean" },
        home: { type: "string" },
        instance: { type: "string" },
        "heartbeat-ms": { type: "string" },
        "token-factory-url": { type: "string" },
        "sandboxes-url": { type: "string" },
        "tavily-url": { type: "string" },
        // A marker that lets an orphan check find engine processes by their command line; it means nothing else.
        "nivra-engine": { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw new ArgsError(error instanceof Error ? error.message : String(error));
  }
  if (!values.stdio) throw new ArgsError("Start the engine with --stdio: it speaks JSON-RPC over its standard streams only.");
  if (!values.home || !isAbsolute(values.home)) throw new ArgsError("--home must be an absolute path to the engine's data folder.");
  const instance = values.instance ?? randomUUID();
  if (!z.uuid().safeParse(instance).success) throw new ArgsError("--instance must be a UUID.");
  const heartbeat = values["heartbeat-ms"] === undefined ? DEFAULT_HEARTBEAT_MS : Number(values["heartbeat-ms"]);
  if (!Number.isInteger(heartbeat) || heartbeat < 0) throw new ArgsError("--heartbeat-ms must be a whole number of milliseconds, 0 or more.");
  return {
    home: values.home,
    instanceId: instance,
    heartbeatMs: heartbeat,
    tokenFactoryUrl: loopbackUrl("--token-factory-url", values["token-factory-url"]),
    sandboxesUrl: loopbackUrl("--sandboxes-url", values["sandboxes-url"]),
    tavilyUrl: loopbackUrl("--tavily-url", values["tavily-url"]),
  };
}

/** A test endpoint must be on this machine, so the key can never be sent anywhere else through it. */
function loopbackUrl(flag: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArgsError(`${flag} must be a URL.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname)) {
    throw new ArgsError(`${flag} is for tests and must point at this machine (127.0.0.1, [::1] or localhost).`);
  }
  return url.href.replace(/\/$/, "");
}
