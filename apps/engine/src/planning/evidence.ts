import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Mask, PlanningEvidence } from "@nivra/domain";
import type { ExecutionBackend, ExecutionSession } from "../exec/backend.ts";
import { RepoReader } from "../repo/files.ts";
import { RepoError } from "../repo/paths.ts";

export const evidenceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Include the scoped inventory behind a truncated visible list, without reading any additional file content. */
export function planningInventoryDigest(reader: RepoReader, input: { glob?: string | undefined }): string {
  const match = (path: string) => !input.glob || posix.matchesGlob(path, input.glob);
  return evidenceDigest({ readable: [...reader.readable].filter(match).sort(), hidden: [...reader.hidden].filter(([path]) => match(path)).sort(([a], [b]) => a.localeCompare(b)), oversized: [...reader.oversized].filter(match).sort() });
}

export async function openPlanningReader(repoPath: string, backend: ExecutionBackend, findGit: () => string | null, mask: Mask, signal?: AbortSignal): Promise<{ reader: RepoReader; session: ExecutionSession }> {
  const git = findGit();
  if (!git) throw new RepoError("git-missing", "Git isn't installed on this target. Install Git there, then check the planning evidence again.");
  const session = await backend.open({ workspace: repoPath });
  try { return { reader: await RepoReader.open({ root: repoPath, session, git, mask, signal }), session }; }
  catch (error) { await session.close(); throw error; }
}

/** Repeat exactly the bounded observations, never treating a missing checkout as unchanged evidence. */
export async function validatePlanningEvidence(repoPath: string, evidence: PlanningEvidence, backend: ExecutionBackend, findGit: () => string | null, mask: Mask): Promise<{ current: boolean; reason: string | null }> {
  if (!evidence.files.length && !evidence.searches.length && !evidence.inventory.length) return { current: true, reason: null };
  let opened: Awaited<ReturnType<typeof openPlanningReader>> | null = null;
  try {
    opened = await openPlanningReader(repoPath, backend, findGit, mask, AbortSignal.timeout(60_000));
    const { reader } = opened;
    if (await reader.head() !== evidence.baseline) return { current: false, reason: "The repository's commit changed. Refresh its impact assessment before saving." };
    for (const file of evidence.files) {
      const read = await reader.read({ path: file.path, startLine: file.startLine, endLine: file.endLine });
      if (read.delivered.sha256 !== file.sha256) return { current: false, reason: "A file used by this plan changed. Refresh its impact assessment before saving." };
    }
    for (const search of evidence.searches) {
      const { digest: _digest, ...query } = search;
      const found = await reader.search(query);
      if (evidenceDigest(found) !== search.digest) return { current: false, reason: "A source search used by this plan changed. Refresh its impact assessment before saving." };
    }
    for (const inventory of evidence.inventory) {
      if (planningInventoryDigest(reader, inventory) !== inventory.digest) return { current: false, reason: "The inspected file list changed. Refresh the plan before saving." };
    }
    return { current: true, reason: null };
  } catch { return { current: false, reason: "Repository impact could not be checked. Reconnect its target and refresh the assessment, or explicitly save a new provisional manual plan." }; }
  finally { await opened?.session.close(); }
}
