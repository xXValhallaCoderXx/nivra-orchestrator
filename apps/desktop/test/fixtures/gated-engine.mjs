// Stands in for an engine whose answer to runs.start is held until the test releases it (a `release` file in its
// home), so a test can act while a submission is out. It writes every method it is asked for to `calls.log`, turns
// runs.cancel down while a `fail-cancel` file exists, as an engine that can't stop a run would, and holds its answer to
// runs.cancel while a `hold-cancel` file exists, until a `release-cancel` file appears, then answers the held ones in
// the order they came. runs.get and runs.result
// answer for a finished run whose result holds one suggestion; runs.result is held while a `hold-result` file exists,
// until a `release-result` file appears. Its store's id (D26) is kept in its home, so the same home keeps one id.
// For conversation turns (D26): with an `accept` file, runs.start records the run (`accepted.log`) before it holds its
// answer, as an engine that created the run would; with an `error-start` file, that answer is then an internal error
// (a refusal, without `accept`).
// runs.find answers for a recorded request id with the run still running (held while a `hold-find` file exists, until a
// `release-find` file appears); runs.get says "succeeded", or "cancelled" for a run it was asked to cancel; each run it
// cancels is written to `cancelled.log`; runs.reply gives a general reply; runs.events has no events.
// For reviews (D31): runs.start records each review's request id and input (`reviews.log`), and runs.review answers
// with a report that repeats what it was asked for, or names the next plan version while a `wrong-report` file exists.
// For sandbox checks (D36): runs.sandbox answers that there is no report yet; runs.get says "running" for a run it
// wasn't asked to cancel while a `running` file exists, and is turned down while a `fail-get` file exists, as an engine
// that can't read a run would.
// For coachings (NIV-53): runs.start records each coaching's request id and input (`coaches.log`), and runs.coach
// answers with a complete report that repeats what it was bound to, with one change to the goal.
// For research (D37): runs.start records each research request and what it was bound to (`research.log`), and
// runs.research answers with a report that repeats it: complete, or cancelled for a run it was asked to cancel. With a
// `fail-cancel-once` file, the next runs.cancel it answers is turned down, and the file is removed; with a
// `fail-cancel-for` file, runs.cancel for the run whose id it holds is turned down.
// For task runs (D39, D40): task.preview answers that the checkout is ready to run, with a fixed snapshot, so the
// window can start one. runs.start records each task run's request id, input and brief (`tasks.log`). While a
// `task-report` file exists, runs.task answers such a run with a finished report that proposes the change `TASK_HASH`
// names, every acceptance case passed, every baseline selection matched and every frozen file unchanged, from the
// environment its input named (D41), and runs.proposal with that proposal. task.apply records each request id and
// the applied change it answers with (`applies.log`), unless a `refuse-apply` file exists; its answer is held while a
// `hold-apply` file exists, until a `release-apply` file appears, and is an internal error while an `error-apply` file
// exists; with a `partial-apply` file, the change it records was applied in part, and with an `aside-apply` file as well,
// one more file of it was moved aside with nothing in its place. task.applyStatus answers a recorded apply by its
// request id, or null; task.restore takes one back to its originals and task.dismiss settles one, each kept in
// `applies.log` so a later applyStatus reads it; with an `error-settle` file, either does its work, then answers with an
// internal error, as an engine whose answer is lost, and with a `hold-settle` file, does its work and never answers.
// For environments (D41, NIV-55): environment.resolve records what it was asked (`env-resolves.log`) and answers with
// a ready recipe (a pnpm workspace on Node 24, on the Node a runtime choice names, installing the packages a scope
// chooses with one --filter each, or the whole project while an `env-ignores-scope` file exists, as an engine that
// ignored the choice would) whose fingerprint covers the choices it was given, and also an `env-changed` file while
// one exists, as a commit that changed would; it asks for a choice while an `env-needs-choice` file exists, and
// refuses while an `env-refused` one does. Every answer carries the workspace's facts (D52): packages/data and
// packages/web, which links data, or one package while an `env-single` file exists; a chosen package it hasn't got is
// refused with them, and chosen packages install with what they link and the root. runs.start records each
// preparation with its input and context (`environments.log`). runs.environment answers with a report: in progress
// while a `running` file exists, cancelled for a run it was asked to cancel, else the outcome an `environment-outcome`
// file names (prepared unless it says otherwise), with the recipe's environment only when it is prepared, or whatever
// it is while an `environment-prepared-anyway` file exists; its builds are missing esbuild while an
// `environment-builds-missing` file exists. Its project fingerprint hashes the project id it was handed with the
// secrets. runs.get says a preparation whose outcome isn't prepared failed, unless an `environment-run-succeeds` file
// exists. task.preview records what it was asked (`task-previews.log`), and echoes the environment it was given, a
// recipe's in its own field, with the brief's frozen files.
// It takes secrets.update, and turns down at once any other method it doesn't stand in for, so no caller waits out its
// time limit. The window's tests run it as the local engine with --nivra-test-engine=gated (unpackaged only).
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[process.argv.indexOf("--home") + 1];
const instanceId = process.argv[process.argv.indexOf("--instance") + 1] || randomUUID();
mkdirSync(home, { recursive: true });
if (!existsSync(join(home, "home-id"))) writeFileSync(join(home, "home-id"), randomUUID());
const homeId = readFileSync(join(home, "home-id"), "utf8").trim();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const summary = (status, id = randomUUID(), workflowId = "explain") => {
  const now = new Date().toISOString();
  return { id, workflowId, title: workflowId === "chat" ? "Chat" : "Explain", status, input: {}, createdAt: now, startedAt: now, finishedAt: null, error: null, durationMs: null, usage: null, route: null };
};
const cancelled = new Set();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** The Nebius project id the host handed over with the secrets, as an engine keeps it in memory. */
let nebiusProject = null;
/** The gated workspace's packages (NIV-55, D52): web links data, and pnpm always installs the root. */
const PACKAGES = [
  { folder: "packages/data", name: "@mono/data", needs: [] },
  { folder: "packages/web", name: "@mono/web", needs: ["packages/data"] },
];
/** The workspace's facts as a resolver sends them: none chosen while an `env-single` file exists, as for one package. */
const factsFor = () => {
  const single = existsSync(join(home, "env-single"));
  const why = "This project is one package, so installing it is installing the whole project.";
  return {
    packages: single ? [] : PACKAGES.map(({ folder, name }) => ({ folder, name, unavailable: null })),
    more: 0,
    root: { dependencies: 1, examples: ["typescript"], optional: false, reason: "pnpm installs the workspace root's own dependencies whenever it installs chosen packages." },
    modes: [
      { mode: "whole", available: true, reason: null },
      { mode: "packages", available: !single, reason: single ? why : null },
      { mode: "selectors", available: !single, reason: single ? "This project isn't a pnpm workspace, so there are no packages to choose." : null },
    ],
  };
};
/** A packages scope's selection as the resolver works it out: the chosen packages and what they link, in folder order. */
const selectionFor = (scope) => {
  const installed = new Set(scope.packages);
  for (const folder of scope.packages) for (const need of PACKAGES.find((item) => item.folder === folder)?.needs ?? []) installed.add(need);
  return { packages: [...installed].sort().map((folder) => ({ folder, name: PACKAGES.find((item) => item.folder === folder).name, chosen: scope.packages.includes(folder) })), root: true };
};
/** A recipe as the gated engine resolves one (NIV-55): a pnpm workspace on Node 24, or on the Node the person chose, installing what they chose. */
const recipeFor = (choices) => {
  const node = choices?.runtime ?? "24.21.0";
  const scope = choices?.scope && !existsSync(join(home, "env-ignores-scope")) ? choices.scope : { kind: "whole" };
  const selection = scope.kind === "packages" ? selectionFor(scope) : undefined;
  const filters = scope.kind === "selected" ? ["--fail-if-no-match", ...scope.selectors.flatMap((selector) => ["--filter", selector])] : selection ? ["--fail-if-no-match", ...selection.packages.flatMap((item) => ["--filter", item.name])] : [];
  return {
    format: "nivra.environment-recipe.v1",
    profile: "node",
    platform: { os: "linux", arch: "x86_64", libc: "musl" },
    image: { registryUrl: `docker://docker.io/library/node:${node}-alpine`, tag: `node:${node}-alpine` },
    tools: [
      { name: "node", version: { kind: "exact", version: node }, from: "image" },
      { name: "npm", version: { kind: "bundled", with: "node" }, from: "image" },
      { name: "pnpm", version: { kind: "exact", version: "11.5.3" }, from: "bootstrap" },
    ],
    bootstrap: [{ tool: "pnpm", version: "11.5.3", via: "corepack-else-npm-global" }],
    install: { tool: "pnpm", args: ["install", "--frozen-lockfile", ...filters], options: {} },
    scope,
    ...(selection ? { selection } : {}),
    builds: { tool: "pnpm", runs: "allowed", allowed: ["esbuild"], denied: [], strict: true, source: "pnpm-workspace.yaml", notes: [] },
    configuration: { mode: "manifests", files: ["package.json", "packages/data/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map((path) => ({ path, bytes: 100, sha256: sha256(path) })), digest: "2".repeat(64) },
    systemPackages: [],
    workdir: "/workspace",
    env: { preparation: { CI: "1" }, task: { CI: "1", COREPACK_ENABLE_NETWORK: "0", pnpm_config_verify_deps_before_run: "false" } },
    artifacts: { dependency: ["node_modules"], caches: ["/root/.cache"] },
    network: { preparation: "on", tasks: "off", hosts: ["registry.npmjs.org"], imageRegistry: "docker.io" },
    probes: ["tool-versions"],
    limits: { importSeconds: 900, prepareSeconds: 600, probeSeconds: 120 },
  };
};
/** A stand-in for a digest: the host never works one out again, it only compares them. */
const digestOf = (value) => sha256(JSON.stringify(value));
/** The rows a gated resolution shows, each with where its value came from. */
const rowsFor = (choices, recipe) => [
  { fact: "runtime", label: "Node", value: recipe.tools[0].version.version, source: choices?.runtime ? "choice" : "declared", declarations: [{ file: ".nvmrc", field: null, value: "24.21.0" }], note: null },
  { fact: "manager", label: "Package manager", value: "pnpm 11.5.3", source: "declared", declarations: [{ file: "package.json", field: "packageManager", value: "pnpm@11.5.3" }], note: null },
];
/** A preparation's choices and its outcome, as the flags say. */
const preparation = (runId) => logged("environments.log", runId);
const environmentOutcome = () => (existsSync(join(home, "environment-outcome")) ? readFileSync(join(home, "environment-outcome"), "utf8").trim() : "prepared");
/** A preparation's report, as an engine keeps one. */
const environmentReport = (runId) => {
  const run = preparation(runId);
  if (!run) return null;
  const now = new Date().toISOString();
  const going = !cancelled.has(runId) && existsSync(join(home, "running"));
  const outcome = cancelled.has(runId) ? "cancelled" : going ? "in-progress" : environmentOutcome();
  const recipe = recipeFor(run.context.choices);
  const verified = {
    format: "nivra.environment-verified.v1",
    recipe: digestOf(recipe),
    tools: [
      { name: "node", version: recipe.tools[0].version.version },
      { name: "npm", version: "11.19.0" },
      { name: "pnpm", version: "11.5.3" },
    ],
    platform: { os: "linux", arch: "x86_64", libc: "musl", release: "Alpine Linux v3.22" },
    images: { base: "img-imported", prepared: `image-${runId.slice(0, 8)}`, imported: true },
    builds: existsSync(join(home, "environment-builds-missing")) ? { state: "missing", missing: ["esbuild"] } : { state: "complete", missing: [] },
    generated: null,
    probes: [{ name: "readiness", durationMs: 900 }],
    verifiedAt: now,
  };
  const prepared = {
    format: "nivra.environment-prepared.v2",
    recipe,
    recipeDigest: digestOf(recipe),
    verified,
    verifiedDigest: digestOf(verified),
    baseline: "a".repeat(40),
    projectFingerprint: nebiusProject ? sha256(`nivra.nebius-project.v1\0${nebiusProject}`) : "f".repeat(64),
    preparedAt: now,
  };
  const stopped = outcome === "failed" ? { code: "install", step: "preparation", message: "The install in the sandbox didn't finish, so no environment was made." } : outcome === "cancelled" ? { code: "cancelled", step: "preparation", message: "Cancelled." } : null;
  return {
    outcome,
    stopped,
    prepared: null,
    environment: outcome === "prepared" || existsSync(join(home, "environment-prepared-anyway")) ? prepared : null,
    install: going ? null : { exitCode: outcome === "failed" ? 1 : 0, logTail: outcome === "failed" ? "ERR_PNPM_OUTDATED_LOCKFILE <b>Cannot install</b> with frozen-lockfile\n" : "installed\n" },
    steps: [],
    cleanup: null,
    request: { runId, clientRequestId: run.clientRequestId },
    updatedAt: now,
    finishedAt: going ? null : now,
  };
};
/** The change a gated task run proposes. */
const TASK_HASH = "5".repeat(64);
/** A line of a `<id> <json>` log, by its id. */
const logged = (file, id) => {
  const line = existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").split("\n").find((entry) => entry.startsWith(`${id} `)) : undefined;
  return line ? JSON.parse(line.slice(id.length + 1)) : null;
};
/** A finished task run's report, as an engine keeps one: a verified change proposed. */
const taskReport = (runId) => {
  const run = logged("tasks.log", runId);
  if (!run) return null;
  const now = new Date().toISOString();
  return {
    outcome: "proposed",
    stopped: null,
    task: { taskId: run.input.taskId, attemptId: run.clientRequestId, briefVersion: run.input.briefVersion, briefDigest: run.input.briefDigest },
    snapshot: null,
    toolchain: [],
    // A recipe's environment in its own field (NIV-55), and the setup files as they came back, unchanged.
    environment: run.input.environment?.format ? null : (run.input.environment ?? null),
    environmentRef: run.input.environment?.format ? run.input.environment : null,
    setup: run.input.environment?.format ? { unchanged: true, changed: [] } : null,
    baseline: (run.brief?.baseline ?? []).map((given, index) => ({ number: index + 1, name: given.name, matched: true, reason: null, exitCode: given.expectedExitCode, stdoutTail: given.expectedOutput ?? "", stderrTail: "", durationMs: 120 })),
    frozen: (run.brief?.frozen ?? []).map((path) => ({ path, unchanged: true })),
    worker: null,
    checks: [],
    verified: true,
    steps: [{ label: "prepare", exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false, persisted: true, durationMs: 900, status: "SUCCESS", usage: null, stdoutTail: "", stderrTail: "" }],
    proposal: { hash: TASK_HASH, patchSha256: "6".repeat(64), patchBytes: 10, files: 1 },
    reportSha256: "7".repeat(64),
    cleanup: null,
    route: null,
    request: { runId, clientRequestId: run.clientRequestId },
    updatedAt: now,
    finishedAt: now,
  };
};
/** An apply as an engine reports one: the change written in place, its original kept aside. */
const appliedView = (requestId, runId) => {
  const now = new Date().toISOString();
  const applyId = randomUUID();
  return {
    applyId,
    requestId,
    runId,
    proposalHash: TASK_HASH,
    status: "applied",
    refusal: null,
    paths: [{ path: "greet.sh", change: "changed", place: "post", found: { kind: "file", mode: "100644", size: 10 }, kept: ["orig-0"], changedSince: false }],
    folders: [],
    recovery: `nivra-apply/${applyId}`,
    failure: null,
    resolution: null,
    createdAt: now,
    updatedAt: now,
  };
};
const accepted = (clientRequestId) => {
  if (!existsSync(join(home, "accepted.log"))) return null;
  const line = readFileSync(join(home, "accepted.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${clientRequestId} `));
  return line ? line.split(" ")[1] : null;
};
/** A review's report as an engine keeps one, repeating what the review was asked for. */
/** A coaching's report, bound to what its request was: complete, with one change to the goal (NIV-53). */
const coachReport = (runId) => {
  const line = existsSync(join(home, "coaches.log")) ? readFileSync(join(home, "coaches.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${runId} `)) : undefined;
  if (!line) return null;
  const { clientRequestId, input } = JSON.parse(line.slice(runId.length + 1));
  const now = new Date().toISOString();
  return {
    profile: input.profile,
    instructionsSha256: "a".repeat(64),
    taskId: input.taskId,
    briefVersion: input.briefVersion,
    bindingDigest: input.bindingDigest,
    packetDigest: input.packetDigest,
    preferencesDigest: input.preferencesDigest,
    outcome: "complete",
    scope: "general",
    packet: { chars: 100, criteria: 1, assumptions: 0, gaps: 0, mission: false, findings: 0 },
    summary: "A gated coaching.",
    questions: [],
    changes: [{ field: "goal", text: "A gated goal", reason: "", refs: [], usable: true }],
    suggestedChecks: [],
    unknowns: [],
    dropped: { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 },
    stage: { status: "answered", reason: null, kind: null, message: null, problems: [], requests: 1, estimatedInputTokens: 100, inputTokens: null, outputTokens: null, elapsedMs: 10, finishReason: null, servedModel: null },
    request: { runId, clientRequestId },
    route: null,
    sampling: { temperature: null, topP: null, maxOutputTokens: 4000, toolChoice: "forced" },
    preferences: { revision: 0, digest: input.preferencesDigest, records: [] },
    usage: { inputTokens: null, outputTokens: null, calls: 1, reportedCalls: 0 },
    budget: { limits: { requests: 1, totalMs: 180000, outputTokensPerRequest: 4000, estimatedInputTokens: 60000 }, used: { requests: 1, elapsedMs: 10, inputTokens: 100, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 1, overrunTokens: 0 }, stopped: null },
    elapsedMs: 10,
    updatedAt: now,
    finishedAt: now,
  };
};

const reviewReport = (runId) => {
  const line = existsSync(join(home, "reviews.log")) ? readFileSync(join(home, "reviews.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${runId} `)) : undefined;
  if (!line) return null;
  const { clientRequestId, input } = JSON.parse(line.slice(runId.length + 1));
  const now = new Date().toISOString();
  const adjusted = { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 };
  return {
    panel: input.panel ?? "council",
    planId: input.planId,
    planVersion: existsSync(join(home, "wrong-report")) ? input.planVersion + 1 : input.planVersion,
    packetDigest: input.packetDigest,
    preferencesDigest: input.preferencesDigest,
    outcome: cancelled.has(runId) ? "cancelled" : "complete",
    scope: { kind: "general" },
    packet: { textChars: 1, assumptions: 0, references: 0 },
    request: { runId, clientRequestId },
    route: null,
    sampling: { temperature: null, topP: null, maxOutputTokens: 4000, toolChoice: "forced" },
    preferences: { revision: 0, digest: "gated", records: [] },
    reviewers: [{ role: "architecture", summary: "A gated review.", findings: [], assumptions: [], gaps: [], adjusted }],
    synthesis: null,
    stages: [],
    usage: { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 },
    budget: {
      limits: { requests: 3, totalMs: 330000, outputTokensPerRequest: 4000, estimatedInputTokens: 120000 },
      used: { requests: 0, elapsedMs: 0, inputTokens: 0, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 0, overrunTokens: 0 },
      stopped: null,
    },
    elapsedMs: 0,
    updatedAt: now,
    finishedAt: now,
  };
};
/** A research report as an engine keeps one, repeating what the research was bound to. */
const researchReport = (runId) => {
  const line = existsSync(join(home, "research.log")) ? readFileSync(join(home, "research.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${runId} `)) : undefined;
  if (!line) return null;
  const { clientRequestId, input, packet } = JSON.parse(line.slice(runId.length + 1));
  const now = new Date().toISOString();
  const stopped = cancelled.has(runId);
  return {
    planId: input.planId,
    planVersion: input.planVersion,
    packetDigest: input.packetDigest,
    outcome: stopped ? "cancelled" : "complete",
    scope: packet.scope,
    request: { runId, clientRequestId },
    route: null,
    queries: packet.assumptions.map(({ id, text, query }) => ({ assumption: id, text, query })),
    sites: packet.sites,
    requests: [],
    pages: [],
    passages: [],
    assessments: [],
    checks: { citations: 0, valid: 0, relabelled: 0 },
    attribution: null,
    stop: stopped ? { code: "cancelled", message: "Cancelled." } : null,
    usage: { credits: null, model: { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 } },
    budget: null,
    elapsedMs: 0,
    updatedAt: now,
    finishedAt: now,
  };
};
/** The answers to runs.cancel held while a `hold-cancel` file exists, given in the order they came once released. */
const heldCancels = [];
setInterval(() => {
  if (heldCancels.length && existsSync(join(home, "release-cancel"))) for (const answer of heldCancels.splice(0)) answer();
}, 25).unref();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(join(home, "calls.log"), `${request.method}\n`);
    if (request.method === "initialize") {
      nebiusProject = request.params.secrets?.NEBIUS_PROJECT_ID ?? null;
      send({ id: request.id, result: { protocolVersion: 23, engineVersion: "gated", instanceId, pid: process.pid, home, homeId, runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch } });
    } else if (request.method === "ping") {
      send({ id: request.id, result: { instanceId } });
    } else if (request.method === "runs.start") {
      const runId = randomUUID();
      if (existsSync(join(home, "accept"))) appendFileSync(join(home, "accepted.log"), `${request.params.clientRequestId} ${runId}\n`);
      if (request.params.workflowId === "review") appendFileSync(join(home, "reviews.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input })}\n`);
      if (request.params.workflowId === "task") appendFileSync(join(home, "tasks.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input, brief: request.params.context.brief })}\n`);
      if (request.params.workflowId === "environment") {
        appendFileSync(join(home, "environments.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input, context: request.params.context })}\n`);
      }
      if (request.params.workflowId === "coach") appendFileSync(join(home, "coaches.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input })}\n`);
      if (request.params.workflowId === "research") {
        appendFileSync(join(home, "research.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input, packet: request.params.context.packet })}\n`);
      }
      const held = setInterval(() => {
        if (!existsSync(join(home, "release"))) return;
        clearInterval(held);
        if (existsSync(join(home, "error-start"))) send({ id: request.id, error: { code: -32603, message: existsSync(join(home, "accept")) ? "the engine failed after accepting the run" : "The engine refused the run." } });
        else send({ id: request.id, result: summary("running", runId, request.params.workflowId) });
      }, 25);
    } else if (request.method === "runs.find") {
      const answer = () => {
        const runId = accepted(request.params.clientRequestId);
        send({ id: request.id, result: runId ? (cancelled.has(runId) ? { ...summary("cancelled", runId, "chat"), finishedAt: new Date().toISOString() } : summary("running", runId, "chat")) : null });
      };
      if (!existsSync(join(home, "hold-find"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-find"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "runs.get") {
      const failedPreparation = preparation(request.params.runId) !== null && environmentOutcome() !== "prepared" && !existsSync(join(home, "environment-run-succeeds"));
      const status = cancelled.has(request.params.runId) ? "cancelled" : existsSync(join(home, "running")) ? "running" : failedPreparation ? "failed" : "succeeded";
      if (existsSync(join(home, "fail-get"))) send({ id: request.id, error: { code: -32603, message: "the run couldn't be read" } });
      else send({ id: request.id, result: { ...summary(status), id: request.params.runId, finishedAt: status === "running" ? null : new Date().toISOString() } });
    } else if (request.method === "runs.reply") {
      const record = { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "gated" };
      send({ id: request.id, result: { kind: "general", text: "A gated reply.", cutOff: false, context: { preferences: { revision: 0, digest: "gated", records: [] }, history: record }, finishedAt: new Date().toISOString() } });
    } else if (request.method === "runs.review") {
      send({ id: request.id, result: reviewReport(request.params.runId) });
    } else if (request.method === "runs.coach") {
      send({ id: request.id, result: coachReport(request.params.runId) });
    } else if (request.method === "runs.research") {
      send({ id: request.id, result: researchReport(request.params.runId) });
    } else if (request.method === "runs.sandbox") {
      send({ id: request.id, result: null });
    } else if (request.method === "runs.environment") {
      send({ id: request.id, result: environmentReport(request.params.runId) });
    } else if (request.method === "environment.resolve") {
      appendFileSync(join(home, "env-resolves.log"), `${JSON.stringify(request.params)}\n`);
      const { choices } = request.params;
      const recipe = recipeFor(choices);
      const rows = rowsFor(choices, recipe);
      const unknown = choices.scope?.kind === "packages" ? choices.scope.packages.find((folder) => !factsFor().packages.some((item) => item.folder === folder)) : undefined;
      if (unknown !== undefined) {
        send({ id: request.id, result: { status: "refused", code: "scope", message: `${JSON.stringify(unknown)} isn't one of this workspace's packages at this commit: it may have been moved or removed. Untick it, or install the whole project, then preview again.`, rows: [], workspace: factsFor() } });
      } else if (existsSync(join(home, "env-refused"))) {
        send({ id: request.id, result: { status: "refused", code: "unsupported-manager", message: "This project installs with yarn, which Nivra doesn't prepare yet. Use npm or pnpm, then preview the environment again.", rows } });
      } else if (existsSync(join(home, "env-needs-choice")) && !choices.runtime) {
        const options = ["24.21.0", "22.23.4"].map((value) => ({ value, label: `Node ${value}`, note: null }));
        send({ id: request.id, result: { status: "needs-choice", rows, choices: [{ id: "runtime", why: "conflict", message: ".nvmrc pins Node 24.21.0, and .node-version pins 22.23.4. Choose the one this project uses.", declarations: [{ file: ".nvmrc", field: null, value: "24.21.0" }, { file: ".node-version", field: null, value: "22.23.4" }], options }], warnings: [], limitations: [], workspace: factsFor() } });
      } else {
        send({ id: request.id, result: { status: "ready", rows, recipe, warnings: [], limitations: [], workspace: factsFor(), recipeDigest: digestOf(recipe), baseline: "a".repeat(40), sentBytes: 900, leftOut: [".npmrc"], retention: "Images are retained for 180 days.", fingerprint: sha256(JSON.stringify([choices, existsSync(join(home, "env-changed"))])) } });
      }
    } else if (request.method === "runs.events") {
      send({ id: request.id, result: { events: [], next: request.params.after ?? 0, status: cancelled.has(request.params.runId) ? "cancelled" : "succeeded" } });
    } else if (request.method === "runs.result") {
      const answer = () =>
        send({
          id: request.id,
          result: {
            question: "",
            headAtStart: null,
            headAtEnd: null,
            summary: "A gated result.",
            findings: [],
            suggestions: [{ statement: "Name component files in PascalCase.", citations: [] }],
            gaps: [],
            context: { map: [], reads: [], searches: 0, searchHits: 0, chars: 0, changedFiles: [] },
            checks: { citations: 0, checked: 0 },
            answeredAtStep: 0,
            finishedAt: new Date().toISOString(),
          },
        });
      if (!existsSync(join(home, "hold-result"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-result"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "runs.cancel") {
      const answer = () => {
        const once = existsSync(join(home, "fail-cancel-once"));
        if (once) rmSync(join(home, "fail-cancel-once"));
        const named = existsSync(join(home, "fail-cancel-for")) && readFileSync(join(home, "fail-cancel-for"), "utf8") === request.params.runId;
        if (once || named || existsSync(join(home, "fail-cancel"))) send({ id: request.id, error: { code: -32000, message: "the run couldn't be stopped" } });
        else {
          cancelled.add(request.params.runId);
          appendFileSync(join(home, "cancelled.log"), `${request.params.runId}\n`);
          send({ id: request.id, result: { status: "cancelled", wasTerminal: false } });
        }
      };
      if (!existsSync(join(home, "hold-cancel"))) answer();
      else heldCancels.push(answer);
    } else if (request.method === "runs.task" && existsSync(join(home, "task-report"))) {
      send({ id: request.id, result: taskReport(request.params.runId) });
    } else if (request.method === "runs.proposal" && existsSync(join(home, "task-report"))) {
      const sha = "8".repeat(64);
      send({
        id: request.id,
        result: { hash: TASK_HASH, baseline: "a".repeat(40), prefix: "", paths: [{ path: "greet.sh", change: "changed", before: { mode: "100644", sha256: sha }, after: { mode: "100644", sha256: "9".repeat(64) } }], patch: "--- a/greet.sh\n+++ b/greet.sh\n", patchBytes: 30, truncated: false },
      });
    } else if (request.method === "task.preview") {
      appendFileSync(join(home, "task-previews.log"), `${JSON.stringify(request.params)}\n`);
      const none = { count: 0, sample: [] };
      const baselineChecks = request.params.brief.baseline?.length ?? 0;
      send({
        id: request.id,
        result: {
          status: "ready",
          snapshot: { baseline: "a".repeat(40), prefix: "", files: 2, bytes: 3072, leftOut: { secret: none, output: none, submodule: none, excluded: none }, untracked: none, lfsPointers: 0, fingerprint: "c".repeat(64), retention: "Images are retained for 180 days." },
          programs: ["."],
          unprobed: 0,
          caseFiles: [],
          environment: request.params.environment?.format ? null : (request.params.environment ?? null),
          environmentRef: request.params.environment?.format ? request.params.environment : null,
          frozen: (request.params.brief.frozen ?? []).map((path) => ({ path, sha256: sha256(path) })),
          limits: { modelRequests: 12, requestSeconds: 150, outputTokensPerRequest: 8000, estimatedInputTokens: 160000, toolCalls: 24, writes: 8, writeBytes: 32768, runs: 4, baselineChecks, operations: 17 + baselineChecks, checkSeconds: 60, sessionMinutes: 20, runMinutes: 33 },
        },
      });
    } else if (request.method === "task.admission") {
      const denied = existsSync(join(home, "deny-admission"));
      send({ id: request.id, result: { eligible: !denied, reason: denied ? "Required repository check 1 wasn't shown to pass, so this change can't be approved. Reject it, or request a revision." : null, proposalHash: request.params.approvedHash, reportSha256: "a".repeat(64), legacy: true } });
    } else if (request.method === "task.apply") {
      const { requestId, runId } = request.params;
      const known = logged("applies.log", requestId);
      const partial = existsSync(join(home, "partial-apply"));
      const aside = { path: "README.md", change: "changed", place: "aside", found: { kind: "absent", mode: null, size: null }, kept: ["orig-1"], changedSince: false };
      const fresh = appliedView(requestId, runId);
      const view = known ?? { ...fresh, ...(partial ? { status: "partial" } : {}), ...(partial && existsSync(join(home, "aside-apply")) ? { paths: [...fresh.paths, aside] } : {}) };
      if (!known && !existsSync(join(home, "refuse-apply"))) appendFileSync(join(home, "applies.log"), `${requestId} ${JSON.stringify(view)}\n`);
      const answer = () => {
        if (existsSync(join(home, "error-apply"))) send({ id: request.id, error: { code: -32603, message: "the engine failed while it applied the change" } });
        else if (existsSync(join(home, "refuse-apply"))) send({ id: request.id, error: { code: -32602, message: "This engine has no proposal for that run, so nothing was written. Run the task again." } });
        else send({ id: request.id, result: view });
      };
      if (!existsSync(join(home, "hold-apply"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-apply"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "task.applyStatus") {
      send({ id: request.id, result: logged("applies.log", request.params.requestId) });
    } else if (request.method === "task.dismiss" || request.method === "task.restore") {
      const file = join(home, "applies.log");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      const at = lines.findIndex((entry) => JSON.parse(entry.slice(entry.indexOf(" ") + 1)).applyId === request.params.applyId);
      const updatedAt = new Date().toISOString();
      if (at < 0) send({ id: request.id, error: { code: -32602, message: "This engine has no apply by that id." } });
      else {
        const line = JSON.parse(lines[at].slice(lines[at].indexOf(" ") + 1));
        const next = request.method === "task.restore" ? { ...line, status: "not-applied", paths: line.paths.map((path) => ({ ...path, place: "pre", found: { kind: "file", mode: "100644", size: 10 } })), updatedAt } : { ...line, resolution: request.params.as, updatedAt };
        // Kept, as an engine keeps it: a later applyStatus reads it.
        lines[at] = `${line.requestId} ${JSON.stringify(next)}`;
        writeFileSync(file, `${lines.join("\n")}\n`);
        if (existsSync(join(home, "hold-settle"))) {
          // Done and kept, and the answer never comes: as an engine stopped before it could reply.
        } else if (existsSync(join(home, "error-settle"))) send({ id: request.id, error: { code: -32603, message: "the engine failed after it settled the change" } });
        else send({ id: request.id, result: next });
      }
    } else if (request.method === "secrets.update") {
      if (request.params.set?.NEBIUS_PROJECT_ID) nebiusProject = request.params.set.NEBIUS_PROJECT_ID;
      if (request.params.remove?.includes("NEBIUS_PROJECT_ID")) nebiusProject = null;
      send({ id: request.id, result: { ok: true } });
    } else if (request.method === "shutdown") {
      send({ id: request.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 10);
    } else {
      send({ id: request.id, error: { code: -32601, message: `The gated engine doesn't stand in for ${request.method}.` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
