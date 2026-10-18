import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PreferenceIntent, PreferenceScope } from "@nivra/domain";
import { z } from "zod";
import { driveFromMount, folderLabel, sameFolder } from "./paths.ts";

/**
 * The host's own records (D7): the project registry, the engineer's preferences and window placement, as one JSON file
 * in Electron's user-data folder. The host is their only owner; engines get what they need with each request (D21).
 * Writes are atomic (temp file, then rename, retried on Windows sharing errors), as in Hird's preferences.ts. There is
 * no chosen target any more: each project's folder decides where it runs (D17).
 */

const Rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

/**
 * What a project allows to leave the machine (D20), both off until the person agrees. `modelContext` lets repository
 * excerpts go to Token Factory; `cloudExecution` is kept but unused until cloud execution exists.
 */
export const ProjectSharing = z.strictObject({ modelContext: z.boolean(), cloudExecution: z.boolean() });
export type ProjectSharing = z.infer<typeof ProjectSharing>;
export const NO_SHARING: ProjectSharing = { modelContext: false, cloudExecution: false };

export const ProjectRecord = z.strictObject({
  id: z.uuid(),
  /** "local" or "wsl:<distro>". */
  targetId: z.string().min(1).max(80),
  /** In the target's own form: POSIX inside WSL, a Windows path for the native target. */
  nativePath: z.string().min(1).max(4096),
  label: z.string().min(1).max(200),
  addedAt: z.iso.datetime(),
  sharing: ProjectSharing.default({ modelContext: false, cloudExecution: false }),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

/**
 * Where a kept suggestion came from (D23): the run and the suggestion's place in its result, the HEAD that run started
 * at, when it finished, and only the lines the model was shown. It stays in the host and never reaches a run.
 */
export const PreferenceEvidence = z.strictObject({
  runId: z.uuid(),
  suggestion: z.number().int().nonnegative(),
  headAtStart: z.string().nullable(),
  ranAt: z.iso.datetime(),
  citations: z.array(z.strictObject({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() })).max(8),
});
export type PreferenceEvidence = z.infer<typeof PreferenceEvidence>;

/**
 * One preference, in the only canonical copy (D21). Only confirmed ones reach a run. One the person replaced stays as
 * history, `superseded`, and never reaches a run again (D23). Every field added since the first version has a default,
 * so a file an older version wrote still reads.
 */
export const PreferenceRecord = z
  .strictObject({
    id: z.uuid(),
    statement: z.string().min(1).max(500),
    scope: PreferenceScope,
    /** The project a project preference belongs to; null for a personal one, which applies to every project. */
    projectId: z.uuid().nullable(),
    /** A default, or a project's decision to change its existing conventions (D23). */
    intent: PreferenceIntent.default("default"),
    status: z.enum(["suggested", "confirmed", "superseded"]),
    /** Where it came from: typed in by the person, kept from a run's suggestion, or imported (D23). */
    origin: z.enum(["entered", "suggested", "imported"]),
    /** 1 when created, raised by every edit. */
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** When the person confirmed this wording; null while it is a suggestion. */
    confirmedAt: z.iso.datetime().nullable(),
    /** The preference this one replaced, and for a replaced one, what replaced it and when (D23). */
    supersedes: z.uuid().nullable().default(null),
    supersededBy: z.uuid().nullable().default(null),
    supersededAt: z.iso.datetime().nullable().default(null),
    /** For one kept from a suggestion, where it came from. */
    evidence: PreferenceEvidence.nullable().default(null),
  })
  .refine((record) => (record.scope === "project") === (record.projectId !== null), "A project preference names its project, and a personal one names none.")
  .refine((record) => record.intent === "default" || record.scope === "project", "Only a project's own preference can override its conventions.");
export type PreferenceRecord = z.infer<typeof PreferenceRecord>;

// Not strict: a key an older version wrote (`selectedTargetId`) is dropped on the next write, not a reason to set the
// whole file aside.
const HostData = z.object({
  version: z.literal(1).default(1),
  projects: z.array(ProjectRecord).default([]),
  preferences: z.array(PreferenceRecord).default([]),
  /** Raised by every change to any preference, so a run can say which version of them it was given. */
  preferencesRevision: z.number().int().nonnegative().default(0),
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
 * Writes a file only its owner can read (0600), atomically: a new temp file, then a rename, so a file that already
 * exists ends up 0600 too. `writeFileSync`'s mode applies only when it creates the file (D23: preference exports).
 */
export function writePrivateFile(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  try {
    renameRetrying(temp, path);
  } catch (error) {
    // The temp file holds the same text: it never stays behind.
    rmSync(temp, { force: true });
    throw error;
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
