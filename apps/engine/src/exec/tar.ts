/**
 * The workspace's tar archives (NIV-42, D34). One format, both ways: GNU tar, as busybox writes and reads it.
 * - **What the engine writes:** exact bytes, a fixed owner and time, links kept as links, and `L`/`K` records for a
 *   name or a link target past 100 bytes. It also writes a folder entry for every parent, so nothing depends on the
 *   extractor making them.
 * - **What comes back from the sandbox is untrusted.** It is bounded before anything is allocated, and every header is
 *   checked: its checksum, its magic, octal numbers only, and the two end blocks followed by zeros only. Only regular
 *   files, folders and symbolic links are taken; anything else is refused by name.
 * - **Paths are checked as they are read:** strict UTF-8 with one leading `./`, and no absolute path, `..` or empty
 *   component. Duplicates, a file where a folder is needed, and anything under a link are refused. Nothing is ever
 *   extracted onto disk by following an archive's paths.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
// A leading byte-order mark is part of a name, so it is kept.
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type TarEntry =
  | { path: string; kind: "file"; executable: boolean; bytes: Uint8Array }
  | { path: string; kind: "dir" }
  | { path: string; kind: "link"; target: string };

export interface TarLimits {
  maxEntries: number;
  /** The whole archive. */
  maxBytes: number;
  /** One file's content. */
  maxEntryBytes: number;
  /** One path, or one link target, in UTF-8 bytes. */
  maxPathBytes: number;
}

/** An archive Nivra won't take, and why, in words a person can act on. */
export class TarRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarRefusal";
  }
}

/** A name a header field can hold: at most `size` bytes, NUL-padded. */
function field(bytes: Uint8Array, at: number, size: number, value: Uint8Array): void {
  bytes.set(value.subarray(0, size), at);
}

function octalField(bytes: Uint8Array, at: number, digits: number, value: number): void {
  field(bytes, at, digits + 1, encoder.encode(`${value.toString(8).padStart(digits, "0")}\0`));
}

/** One GNU header block: `ustar ` and ` \0`, owner 0, time 0, and the checksum over the block. */
function header(name: Uint8Array, type: string, mode: number, size: number, link: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (size > 0o77777777777) throw new TarRefusal("A file is too large for a tar header.");
  const block = new Uint8Array(BLOCK);
  field(block, 0, 100, name);
  octalField(block, 100, 7, mode);
  octalField(block, 108, 7, 0);
  octalField(block, 116, 7, 0);
  octalField(block, 124, 11, size);
  octalField(block, 136, 11, 0);
  block.set(encoder.encode(type), 156);
  field(block, 157, 100, link);
  block.set(encoder.encode("ustar  \0"), 257);
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

/** Content padded to whole blocks. */
function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.byteLength / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
}

/** A `././@LongLink` record for a name (`L`) or a link target (`K`) past 100 bytes. */
function longRecord(type: "L" | "K", value: Uint8Array): Uint8Array[] {
  const data = new Uint8Array(value.byteLength + 1);
  data.set(value);
  return [header(encoder.encode("././@LongLink"), type, 0, data.byteLength), padded(data)];
}

/** The archive for `entries`, in their order. Parents' folder entries come first, made once each. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const folders = new Set<string>();
  const folder = (path: string) => {
    if (folders.has(path)) return;
    folders.add(path);
    const name = encoder.encode(`${path}/`);
    if (name.byteLength > 100) blocks.push(...longRecord("L", name));
    blocks.push(header(name, "5", 0o755, 0));
  };
  for (const entry of entries) {
    // The parents not made yet, found from the deepest up to one that was: a folder's parents are always made first.
    const missing: string[] = [];
    for (let slash = entry.path.lastIndexOf("/"); slash > 0; slash = entry.path.lastIndexOf("/", slash - 1)) {
      const parent = entry.path.slice(0, slash);
      if (folders.has(parent)) break;
      missing.push(parent);
    }
    for (let index = missing.length - 1; index >= 0; index--) folder(missing[index]!);
    if (entry.kind === "dir") {
      folder(entry.path);
      continue;
    }
    const name = encoder.encode(entry.path);
    if (name.byteLength > 100) blocks.push(...longRecord("L", name));
    if (entry.kind === "link") {
      const target = encoder.encode(entry.target);
      if (target.byteLength > 100) blocks.push(...longRecord("K", target));
      blocks.push(header(name, "2", 0o777, 0, target));
    } else {
      blocks.push(header(name, "0", entry.executable ? 0o755 : 0o644, entry.bytes.byteLength), padded(entry.bytes));
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(blocks.reduce((size, block) => size + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

/** A NUL-terminated header field, as bytes. */
function cstring(block: Uint8Array, at: number, size: number): Uint8Array {
  const slice = block.subarray(at, at + size);
  const end = slice.indexOf(0);
  return end < 0 ? slice : slice.subarray(0, end);
}

