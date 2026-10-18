// The live acceptance record (NIV-14): every check with its outcome and attempt, every run's numbers, and the public
// summary built from them. The summary is built from listed fields only: of the private fixture B, nothing reaches it
// but numbers, booleans and fixed values. `findLeaks` then looks for B's own identifiers in what would be published,
// as a second check. A check's id comes only from CHECKS, which ties it to an acceptance criterion and says whether it
// is strict (engine or host behaviour that must hold), required (a demonstration that depends on the model and gates
// acceptance) or optional (exact wording, recorded only). Pure functions, unit-tested.

export type Outcome = "pass" | "fail" | "incomplete" | "not-run";
export type Fixture = "A" | "B" | "fresh" | "none";
export type Kind = "strict" | "required" | "optional";

export const CRITERIA = {
  identity: "The build under test is the candidate: its hashes, versions and runtimes",
  handoff: "Every run receives exactly the app's current preferences, at the fixture's HEAD, through Token Factory",
  "evidence-a": "Explaining A rests on lines the model was shown",
  preferences: "A personal and an A-only preference are confirmed",
  "contrast-b": "On B the repository governs over the personal default, and A's own never reaches B",
  "task-choice": "A task choice governs that run, Currently stays the repository's, and nothing stored changes",
  lifecycle: "Edits, replacements and deletions reach the next request",
  freshness: "A changed file reaches the next request",
  consent: "Refusing or withdrawing consent sends nothing further",
  cancel: "Cancelling ends a run as cancelled",
  "provider-failure": "A provider failure is named, with no chat request",
  "engine-restart": "A restarted or killed engine leaves a truthful final state, and nothing is replayed",
  "app-restart": "The app comes back with its profile intact and no run left running",
  cleanup: "The key is removed, the engines are gone, the profiles are deleted and the home is restored",
} as const;
export type Criterion = keyof typeof CRITERIA;

/** Every check the harness can record. */
export const CHECKS = {
  "identity.sums": ["identity", "strict"],
  "identity.package": ["identity", "strict"],
  "identity.app": ["identity", "strict"],
  "identity.runtime": ["identity", "strict"],
  "identity.app-info": ["identity", "strict"],
  "identity.engine": ["identity", "strict"],
  "identity.provisioned": ["identity", "strict"],
  "identity.no-native-engine": ["identity", "strict"],
  "handoff.snapshot": ["handoff", "strict"],
  "handoff.route": ["handoff", "strict"],
  "handoff.head": ["handoff", "strict"],
  "consent.refused": ["consent", "strict"],
  "consent.refused-bridge": ["consent", "strict"],
  "consent.withdrawn": ["consent", "strict"],
  "cancel.held": ["cancel", "strict"],
  "cancel.live": ["cancel", "strict"],
  "provider.no-key": ["provider-failure", "strict"],
  "provider.bad-key": ["provider-failure", "strict"],
  "provider.network": ["provider-failure", "optional"],
  "provider.check": ["provider-failure", "strict"],
  "engine.graceful-held": ["engine-restart", "strict"],
  "engine.kill-held": ["engine-restart", "strict"],
  "engine.graceful-live": ["engine-restart", "strict"],
  "engine.kill-live": ["engine-restart", "strict"],
  "app.closed-run": ["app-restart", "strict"],
  "app.no-running": ["app-restart", "strict"],
  "app.intact": ["app-restart", "strict"],
  "app.old-run-unknown": ["app-restart", "strict"],
  "app.live-after": ["app-restart", "strict"],
  "a.explain": ["evidence-a", "strict"],
  "a.checked-citations": ["evidence-a", "required"],
  "prefs.confirmed": ["preferences", "strict"],
  "b.privacy-gate": ["contrast-b", "strict"],
  "b.explain": ["contrast-b", "strict"],
  "b.isolation": ["contrast-b", "strict"],
  "b.ranking": ["contrast-b", "strict"],
  "b.repository-governs": ["contrast-b", "required"],
  "choice.explain": ["task-choice", "strict"],
  "choice.store-unchanged": ["task-choice", "strict"],
  "choice.ranking": ["task-choice", "strict"],
  "choice.governs": ["task-choice", "required"],
  "life.edit": ["lifecycle", "strict"],
  "life.replace": ["lifecycle", "strict"],
  "life.delete": ["lifecycle", "strict"],
  "life.wording": ["lifecycle", "optional"],
  "fresh.map-changed": ["freshness", "strict"],
  "fresh.name-seen": ["freshness", "optional"],
  "cleanup.key-removed": ["cleanup", "strict"],
  "cleanup.engines-exited": ["cleanup", "strict"],
  "cleanup.profiles-deleted": ["cleanup", "strict"],
  "cleanup.home-restored": ["cleanup", "strict"],
} as const satisfies Record<string, readonly [Criterion, Kind]>;
export type CheckId = keyof typeof CHECKS;

