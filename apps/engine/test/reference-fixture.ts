import { createHash, randomUUID } from "node:crypto";
import { commentPayload, manifestPayload, type FrozenReferenceContext, type ReferenceManifest } from "@nivra/domain";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function referenceFixture(marker = "task reference canary"): Promise<FrozenReferenceContext> {
  const taskId = randomUUID(), id = randomUUID();
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const comment = { id: randomUUID(), taskId, order: 1, author: "You" as const, createdAt: "2026-10-30T00:00:00.000Z", text: marker, sha256: "" };
  comment.sha256 = hash(commentPayload(comment));
  const manifest: ReferenceManifest = { version: 1, taskId, comments: [{ id: comment.id, sha256: comment.sha256 }], attachments: [{ id, sha256: hash(Buffer.from(base64, "base64")), preparedSha256: hash(Buffer.from(base64, "base64")) }], summaries: [] };
  return { manifest, digest: hash(manifestPayload(manifest)), comments: [comment], attachments: [{ id, name: "reference.png", kind: "image", text: null, image: { mediaType: "image/png", base64, width: 1, height: 1 } }], summaries: [] };
}
