import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readTar, TarRefusal, writeTar, type TarEntry, type TarLimits } from "../src/exec/tar.ts";

/**
 * The workspace's tar archives (NIV-42, D34). They are checked against this machine's GNU tar in both directions, and
 * against an independent writer in this file that lays headers out as busybox does. The reader is also given a set of
 * malformed headers. The live run (B3) checks busybox itself.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nivra tar ${label} `));
  dirs.push(dir);
  return dir;
};
const LIMITS: TarLimits = { maxEntries: 1_000, maxBytes: 16 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024, maxPathBytes: 1_024 };
const text = (value: string) => new TextEncoder().encode(value);
const LONG = `deep/${"a-folder-with-a-long-name/".repeat(5)}and-a-file-whose-name-is-long-too.txt`;
const LONG_TARGET = `../${"x".repeat(150)}`;

/** Files, folders and links, the awkward kinds included: a long path, a UTF-8 name, a binary, an empty file. */
const SAMPLE: TarEntry[] = [
  { path: "README.md", kind: "file", executable: false, bytes: text("# Sample\n") },
  { path: "bin/run.sh", kind: "file", executable: true, bytes: text("#!/bin/sh\necho run\n") },
  { path: "empty", kind: "file", executable: false, bytes: new Uint8Array(0) },
  { path: "binary.dat", kind: "file", executable: false, bytes: new Uint8Array([0, 1, 2, 0, 255, 0]) },
  { path: "dir with space/ü.txt", kind: "file", executable: false, bytes: text("unicode\n") },
  { path: LONG, kind: "file", executable: false, bytes: text("long\n") },
  { path: "link", kind: "link", target: "README.md" },
  { path: "long-link", kind: "link", target: LONG_TARGET },
  { path: "kept/empty-folder", kind: "dir" },
];

/** What a read gives for the sample's files and links, ignoring the folders it implies. */
const shape = (entries: readonly TarEntry[]) =>
  entries
    .flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry.executable, [...entry.bytes].join(",")]] : entry.kind === "link" ? [[entry.path, "->", entry.target]] : []))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

/**
 * An independent header writer, laid out as busybox's `tar -c` writes them: the GNU magic, owner root, a real time,
 * names under `./`, and `././@LongLink` records past 100 bytes. Its checksum can be left wrong on purpose.
 */
