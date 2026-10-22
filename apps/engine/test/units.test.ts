import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArgsError, readArgs } from "../src/args.ts";
import { libsqlFileUrl } from "../src/db/libsql-url.ts";
import { startWatchdog } from "../src/engine.ts";
import { childEnv, insideWsl } from "../src/exec/child-env.ts";
import { findOnPath } from "../src/exec/find-executable.ts";
import { mastraInputOf } from "../src/runs/scheduler.ts";
import { SecretVault } from "../src/secrets/vault.ts";
import { parseStatus } from "../src/workflows/hello.ts";

describe("childEnv", () => {
  it("keeps exactly one PATH key, named for the platform", () => {
    const base = { PATH: "/usr/bin", Path: "C:\\other", HOME: "/home/a" };
    assert.deepEqual(Object.keys(childEnv(base, {}, { platform: "linux" })).filter((k) => k.toLowerCase() === "path"), ["PATH"]);
    const windows = childEnv({ Path: "C:\\Windows;C:\\Git", SystemRoot: "C:\\Windows" }, {}, { platform: "win32" });
    assert.deepEqual(Object.keys(windows).filter((k) => k.toLowerCase() === "path"), ["Path"]);
    assert.equal(windows["Path"], "C:\\Windows;C:\\Git");
  });

  it("drops provider keys, NODE_OPTIONS and Electron's variables, and keeps Windows' essentials", () => {
    const env = childEnv(
      { NEBIUS_API_KEY: "k", NEBIUS_PROJECT_ID: "p", TAVILY_API_KEY: "t", OPENAI_API_KEY: "k", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1", SystemRoot: "C:\\Windows", TEMP: "C:\\t", APPDATA: "C:\\a" },
      {},
      { platform: "win32" },
    );
    assert.deepEqual(Object.keys(env).sort(), ["APPDATA", "SystemRoot", "TEMP"]);
  });

  it("strips Windows folders from WSL's PATH when asked, and lets an extra PATH win", () => {
    const base = { PATH: "/usr/local/bin:/mnt/c/Program Files/Docker/Docker/resources/bin:/usr/bin:/mnt/d/tools:/mntx/keep" };
    assert.equal(childEnv(base, {}, { platform: "linux", stripWindowsPaths: true })["PATH"], "/usr/local/bin:/usr/bin:/mntx/keep");
    assert.equal(childEnv(base, { PATH: "/only" }, { platform: "linux" })["PATH"], "/only");
  });

  it("recognises WSL by its variables or its kernel", () => {
    assert.equal(insideWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "6.8.0"), true);
    assert.equal(insideWsl({}, "6.18.33.1-microsoft-standard-WSL2"), true);
    assert.equal(insideWsl({}, "6.8.0-45-generic"), false);
  });
});

describe("findOnPath", () => {
  it("looks only in absolute PATH folders, and only for .exe on Windows", () => {
    const seen: string[] = [];
    const exists = (candidate: string) => {
      seen.push(candidate);
      return candidate === "C:\\Git\\cmd\\git.exe";
    };
    assert.equal(findOnPath("git", { env: { Path: ".;relative;C:\\Git\\cmd" }, platform: "win32", exists }), "C:\\Git\\cmd\\git.exe");
    assert.deepEqual(seen, ["C:\\Git\\cmd\\git.exe"]);
    assert.equal(findOnPath("npm", { env: { Path: "C:\\nodejs" }, platform: "win32", exists: (c) => c.endsWith(".cmd") }), null);
  });
});

describe("readArgs", () => {
  it("needs --stdio and an absolute --home, and reads the heartbeat", () => {
    assert.throws(() => readArgs(["--home", "/tmp/x"]), ArgsError);
    assert.throws(() => readArgs(["--stdio", "--home", "relative"]), ArgsError);
    assert.throws(() => readArgs(["--stdio", "--home", "/tmp/x", "--heartbeat-ms", "-1"]), ArgsError);
    assert.throws(() => readArgs(["--stdio", "--home", "/tmp/x", "--unknown"]), ArgsError);
    const args = readArgs(["--stdio", "--home", "/tmp/x", "--heartbeat-ms", "0", "--nivra-engine"]);
    assert.equal(args.heartbeatMs, 0);
    assert.equal(args.instanceId.length, 36);
  });

  it("takes a test endpoint only on this machine, for Token Factory, Nebius Sandboxes and Tavily alike", () => {
    for (const flag of ["--token-factory-url", "--sandboxes-url", "--tavily-url"]) {
      assert.throws(() => readArgs(["--stdio", "--home", "/tmp/x", flag, "https://api.tavily.com"]), ArgsError, flag);
      assert.throws(() => readArgs(["--stdio", "--home", "/tmp/x", flag, "not an address"]), ArgsError, flag);
    }
    const args = readArgs(["--stdio", "--home", "/tmp/x", "--tavily-url", "http://127.0.0.1:4000/"]);
    assert.deepEqual([args.tavilyUrl, args.tokenFactoryUrl, args.sandboxesUrl], ["http://127.0.0.1:4000", null, null]);
  });
});

describe("startWatchdog", () => {
  it("fires after three silent ticks and never while messages keep arriving", async () => {
    let received = 0;
    let silences = 0;
    const stopTalking = setInterval(() => received++, 10);
    const stop = startWatchdog(90, () => received, () => silences++);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(silences, 0);
    clearInterval(stopTalking);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(silences, 1);
    stop();
  });

  it("is off at 0", () => {
    let silences = 0;
    startWatchdog(0, () => 0, () => silences++)();
    assert.equal(silences, 0);
  });
});

describe("libsqlFileUrl", () => {
  it("escapes only %, # and ?", () => {
    assert.equal(libsqlFileUrl("/tmp/a b ü%#?/m.db"), "file:/tmp/a b ü%25%23%3F/m.db");
    assert.equal(libsqlFileUrl("C:\\Users\\A B\\m.db"), "file:C:\\Users\\A B\\m.db");
  });
});

describe("SecretVault", () => {
  it("masks every known value, the longest first", () => {
    const vault = new SecretVault();
    vault.set("NEBIUS_API_KEY", "abc-secret-123");
    assert.equal(vault.mask("key=abc-secret-123; again abc-secret-123"), "key=[secret:NEBIUS_API_KEY]; again [secret:NEBIUS_API_KEY]");
    vault.remove("NEBIUS_API_KEY");
    assert.equal(vault.mask("abc-secret-123"), "abc-secret-123");
  });
});

describe("parseStatus", () => {
  it("reads branch, upstream, ahead/behind and changed entries from porcelain v2", () => {
    const output = [
      "# branch.oid 1234",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 abc abc src/a.ts",
      "? notes.txt",
      "",
    ].join("\n");
    assert.deepEqual(parseStatus(output), { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, changes: 2 });
    assert.equal(parseStatus("# branch.head (detached)\n").branch, null);
  });
});

describe("mastraInputOf", () => {
  it("hands Mastra exactly what a workflow narrows its input to, never the whole input in place of nothing (D22)", () => {
    const input = { repoPath: "/repo", question: "a question Mastra must never store" };
    assert.deepEqual(
      [
        mastraInputOf({ id: "explain", title: () => "", mastraInput: () => ({ repoPath: "/repo" }) }, input),
        mastraInputOf({ id: "explain", title: () => "", mastraInput: () => undefined }, input),
        mastraInputOf({ id: "hello", title: () => "" }, input) === input,
      ],
      [{ repoPath: "/repo" }, undefined, true],
    );
  });
});
