import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { SEARCH_COUNT_MAX, WorkspaceCopy } from "../src/task/copy.ts";
import { cleanUp, repoWith, snap } from "./workspace-fixtures.ts";

/**
 * The worker's search (NIV-35): file names and lines of text in the engine's own copy of the workspace, the approved
 * snapshot plus the worker's checked writes, and nothing else. Matched literally, ignoring case, within its bounds.
 */
after(cleanUp);

const copyOf = async (files: Parameters<typeof repoWith>[0]) => new WorkspaceCopy(await snap(repoWith(files)));

describe("the worker's search (NIV-35)", () => {
  it("finds names and lines ignoring case, under a folder when one is given, with each line's number", async () => {
    const copy = await copyOf({ "src/Units.ts": "export function convertWeight() {}\r\n// convertweight is used below\n", "src/other.ts": "const x = 1\n", "docs/units.md": "# Units\n" });
    assert.deepEqual(copy.search("UNITS", "names", "", 40, 200).matches, [{ path: "docs/units.md" }, { path: "src/Units.ts" }]);
    assert.deepEqual(copy.search("units", "names", "src", 40, 200).matches, [{ path: "src/Units.ts" }]);
    // A line keeps its words but not its carriage return; every matching line is counted, the second included.
    assert.deepEqual(copy.search("ConvertWeight", "content", "", 40, 200), {
      matches: [
        { path: "src/Units.ts", line: 1, text: "export function convertWeight() {}" },
        { path: "src/Units.ts", line: 2, text: "// convertweight is used below" },
      ],
      total: 2,
      capped: false,
      skipped: 0,
    });
    // A folder is a prefix of the paths the copy holds, so a sibling whose name starts the same isn't under it.
    assert.deepEqual(copy.search("x", "content", "src/oth", 40, 200).matches, []);
  });

  it("cuts a long line around the match, and says where it was cut", async () => {
    const line = `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`;
    const found = (await copyOf({ "long.txt": `${line}\n` })).search("needle", "content", "", 40, 50).matches[0]!;
    assert.match(found.text!, /^\.\.\.a+NEEDLEb+\.\.\.$/);
    assert.equal(found.text!.length, 50 + 6);
  });

  it("shows the match in a long line whose letters change length when lowercased (İ)", async () => {
    const found = (await copyOf({ "turkish.txt": `${"İ".repeat(300)}NEEDLE${"b".repeat(1_000)}\n` })).search("needle", "content", "", 40, 50).matches[0]!;
    assert.ok(found.text!.includes("NEEDLE"), found.text);
  });

  it("skips what isn't UTF-8 text, and links, counting them, and never follows a link", async () => {
    const copy = await copyOf({ "a.bin": new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x00]), "b.txt": new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0xff]), "c.txt": "need\n", "d.lnk": { link: "c.txt" } });
    const found = copy.search("need", "content", "", 40, 200);
    assert.deepEqual([found.matches, found.skipped], [[{ path: "c.txt", line: 1, text: "need" }], 3]);
  });

  it("searches the worker's own writes as the copy holds them, and no longer finds what they replaced", async () => {
    const copy = await copyOf({ "greet.sh": "printf 'Hello'\n" });
    copy.record("greet.sh", new TextEncoder().encode("printf 'Farewell'\n"));
    assert.deepEqual([copy.search("farewell", "content", "", 40, 200).total, copy.search("hello", "content", "", 40, 200).total], [1, 0]);
  });

  it("returns at most its matches, and stops counting at its ceiling, saying so", async () => {
    const copy = await copyOf({ "many.txt": Array.from({ length: SEARCH_COUNT_MAX + 50 }, () => "hit").join("\n") });
    const found = copy.search("hit", "content", "", 40, 200);
    assert.deepEqual([found.matches.length, found.total, found.capped], [40, SEARCH_COUNT_MAX, true]);
  });
});