export interface CheckEntry {
  id: CheckId;
  outcome: Outcome;
  attempt: number;
  fixture: Fixture;
  /** Milliseconds from the session's start. */
  at: number;
  /** For the private record only: it may name B. */
  detail: string;
}

export const PURPOSES = [
  "explain",
  "hello",
  "choice",
  "edit",
  "replace",
  "delete",
  "fresh",
  "withdraw",
  "cancel",
  "graceful-restart",
  "kill",
  "app-restart",
  "after-restart",
  "network",
  "bad-key",
  "no-key",
] as const;
export type Purpose = (typeof PURPOSES)[number];

export interface RunEntry {
  runId: string;
  fixture: Fixture;
  purpose: Purpose;
  attempt: number;
  status: string;
  failureKind: string | null;
  model: string | null;
  endpoint: string | null;
  durationMs: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null; calls: number | null; reportedCalls: number | null } | null;
  citations: { total: number; checked: number } | null;
  /** Reported conflicts by the reason that governs them. */
  conflicts: Partial<Record<string, number>> | null;
  suggestions: number | null;
  refusals: { citations: number; conflicts: number; schema: number } | null;
  preferences: { count: number; revision: number } | null;
}

export interface FixtureFacts {
  name: string;
  head: string;
  dirty: number;
  tracked: number;
  /** Counted from the files, without a model: so the contrast is shown to be real. */
  conventions: { pascalTsx: number; kebabTsx: number; vitest: boolean; jest: boolean };
}

export interface AcceptanceRecord {
  platform: "linux" | "windows";
  session: "rehearsal" | "live";
  startedAt: string;
  build: {
    version: string;
    commit: string;
    clean: boolean;
    artefacts: Array<{ name: string; sha256: string }>;
    runtimes: Array<{ target: string; contentHash: string }>;
  } | null;
  /** The commit this harness ran from: it may be later than the candidate's, which only the app's files decide. */
  harness: { commit: string; clean: boolean };
  machine: Record<string, string | number | null>;
  fixtures: Partial<Record<"A" | "B", FixtureFacts>>;
  checks: CheckEntry[];
  runs: RunEntry[];
  /** The commands run, with private paths already replaced by placeholders. */
  commands: string[];
}

/** B's identifiers, kept privately and used only to look for them in what would be published. */
export interface PrivateIdentifiers {
  paths: string[];
  label: string;
  name: string;
  remote: string | null;
  head: string;
}

const FIXTURES: ReadonlySet<string> = new Set<Fixture>(["A", "B", "fresh", "none"]);
const OUTCOMES: ReadonlySet<string> = new Set<Outcome>(["pass", "fail", "incomplete", "not-run"]);
const RUN_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "missed"]);
const FAILURE_KINDS = new Set([
  "sharing-refused",
  "no-key",
  "context-too-small",
  "auth",
  "rate-limit",
  "model-unavailable",
  "provider",
  "bad-request",
  "bad-response",
  "network",
  "timeout",
  "malformed",
  "cancelled",
  "internal",
]);
const ENDPOINTS = new Set(["token-factory", "loopback-test"]);
const REASONS = new Set(["choice", "override", "repository", "project-default", "personal-default", "unresolved"]);
const MACHINE_KEYS = [
  "windowsBuild",
  "windowsVersion",
  "windowsCpu",
  "windowsRamGiB",
  "wslVersion",
  "wslNetworking",
  "wslg",
  "distro",
  "kernel",
  "linuxCpu",
  "linuxRamGiB",
  "deb",
  "chromeSandbox",
  "electron",
  "chrome",
  "appNode",
  "engineNode",
] as const;
const MODEL = /^nvidia\/[\w.-]+$/;
const HEX = /^[0-9a-f]{7,64}$/;

const fixed = (value: string | null, allowed: ReadonlySet<string>) => (value !== null && allowed.has(value) ? value : value === null ? null : "unrecognised");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const hex = (value: string) => (HEX.test(value) ? value : "unrecognised");

/** The outcome of each check after its last attempt. Attempts are numbered from 1. */
export function finalOutcomes(checks: readonly CheckEntry[]): Map<string, CheckEntry> {
  const last = new Map<string, CheckEntry>();
  for (const check of checks) {
    const key = `${check.id}|${check.fixture}`;
    const seen = last.get(key);
    if (!seen || check.attempt >= seen.attempt) last.set(key, check);
  }
  return last;
}

