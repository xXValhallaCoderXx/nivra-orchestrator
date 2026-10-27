import { createHash } from "node:crypto";
import { MISSION_LIMITS, type MissionContent, type MissionRef } from "@nivra/domain";
import { insertConversation } from "./workspace.ts";
import { num, str, type Row, type WorkspaceDb } from "./workspace-db.ts";

/**
 * Missions (NIV-52) in the workspace, as plain functions over the open database: a mission and its immutable versions,
 * and the tasks in its backlog. A mission needs no repository. Its review plans and reviews belong to a general
 * conversation of its own (D26, D31), made with it, which holds no messages and isn't listed with conversations. No
 * Electron (D12), so `node --test` drives them directly.
 */

export interface MissionRecord {
  id: string;
  /** The conversation that holds the mission's review plans and reviews, and nothing else. */
  conversationId: string;
  createdAt: string;
}

/** One version of a mission, as stored: its content exactly as the person saved it, and that content's sha256. */
export interface MissionVersionRecord {
  id: string;
  missionId: string;
  version: number;
  content: MissionContent;
  sha256: string;
  createdAt: string;
}

const missionOf = (row: Row): MissionRecord => ({ id: str(row["id"]), conversationId: str(row["conversation_id"]), createdAt: str(row["created_at"]) });

const versionOf = (row: Row): MissionVersionRecord => ({
  id: str(row["id"]),
  missionId: str(row["mission_id"]),
  version: num(row["version"]),
  content: JSON.parse(str(row["content_json"])) as MissionContent,
  sha256: str(row["sha256"]),
  createdAt: str(row["created_at"]),
});

const shaOf = (json: string) => createHash("sha256").update(json).digest("hex");

/** A mission version as a binding names it. */
export const missionRefOf = (version: MissionVersionRecord): MissionRef => ({ missionId: version.missionId, versionId: version.id, version: version.version, sha256: version.sha256 });

/**
 * Makes a mission: its conversation (general, on this computer's engine), the mission, and version 1, in one
 * transaction. The content is checked by the caller.
 */
export function insertMission(workspace: WorkspaceDb, mission: MissionRecord, first: { id: string; content: MissionContent }): MissionVersionRecord {
  return workspace.tx((db) => {
    insertConversation(workspace, { id: mission.conversationId, kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "Mission", createdAt: mission.createdAt, updatedAt: mission.createdAt });
    db.prepare("INSERT INTO missions (id, conversation_id, created_at) VALUES (?, ?, ?)").run(mission.id, mission.conversationId, mission.createdAt);
    const json = JSON.stringify(first.content);
    db.prepare("INSERT INTO mission_versions (id, mission_id, version, content_json, sha256, created_at) VALUES (?, ?, 1, ?, ?, ?)").run(first.id, mission.id, json, shaOf(json), mission.createdAt);
    return getMissionVersion(workspace, first.id)!;
  });
}

/**
 * Adds a mission's next version, in one transaction, only while its latest is still `after`, the version the person
 * read: an edit made from an older version never lands on a newer one (null then, as for a mission that is gone).
 */
