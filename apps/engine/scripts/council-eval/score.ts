import type { ReviewReport, RunStatus, RunSummary } from "@nivra/domain";
import { ARMS, FIXTURE_IDS, type Arm, type FixtureId, type Frozen, type Protocol, type Rubric } from "./files.ts";
import { matchedDefects } from "./match.ts";

/**
 * Scoring that doesn't trust the model (NIV-40, D32). Three passes: the rubric's automatic matching; a blinded sheet,
 * shuffled by the protocol's seed with the arms hidden, that a person confirms or corrects; and scores worked out from
 * that sheet alone, with the automatic-only scores beside them. Agreement between reviewers earns nothing: each known
 * defect counts once per fixture and arm, however many findings name it, and only reviewers' findings are scored.
 */

/** One run as the evaluation keeps it. */
export interface RunRecord {
  fixture: FixtureId;
  arm: Arm;
  clientRequestId: string;
  runId: string | null;
  /** The run's end, or `not-sent` when its store established it never ran, or `unknown` when that can't be told. */
  status: RunStatus | "not-sent" | "unknown";
  failureKind: string | null;
  summary: RunSummary | null;
  report: ReviewReport | null;
  /** Requests the run made, from its report's budget; null when it can't be told. */
  requests: number | null;
  events: number;
}

const SEVERE = new Set(["high", "medium"]);

/** A run reported when it ended with at least one reviewer's report. */
export const reported = (record: RunRecord | undefined): boolean => (record?.report?.reviewers.length ?? 0) > 0;
const complete = (record: RunRecord | undefined): boolean => record?.report?.outcome === "complete";
const tokensOf = (record: RunRecord | undefined): number | null => {
  const usage = record?.report?.usage ?? null;
  return usage && usage.inputTokens !== null && usage.outputTokens !== null ? usage.inputTokens + usage.outputTokens : null;
};

/** One line of the sheet: a reviewer's finding, or, for the control, a reviewer's summary. The arm is never on it. */
export interface SheetItem {
  item: string;
  fixture: FixtureId;
  kind: "finding" | "summary";
  /** What the labeller reads: a finding as the reviewer gave it, without its id (which would name the arm). */
  finding: { title: string; detail: string; recommendation: string; severity: string | null; basis: string; refs: string[] } | null;
  summary: string | null;
  automatic: { defects: string[] | null; material: boolean | null; actionable: boolean | null; substantive: boolean | null };
  /** Filled in by the labeller; null until then. */
  label: {
    /** The known defects it names, by id; [] for none. */
    defects: string[] | null;
    /** For a finding that names no known defect: whether it is a useful one, and a key that groups the same point. */
    novel: "useful" | "not-useful" | null;
    novelKey: string | null;
    unsupported: "none" | "U1" | "U3" | null;
    actionable: boolean | null;
    /** On the control only: whether a finding is a material problem (a false alarm), or a summary a substantive review. */
    material: boolean | null;
    substantive: boolean | null;
  };
}

export interface SheetKey {
  [item: string]: { fixture: FixtureId; arm: Arm; role: string; findingId: string | null };
}

/** A small seeded generator (mulberry32), so the same seed always gives the same shuffle. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The blinded sheet: every reviewer finding of every run, and each control run's reviewer summaries, shuffled by the
 * protocol's seed and numbered after shuffling, with the automatic pass's reading beside each. The key that says which
 * arm each line came from is kept apart.
 */
