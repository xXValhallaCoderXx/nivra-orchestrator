import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { extractAnswer, searchAnswer, startTavilyStub } from "./stub-tavily.ts";
import { startStub, toolCall } from "./stub-token-factory.ts";

/**
 * The research live check's script (NIV-45), driven as a person drives it: its request for approval, its refusals
 * before anything is sent, and the whole recipe against a loopback Tavily and Token Factory. Never a real request.
 */
const CLI = fileURLToPath(new URL("../scripts/research-check.ts", import.meta.url));
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "nivra-research-check-"));
  dirs.push(dir);
  return dir;
};

function cli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
const digestIn = (text: string) => /^Approval digest: ([0-9a-f]{64})$/m.exec(text)?.[1] ?? null;

describe("the research live check (NIV-45)", () => {
  it("prints the request for approval, the same each time, touching no network", async () => {
    const [first, second] = await Promise.all([cli(["--plan"]), cli(["--plan"])]);
    assert.equal(first.code, 0, first.stderr);
    const digest = digestIn(first.stdout);
    assert.ok(digest);
    assert.equal(digestIn(second.stdout), digest);
    for (const needle of [
      "Nothing here touches the network.",
      "It covers the revision, the plan, its assumptions, the queries exactly as sent, the sites, Tavily's request parameters, the model, its",
      "instructions and tool, and every limit. A change to any of them changes it. One approval is one run.",
      "Never a key: both files are masked as the engine's store masks.",
      `A1 query "distutils is still in Python 3.12's standard library"`,
      `A2 query "Python 3.12 f-strings can reuse the enclosing quotes"`,
      `A3 query "venv still pre-installs setuptools"`,
      `include_domains_mode "prefer"`,
      `"search_depth": "basic"`,
      `"max_results": 5`,
      `"chunks_per_source": 3`,
      `"extract_depth": "basic"`,
      `"timeout": 40`,
      "never the plan's text",
      "At most 6 credits",
      `model ${MODEL}`,
      "exactly 1 request, a forced submit_research tool call, at most 4,000 output tokens",
      "one deadline, 240 s from the start",
      "searching and reading stop 90 s in",
      "the model gets at most 150 s, and never past the deadline",
      "nothing is retried",
      "It is never switched to here",
      `--approved ${digest}`,
    ])
      assert.ok(first.stdout.includes(needle), needle);
  });

  it("refuses before anything is sent and leaves no evidence: a wrong digest, missing or mixed switches, a stub elsewhere", async () => {
    const dir = scratch();
    const keys = join(dir, "keys.env");
    writeFileSync(keys, "NEBIUS_API_KEY=not-a-key\nTAVILY_API_KEY=tvly-not-a-key\n", { mode: 0o600 });
    const out = join(dir, "evidence");
    const cases: Array<[readonly string[], RegExp]> = [
      [["--credentials", keys, "--tavily-credentials", keys, "--approved", "0".repeat(64), "--out", out], /^--approved isn't this recipe's digest/],
      [["--credentials", keys, "--out", out], /^The live check needs --credentials \(the Token Factory key file\), --tavily-credentials/],
      [["--approved", "0".repeat(64), "--tavily-url", "http://127.0.0.1:9"], /^Give --credentials, --tavily-credentials and --approved for the live check, or --tavily-url/],
      [["--tavily-url", "http://127.0.0.1:9", "--out", out], /^Give both --tavily-url and --token-factory-url/],
      [["--tavily-url", "https://api.tavily.com", "--token-factory-url", "http://127.0.0.1:9", "--out", out], /^A stub must be on this computer/],
    ];
    for (const [args, words] of cases) {
      const { code, stdout, stderr } = await cli(args);
      assert.equal(code, 2, stderr);
      assert.match(stderr, words);
      assert.equal(stdout.includes("not-a-key") || stderr.includes("not-a-key"), false);
      assert.equal(existsSync(out), false, args.join(" "));
    }
  });

  it("runs the recipe once against stubs: three searches, one Extract an assumption, one model request, and evidence with no key", async () => {
    const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
    const PEP632 = "https://peps.python.org/pep-0632/";
    const PEP701 = "https://peps.python.org/pep-0701/";
    const CHUNKS: Record<string, string[]> = {
      [WHATSNEW]: ["The distutils package has been removed from the standard library.", "gh-95299: venv no longer pre-installs setuptools in new virtual environments."],
      [PEP632]: ["This PEP proposes removing distutils in Python 3.12."],
      [PEP701]: ["Quote reuse is allowed in Python 3.12 f-strings."],
    };
    const tavily = await startTavilyStub((call) => {
      const query = String(call.body?.["query"] ?? "");
      if (call.path === "/search") {
        if (query.startsWith("distutils")) return { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }, { url: PEP632, title: "PEP 632 – Deprecate distutils module" }]) };
        if (query.startsWith("Python 3.12 f-strings")) return { body: searchAnswer([{ url: PEP701, title: "PEP 701 – Syntactic formalization of f-strings" }]) };
        return { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }]) };
      }
      const urls = (call.body?.["urls"] ?? []) as string[];
      return { body: extractAnswer(urls.map((url) => ({ url, chunks: CHUNKS[url] ?? [] }))) };
    });
    const assessment = (assumption: string, outcome: string, passage: string, stance: string, quote: string, amendment = "") => ({
      assumption,
      outcome,
      reasoning: "From the passages read.",
      citations: [{ passage, stance, quote }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
      uncertainty: "",
      amendment,
    });
    // The passages, in assumption order: A1 reads What's New (S1.1, S1.2) and PEP 632 (S2.1); A2 reads PEP 701 (S3.1); A3 reads What's New again (S1.3, S1.4).
    const answer = {
      assessments: [
        assessment("A1", "contradicted", "S1.1", "contradicts", "has been removed from the standard library", "Replace the distutils imports before moving to 3.12."),
        assessment("A2", "supported", "S3.1", "supports", "Quote reuse is allowed in Python 3.12 f-strings"),
        assessment("A3", "contradicted", "S1.4", "contradicts", "venv no longer pre-installs setuptools in new virtual environments", "Install setuptools in each environment that needs it."),
      ],
    };
    const factory = await startStub({ models: [{ id: MODEL }, { id: "nvidia/other-model" }], chat: () => toolCall("submit_research", answer, { tokens: [9_000, 700] }) });
    try {
      const out = join(scratch(), "evidence");
      const { code, stdout, stderr } = await cli(["--tavily-url", tavily.url, "--token-factory-url", factory.url, "--out", out]);
      assert.equal(code, 0, `${stdout}\n${stderr}`.slice(-2_000));
      assert.match(stdout, /^Outcome: complete in /m);

      // Exactly the recipe's requests, with the approved queries, the key only in the header, and never the plan's text.
      assert.deepEqual(
        tavily.calls.map((call) => call.path),
        ["/search", "/search", "/search", "/extract", "/extract", "/extract"],
      );
      assert.deepEqual(
        tavily.calls
          .filter((call) => call.path === "/search")
          .map((call) => call.body?.["query"])
          .sort(),
        ["Python 3.12 f-strings can reuse the enclosing quotes", "distutils is still in Python 3.12's standard library", "venv still pre-installs setuptools"],
      );
      for (const call of tavily.calls) {
        assert.equal(call.authorization, "Bearer tvly-stub-key-for-research-check");
        assert.equal(call.raw.includes("setup.py keeps importing distutils"), false);
      }
      assert.equal(factory.chats().length, 1);

      assert.deepEqual(readdirSync(out).sort(), ["check.json", "recipe.txt", "report.json"]);
      assert.equal(statSync(out).mode & 0o777, 0o700);
      for (const name of readdirSync(out)) {
        assert.equal(statSync(join(out, name)).mode & 0o777, 0o600, name);
        const text = readFileSync(join(out, name), "utf8");
        assert.equal(text.includes("tvly-stub-key-for-research-check") || text.includes("stub-model-key-for-research-check"), false, name);
      }
      const check = JSON.parse(readFileSync(join(out, "check.json"), "utf8")) as Record<string, unknown>;
      assert.deepEqual(
        [check["mode"], check["outcome"], check["model"], check["credits"], check["reportFitsContract"], check["approvalDigest"]],
        ["stub", "complete", MODEL, 6, true, digestIn(readFileSync(join(out, "recipe.txt"), "utf8"))],
      );
      assert.deepEqual(check["extracts"], [
        { assumption: "A1", asked: 2, returned: 2, credits: 1 },
        { assumption: "A2", asked: 1, returned: 1, credits: 1 },
        { assumption: "A3", asked: 1, returned: 1, credits: 1 },
      ]);
      assert.deepEqual(
        (check["assessments"] as Array<Record<string, unknown>>).map((item) => [item["assumption"], item["shown"], item["valid"]]),
        [
          ["A1", "contradicted", 1],
          ["A2", "supported", 1],
          ["A3", "contradicted", 1],
        ],
      );
      assert.deepEqual(check["tokens"], { inputTokens: 9_000, outputTokens: 700, calls: 1, reportedCalls: 1 });
    } finally {
      await Promise.all([tavily.close(), factory.close()]);
    }
  });
});
