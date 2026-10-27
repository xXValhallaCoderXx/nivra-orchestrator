import { z } from "zod";

/**
 * Nivra's built-in specialists (NIV-52, NIV-53): fixed, versioned instructions, each with a name, a personality and a
 * purpose the window shows. A profile grants nothing: no tools, no memory, no writes and no permission. Its personality
 * changes how it writes, never what it may do. Whoever holds a profile's instructions pins their hash to its version
 * here in a test (the council's with the mission review, the coach's with Track C's coach), so the text can't change
 * without a new version. A result records the versions it was made with, and stays readable, labelled with them, after
 * a profile moves on.
 *
 * The council's three profiles review a mission's selected tasks (Track B). The coach prepares one task (Track C,
 * which owns its entry's wording and version).
 */

export const SpecialistId = z.enum(["product-architect", "risk-testability", "council-chair", "task-readiness-coach"]);
export type SpecialistId = z.infer<typeof SpecialistId>;

export interface SpecialistProfile {
  id: SpecialistId;
  /** Raised whenever its instructions, or what it hands in, change. */
  version: number;
  /** How the window names it. */
  name: string;
  /** How it writes. */
  personality: string;
  /** What it looks at. */
  purpose: string;
  /** What it may use besides the message it is sent: nothing. */
  capabilities: readonly [];
  /** The model calls it makes for one thing the person asks for. */
  callsPerAction: 1;
}

export const SPECIALISTS: Readonly<Record<SpecialistId, SpecialistProfile>> = {
  "product-architect": {
    id: "product-architect",
    version: 1,
    name: "Product architect",
    personality: "Pragmatic, outcome-focused and direct.",
    purpose: "Whether the selected work serves the mission: fit, feasibility, scope and order, missing prerequisites and work that conflicts.",
    capabilities: [],
    callsPerAction: 1,
  },
  "risk-testability": {
    id: "risk-testability",
    version: 1,
    name: "Risk and testability reviewer",
    personality: "Constructively sceptical, concrete and evidence-led.",
    purpose: "Dependencies, failure behaviour and ambiguity, and how each claim could be tested.",
    capabilities: [],
    callsPerAction: 1,
  },
  "council-chair": {
    id: "council-chair",
    version: 1,
    name: "Council chair",
    personality: "Balanced, concise and open about what isn't known.",
    purpose: "Puts the reviewers' findings in order and keeps their disagreements and unknowns. It adds no findings, and agreement isn't proof.",
    capabilities: [],
    callsPerAction: 1,
  },
  "task-readiness-coach": {
    id: "task-readiness-coach",
    version: 1,
    name: "Task readiness coach",
    personality: "Patient, precise, encouraging and concise.",
    purpose: "Asks the few questions that matter most and proposes understandable changes to one task's brief, each with its reason. It never decides readiness, runs nothing and changes nothing by itself.",
    capabilities: [],
    callsPerAction: 1,
  },
};

/** The council that reviews a mission (NIV-52), in the order its stages run: two reviewers on their own, then the chair. */
export const MISSION_COUNCIL = ["product-architect", "risk-testability", "council-chair"] as const satisfies readonly SpecialistId[];

/** A profile as a result names it: which one, and which version of its instructions. */
export const SpecialistRef = z.strictObject({ id: SpecialistId, version: z.number().int().positive() });
export type SpecialistRef = z.infer<typeof SpecialistRef>;

/** The reference to a profile as the catalogue has it now. */
export const specialistRef = (id: SpecialistId): SpecialistRef => ({ id, version: SPECIALISTS[id].version });
