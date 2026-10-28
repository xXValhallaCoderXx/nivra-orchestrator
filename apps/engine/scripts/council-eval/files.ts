import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { packetDigest, ReviewPacket, type ParamsOf, type ReviewPanel } from "@nivra/domain";
import { z } from "zod";

/**
 * The council evaluation's frozen inputs (NIV-40, D32): five synthetic plans, the rubric that scores reviews of them, and
 * the protocol that fixes everything else before any paid call. Both arms are sent exactly the same packet, built here.
 */

export const FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/council-eval/", import.meta.url));
export const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));

export const FIXTURE_IDS = ["f1", "f2", "f3", "f4", "f5"] as const;
export const FixtureId = z.enum(FIXTURE_IDS);
export type FixtureId = z.infer<typeof FixtureId>;
export const ARMS = ["single", "council"] as const satisfies readonly ReviewPanel[];
export type Arm = (typeof ARMS)[number];

export const Fixture = z.strictObject({ id: FixtureId, title: z.string().min(1).max(200), control: z.boolean(), packet: ReviewPacket });
export type Fixture = z.infer<typeof Fixture>;

const Stem = z.string().min(1).max(60);
export const Defect = z.strictObject({
  id: z.string().regex(/^f[1-5]-[a-z0-9-]+$/),
  severity: z.enum(["high", "medium", "low"]),
  summary: z.string().min(1).max(300),
  match: z.strictObject({ all: z.array(z.array(Stem).min(1)).min(1).max(6) }),
  positive: z.array(z.string().min(1)).min(2),
  negative: z.array(z.string().min(1)).min(2),
});
export type Defect = z.infer<typeof Defect>;

export const Rubric = z.strictObject({
  version: z.literal("nivra.council-eval.rubric.v1"),
  matching: z.string().min(1),
  defects: z.strictObject({ f1: z.array(Defect), f2: z.array(Defect), f3: z.array(Defect), f4: z.array(Defect), f5: z.array(Defect) }),
  control: z.strictObject({ fixture: FixtureId, rule: z.string(), noIssues: z.array(z.string()).min(1), nits: z.array(z.string()), falseAlarms: z.array(z.string()) }),
  unsupported: z.strictObject({ U1: z.string(), U2: z.string(), U3: z.string() }),
  actionable: z.string(),
  novel: z.string(),
});
export type Rubric = z.infer<typeof Rubric>;

const Limits = z.strictObject({ requests: z.number().int().positive(), totalMs: z.number().int().positive(), outputTokensPerRequest: z.number().int().positive(), estimatedInputTokens: z.number().int().positive() });
export const Protocol = z.strictObject({
  version: z.literal("nivra.council-eval.protocol.v1"),
  fixtures: z.array(FixtureId).length(5),
  order: z.string(),
  model: z.string().min(1),
  endpoint: z.literal("token-factory"),
  sampling: z.strictObject({ temperature: z.null(), topP: z.null(), maxOutputTokens: z.number().int().positive(), toolChoice: z.enum(["forced", "auto"]) }),
  limits: z.strictObject({ single: Limits, council: Limits }),
  requestMs: z.number().int().positive(),
  /** A run is cancelled at its limit plus `cancelMarginMs`, and given `reconcileMs` more to end before it is kept as unresolved. */
  runner: z.strictObject({ cancelMarginMs: z.number().int().nonnegative(), reconcileMs: z.number().int().nonnegative(), batchMs: z.number().int().positive(), maxRequests: z.number().int().positive() }),
  preferences: z.strictObject({ revision: z.literal(0), records: z.array(z.never()).length(0) }),
  stops: z.array(z.string()).min(1),
  /** Who labels the blinded sheet: chosen when the protocol is frozen, before approval. */
  labelling: z.enum(["pending", "nate", "claude-blind-nate-reviews"]),
  seed: z.number().int(),
  decision: z.strictObject({
    inconclusive: z.string(),
    defer: z.string(),
    adopt: z.string(),
    simplify: z.string(),
    thresholds: z.strictObject({
      minFixturesBothReported: z.number().int(),
      deferUnsupportedMargin: z.number().int(),
      deferFalseAlarmMargin: z.number().int(),
      deferCompleteAtMost: z.number().int(),
      adoptKnownMargin: z.number().int(),
      adoptKnownPlusNovelMargin: z.number().int(),
      adoptUnsupportedMargin: z.number().int(),
      adoptCompleteAtLeast: z.number().int(),
      adoptLatencyRatio: z.number(),
      adoptTokenRatio: z.number(),
      adoptActionabilityMargin: z.number(),
    }),
  }),
});
export type Protocol = z.infer<typeof Protocol>;

