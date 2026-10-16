import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * The host's own records (D7): the chosen target, the project registry and window placement, as one JSON file in
 * Electron's user-data folder. The host is their only owner; engines get what they need with each request. Writes
 * are atomic (temp file, then rename, retried on Windows sharing errors), as in Hird's preferences.ts.
 */

const Rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

export const ProjectRecord = z.strictObject({
  id: z.uuid(),
  /** "local" or "wsl:<distro>". */
  targetId: z.string().min(1).max(80),
  /** In the target's own form: POSIX inside WSL, a Windows path for the native target. */
  nativePath: z.string().min(1).max(4096),
  label: z.string().min(1).max(200),
  addedAt: z.iso.datetime(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

const HostData = z.object({
  version: z.literal(1).default(1),
  selectedTargetId: z.string().min(1).max(80).optional(),
  projects: z.array(ProjectRecord).default([]),
  zoom: z.number().min(0.5).max(3).optional(),
  window: z.object({ bounds: Rect, maximized: z.boolean() }).optional(),
});
export type HostData = z.infer<typeof HostData>;

export class HostStore {
  readonly path: string;
  #data: HostData;

  constructor(path: string) {
    this.path = path;
    this.#data = HostStore.#read(path);
  }

  static #read(path: string): HostData {
    try {
      const parsed = HostData.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) return parsed.data;
      // A file this version cannot read is kept aside rather than overwritten.
      renameSync(path, `${path}.unreadable-${Date.now()}`);
    } catch {
      // Missing or not JSON: start empty.
    }
    return HostData.parse({});
  }

  get data(): Readonly<HostData> {
    return this.#data;
  }

  update(change: (data: HostData) => HostData): void {
    const next = HostData.parse(change(structuredClone(this.#data)));
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameRetrying(temp, this.path);
    this.#data = next;
  }
}

/**
 * Renames a just-written temp file over the real one. On Windows a rename fails while another process (an antivirus,
 * the indexer, a reader) has the target open, so it is retried a few times (from Hird).
 */
export function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}