export function buildSheet(records: readonly RunRecord[], frozen: Frozen): { sheet: SheetItem[]; key: SheetKey } {
  const control = frozen.rubric.control.fixture;
  const lines: Array<{ item: Omit<SheetItem, "item">; key: SheetKey[string] }> = [];
  for (const record of records) {
    for (const reviewer of record.report?.reviewers ?? []) {
      for (const finding of reviewer.findings) {
        const defects = matchedDefects(finding, frozen.rubric.defects[record.fixture]);
        lines.push({
          item: {
            fixture: record.fixture,
            kind: "finding",
            finding: { title: finding.title, detail: finding.detail, recommendation: finding.recommendation, severity: finding.severity, basis: finding.basis, refs: finding.refs },
            summary: null,
            automatic: { defects, material: record.fixture === control ? SEVERE.has(finding.severity ?? "") : null, actionable: finding.recommendation.trim().length > 0, substantive: null },
            label: emptyLabel(),
          },
          key: { fixture: record.fixture, arm: record.arm, role: reviewer.role, findingId: finding.id },
        });
      }
      if (record.fixture === control) {
        lines.push({
          item: { fixture: record.fixture, kind: "summary", finding: null, summary: reviewer.summary, automatic: { defects: null, material: null, actionable: null, substantive: reviewer.summary.trim().length > 0 }, label: emptyLabel() },
          key: { fixture: record.fixture, arm: record.arm, role: reviewer.role, findingId: null },
        });
      }
    }
  }
  const random = seeded(frozen.protocol.seed);
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [lines[i], lines[j]] = [lines[j]!, lines[i]!];
  }
  const width = String(lines.length).length;
  const sheet: SheetItem[] = [];
  const key: SheetKey = {};
  lines.forEach((line, index) => {
    const item = `S${String(index + 1).padStart(width, "0")}`;
    sheet.push({ item, ...line.item });
    key[item] = line.key;
  });
  return { sheet, key };
}

const emptyLabel = (): SheetItem["label"] => ({ defects: null, novel: null, novelKey: null, unsupported: null, actionable: null, material: null, substantive: null });

/** The sheet's lines still missing a label the scores need, by item; empty when it is complete. */
export function missingLabels(sheet: readonly SheetItem[], rubric: Rubric): string[] {
  const control = rubric.control.fixture;
  return sheet
    .filter((line) => {
      const label = line.label;
      if (line.kind === "summary") return label.substantive === null;
      if (label.defects === null || label.unsupported === null || label.actionable === null) return true;
      if (line.fixture === control && label.material === null) return true;
      return label.defects.length === 0 && line.fixture !== control && (label.novel === null || (label.novel === "useful" && !label.novelKey));
    })
    .map((line) => line.item);
}

export interface ArmScores {
  /** Known defects found, each once per fixture: by fixture, and in all. */
  knownByFixture: Record<FixtureId, string[]>;
  known: number;
  /** Useful novel findings, each point once per fixture; null when nobody has judged them. */
  usefulNovel: number | null;
  /** Unsupported findings: U1 and U3 from the sheet (null when not judged), and U2, every reference the engine dropped. */
  unsupported: number | null;
  refsDropped: number;
  /** Material findings on the control. */
  falseAlarms: number;
  /** Whether the control's review was a substantive one that raised nothing material; null without a run that reported. */
  controlCorrect: boolean | null;
  complete: number;
  reported: FixtureId[];
  /** The share of findings that are actionable; null with no findings. */
  actionability: number | null;
  latencyMs: Record<FixtureId, number | null>;
  tokens: Record<FixtureId, number | null>;
  findings: number;
}

type Reading = "labelled" | "automatic";

/**
 * One arm's scores, from the labelled sheet or from the automatic pass alone. The automatic pass can't judge novelty,
 * U1 or U3, so those stay null there rather than becoming 0.
 */