/**
 * Each criterion's outcome: `fail` when a strict or required check failed, `incomplete` when one is still incomplete or
 * wasn't run, `pass` when every one passed on its last attempt, `not-run` when the session recorded none. Optional
 * checks never change it.
 */
export function criteriaOutcomes(checks: readonly CheckEntry[]): Record<Criterion, Outcome> {
  const outcomes = Object.fromEntries(Object.keys(CRITERIA).map((criterion) => [criterion, "not-run"])) as Record<Criterion, Outcome>;
  const finals = [...finalOutcomes(checks).values()];
  for (const criterion of Object.keys(CRITERIA) as Criterion[]) {
    const gating = finals.filter((check) => CHECKS[check.id][0] === criterion && CHECKS[check.id][1] !== "optional");
    if (!gating.length) continue;
    outcomes[criterion] = gating.some((c) => c.outcome === "fail") ? "fail" : gating.every((c) => c.outcome === "pass") ? "pass" : "incomplete";
  }
  return outcomes;
}

export interface PublicSummary {
  platform: "linux" | "windows";
  session: "rehearsal" | "live";
  startedAt: string;
  build: AcceptanceRecord["build"];
  harness: AcceptanceRecord["harness"];
  machine: Partial<Record<(typeof MACHINE_KEYS)[number], string | number | null>>;
  fixtures: {
    A: FixtureFacts | null;
    B: { dirty: number; tracked: number; conventions: FixtureFacts["conventions"] } | null;
  };
  criteria: Array<{ criterion: Criterion; outcome: Outcome; checks: number; attempts: number }>;
  checks: Array<{ id: CheckId; criterion: Criterion; kind: Kind; fixture: Fixture; attempt: number; outcome: Outcome }>;
  runs: Array<Omit<RunEntry, "runId">>;
  totals: { runs: number; attempts: number; inputTokens: number | null; outputTokens: number | null; calls: number; durationMs: number };
  commands: string[];
}

