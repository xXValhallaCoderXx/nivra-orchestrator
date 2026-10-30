import { inflateSync } from "node:zlib";
import { REFERENCE_LIMITS } from "@nivra/domain";

const refused = () => new Error("This isn't a supported static PNG, JPEG or WebP image. Export a static PNG or JPEG and attach it again.");
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function imageInfo(bytes: Buffer): { mediaType: string; width: number; height: number } {
  let width = 0, height = 0, mediaType = "";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mediaType = "image/png";
    let ended = false;
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(at), kind = bytes.toString("ascii", at + 4, at + 8);
      if (at + length + 12 > bytes.length || kind === "acTL") throw refused();
      if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) throw refused();
      if (at === 8 && (kind !== "IHDR" || length !== 13)) throw refused();
      if (kind === "IHDR") { if (at !== 8 || length !== 13) throw refused(); width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12); }
      if (kind === "IEND") ended = length === 0 && at + 12 === bytes.length;
      at += length + 12;
    }
    if (!ended) throw refused();
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mediaType = "image/jpeg";
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 0xff) throw refused();
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) throw refused();
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) { height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); }
      at += length;
    }
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    mediaType = "image/webp";
    for (let at = 12; at + 8 <= bytes.length;) {
      const kind = bytes.toString("ascii", at, at + 4), length = bytes.readUInt32LE(at + 4), data = at + 8;
      if (data + length > bytes.length || kind === "ANIM" || kind === "ANMF") throw refused();
      if (kind === "VP8X" && length >= 10) { if (bytes[data]! & 2) throw refused(); width = 1 + bytes.readUIntLE(data + 4, 3); height = 1 + bytes.readUIntLE(data + 7, 3); }
      else if (!width && kind === "VP8 " && length >= 10) { width = bytes.readUInt16LE(data + 6) & 0x3fff; height = bytes.readUInt16LE(data + 8) & 0x3fff; }
      else if (!width && kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) { const size = bytes.readUInt32LE(data + 1); width = 1 + (size & 0x3fff); height = 1 + ((size >>> 14) & 0x3fff); }
      at = data + length + (length % 2);
    }
  }
  if (!width || !height || width * height > REFERENCE_LIMITS.pixels) throw new Error("This image is unreadable or exceeds 16 megapixels. Export a smaller static PNG or JPEG and attach it again.");
  return { mediaType, width, height };
}

/** The renderer is untrusted: validate its PNG dimensions and bounded decoded bytes before retaining it. */
export function validatePreparedImage(bytes: Buffer): { width: number; height: number } {
  const info = imageInfo(bytes);
  if (info.mediaType !== "image/png" || bytes.length > REFERENCE_LIMITS.imageBytes || Math.max(info.width, info.height) > REFERENCE_LIMITS.edge || bytes[24] !== 8 || ![2, 6].includes(bytes[25]!) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw new Error("The prepared image exceeds its PNG limits. Prepare a smaller image, then try again.");
  const chunks: Buffer[] = [];
  let ended = false;
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), kind = bytes.toString("ascii", at + 4, at + 8);
    if (kind === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    if (kind === "IEND") ended = at + 12 === bytes.length;
    at += length + 12;
  }
  const rowBytes = info.width * (bytes[25] === 6 ? 4 : 3) + 1;
  const size = rowBytes * info.height;
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: size }); }
  catch { throw new Error("The prepared PNG has invalid or oversized decoded content. Prepare a smaller image again."); }
  if (!ended || decoded.length !== size) throw new Error("The prepared PNG is incomplete. Prepare the image again.");
  for (let row = 0; row < info.height; row++) if (decoded[row * rowBytes]! > 4) throw new Error("The prepared PNG is unreadable. Prepare the image again.");
  return { width: info.width, height: info.height };
}
