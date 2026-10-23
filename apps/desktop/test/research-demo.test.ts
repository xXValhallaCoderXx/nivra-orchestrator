import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { researchPacketDigest } from "@nivra/domain";
import { seedProjectPlan } from "../e2e/seed-workspace.ts";
import { DEMO_PROJECT, DEMO_SEED, DEMO_SITES, demoFingerprint, demoPacket } from "../scripts/research-demo.ts";
import { HostStore } from "../src/main/host-store.ts";
import { queryChecks, researchDeny, researchFingerprint, researchPacket } from "../src/main/research.ts";
import type { PlanContent } from "../src/main/tasks.ts";
import { getArtifact, getConversation } from "../src/main/workspace.ts";
import { openWorkspace } from "../src/main/workspace-db.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A profile whose nivra.json holds the demonstration project, as the app writes it when the folder is added. */
function profile() {
  const userData = mkdtempSync(join(tmpdir(), "nivra research demo "));
  dirs.push(userData);
  const project = { id: randomUUID(), targetId: "wsl:Ubuntu", nativePath: `/home/me/${DEMO_PROJECT}`, label: DEMO_PROJECT, addedAt: new Date().toISOString(), sharing: { modelContext: true, cloudExecution: false } };
  new HostStore(join(userData, "nivra.json")).update((data) => ({ ...data, projects: [project] }));
  return { userData, project };
}

describe("R3's demonstration plan (D37, NIV-45)", () => {
  it("is seeded on its project's engine, and the app freezes exactly the packet and fingerprint the recipe works out", async () => {
    const { userData, project } = profile();
    const seeded = seedProjectPlan(userData, DEMO_SEED);
    assert.deepEqual(seeded, { conversationId: DEMO_SEED.ids.conversationId, planId: DEMO_SEED.ids.planId, targetId: "wsl:Ubuntu" });
    const opening = openWorkspace(join(userData, "workspace.db"));
    assert.equal(opening.state, "ready");
    if (opening.state !== "ready") return;
    try {
      const plan = getArtifact(opening.db, DEMO_SEED.ids.planId)!;
      const conversation = getConversation(opening.db, DEMO_SEED.ids.conversationId)!;
      const content = plan.content as PlanContent;
      assert.deepEqual([plan.version, conversation.kind, conversation.targetId, conversation.projectId, content.kind, content.assumptions], [1, "project", "wsl:Ubuntu", project.id, "repository", DEMO_SEED.assumptions]);
      // Both of the plan's assumptions, each query its own words, with the sites, as the journey picks them.
      const selection = { assumptions: DEMO_SEED.assumptions.map((query, index) => ({ from: { kind: "plan" as const, index }, query })), sites: { mode: DEMO_SITES.mode, hosts: DEMO_SITES.hosts } };
      const packet = researchPacket(plan, conversation, selection, []);
      assert.deepEqual(packet, demoPacket());
      const packetDigest = await researchPacketDigest(packet);
      const expected = await demoFingerprint();
      assert.deepEqual(
        { packetDigest, fingerprint: researchFingerprint({ planId: plan.id, planVersion: plan.version, packetDigest, webResearch: true, modelSharing: true }) },
        expected,
      );
      // Neither query names the project or holds anything the checks refuse.
      assert.deepEqual(
        queryChecks(packet, researchDeny([project], content), []).map((check) => check.problems),
        [[], []],
      );
    } finally {
      opening.db.close();
    }
  });

  it("refuses to seed a project the app hasn't added", () => {
    const { userData } = profile();
    assert.throws(() => seedProjectPlan(userData, { ...DEMO_SEED, projectLabel: "elsewhere" }), /^Error: No project is labelled elsewhere in this profile\. Add its folder in the app first\.$/);
  });
});
