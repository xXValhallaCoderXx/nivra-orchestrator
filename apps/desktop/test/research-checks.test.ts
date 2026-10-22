import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { researchChecks } from "../scripts/research-checks.ts";
import { startResearchStandIns } from "../scripts/research-stand-ins.ts";
import { answerResearch, standInClient } from "../scripts/stand-in.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import { runTool } from "../src/main/targets/process.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";

/**
 * verify:windows's research checks (D37), rehearsed here so a mistake in them shows before a Windows turn: the same
 * checks, through the same host, against a target that says it is `wsl:Test` and runs its engine locally, and the
 * stand-ins reached through the same channel, over pipes. The Windows run is what shows wsl.exe and interop.
 */
const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const runtime = { node: process.execPath, entry: ENGINE, runtimeHash: null };

describe("verify:windows's research checks, rehearsed against a local engine (D37)", () => {
  it("pass: a project in the distribution, a plan from its conversation, research off refusing, and a whole run", async () => {
    const stands = await startResearchStandIns();
    const root = mkdtempSync(join(tmpdir(), "nivra research checks ü%# "));
    try {
      // The channel as verify-windows.ts wires it: commands out on one pipe, answers back on the other.
      const out = new PassThrough();
      const back = new PassThrough();
      createInterface({ input: out }).on("line", (line) => back.write(`${answerResearch(stands, line.slice("@stub ".length))}\n`));
      const home = join(root, "engine home");
      const inner = new LocalTarget({ platform: "linux", runtime, home, extraArgs: ["--tavily-url", stands.tavily.url, "--token-factory-url", stands.model.url] });
      const target: ExecutionTarget = {
        descriptor: { id: "wsl:Test", kind: "wsl", label: "Test · WSL", platform: "linux", distro: "Test" },
        probe: () => inner.probe(),
        prepare: (request) => inner.prepare(request),
      };
      const results: Array<{ name: string; ok: boolean; detail: string }> = [];
      await researchChecks({
        target,
        discovery: { status: "ready", wslExe: "wsl.exe", distros: [{ name: "Test", version: 2, isDefault: true, defaultUid: 1000, osVersion: null }], hidden: [] },
        local: new LocalTarget({ platform: "linux", runtime, home: join(root, "local home") }),
        // "In the distribution" is here, with a home of the test's own for the repository.
        inDistro: (args, timeoutMs = 60_000) => runTool(args[0]!, args.slice(1), { cwd: "/", env: { ...(process.env as Record<string, string>), HOME: join(root, "distro home") }, timeoutMs }),
        root: join(root, "host"),
        logsDir: join(root, "logs"),
        stub: standInClient(back, out),
        check: async (name, body) => {
          try {
            results.push({ name, ok: true, detail: await body() });
            return true;
          } catch (error) {
            results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
            return false;
          }
        },
        log: () => undefined,
      });
      const failed = results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`);
      assert.deepEqual([results.length, failed], [4, []]);
    } finally {
      await stands.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
