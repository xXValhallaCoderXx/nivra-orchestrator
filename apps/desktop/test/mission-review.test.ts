import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MISSION_LIMITS, MISSION_REVIEW_LIMITS, type MissionContent, type PreferenceSnapshot } from "@nivra/domain";
import { addMissionTask, insertMission, insertMissionVersion, type MissionRecord } from "../src/main/mission-store.ts";
import { composeMissionReview, missionContentOf, missionDigests, missionPreviewFingerprint, refuseMissionCredentials, refusePacketCredentials } from "../src/main/missions.ts";
import { briefFrom } from "../src/main/tasks.ts";
import { insertArtifact, insertTask, updateTask, versionsOf } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";

/**
 * What a mission review sends (NIV-52), worked out from the records: the composition, its limits and refusals, the
 * credential check over the whole packet, and the fingerprint a preview is bound by. Through the workspace's own
 * functions, on a real file.
 */

const dirs: string[] = [];
const dbs: WorkspaceDb[] = [];
after(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const AT = "2026-10-28T02:00:00.000Z";
const KEY = "nvapi-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
const MISSION: MissionContent = { name: "Runner's log", intendedUsers: "Club runners.", outcome: "A runner sees this week's distance against their plan.", successCriteria: ["Shows within a second."], constraints: [], nonGoals: [] };
const NONE: PreferenceSnapshot = { revision: 0, records: [] };

function workspace(): WorkspaceDb {
  const dir = mkdtempSync(join(tmpdir(), "nivra mission review "));
  dirs.push(dir);
  const opening = openWorkspace(join(dir, "workspace.db"));
  if (opening.state !== "ready") throw new Error(opening.reason);
  dbs.push(opening.db);
  return opening.db;
}

function seeded(titles: string[], options: { projectOf?: Record<string, string>; context?: Record<string, string> } = {}) {
  const db = workspace();
  const mission: MissionRecord = { id: randomUUID(), conversationId: randomUUID(), createdAt: AT };
  insertMission(db, mission, { id: randomUUID(), content: MISSION });
  const ids = titles.map((title) => {
    const id = randomUUID();
    const fields = { goal: `Do ${title}.`, acceptanceCriteria: ["It works."], scope: "", exclusions: "", context: options.context?.[title] ?? "", assumptions: [], checks: [], acceptanceCases: [{ name: "saves", command: "node check.mjs", expectedOutput: "ok\n", expectedExitCode: 0 }] };
    insertTask(db, { id, title, projectId: options.projectOf?.[title] ?? null, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: briefFrom(fields), derivedFrom: null });
    addMissionTask(db, mission.id, id, AT);
    return id;
  });
  return { db, mission, ids };
}

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("a mission review's composition (NIV-52)", () => {
  it("sends the mission's latest version and each selected task's title and latest brief, in the order selected", () => {
    const { db, mission, ids } = seeded(["Store runs", "Weekly total", "Sync"]);
    insertMissionVersion(db, mission.id, { id: randomUUID(), content: { ...MISSION, constraints: ["Works offline."] }, createdAt: AT }, 1);
    const composition = composeMissionReview(db, mission, [ids[1]!, ids[0]!], null);
    assert.deepEqual(
      composition.binding.tasks.map((task) => [task.title, task.briefVersion]),
      [
        ["Weekly total", 1],
        ["Store runs", 1],
      ],
    );
    assert.deepEqual([composition.binding.mission?.version, composition.packet.mission.constraints, composition.packet.othersInBacklog], [2, ["Works offline."], 1]);
    assert.match(composition.text, /^The mission \(mission\):/);
    assert.match(composition.text, /T1\. Weekly total\n[\s\S]*T2\. Store runs\n/);
    assert.match(composition.text, /Acceptance cases, by name: saves/);
    assert.doesNotMatch(composition.text, /node check\.mjs|ok\n/, "a case's command and expected output stay with the task");
    assert.deepEqual([composition.packet.model, composition.packet.scope], [null, { kind: "general" }]);
  });

  it("refuses an empty selection, more than five, a task twice, one outside the backlog or gone, and one linked to a repository", () => {
    const { db, mission, ids } = seeded(["A", "B", "C", "D", "E", "F", "Linked"], { projectOf: { Linked: randomUUID() } });
    const outside = randomUUID();
    insertTask(db, { id: outside, title: "Elsewhere", projectId: null, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: briefFrom({ goal: "", acceptanceCriteria: [], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] }), derivedFrom: null });
    const linked = ids[6]!;
    assert.deepEqual(
      [
        refusal(() => composeMissionReview(db, mission, [], null)),
        refusal(() => composeMissionReview(db, mission, ids.slice(0, 6), null)),
        refusal(() => composeMissionReview(db, mission, [ids[0]!, ids[0]!], null)),
        refusal(() => composeMissionReview(db, mission, [outside], null)),
        refusal(() => composeMissionReview(db, mission, [randomUUID()], null)),
        refusal(() => composeMissionReview(db, mission, [linked], null)),
      ],
      [
        "Select at least one task to review.",
        `A review takes at most ${MISSION_REVIEW_LIMITS.tasks} tasks, and 6 are selected. Leave some out, then preview again.`,
        "A task is selected twice. Select each task once, then preview again.",
        "A selected task is no longer in this mission's backlog. Check the selection, then preview again.",
        "A selected task is no longer in this mission's backlog. Check the selection, then preview again.",
        `"Linked" is linked to a repository, and mission reviews take only tasks that aren't, for now. Leave it out, then preview again.`,
      ],
    );
  });

  it("refuses a selection over the review text limit, naming the sizes, rather than shortening it", () => {
    const long = "c".repeat(9_500);
    const { db, mission, ids } = seeded(["A", "B", "C"], { context: { A: long, B: long, C: long } });
    assert.equal(composeMissionReview(db, mission, [ids[0]!, ids[1]!], null).packet.tasks.length, 2, "two fit");
    const words = refusal(() => composeMissionReview(db, mission, ids, null));
    assert.match(words, /^This review would send 2\d,\d{3} characters, and a review can take 20,000\. Leave a task out, or shorten the longest \(T\d, about 9,5\d\d characters\), then preview again\.$/);
  });

  it("binds a later brief and a rename into what a preview's fingerprint covers", async () => {
    const { db, mission, ids } = seeded(["Store runs", "Weekly total"]);
    const fingerprint = async () => missionPreviewFingerprint(await missionDigests(composeMissionReview(db, mission, ids, null), NONE));
    const first = await fingerprint();
    assert.equal(await fingerprint(), first, "the same records give the same fingerprint");
    assert.ok(updateTask(db, ids[0]!, 1, { title: "Store runs on the phone" }, AT));
    const renamed = await fingerprint();
    const latest = versionsOf(db, ids[1]!).at(-1)!;
    insertArtifact(db, { id: randomUUID(), kind: "brief", lineageId: ids[1]!, content: { ...(latest.content as object), goal: "Show the week's total." }, conversationId: null, taskId: ids[1]!, messageId: null, runLinkId: null, derivedFrom: latest.id, createdAt: AT }, latest.version);
    const revised = await fingerprint();
    insertMissionVersion(db, mission.id, { id: randomUUID(), content: { ...MISSION, nonGoals: ["Social features."] }, createdAt: AT }, 1);
    const missionEdited = await fingerprint();
    const withPreference = missionPreviewFingerprint(await missionDigests(composeMissionReview(db, mission, ids, null), { revision: 1, records: [{ id: randomUUID(), statement: "Prefer small steps.", scope: "personal", intent: "default", revision: 1 }] }));
    const reordered = missionPreviewFingerprint(await missionDigests(composeMissionReview(db, mission, [ids[1]!, ids[0]!], null), NONE));
    assert.equal(new Set([first, renamed, revised, missionEdited, withPreference, reordered]).size, 6);
  });
});

