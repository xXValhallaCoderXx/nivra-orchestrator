// R3's demonstration of research (D37, NIV-45): one project plan with two assumptions that matter to it, seeded so no
// model call makes it, and researched with each assumption's own words as its query. The live run, its rehearsal, the
// offline journey and a unit test all take it from here, so what is approved is what each of them does.
import { researchPacketDigest, type ResearchPacket } from "@nivra/domain";
import type { ProjectSeed } from "../e2e/seed-workspace.ts";
import { researchFingerprint } from "../src/main/research.ts";
import { planText } from "../src/shared/plans.ts";

/** The demonstration project's folder and label: one word that no query holds, so the project-name check passes. */
export const DEMO_PROJECT = "kestrelyard";

/**
 * The plan: a fresh virtual environment, and nothing installed into it before the wheel is built, so both assumptions
 * decide whether setup.py's import of distutils.core works on 3.12. Shown in the app as A1 and A2 (R1's A1 and A3).
 */
export const DEMO_SEED: ProjectSeed = {
  projectLabel: DEMO_PROJECT,
  question: "How do we move the build image to Python 3.12?",
  answer:
    "Move the build image from Python 3.11 to 3.12. The image creates a fresh virtual environment with python -m venv /opt/venv, then builds the wheel inside it with python setup.py bdist_wheel, installing nothing else into it first. setup.py keeps importing distutils.core.",
  assumptions: ["distutils is still in Python 3.12's standard library", "Python 3.12's venv still pre-installs setuptools"],
  ids: {
    conversationId: "b1dafae9-c2db-481d-ba4d-c4a7046c3302",
    turnId: "e2c4b317-0394-49dd-a6fa-303c1a51458c",
    messageId: "dfc1de89-4f33-45a9-8f74-83b497de2ebe",
    planId: "a8665105-e662-4a7a-8165-def5143e3528",
    lineageId: "4e9faa26-b8f3-410d-9910-7cfb8c94b710",
  },
};

/** The sites the research prefers, as typed into the dialog. */
export const DEMO_SITES = { mode: "prefer" as const, hosts: ["docs.python.org", "peps.python.org"] };

/** The packet the app freezes for this plan with both assumptions picked, each query its own words, and the sites. */
export function demoPacket(): ResearchPacket {
  // planText reads a repository reply's answer, proposals and assumptions only; the unit test checks this against the
  // plan the seed actually saves.
  const reply = { kind: "repository", answer: DEMO_SEED.answer, proposals: [], assumptions: DEMO_SEED.assumptions };
  const text = planText(reply as unknown as Parameters<typeof planText>[0]);
  return {
    scope: { kind: "project", headAtStart: null },
    planText: text,
    assumptions: DEMO_SEED.assumptions.map((assumption, index) => ({ id: `A${index + 1}` as "A1" | "A2", text: assumption, origin: { kind: "plan" as const, index }, query: assumption })),
    sites: { mode: DEMO_SITES.mode, hosts: [...DEMO_SITES.hosts] },
  };
}

/** The packet's digest, and the fingerprint the preview shows with research on and the project's sharing on. */
export async function demoFingerprint(): Promise<{ packetDigest: string; fingerprint: string }> {
  const packetDigest = await researchPacketDigest(demoPacket());
  return { packetDigest, fingerprint: researchFingerprint({ planId: DEMO_SEED.ids.planId, planVersion: 1, packetDigest, webResearch: true, modelSharing: true }) };
}
