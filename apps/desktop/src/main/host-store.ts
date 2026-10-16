import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { driveFromMount, folderLabel, sameFolder } from "./paths.ts";

/**
 * The host's own records (D7): the project registry and window placement, as one JSON file in Electron's user-data
 * folder. The host is their only owner; engines get what they need with each request. Writes are atomic (temp file,
 * then rename, retried on Windows sharing errors), as in Hird's preferences.ts. There is no chosen target any more:
 * each project's folder decides where it runs (D17).
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

// Not strict: a key an older version wrote (`selectedTargetId`) is dropped on the next write, not a reason to set the
// whole file aside.
const HostData = z.object({
  version: z.literal(1).default(1),
  projects: z.array(ProjectRecord).default([]),
  zoom: z.number().min(0.5).max(3).optional(),
  window: z.object({ bounds: Rect, maximized: z.boolean() }).optional(),
});
export type HostData = z.infer<typeof HostData>;

/**
 * Brings records an older version wrote in line with D17. On Windows, a folder on a drive that was added for a WSL
 * target (stored as `/mnt/<drive>/…`) belongs to Windows, so it moves to the Windows engine, keeping its id, label and
 * date; when that folder is also listed for Windows already, the two become one. Nothing is dropped silently: each
 * record that changed gets a notice for this session.
 */
export function migrateHostData(data: HostData, platform: NodeJS.Platform): { data: HostData; changed: boolean; notices: Map<string, string> } {
  const notices = new Map<string, string>();
  if (platform !== "win32") return { data, changed: false, notices };
  const projects: ProjectRecord[] = [];
  let changed = false;
  for (const record of data.projects) {
    const drive = record.targetId.startsWith("wsl:") ? driveFromMount(record.nativePath) : null;
    if (!drive) {
      projects.push(record);
      continue;
    }
    changed = true;
    const notice = `This folder is on drive ${drive[0]}:, so it now runs on Windows, which owns that drive.`;
    const twin = data.projects.find((p) => p.targetId === "local" && sameFolder(p.nativePath, drive, true));
    if (twin) {
      notices.set(twin.id, notice);
      continue;
    }
    projects.push({ ...record, targetId: "local", nativePath: drive, label: record.label || folderLabel(drive) });
    notices.set(record.id, notice);
  }
  return { data: changed ? { ...data, projects } : data, changed, notices };
}

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