/** A header's octal number: digits only, NUL- or space-terminated. Base-256 (the high bit set) is refused. */
function octal(block: Uint8Array, at: number, size: number, what: string): number {
  if (block[at]! & 0x80) throw new TarRefusal(`The archive gives a ${what} in base-256, which Nivra doesn't read.`);
  const text = new TextDecoder("latin1").decode(block.subarray(at, at + size)).replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!/^[0-7]*$/.test(text)) throw new TarRefusal(`The archive's ${what} isn't an octal number.`);
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** Whether the header's checksum holds: the unsigned sum of its bytes, with the checksum field as spaces. */
function checksumHolds(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return octal(block, 148, 8, "checksum") === sum;
}

const TYPE_NAMES: Readonly<Record<string, string>> = {
  "1": "hard link",
  "3": "character device",
  "4": "block device",
  "6": "named pipe",
  "7": "contiguous file",
  x: "pax extended header",
  g: "pax global header",
  S: "sparse file",
  V: "volume label",
  M: "multi-volume continuation",
};

/** Strict UTF-8, or a refusal: a name Nivra can't read exactly is a name it won't write. */
function utf8(bytes: Uint8Array, what: string): string {
  try {
    return strict.decode(bytes);
  } catch {
    throw new TarRefusal(`The archive holds ${what} that isn't valid UTF-8.`);
  }
}

/** A path from the archive, normalised: one leading `./` and any trailing `/` removed, and checked. */
function archivePath(raw: string, limits: TarLimits): string {
  let path = raw.startsWith("./") ? raw.slice(2) : raw;
  path = path.replace(/\/+$/, "");
  if (path === "" || path === ".") return "";
  if (path.startsWith("/")) throw new TarRefusal(`The archive holds an absolute path (${JSON.stringify(raw).slice(0, 120)}).`);
  if (encoder.encode(path).byteLength > limits.maxPathBytes) throw new TarRefusal(`The archive holds a path over ${limits.maxPathBytes} bytes.`);
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") throw new TarRefusal(`The archive holds a path with ${part === ".." ? "a .. component" : "an empty component"} (${JSON.stringify(raw).slice(0, 120)}).`);
  }
  return path;
}