export function insertMissionVersion(workspace: WorkspaceDb, missionId: string, version: { id: string; content: MissionContent; createdAt: string }, after: number): MissionVersionRecord | null {
  return workspace.tx((db) => {
    const latest = db.prepare("SELECT MAX(version) AS v FROM mission_versions WHERE mission_id = ?").get(missionId)?.["v"];
    if (latest === null || latest === undefined || num(latest) !== after) return null;
    const json = JSON.stringify(version.content);
    db.prepare("INSERT INTO mission_versions (id, mission_id, version, content_json, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(version.id, missionId, after + 1, json, shaOf(json), version.createdAt);
    return getMissionVersion(workspace, version.id);
  });
}

export function getMission(workspace: WorkspaceDb, missionId: string): MissionRecord | null {
  const row = workspace.db.prepare("SELECT * FROM missions WHERE id = ?").get(missionId);
  return row ? missionOf(row) : null;
}

/** The mission a conversation belongs to, or null for any other conversation. */
export function missionOfConversation(workspace: WorkspaceDb, conversationId: string): MissionRecord | null {
  const row = workspace.db.prepare("SELECT * FROM missions WHERE conversation_id = ?").get(conversationId);
  return row ? missionOf(row) : null;
}

/** Every mission with its latest version, the most recently changed first. */
export function listMissions(workspace: WorkspaceDb): Array<{ mission: MissionRecord; latest: MissionVersionRecord }> {
  const rows = workspace.db
    .prepare(
      "SELECT missions.id AS m_id, missions.conversation_id AS m_conversation, missions.created_at AS m_created, mission_versions.* FROM missions JOIN mission_versions ON mission_versions.mission_id = missions.id WHERE mission_versions.version = (SELECT MAX(version) FROM mission_versions WHERE mission_id = missions.id) ORDER BY mission_versions.created_at DESC, missions.id",
    )
    .all();
  return rows.map((row) => ({ mission: { id: str(row["m_id"]), conversationId: str(row["m_conversation"]), createdAt: str(row["m_created"]) }, latest: versionOf(row) }));
}

/** A mission's versions, oldest first. */
export function missionVersions(workspace: WorkspaceDb, missionId: string): MissionVersionRecord[] {
  return workspace.db.prepare("SELECT * FROM mission_versions WHERE mission_id = ? ORDER BY version").all(missionId).map(versionOf);
}

export function latestMissionVersion(workspace: WorkspaceDb, missionId: string): MissionVersionRecord | null {
  const row = workspace.db.prepare("SELECT * FROM mission_versions WHERE mission_id = ? ORDER BY version DESC LIMIT 1").get(missionId);
  return row ? versionOf(row) : null;
}

export function getMissionVersion(workspace: WorkspaceDb, versionId: string): MissionVersionRecord | null {
  const row = workspace.db.prepare("SELECT * FROM mission_versions WHERE id = ?").get(versionId);
  return row ? versionOf(row) : null;
}

/** Why a task couldn't join a backlog, or that it did. */
export type AddedTask = "added" | "already-here" | "in-another-mission" | "backlog-full" | "gone";

/**
 * Puts a task in a mission's backlog, in one transaction. A task is in one backlog at most, and a backlog holds at most
 * `MISSION_LIMITS.tasks`. Nothing about the task itself changes.
 */
export function addMissionTask(workspace: WorkspaceDb, missionId: string, taskId: string, at: string): AddedTask {
  return workspace.tx((db) => {
    if (!db.prepare("SELECT 1 FROM missions WHERE id = ?").get(missionId) || !db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) return "gone";
    const current = db.prepare("SELECT mission_id FROM mission_tasks WHERE task_id = ?").get(taskId)?.["mission_id"];
    if (current !== undefined) return str(current) === missionId ? "already-here" : "in-another-mission";
    if (num(db.prepare("SELECT COUNT(*) AS n FROM mission_tasks WHERE mission_id = ?").get(missionId)?.["n"]) >= MISSION_LIMITS.tasks) return "backlog-full";
    db.prepare("INSERT INTO mission_tasks (task_id, mission_id, added_at) VALUES (?, ?, ?)").run(taskId, missionId, at);
    return "added";
  });
}

/** Takes a task out of a mission's backlog; the task itself stays as it is. False when it wasn't in that backlog. */
export function removeMissionTask(workspace: WorkspaceDb, missionId: string, taskId: string): boolean {
  return Number(workspace.db.prepare("DELETE FROM mission_tasks WHERE task_id = ? AND mission_id = ?").run(taskId, missionId).changes) === 1;
}

/** The tasks in a mission's backlog, in the order they joined it. */
export function missionTaskIds(workspace: WorkspaceDb, missionId: string): string[] {
  return workspace.db
    .prepare("SELECT task_id FROM mission_tasks WHERE mission_id = ? ORDER BY added_at, rowid")
    .all(missionId)
    .map((row) => str(row["task_id"]));
}

/** The mission whose backlog holds a task, or null. */
export function missionOfTask(workspace: WorkspaceDb, taskId: string): string | null {
  const row = workspace.db.prepare("SELECT mission_id FROM mission_tasks WHERE task_id = ?").get(taskId);
  return row ? str(row["mission_id"]) : null;
}