export function armScores(arm: Arm, records: readonly RunRecord[], sheet: readonly SheetItem[], key: SheetKey, rubric: Rubric, reading: Reading): ArmScores {
  const control = rubric.control.fixture;
  const mine = sheet.filter((line) => key[line.item]?.arm === arm);
  const runs = new Map(records.filter((record) => record.arm === arm).map((record) => [record.fixture, record]));
  const knownByFixture = Object.fromEntries(FIXTURE_IDS.map((id) => [id, [] as string[]])) as Record<FixtureId, string[]>;
  const novelByFixture = new Map<FixtureId, Set<string>>();
  let unsupported = 0;
  let actionable = 0;
  let findings = 0;
  let falseAlarms = 0;
  for (const line of mine) {
    if (line.kind !== "finding") continue;
    findings++;
    const defects = (reading === "labelled" ? line.label.defects : line.automatic.defects) ?? [];
    for (const id of defects) if (!knownByFixture[line.fixture].includes(id)) knownByFixture[line.fixture].push(id);
    if (reading === "labelled") {
      if (line.label.unsupported === "U1" || line.label.unsupported === "U3") unsupported++;
      if (defects.length === 0 && line.label.novel === "useful" && line.label.novelKey) {
        const keys = novelByFixture.get(line.fixture) ?? new Set<string>();
        keys.add(line.label.novelKey.trim().toLowerCase());
        novelByFixture.set(line.fixture, keys);
      }
    }
    if ((reading === "labelled" ? line.label.actionable : line.automatic.actionable) === true) actionable++;
    if (line.fixture === control && (reading === "labelled" ? line.label.material : line.automatic.material) === true) falseAlarms++;
  }
  const controlRun = runs.get(control);
  const summaries = mine.filter((line) => line.kind === "summary");
  const substantive = summaries.length > 0 && summaries.every((line) => (reading === "labelled" ? line.label.substantive : line.automatic.substantive) === true);
  const refsDropped = [...runs.values()].reduce((sum, record) => sum + (record.report?.reviewers.reduce((n, reviewer) => n + reviewer.adjusted.refsDropped, 0) ?? 0), 0);
  return {
    knownByFixture,
    known: Object.values(knownByFixture).reduce((sum, ids) => sum + ids.length, 0),
    usefulNovel: reading === "labelled" ? [...novelByFixture.values()].reduce((sum, keys) => sum + keys.size, 0) : null,
    unsupported: reading === "labelled" ? unsupported + refsDropped : null,
    refsDropped,
    falseAlarms,
    controlCorrect: reported(controlRun) ? complete(controlRun) && falseAlarms === 0 && substantive : null,
    complete: [...runs.values()].filter(complete).length,
    reported: FIXTURE_IDS.filter((id) => reported(runs.get(id))),
    actionability: findings ? actionable / findings : null,
    latencyMs: Object.fromEntries(FIXTURE_IDS.map((id) => [id, runs.get(id)?.summary?.durationMs ?? null])) as Record<FixtureId, number | null>,
    tokens: Object.fromEntries(FIXTURE_IDS.map((id) => [id, tokensOf(runs.get(id))])) as Record<FixtureId, number | null>,
    findings,
  };
}

export const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export type Decision = "inconclusive" | "defer" | "adopt" | "simplify";

export interface Decided {
  decision: Decision;
  bothReported: FixtureId[];
  latencyRatio: number | null;
  /** The median token ratio, or "unknown" when a run in the comparison didn't report its tokens. */
  tokenRatio: number | "unknown" | null;
  /** Each rule the decision weighed, in the protocol's order, with whether it held. */
  checks: Array<{ rule: "defer" | "adopt"; what: string; held: boolean }>;
}

const EPSILON = 1e-9;

/**
 * The protocol's decision (D32), in its order: inconclusive with too few fixtures reported by both arms; defer if any
 * defer rule holds; adopt only if every adopt rule does; otherwise simplify. Scores still unjudged count as failing.
 */