/** The entries of an untrusted archive, in its order, or a refusal saying why it isn't taken. */
export function readTar(archive: Uint8Array, limits: TarLimits): TarEntry[] {
  if (archive.byteLength > limits.maxBytes) throw new TarRefusal(`The archive is ${archive.byteLength} bytes, over the ${limits.maxBytes} Nivra takes.`);
  if (archive.byteLength % BLOCK !== 0) throw new TarRefusal("The archive isn't a whole number of 512-byte blocks: it was cut short, or isn't a tar archive.");
  const entries: TarEntry[] = [];
  // One place per name, a folder's places under it: each entry is checked against its parents in time linear in its
  // path, however deep, so a hostile archive can't hold the engine up.
  const root: Place = { kind: "dir", children: new Map() };
  let longName: string | null = null;
  let longLink: string | null = null;
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > archive.byteLength) throw new TarRefusal("The archive ends without its two end blocks.");
    const block = archive.subarray(offset, offset + BLOCK);
    if (isZero(block)) {
      if (offset + 2 * BLOCK > archive.byteLength || !isZero(archive.subarray(offset + BLOCK, offset + 2 * BLOCK))) throw new TarRefusal("The archive's end isn't two zero blocks.");
      if (!isZero(archive.subarray(offset + 2 * BLOCK))) throw new TarRefusal("The archive holds data after its end.");
      if (longName !== null || longLink !== null) throw new TarRefusal("The archive ends after a long name, with no entry for it.");
      break;
    }
    if (!checksumHolds(block)) throw new TarRefusal("A header's checksum doesn't hold, so the archive is damaged.");
    const magic = new TextDecoder("latin1").decode(block.subarray(257, 265));
    const posix = magic === "ustar\u000000";
    if (!posix && magic !== "ustar  \0") throw new TarRefusal("A header isn't a ustar or GNU tar header.");
    const type = String.fromCharCode(block[156]!);
    const size = octal(block, 124, 12, "size");
    if (size > limits.maxEntryBytes) throw new TarRefusal(`An entry is ${size} bytes, over the ${limits.maxEntryBytes} Nivra takes for one file.`);
    const dataStart = offset + BLOCK;
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (next > archive.byteLength) throw new TarRefusal("The archive was cut short inside an entry.");
    const data = archive.subarray(dataStart, dataStart + size);
    offset = next;
    if (type === "L" || type === "K") {
      if (size > limits.maxPathBytes + 1) throw new TarRefusal(`The archive holds a ${type === "L" ? "name" : "link target"} over ${limits.maxPathBytes} bytes.`);
      if ((type === "L" ? longName : longLink) !== null) throw new TarRefusal("The archive holds two long names in a row for one entry.");
      const end = data.indexOf(0);
      const value = utf8(end < 0 ? data : data.subarray(0, end), "a long name");
      if (type === "L") longName = value;
      else longLink = value;
      continue;
    }
    if (!(type === "0" || type === "\0" || type === "5" || type === "2")) throw new TarRefusal(`The archive holds a ${TYPE_NAMES[type] ?? `kind of entry Nivra doesn't take (type ${JSON.stringify(type)})`}, which Nivra doesn't take.`);
    // A POSIX header's prefix extends its name; a GNU header's prefix field holds other things, and is ignored.
    const prefix = posix ? cstring(block, 345, 155) : new Uint8Array(0);
    const name = longName ?? (prefix.byteLength ? `${utf8(prefix, "a name")}/${utf8(cstring(block, 0, 100), "a name")}` : utf8(cstring(block, 0, 100), "a name"));
    const target = longLink ?? utf8(cstring(block, 157, 100), "a link target");
    longName = longLink = null;
    const path = archivePath(name, limits);
    if (path === "") {
      if (type !== "5") throw new TarRefusal("The archive holds a file with no name.");
      continue;
    }
    const entry: TarEntry =
      type === "5"
        ? { path, kind: "dir" }
        : type === "2"
          ? { path, kind: "link", target: checkedTarget(target, limits) }
          : { path, kind: "file", executable: (octal(block, 100, 8, "mode") & 0o100) !== 0, bytes: data.slice() };
    placeEntry(root, entry);
    entries.push(entry);
    if (entries.length > limits.maxEntries) throw new TarRefusal(`The archive holds more than ${limits.maxEntries} entries.`);
  }
  return entries;
}

interface Place {
  /** null for a folder the archive only implies. */
  kind: TarEntry["kind"] | null;
  children: Map<string, Place> | null;
}

/** Puts an entry in its place. Its parents must be folders, never a file or a link, and nothing may be there yet. */
function placeEntry(root: Place, entry: TarEntry): void {
  const { path } = entry;
  const under = (at: string, parent: TarEntry["kind"] | null) => new TarRefusal(`The archive holds ${at} under ${at.slice(0, at.lastIndexOf("/"))}, which ${parent === "link" ? "is a link" : "it also holds as a file"}.`);
  let place = root;
  let start = 0;
  for (;;) {
    const slash = path.indexOf("/", start);
    const part = slash < 0 ? path.slice(start) : path.slice(start, slash);
    place.children ??= new Map();
    let next = place.children.get(part);
    if (!next) place.children.set(part, (next = { kind: null, children: null }));
    place = next;
    if (slash < 0) break;
    if (place.kind === "file" || place.kind === "link") throw under(path, place.kind);
    start = slash + 1;
  }
  if (place.kind !== null) throw new TarRefusal(`The archive holds ${path} twice.`);
  // Something came first under what is now a file or a link.
  const [child] = place.children?.keys() ?? [];
  if (entry.kind !== "dir" && child !== undefined) throw under(`${path}/${child}`, entry.kind);
  place.kind = entry.kind;
}

function checkedTarget(target: string, limits: TarLimits): string {
  if (target === "") throw new TarRefusal("The archive holds a link with no target.");
  if (encoder.encode(target).byteLength > limits.maxPathBytes) throw new TarRefusal(`The archive holds a link target over ${limits.maxPathBytes} bytes.`);
  return target;
}