export interface Frozen {
  fixtures: Fixture[];
  rubric: Rubric;
  protocol: Protocol;
  /** Each fixture's packet fingerprint, as the engine works it out. */
  packetDigests: Record<FixtureId, string>;
  /** What approval binds: the fixtures, the rubric and the protocol, read as data (formatting doesn't count). */
  approvalDigest: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** JSON with every object's keys sorted, so a fingerprint depends on content, never on formatting or key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Reads and checks the frozen inputs. Each fixture's file is named after its id, and the protocol names all five in order. */
export async function loadFrozen(dir = FIXTURES_DIR): Promise<Frozen> {
  const protocol = Protocol.parse(readJson(join(dir, "protocol.json")));
  const rubric = Rubric.parse(readJson(join(dir, "rubric.json")));
  if (protocol.fixtures.join() !== FIXTURE_IDS.join()) throw new Error(`The protocol must list the fixtures ${FIXTURE_IDS.join(", ")}, in that order.`);
  const fixtures = FIXTURE_IDS.map((id) => {
    const fixture = Fixture.parse(readJson(join(dir, "plans", `${id}.json`)));
    if (fixture.id !== id) throw new Error(`plans/${id}.json holds fixture ${fixture.id}.`);
    return fixture;
  });
  const controls = fixtures.filter((fixture) => fixture.control).map((fixture) => fixture.id);
  if (controls.join() !== rubric.control.fixture || rubric.defects[rubric.control.fixture].length) throw new Error("Exactly one fixture is the control: the rubric's, with no known defects.");
  for (const fixture of fixtures) {
    for (const defect of rubric.defects[fixture.id]) {
      if (!defect.id.startsWith(`${fixture.id}-`)) throw new Error(`Defect ${defect.id} is listed under ${fixture.id}.`);
    }
  }
  const digests = await Promise.all(fixtures.map((fixture) => packetDigest(fixture.packet)));
  const packetDigests = Object.fromEntries(FIXTURE_IDS.map((id, i) => [id, digests[i]!])) as Record<FixtureId, string>;
  const approvalDigest = sha256(canonical(["nivra.council-eval.approval.v1", protocol, rubric, fixtures]));
  return { fixtures, rubric, protocol, packetDigests, approvalDigest };
}

/** A fixture's plan id: a UUID made from its packet's fingerprint, so both arms, and any rerun, review the same plan. */
export function planIdOf(digest: string): string {
  const hex = digest.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * The one request a run sends: the fixture's packet, unchanged, with the protocol's empty preference snapshot and, for
 * a project-scoped fixture, consent (it is synthetic). `--plan` prints what it shows from this same function.
 */
export function requestFor(frozen: Frozen, fixtureId: FixtureId, arm: Arm, clientRequestId: string): Extract<ParamsOf<"runs.start">, { workflowId: "review" }> & { context: { packet: ReviewPacket } } {
  const fixture = frozen.fixtures.find((f) => f.id === fixtureId)!;
  return {
    clientRequestId,
    workflowId: "review",
    input: { panel: arm, planId: planIdOf(frozen.packetDigests[fixtureId]), planVersion: 1, packetDigest: frozen.packetDigests[fixtureId], preferencesDigest: EMPTY_PREFERENCES_DIGEST },
    context: { preferences: frozen.protocol.preferences, sharing: { modelContext: fixture.packet.scope.kind === "project" }, packet: fixture.packet },
  };
}

/** The fingerprint of no preferences (D21): SHA-256 of "[]". */
export const EMPTY_PREFERENCES_DIGEST = sha256("[]");

/** The order runs go in: each fixture in turn, the arms alternating which goes first. */
export function runOrder(): Array<{ fixture: FixtureId; arm: Arm }> {
  return FIXTURE_IDS.flatMap((fixture, index) => (index % 2 === 0 ? ARMS : [...ARMS].reverse()).map((arm) => ({ fixture, arm })));
}

/** Whether `path` is the repository or inside it, judged by real paths, so a link from outside to inside counts as inside. */
export function insideRepository(path: string, repository = REPOSITORY): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const within = relative(real(repository), real(path));
  return within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`));
}

/**
 * The Token Factory key, from a file holding a NEBIUS_API_KEY=… line, outside the repository and readable by its owner
 * only. Refused in words that say what to do; the key itself is never printed.
 */
export function readCredentials(file: string): string {
  const path = resolve(file);
  if (insideRepository(path)) throw new Error(`${path} is inside the repository. Keep the credentials file outside it (for example ~/.config/nivra/token-factory.env), then try again. Nothing was sent.`);
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new Error(`${path} can't be read. Check the path, then try again. Nothing was sent.`);
  }
  const mode = statSync(real).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) throw new Error(`${path} can be read by others (mode ${mode.toString(8)}). Run chmod 600 on it, then try again. Nothing was sent.`);
  const key = parseEnv(readFileSync(real, "utf8"))["NEBIUS_API_KEY"]?.trim();
  if (!key) throw new Error(`${path} has no NEBIUS_API_KEY line. Add one, then try again. Nothing was sent.`);
  return key;
}