export function decide(single: ArmScores, council: ArmScores, protocol: Protocol): Decided {
  const t = protocol.decision.thresholds;
  const bothReported = FIXTURE_IDS.filter((id) => single.reported.includes(id) && council.reported.includes(id));
  const latency = bothReported.flatMap((id) => {
    const s = single.latencyMs[id];
    const c = council.latencyMs[id];
    return s !== null && c !== null && s > 0 ? [c / s] : [];
  });
  const latencyRatio = median(latency);
  const unknownTokens = bothReported.some((id) => single.tokens[id] === null || council.tokens[id] === null);
  const tokenRatio = !bothReported.length ? null : unknownTokens ? "unknown" : median(bothReported.map((id) => council.tokens[id]! / Math.max(1, single.tokens[id]!)));
  const checks: Decided["checks"] = [];
  if (bothReported.length < t.minFixturesBothReported) return { decision: "inconclusive", bothReported, latencyRatio, tokenRatio, checks };
  const total = (scores: ArmScores) => (scores.usefulNovel === null ? null : scores.known + scores.usefulNovel);
  const sTotal = total(single);
  const cTotal = total(council);
  const known = (n: number | null) => (n === null ? "not judged" : String(n));
  const deferRules: Array<[string, boolean]> = [
    [`Known defects plus useful novel findings: council ${known(cTotal)}, single ${known(sTotal)}; defer when the council's are no more`, cTotal === null || sTotal === null || cTotal <= sTotal],
    [`Unsupported findings: council ${known(council.unsupported)}, single ${known(single.unsupported)}; defer at ${t.deferUnsupportedMargin} or more above`, council.unsupported === null || single.unsupported === null || council.unsupported >= single.unsupported + t.deferUnsupportedMargin],
    [`False alarms on the control: council ${council.falseAlarms}, single ${single.falseAlarms}; defer at ${t.deferFalseAlarmMargin} or more above`, council.falseAlarms >= single.falseAlarms + t.deferFalseAlarmMargin],
    [`Complete council runs: ${council.complete} of 5; defer at ${t.deferCompleteAtMost} or fewer`, council.complete <= t.deferCompleteAtMost],
  ];
  for (const [what, held] of deferRules) checks.push({ rule: "defer", what, held });
  if (deferRules.some(([, held]) => held)) return { decision: "defer", bothReported, latencyRatio, tokenRatio, checks };
  const adoptRules: Array<[string, boolean]> = [
    [`Known defects: council ${council.known}, single ${single.known}; adopt needs ${t.adoptKnownMargin} or more above`, council.known >= single.known + t.adoptKnownMargin],
    [`Known plus useful novel: council ${known(cTotal)}, single ${known(sTotal)}; adopt needs ${t.adoptKnownPlusNovelMargin} or more above`, cTotal !== null && sTotal !== null && cTotal >= sTotal + t.adoptKnownPlusNovelMargin],
    [`Unsupported: council ${known(council.unsupported)}, single ${known(single.unsupported)}; adopt allows at most ${t.adoptUnsupportedMargin} above`, council.unsupported !== null && single.unsupported !== null && council.unsupported <= single.unsupported + t.adoptUnsupportedMargin],
    [`False alarms on the control: council ${council.falseAlarms}, single ${single.falseAlarms}; adopt allows none above`, council.falseAlarms <= single.falseAlarms],
    [`Complete council runs: ${council.complete} of 5; adopt needs ${t.adoptCompleteAtLeast}`, council.complete >= t.adoptCompleteAtLeast],
    [`Median latency ratio: ${latencyRatio === null ? "none" : latencyRatio.toFixed(2)}; adopt allows ${t.adoptLatencyRatio.toFixed(1)}`, latencyRatio !== null && latencyRatio <= t.adoptLatencyRatio + EPSILON],
    [`Median token ratio: ${tokenRatio === null ? "none" : tokenRatio === "unknown" ? "unknown (a run didn't report its tokens)" : tokenRatio.toFixed(2)}; adopt allows ${t.adoptTokenRatio.toFixed(1)}, or unknown`, tokenRatio === "unknown" || (typeof tokenRatio === "number" && tokenRatio <= t.adoptTokenRatio + EPSILON)],
    [
      `Actionability: council ${council.actionability === null ? "none" : council.actionability.toFixed(2)}, single ${single.actionability === null ? "none" : single.actionability.toFixed(2)}; adopt allows ${t.adoptActionabilityMargin.toFixed(2)} below`,
      council.actionability !== null && single.actionability !== null && council.actionability >= single.actionability - t.adoptActionabilityMargin - EPSILON,
    ],
  ];
  for (const [what, held] of adoptRules) checks.push({ rule: "adopt", what, held });
  return { decision: adoptRules.every(([, held]) => held) ? "adopt" : "simplify", bothReported, latencyRatio, tokenRatio, checks };
}

/** Both arms' scores and the decision, from the labelled sheet, with the automatic-only scores beside them. */
export function scoreBatch(records: readonly RunRecord[], sheet: readonly SheetItem[], key: SheetKey, frozen: Frozen) {
  const scores = (reading: Reading) => Object.fromEntries(ARMS.map((arm) => [arm, armScores(arm, records, sheet, key, frozen.rubric, reading)])) as Record<Arm, ArmScores>;
  const labelled = scores("labelled");
  return { labelled, automatic: scores("automatic"), decided: decide(labelled.single, labelled.council, frozen.protocol) };
}
