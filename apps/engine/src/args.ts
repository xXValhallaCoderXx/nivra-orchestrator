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
}

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export const DEFAULT_HEARTBEAT_MS = 30_000;

export function readArgs(argv: readonly string[]): EngineArgs {
  let values: { stdio?: boolean; home?: string; instance?: string; "heartbeat-ms"?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        stdio: { type: "boolean" },
        home: { type: "string" },
        instance: { type: "string" },
        "heartbeat-ms": { type: "string" },
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
  return { home: values.home, instanceId: instance, heartbeatMs: heartbeat };
}
