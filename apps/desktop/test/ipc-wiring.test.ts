import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CHAT_LIMITS } from "@nivra/domain";
import { IPC, MESSAGE_CHARS } from "../src/shared/ipc.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
const keys = Object.keys(IPC);

describe("the bridge between the window and main (AGENTS.md, Electron security rules)", () => {
  it("gives every call one main handler, through the checked helper, and one preload entry, each on a channel of its own", () => {
    const main = source("../src/main/index.ts");
    const preload = source("../src/preload/index.ts");
    assert.equal(new Set(Object.values(IPC)).size, keys.length, "every channel is unique");
    const unhandled = keys.filter((key) => count(main, new RegExp(`[^.\\w]handle\\(\\s*IPC\\.${key},`, "g")) !== 1);
    assert.deepEqual(unhandled, []);
    // Every registration names an IPC entry, and only the helper (which checks the sender and the arguments) reaches ipcMain.
    assert.deepEqual([count(main, /[^.\w]handle\(/g), count(main, /ipcMain\./g)], [keys.length, 1]);
    const unexposed = keys.filter((key) => count(preload, new RegExp(`^  ${key}: \\([^)]*\\) => ipcRenderer\\.invoke\\(IPC\\.${key}[,)]`, "gm")) !== 1);
    assert.deepEqual(unexposed, []);
    // The preload uses ipcRenderer only to invoke a named channel.
    assert.deepEqual([count(preload, /ipcRenderer\./g), count(preload, /ipcRenderer\.invoke\(IPC\.\w+[,)]/g)], [keys.length, keys.length]);
  });

  it("keeps the end-to-end test's list of window calls the same as the bridge's", () => {
    const list = /const EXPECTED_API = \[([^\]]*)\];/.exec(source("../e2e/app.spec.ts"))?.[1] ?? "";
    const names = [...list.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    assert.equal(names.length, keys.length);
    assert.deepEqual(names, [...keys].sort());
  });

  it("tells the window the same message limit the host and the engine use", () => {
    assert.equal(MESSAGE_CHARS, CHAT_LIMITS.messageChars);
  });
});
