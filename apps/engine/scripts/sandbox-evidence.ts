import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Proposal } from "../src/exec/proposal.ts";

/**
 * Saves a proposal's bound bytes as the live check's evidence (NIV-43, D35), exactly as they were bound: `change.patch`
 * and `report.json` hash to the binding's `patchSha256` and `reportSha256`, so the evidence checks out on its own. The
 * report's readable copy, `report.readable.json`, goes beside them, never in their place.
 *
 * A file whose bytes hold a credential isn't saved, and is named in `held`: masking it would change what was bound. The
 * scan before the upload, and the check of what came back, refuse such bytes first.
 */
export function saveBoundEvidence(folder: string, proposal: Pick<Proposal, "patch" | "report">, credentials: readonly string[]): { saved: string[]; held: string[] } {
  const secrets = credentials.filter((value) => value.length > 0).map((value) => Buffer.from(value, "utf8"));
  const holds = (bytes: Uint8Array) => secrets.some((secret) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(secret));
  const saved: string[] = [];
  const held: string[] = [];
  const save = (name: string, bytes: Uint8Array) => {
    if (holds(bytes)) {
      held.push(name);
      return;
    }
    writeFileSync(join(folder, name), bytes, { mode: 0o600 });
    saved.push(name);
  };
  save("change.patch", proposal.patch);
  save("report.json", proposal.report);
  if (!held.includes("report.json")) save("report.readable.json", new TextEncoder().encode(`${JSON.stringify(JSON.parse(new TextDecoder().decode(proposal.report)), null, 2)}\n`));
  return { saved, held };
}
