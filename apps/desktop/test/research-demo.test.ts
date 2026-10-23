import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { researchPacketDigest } from "@nivra/domain";
import { seedProjectPlan } from "../e2e/seed-workspace.ts";
import { DEMO_PROJECT, DEMO_SEED, DEMO_SITES, demoFingerprint, demoPacket } from "../scripts/research-demo.ts";
import { checkRepo, digestOf, recipeOf, recipeText, type Frozen } from "../scripts/research-live.ts";
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

  it("binds its approval to the revision, the build, the repository and the preview's fingerprint, and says what it covers", async () => {
    const frozen: Frozen = {
      stamp: "20261023T000000Z",
      revision: "a".repeat(40),
      folderWin: "C:\\Users\\me\\AppData\\Local\\nivra-dev\\r3-20261023T000000Z",
      exeSha256: "9".repeat(64),
      appAsarSha256: "b".repeat(64),
      runtimeTarballSha256: "8".repeat(64),
      runtimeContentHash: "c".repeat(16),
      distro: "Ubuntu",
      repo: { path: `/home/me/nivra-r3/${DEMO_PROJECT}`, commit: "d".repeat(40) },
    };
    const recipe = await recipeOf(frozen);
    const digest = digestOf(recipe);
    assert.deepEqual([recipe.fingerprint, recipe.credits, recipe.assumptions.map((assumption) => assumption.query)], [(await demoFingerprint()).fingerprint, 4, DEMO_SEED.assumptions]);
    assert.equal(digestOf(await recipeOf(frozen)), digest, "the same recipe gives the same digest");
    // Where the build was copied to isn't bound; what it is, and where it runs, are.
    for (const [change, bound] of [
      [{ folderWin: "D:\\elsewhere" }, false],
      [{ revision: "e".repeat(40) }, true],
      [{ exeSha256: "7".repeat(64) }, true],
      [{ appAsarSha256: "f".repeat(64) }, true],
      [{ runtimeTarballSha256: "6".repeat(64) }, true],
      [{ runtimeContentHash: "0".repeat(16) }, true],
      [{ distro: "Debian" }, true],
      [{ repo: { ...frozen.repo, commit: "1".repeat(40) } }, true],
    ] as const) {
      assert.equal(digestOf(await recipeOf({ ...frozen, ...change })) !== digest, bound, JSON.stringify(change));
    }
    // Each approval of the recipe is one run: the next run is another digest, approved on its own.
    assert.notEqual(digestOf(await recipeOf(frozen, 2)), digest);
    const text = recipeText(recipe, digest);
    for (const words of [
      "Token Factory: one model listing (GET /v1/models), in the run's prepare step",
      "Tavily: at most 2 searches (POST /search), one for each query, with the sites",
      "Token Factory: one chat completion, with the plan, the assumptions, and the passages read, each with its page's title, host and address and the assumption it was found for",
      "the script turns on research's permission, and allows kestrelyard's sharing with Token Factory, each through its own dialog",
      "A1 and A2 here are R1's A1 and A3",
      "Tavily: at most 2 extracts (POST /extract), over at most 5 pages its searches returned",
      "At most 4 Tavily credits.",
      "Never: Check Token Factory; a chat message; a Nebius project id in the profile; a second Start; a retry or a retake.",
      `A1: ${DEMO_SEED.assumptions[0]}`,
      `A2: ${DEMO_SEED.assumptions[1]}`,
      `Digest: ${digest}`,
    ]) {
      assert.ok(text.includes(words), words);
    }
  });

  it("refuses a demonstration repository changed since it was frozen: an edit, a new commit, or another distribution", () => {
    const path = mkdtempSync(join(tmpdir(), "nivra research demo repo "));
    dirs.push(path);
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: path, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    writeFileSync(join(path, "setup.py"), "from distutils.core import setup\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "The build image");
    const repo = { path, commit: git("rev-parse", "HEAD") };
    checkRepo(repo, "Ubuntu", "Ubuntu");
    writeFileSync(join(path, "setup.py"), "import setuptools\n");
    assert.throws(() => checkRepo(repo, "Ubuntu", "Ubuntu"), /has changes since it was frozen\. Freeze again, and ask for a new approval\.$/);
    git("commit", "-qam", "Changed after the freeze");
    assert.throws(() => checkRepo(repo, "Ubuntu", "Ubuntu"), /is at [0-9a-f]{7}, not the frozen [0-9a-f]{7}\. Freeze again, and ask for a new approval\.$/);
    git("reset", "-q", "--hard", repo.commit);
    writeFileSync(join(path, "notes.txt"), "an untracked file\n");
    assert.throws(() => checkRepo(repo, "Ubuntu", "Ubuntu"), /has changes since it was frozen/);
    rmSync(join(path, "notes.txt"));
    checkRepo(repo, "Ubuntu", "Ubuntu");
    assert.throws(() => checkRepo(repo, "Ubuntu", "Debian"), /^Error: This runs in Debian, but the demonstration was frozen in Ubuntu\. Run it there\.$/);
  });

  it("refuses to seed a project the app hasn't added", () => {
    const { userData } = profile();
    assert.throws(() => seedProjectPlan(userData, { ...DEMO_SEED, projectLabel: "elsewhere" }), /^Error: No project is labelled elsewhere in this profile\. Add its folder in the app first\.$/);
  });
});
