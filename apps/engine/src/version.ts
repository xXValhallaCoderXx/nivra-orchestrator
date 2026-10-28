import { readFileSync } from "node:fs";

export const ENGINE_VERSION = "0.2.0";

/**
 * The staged runtime's content hash, read from the `manifest.json` that staging writes beside the bundle (D5). Null
 * when the engine runs from source.
 */
export function readRuntimeHash(moduleUrl: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("./manifest.json", moduleUrl), "utf8"));
    const hash = (manifest as { contentHash?: unknown } | null)?.contentHash;
    return typeof hash === "string" && hash.length > 0 ? hash : null;
  } catch {
    return null;
  }
}