function rawHeader(fields: { name: string; type: string; size?: number; mode?: number; link?: string; magic?: string; checksum?: "right" | "wrong"; sizeField?: string }): Uint8Array {
  const block = new Uint8Array(512);
  const put = (at: number, value: string) => block.set(new TextEncoder().encode(value), at);
  put(0, fields.name);
  put(100, `${(fields.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, fields.sizeField ?? `${(fields.size ?? 0).toString(8).padStart(11, "0")}\0`);
  put(136, `${(1_760_000_000).toString(8).padStart(11, "0")}\0`);
  put(156, fields.type);
  put(157, fields.link ?? "");
  put(257, fields.magic ?? "ustar  \0");
  put(265, "root");
  put(297, "root");
  block.fill(0x20, 148, 156);
  let sum = block.reduce((total, byte) => total + byte, 0);
  if (fields.checksum === "wrong") sum += 1;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

const blocks = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + Math.ceil(part.byteLength / 512) * 512, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += Math.ceil(part.byteLength / 512) * 512;
  }
  return out;
};
const END = new Uint8Array(1024);
const longName = (value: string, type = "L") => [rawHeader({ name: "././@LongLink", type, size: new TextEncoder().encode(value).byteLength + 1, mode: 0 }), new TextEncoder().encode(`${value}\0`)];

describe("Workspace archives: written by the engine, read back strictly (NIV-42, D34)", () => {
  it("reads back exactly what it wrote: bytes, the executable bit, links, long paths and UTF-8 names", () => {
    const archive = writeTar(SAMPLE);
    assert.equal(archive.byteLength % 512, 0);
    assert.deepEqual(shape(readTar(archive, LIMITS)), shape(SAMPLE));
    assert.equal(Buffer.compare(writeTar(SAMPLE), archive), 0, "the same entries give the same bytes");
  });

  it("is extracted by this machine's GNU tar into exactly the files, modes and links it holds", { skip: process.platform === "win32" ? "needs GNU tar and POSIX modes" : false }, () => {
    const root = tempDir("extract");
    writeFileSync(join(root, "sample.tar"), writeTar(SAMPLE));
    mkdirSync(join(root, "out"));
    const ran = spawnSync("tar", ["-x", "-f", join(root, "sample.tar"), "-C", join(root, "out")], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const out = (path: string) => join(root, "out", path);
    assert.deepEqual(
      [readFileSync(out("README.md"), "utf8"), readFileSync(out(LONG), "utf8"), [...readFileSync(out("binary.dat"))].join(","), readFileSync(out("dir with space/ü.txt"), "utf8"), readFileSync(out("empty")).byteLength],
      ["# Sample\n", "long\n", "0,1,2,0,255,0", "unicode\n", 0],
    );
    assert.deepEqual([(lstatSync(out("bin/run.sh")).mode & 0o111) !== 0, (lstatSync(out("README.md")).mode & 0o111) !== 0], [true, false]);
    assert.deepEqual([readlinkSync(out("link")), readlinkSync(out("long-link")), lstatSync(out("kept/empty-folder")).isDirectory()], ["README.md", LONG_TARGET, true]);
  });

  it("reads what GNU tar writes in its gnu and ustar formats, and refuses a pax header by name", { skip: process.platform === "win32" ? "needs GNU tar" : false }, () => {
    const root = tempDir("gnu");
    const source = join(root, "source");
    mkdirSync(join(source, "bin"), { recursive: true });
    writeFileSync(join(source, "a.txt"), "hello\n");
    writeFileSync(join(source, "bin", "run.sh"), "#!/bin/sh\n");
    chmodSync(join(source, "bin", "run.sh"), 0o755);
    symlinkSync("a.txt", join(source, "link"));
    // A long name GNU tar's ustar format can still split at a slash; the gnu format uses a long-name record.
    const longDir = join(source, "a".repeat(90));
    mkdirSync(longDir);
    writeFileSync(join(longDir, `${"b".repeat(60)}.txt`), "split\n");
    for (const format of ["gnu", "ustar"]) {
      const file = join(root, `${format}.tar`);
      const ran = spawnSync("tar", ["-c", `--format=${format}`, "-f", file, "-C", source, "."], { encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
      const read = readTar(new Uint8Array(readFileSync(file)), LIMITS);
      const files = read.flatMap((entry) => (entry.kind === "file" ? [`${entry.path} ${entry.executable ? "x" : "-"} ${new TextDecoder().decode(entry.bytes)}`] : entry.kind === "link" ? [`${entry.path} -> ${entry.target}`] : []));
      assert.deepEqual(files.sort(), [`${"a".repeat(90)}/${"b".repeat(60)}.txt - split\n`, "a.txt - hello\n", "bin/run.sh x #!/bin/sh\n", "link -> a.txt"].sort(), format);
    }
    // A name too long for ustar's prefix and name needs a pax header in the posix format.
    const deep = join(source, "c".repeat(120));
    mkdirSync(deep);
    writeFileSync(join(deep, `${"d".repeat(150)}.txt`), "pax\n");
    const pax = join(root, "posix.tar");
    assert.equal(spawnSync("tar", ["-c", "--format=posix", "-f", pax, "-C", source, "."]).status, 0);
    assert.throws(() => readTar(new Uint8Array(readFileSync(pax)), LIMITS), /^TarRefusal: The archive holds a pax extended header, which Nivra doesn't take\.$/);
  });

  it("reads an archive laid out as busybox writes one: names under ./, owner root, a real time, long-name records", () => {
    const bytes = text("from busybox\n");
    const archive = blocks(
      rawHeader({ name: "./", type: "5", mode: 0o755 }),
      rawHeader({ name: "./src/", type: "5", mode: 0o755 }),
      rawHeader({ name: "./src/main.c", type: "0", size: bytes.byteLength }),
      bytes,
      ...longName(`./${LONG}`),
      rawHeader({ name: `./${LONG}`.slice(0, 100), type: "0", size: 5 }),
      text("long\n"),
      ...longName(LONG_TARGET, "K"),
      rawHeader({ name: "./long-link", type: "2", mode: 0o777, link: LONG_TARGET.slice(0, 100) }),
      END,
    );
    assert.deepEqual(shape(readTar(archive, LIMITS)), [["long-link", "->", LONG_TARGET], [LONG, false, [...text("long\n")].join(",")], ["src/main.c", false, [...bytes].join(",")]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it("refuses every malformed or unsupported archive, saying why", () => {
    const file = (name: string, content = "x") => [rawHeader({ name, type: "0", size: content.length }), text(content)];
    const cases: Array<[string, Uint8Array, RegExp, Partial<TarLimits>?]> = [
      ["a wrong checksum", blocks(rawHeader({ name: "a", type: "0", checksum: "wrong" }), END), /checksum doesn't hold/],
      ["another format's magic", blocks(rawHeader({ name: "a", type: "0", magic: "notar\0\0\0" }), END), /isn't a ustar or GNU tar header/],
      ["a size that isn't octal", blocks(rawHeader({ name: "a", type: "0", sizeField: "0000000009x\0" }), END), /size isn't an octal number/],
      ["a size in base-256", blocks(rawHeader({ name: "a", type: "0", sizeField: "\x80\0\0\0\0\0\0\0\0\0\0\x01" }), END), /in base-256/],
      ["an archive cut short inside an entry", blocks(rawHeader({ name: "a", type: "0", size: 2_000 }), text("x")), /cut short inside an entry/],
      ["an archive cut mid-block", blocks(...file("a"), END).subarray(0, 700), /isn't a whole number of 512-byte blocks/],
      ["no end blocks", blocks(...file("a")), /ends without its two end blocks/],
      ["one end block, then data", blocks(...file("a"), new Uint8Array(512), ...file("b")), /end isn't two zero blocks/],
      ["data after the end", blocks(...file("a"), END, text("late")), /holds data after its end/],
      ["a long name with nothing after it", blocks(...longName("orphan"), END), /ends after a long name, with no entry for it/],
      ["two long names for one entry", blocks(...longName("one"), ...longName("two"), ...file("a"), END), /two long names in a row/],
      ["a hard link", blocks(rawHeader({ name: "a", type: "1", link: "b" }), END), /holds a hard link, which Nivra doesn't take/],
      ["a named pipe", blocks(rawHeader({ name: "a", type: "6" }), END), /holds a named pipe/],
      ["a device", blocks(rawHeader({ name: "a", type: "3" }), END), /holds a character device/],
      ["a pax header", blocks(rawHeader({ name: "a", type: "x" }), END), /holds a pax extended header/],
      ["an absolute path", blocks(...file("/etc/passwd"), END), /holds an absolute path/],
      ["a .. component", blocks(...file("a/../../escape"), END), /holds a path with a \.\. component/],
      ["an empty component", blocks(...file("a//b"), END), /holds a path with an empty component/],
      ["a duplicate", blocks(...file("a"), ...file("a"), END), /holds a twice/],
      ["a file where a folder is needed", blocks(...file("a"), ...file("a/b"), END), /holds a\/b under a, which it also holds as a file/],
      ["a file under a link", blocks(rawHeader({ name: "l", type: "2", link: "/etc" }), ...file("l/passwd"), END), /holds l\/passwd under l, which is a link/],
      ["a file after something under it", blocks(...file("a/b"), ...file("a"), END), /holds a\/b under a, which it also holds as a file/],
      ["a link after something under it", blocks(...file("l/passwd"), rawHeader({ name: "l", type: "2", link: "/etc" }), END), /holds l\/passwd under l, which is a link/],
      ["a link with no target", blocks(rawHeader({ name: "l", type: "2" }), END), /a link with no target/],
      ["a name that isn't UTF-8", blocks(rawHeader({ name: "�", type: "0" }).fill(0xff, 0, 1), END), /checksum doesn't hold|isn't valid UTF-8/],
      ["too many entries", blocks(...file("a"), ...file("b"), END), /more than 1 entries/, { maxEntries: 1 }],
      ["a file over its cap", blocks(...file("a", "x".repeat(600)), END), /over the 500 Nivra takes for one file/, { maxEntryBytes: 500 }],
      ["an archive over its cap", blocks(...file("a"), END), /over the 100 Nivra takes/, { maxBytes: 100 }],
    ];
    for (const [what, archive, pattern, limits] of cases) assert.throws(() => readTar(archive, { ...LIMITS, ...limits }), (error: Error) => error instanceof TarRefusal && pattern.test(error.message), what);
    // A name that isn't valid UTF-8, with its checksum right.
    const bad = rawHeader({ name: "a", type: "0" });
    bad[0] = 0xc3;
    bad[1] = 0x28;
    bad.fill(0x20, 148, 156);
    const sum = bad.reduce((total, byte) => total + byte, 0);
    bad.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    assert.throws(() => readTar(blocks(bad, END), LIMITS), /a name that isn't valid UTF-8/);
  });

  it("checks a deep archive in time linear in its paths, and keeps a name's leading byte-order mark", () => {
    // The review's hostile result: 7,000 files 505 folders deep, inside the collect step's limits. It took 7 s.
    const deep = "a/".repeat(505);
    const archive = writeTar(Array.from({ length: 7_000 }, (_, index) => ({ path: `${deep}f${index}`, kind: "file" as const, executable: false, bytes: new Uint8Array(0) })));
    const started = performance.now();
    const read = readTar(archive, { maxEntries: 10_000, maxBytes: 16 * 1024 * 1024, maxEntryBytes: 1 << 20, maxPathBytes: 1_024 });
    const elapsed = performance.now() - started;
    assert.equal(read.filter((entry) => entry.kind === "file").length, 7_000);
    assert.ok(elapsed < 2_000, `reading took ${Math.round(elapsed)} ms`);
    const marked = readTar(writeTar([{ path: "﻿name", kind: "file", executable: false, bytes: new Uint8Array(0) }]), LIMITS);
    assert.deepEqual(
      marked.map((entry) => entry.path),
      ["﻿name"],
    );
  });
});