/** The summary that may be published: built field by field from the record, never copied from it. */
export function publicSummary(record: AcceptanceRecord): PublicSummary {
  const criteria = criteriaOutcomes(record.checks);
  const facts = (f: FixtureFacts): FixtureFacts["conventions"] => ({
    pascalTsx: num(f.conventions.pascalTsx) ?? 0,
    kebabTsx: num(f.conventions.kebabTsx) ?? 0,
    vitest: f.conventions.vitest === true,
    jest: f.conventions.jest === true,
  });
  const a = record.fixtures.A;
  const b = record.fixtures.B;
  const runs = record.runs.map((run) => ({
    fixture: FIXTURES.has(run.fixture) ? run.fixture : "none",
    purpose: (PURPOSES as readonly string[]).includes(run.purpose) ? run.purpose : "explain",
    attempt: num(run.attempt) ?? 1,
    status: fixed(run.status, RUN_STATUSES) ?? "unrecognised",
    failureKind: fixed(run.failureKind, FAILURE_KINDS),
    model: run.model === null ? null : MODEL.test(run.model) ? run.model : "unrecognised",
    endpoint: fixed(run.endpoint, ENDPOINTS),
    durationMs: num(run.durationMs),
    usage: run.usage
      ? { inputTokens: num(run.usage.inputTokens), outputTokens: num(run.usage.outputTokens), calls: num(run.usage.calls), reportedCalls: num(run.usage.reportedCalls) }
      : null,
    citations: run.citations ? { total: num(run.citations.total) ?? 0, checked: num(run.citations.checked) ?? 0 } : null,
    conflicts: run.conflicts
      ? Object.fromEntries(Object.entries(run.conflicts).flatMap(([reason, count]) => (REASONS.has(reason) && num(count) !== null ? [[reason, count]] : [])))
      : null,
    suggestions: num(run.suggestions),
    refusals: run.refusals ? { citations: num(run.refusals.citations) ?? 0, conflicts: num(run.refusals.conflicts) ?? 0, schema: num(run.refusals.schema) ?? 0 } : null,
    preferences: run.preferences ? { count: num(run.preferences.count) ?? 0, revision: num(run.preferences.revision) ?? 0 } : null,
  })) as PublicSummary["runs"];
  const sum = (pick: (run: PublicSummary["runs"][number]) => number | null) => {
    const values = runs.map(pick);
    return values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + value!, 0) : null;
  };
  return {
    platform: record.platform === "windows" ? "windows" : "linux",
    session: record.session === "rehearsal" ? "rehearsal" : "live",
    startedAt: new Date(Date.parse(record.startedAt)).toISOString(),
    build: record.build
      ? {
          version: /^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(record.build.version) ? record.build.version : "unrecognised",
          commit: hex(record.build.commit),
          clean: record.build.clean === true,
          artefacts: record.build.artefacts.map((artefact) => ({ name: /^[\w.-]+$/.test(artefact.name) ? artefact.name : "unrecognised", sha256: hex(artefact.sha256) })),
          runtimes: record.build.runtimes.map((runtime) => ({ target: /^[\w-]+$/.test(runtime.target) ? runtime.target : "unrecognised", contentHash: hex(runtime.contentHash) })),
        }
      : null,
    harness: { commit: hex(record.harness.commit), clean: record.harness.clean === true },
    machine: Object.fromEntries(MACHINE_KEYS.flatMap((key) => (key in record.machine ? [[key, record.machine[key] ?? null]] : []))),
    fixtures: {
      A: a ? { name: a.name, head: hex(a.head), dirty: num(a.dirty) ?? 0, tracked: num(a.tracked) ?? 0, conventions: facts(a) } : null,
      B: b ? { dirty: num(b.dirty) ?? 0, tracked: num(b.tracked) ?? 0, conventions: facts(b) } : null,
    },
    criteria: (Object.keys(CRITERIA) as Criterion[]).map((criterion) => {
      const own = record.checks.filter((check) => CHECKS[check.id]?.[0] === criterion);
      return { criterion, outcome: criteria[criterion], checks: new Set(own.map((check) => `${check.id}|${check.fixture}`)).size, attempts: own.length };
    }),
    checks: record.checks
      .filter((check) => check.id in CHECKS)
      .map((check) => ({
        id: check.id,
        criterion: CHECKS[check.id][0],
        kind: CHECKS[check.id][1],
        fixture: FIXTURES.has(check.fixture) ? check.fixture : "none",
        attempt: num(check.attempt) ?? 1,
        outcome: OUTCOMES.has(check.outcome) ? check.outcome : "fail",
      })),
    runs,
    totals: {
      runs: new Set(record.runs.map((run) => run.runId)).size,
      attempts: runs.length,
      // A run with no usage made no model call; one whose tokens weren't reported makes the total unknown.
      inputTokens: sum((run) => (run.usage ? run.usage.inputTokens : 0)),
      outputTokens: sum((run) => (run.usage ? run.usage.outputTokens : 0)),
      calls: runs.reduce((total, run) => total + (run.usage?.calls ?? 0), 0),
      durationMs: runs.reduce((total, run) => total + (run.durationMs ?? 0), 0),
    },
    commands: record.commands.map(String),
  };
}

/**
 * B's identifiers found in text that would be published, by kind (never the value). Paths are looked for as written,
 * with either slash, and JSON-escaped; the label and name as whole words; the HEAD in full and as the short forms Git
 * and Nivra print. Labels under four characters are left to the allowlist: as words they'd match ordinary text.
 */