describe("credentials anywhere in a mission review are refused (NIV-52)", () => {
  const known: Array<[string, string]> = [["NEBIUS_API_KEY", KEY]];

  it("checks the whole packet, a task's title and context and a preference included, naming the part and never the value", () => {
    const { db, mission, ids } = seeded(["Store runs", "Weekly total"], { context: { "Weekly total": `Use ${KEY} for the API.` } });
    const composition = composeMissionReview(db, mission, ids, null);
    const inContext = refusal(() => refusePacketCredentials(composition.packet, NONE, known));
    assert.match(inContext, /^T2's context holds .+, so nothing was sent\. Remove it, then preview again\.$/);
    assert.doesNotMatch(inContext, new RegExp(KEY));
    const clean = seeded(["Store runs"]);
    const cleanPacket = composeMissionReview(clean.db, clean.mission, clean.ids, null).packet;
    assert.equal(refusal(() => refusePacketCredentials(cleanPacket, NONE, known)), "not refused");
    assert.match(refusal(() => refusePacketCredentials({ ...cleanPacket, tasks: [{ ...cleanPacket.tasks[0]!, title: `Rotate ${KEY}` }] }, NONE, known)), /^T1's title holds /);
    assert.match(refusal(() => refusePacketCredentials({ ...cleanPacket, mission: { ...cleanPacket.mission, outcome: `Ship with ${KEY}` } }, NONE, known)), /^The mission's outcome holds /);
    const preference = { revision: 1, records: [{ id: randomUUID(), statement: `Always use ${KEY}.`, scope: "personal" as const, intent: "default" as const, revision: 1 }] };
    assert.match(refusal(() => refusePacketCredentials(cleanPacket, preference, known)), /^Your preference 1 holds /);
    assert.match(refusal(() => refusePacketCredentials({ ...cleanPacket, tasks: [{ ...cleanPacket.tasks[0]!, checks: ["curl -H 'Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'"] }] }, NONE, [])), /^T1's checks looks like it holds /);
  });

  it("refuses a private key that starts in one part and ends in another, which the engine would mask as one, naming both parts", () => {
    const { db, mission, ids } = seeded(["Flag key files"]);
    const packet = composeMissionReview(db, mission, ids, null).packet;
    const task = packet.tasks[0]!;
    const acrossFields = { ...packet, tasks: [{ ...task, goal: "Flag a file whose first line is -----BEGIN RSA PRIVATE KEY-----.", acceptanceCriteria: ["A file holding only -----END RSA PRIVATE KEY----- isn't flagged."] }] };
    assert.equal(
      refusal(() => refusePacketCredentials(acrossFields, NONE, [])),
      "What looks like a private key starts in T1's goal and ends in T1's acceptance criteria, so nothing was sent. Remove its first or last line, then preview again.",
    );
    const footer = { revision: 1, records: [{ id: randomUUID(), statement: "Never commit a file ending -----END OPENSSH PRIVATE KEY-----.", scope: "personal" as const, intent: "default" as const, revision: 1 }] };
    const intoPreference = { ...packet, tasks: [{ ...task, context: "Keys begin -----BEGIN OPENSSH PRIVATE KEY-----" }] };
    assert.match(refusal(() => refusePacketCredentials(intoPreference, footer, [])), /^What looks like a private key starts in T1's context and ends in your preference 1, so nothing was sent\./);
    assert.equal(refusal(() => refusePacketCredentials({ ...packet, tasks: [{ ...task, goal: "Flag a file whose first line is -----BEGIN RSA PRIVATE KEY-----." }] }, NONE, [])), "not refused", "a first line alone is no key");
  });

  it("refuses a mission saved with a credential in it", () => {
    assert.match(refusal(() => refuseMissionCredentials({ ...MISSION, intendedUsers: KEY }, [["NEBIUS_API_KEY", KEY]])), /^The mission's intended users holds .+, so nothing was saved\./);
  });
});

describe("a mission from what the person wrote (NIV-52)", () => {
  it("trims each part, drops empty lines, and refuses a missing name or outcome and anything over its limit, naming it", () => {
    assert.deepEqual(missionContentOf({ ...MISSION, name: "  Runner's log ", successCriteria: ["  one ", "", "   "], nonGoals: [" x "] }), { ...MISSION, successCriteria: ["one"], nonGoals: ["x"] });
    assert.deepEqual(
      [
        refusal(() => missionContentOf({ ...MISSION, name: "  " })),
        refusal(() => missionContentOf({ ...MISSION, outcome: "" })),
        refusal(() => missionContentOf({ ...MISSION, outcome: "o".repeat(MISSION_LIMITS.outcomeChars + 1) })),
        refusal(() => missionContentOf({ ...MISSION, constraints: Array.from({ length: MISSION_LIMITS.items + 1 }, (_, n) => `c${n}`) })),
        refusal(() => missionContentOf({ ...MISSION, nonGoals: ["n".repeat(MISSION_LIMITS.itemChars + 1)] })),
      ],
      [
        "A mission needs a name. Write one, then save it.",
        "A mission needs its outcome: what is true once it's done. Write it, then save it.",
        "The mission's outcome is 2,001 characters long, and it can hold 2,000. Shorten it, then save it again.",
        "The mission's constraints can hold 10 items, and this has 11. Combine or remove some, then save it again.",
        "The mission's non-goals item is 301 characters long, and it can hold 300. Shorten it, then save it again.",
      ],
    );
  });
});