export function findLeaks(text: string, ids: PrivateIdentifiers): string[] {
  const found = new Set<string>();
  const json = (value: string) => JSON.stringify(value).slice(1, -1);
  for (const path of ids.paths) {
    for (const form of [path, path.replace(/\//g, "\\"), path.replace(/\\/g, "/")]) {
      if (text.includes(form) || text.includes(json(form))) found.add("path");
    }
  }
  const word = (value: string) => new RegExp(`(^|[^\\w-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`, "u");
  for (const [kind, value] of [["label", ids.label], ["name", ids.name]] as const) {
    if (value.length >= 4 && word(value).test(text)) found.add(kind);
  }
  if (ids.remote) {
    for (const form of [ids.remote, ids.remote.replace(/\.git$/, ""), ids.remote.replace(/^\w+:\/\/|^git@/, "").replace(/\.git$/, "")]) {
      if (form.length >= 8 && text.includes(form)) found.add("remote");
    }
  }
  for (const length of [7, 12, 40]) {
    const prefix = ids.head.slice(0, length);
    if (prefix.length >= 7 && text.includes(prefix)) found.add("head");
  }
  return [...found].sort();
}

const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const count = (value: number | null) => (value === null ? "not reported" : value.toLocaleString("en-GB"));

/** The public summary as Markdown, for docs/acceptance.md and the ticket. */
export function renderMarkdown(summary: PublicSummary): string {
  const lines = [
    `## ${summary.platform === "windows" ? "Windows → WSL" : "Linux"}, ${summary.session} session, ${summary.startedAt}`,
    "",
    summary.build
      ? `Build ${summary.build.version} at \`${summary.build.commit}\`${summary.build.clean ? "" : " (with uncommitted changes)"}; ${summary.build.artefacts.map((a) => `\`${a.name}\` sha256 \`${a.sha256}\``).join(", ")}; runtimes ${summary.build.runtimes.map((r) => `${r.target} \`${r.contentHash}\``).join(", ")}.`
      : "Build: not recorded.",
    `Harness at \`${summary.harness.commit}\`${summary.harness.clean ? "" : " (with uncommitted changes)"}.`,
    "",
    `Machine: ${Object.entries(summary.machine).map(([key, value]) => `${key} ${value ?? "unknown"}`).join("; ")}.`,
    "",
    summary.fixtures.A ? `Fixture A: \`${summary.fixtures.A.name}\` at \`${summary.fixtures.A.head}\`, ${summary.fixtures.A.tracked} tracked files, ${summary.fixtures.A.dirty} dirty entries.` : "Fixture A: not used.",
    summary.fixtures.B ? `Fixture B (private): ${summary.fixtures.B.tracked} tracked files, ${summary.fixtures.B.dirty} dirty entries.` : "Fixture B: not used.",
    "",
    "| Criterion | Outcome | Checks | Attempts |",
    "|---|---|---|---|",
    ...summary.criteria.map((c) => `| ${CRITERIA[c.criterion]} | **${c.outcome}** | ${c.checks} | ${c.attempts} |`),
    "",
    "| Fixture | Purpose | Attempt | Status | Kind | Model | Time | Tokens in / out | Calls | Citations shown | Conflicts |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.runs.map(
      (r) =>
        `| ${r.fixture} | ${r.purpose} | ${r.attempt} | ${r.status} | ${r.failureKind ?? "—"} | ${r.model ?? "—"} | ${seconds(r.durationMs)} | ${r.usage ? `${count(r.usage.inputTokens)} / ${count(r.usage.outputTokens)}` : "—"} | ${r.usage?.calls ?? "—"} | ${r.citations ? `${r.citations.checked} of ${r.citations.total}` : "—"} | ${r.conflicts ? Object.entries(r.conflicts).map(([reason, n]) => `${reason} ${n}`).join(", ") || "none" : "—"} |`,
    ),
    "",
    `Totals: ${summary.totals.runs} runs over ${summary.totals.attempts} attempts; ${count(summary.totals.inputTokens)} tokens in and ${count(summary.totals.outputTokens)} out over ${summary.totals.calls} calls; ${seconds(summary.totals.durationMs)} of run time. Failed and retried attempts are included.`,
    "",
    "Commands:",
    ...summary.commands.map((command) => `- \`${command}\``),
    "",
  ];
  return lines.join("\n");
}

/** The public summary and its Markdown, refused outright if any of B's identifiers would be published. */
export function publicFiles(record: AcceptanceRecord, ids: PrivateIdentifiers): { json: string; markdown: string } {
  const summary = publicSummary(record);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = renderMarkdown(summary);
  const leaks = findLeaks(`${json}\n${markdown}`, ids);
  if (leaks.length) throw new Error(`The public summary would hold B's ${leaks.join(", ")}, so nothing public was written. Find where it came from in the record.`);
  return { json, markdown };
}

const RANK: Readonly<Record<string, number>> = { choice: 1, override: 2, repository: 3, "project-default": 4, "personal-default": 5 };

/**
 * The reason a conflict should carry, worked out here from its stored sides, independently of the engine's code
 * (D23): the highest rank governs when one source holds it; two or more sources there are unresolved.
 */
export function expectedReason(conflict: {
  choices: readonly string[];
  preferences: ReadonlyArray<{ id: string; scope: string; intent: string }>;
  repositoryConvention: string | null;
  citations: ReadonlyArray<{ checked: boolean }>;
}): string {
  const sources = [
    ...[...new Set(conflict.choices)].map((id) => `choice:${id}`),
    ...[...new Map(conflict.preferences.map((p) => [p.id, p])).values()].map((p) => `${p.scope === "personal" ? "personal-default" : p.intent === "override" ? "override" : "project-default"}:${p.id}`),
    ...(conflict.repositoryConvention?.trim() && conflict.citations.some((citation) => citation.checked) ? ["repository:"] : []),
  ];
  const kind = (source: string) => source.slice(0, source.indexOf(":"));
  const top = Math.min(...sources.map((source) => RANK[kind(source)]!));
  const leaders = sources.filter((source) => RANK[kind(source)] === top);
  return leaders.length === 1 ? kind(leaders[0]!) : "unresolved";
}
