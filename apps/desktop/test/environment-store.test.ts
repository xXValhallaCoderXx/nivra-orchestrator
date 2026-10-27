import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EnvironmentReport, PreparedEnvironment } from "@nivra/domain";
import {
  environmentOf,
  getPreparation,
  insertPreparation,
  latestPreparation,
  openPreparations,
  preparationByRun,
  recordPreparationRun,
  requestPreparationStop,
  setPreparationHome,
  settlePreparation,
  withdrawPreparationStop,
} from "../src/main/environment-store.ts";
import { openWorkspace, WORKSPACE_MIGRATIONS, type WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A workspace at the current schema, with the environments' tables (D41). */
function workspace(): WorkspaceDb {
  const dir = mkdtempSync(join(tmpdir(), "nivra environment ü "));
  dirs.push(dir);
  const opening = openWorkspace(join(dir, "workspace.db"));
  assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
  const ready = opening as Extract<WorkspaceOpening, { state: "ready" }>;
  open.push(ready.db);
  assert.equal(ready.schemaVersion, WORKSPACE_MIGRATIONS.length);
  return ready.db;
}

const AT = "2026-10-27T10:00:00.000Z";
const LATER = "2026-10-27T10:05:00.000Z";
const SPEC = { filters: ["@mono/data..."] };
const preparationFor = (projectId: string, id: string = randomUUID()) => ({ id, projectId, sessionId: "s", targetId: "wsl:Ubuntu", spec: SPEC, preview: "e".repeat(64), createdAt: AT });
const prepared = (image: string): PreparedEnvironment => ({
  image,
  base: { tag: "node:22.23.4-alpine3.24", image: "img-imported", imported: true },
  node: "v22.23.4",
  pnpm: "11.5.3",
  arch: "x86_64",
  baseline: "a".repeat(40),
  inputsDigest: "b".repeat(64),
  spec: SPEC,
  installArgs: ["--frozen-lockfile", "--filter", "@mono/data..."],
  projectFingerprint: "f".repeat(64),
  preparedAt: LATER,
});
/** A report as the engine keeps one: `prepared` holds an environment whatever the outcome, so the store's own rule shows. */
const reportOf = (id: string, runId: string, outcome: EnvironmentReport["outcome"], image: string): EnvironmentReport => ({
  outcome,
  stopped: outcome === "prepared" ? null : { code: "install", step: "preparation", message: "The install in the sandbox didn't finish, so no environment was made." },
  prepared: prepared(image),
  install: { exitCode: outcome === "prepared" ? 0 : 1, logTail: "installed\n" },
  steps: [],
  cleanup: null,
  request: { runId, clientRequestId: id },
  updatedAt: LATER,
  finishedAt: LATER,
});
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("a project's environment in the workspace (D41)", () => {
  it("keeps the spec accepted with each preparation, and takes one open preparation of a project at a time", () => {
    const db = workspace();
    const project = randomUUID();
    const other = randomUUID();
    const first = preparationFor(project);
    assert.equal(insertPreparation(db, first), true);
    assert.equal(insertPreparation(db, { ...preparationFor(project), spec: { filters: [] } }), false, "one open preparation per project");
    assert.equal(insertPreparation(db, preparationFor(other)), true, "another project's is its own");
    assert.deepEqual([environmentOf(db, project)?.spec, environmentOf(db, project)?.prepared, latestPreparation(db, project)?.id], [SPEC, null, first.id]);
    assert.deepEqual(openPreparations(db, { projectId: project }).map((one) => [one.id, one.status, one.homeId, one.runId]), [[first.id, "submitting", null, null]]);
    assert.deepEqual(openPreparations(db, { targetId: "wsl:Ubuntu" }).length, 2);
    // Written past the function, a second open one is refused by the schema itself.
    const raw = (id: string) => db.db.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, created_at) VALUES (?, ?, 's', 'local', 'running', '{\"filters\":[]}', 'x', ?)").run(id, project, AT);
    assert.match(refusal(() => raw(randomUUID())), /UNIQUE constraint failed/);
    // Sent, run, and ended: the next one may start, and its spec becomes the accepted one.
    assert.deepEqual([setPreparationHome(db, first.id, "home-1"), setPreparationHome(db, first.id, "home-2")], [true, false]);
    const runId = randomUUID();
    assert.deepEqual([recordPreparationRun(db, first.id, runId), preparationByRun(db, runId)?.id], [true, first.id]);
    assert.equal(settlePreparation(db, first.id, { status: "failed", errorMessage: "The install failed." }, { report: null, prepared: null }, LATER), true);
    const next = { ...preparationFor(project), spec: { filters: [] }, createdAt: LATER };
    assert.equal(insertPreparation(db, next), true);
    assert.deepEqual([environmentOf(db, project)?.spec, latestPreparation(db, project)?.id, getPreparation(db, first.id)?.status], [{ filters: [] }, next.id, "failed"]);
  });

  it("keeps a prepared environment only from a report whose outcome is prepared, and keeps it while a later preparation fails", () => {
    const db = workspace();
    const project = randomUUID();
    const run = (outcome: EnvironmentReport["outcome"], image: string, status: "answered" | "failed") => {
      const preparation = preparationFor(project);
      insertPreparation(db, preparation);
      const runId = randomUUID();
      recordPreparationRun(db, preparation.id, runId);
      const report = reportOf(preparation.id, runId, outcome, image);
      // The host keeps it only on `prepared`; here the report's outcome alone is enough for the store to refuse it.
      settlePreparation(db, preparation.id, { status }, { report, prepared: report.prepared }, LATER);
      return preparation.id;
    };
    const failed = run("failed", "image-failed", "failed");
    assert.deepEqual([environmentOf(db, project)?.prepared, getPreparation(db, failed)?.report?.outcome], [null, "failed"]);
    const good = run("prepared", "image-good", "answered");
    assert.deepEqual([environmentOf(db, project)?.prepared?.image, environmentOf(db, project)?.preparedBy], ["image-good", good]);
    run("failed", "image-later", "failed");
    assert.deepEqual([environmentOf(db, project)?.prepared?.image, environmentOf(db, project)?.preparedBy], ["image-good", good], "a failed preparation leaves the prepared one as it was");
    // An ended preparation keeps its first outcome and report.
    assert.equal(settlePreparation(db, good, { status: "unknown" }, { report: reportOf(good, randomUUID(), "prepared", "image-other"), prepared: prepared("image-other") }, LATER), false);
    assert.equal(getPreparation(db, good)?.report?.prepared?.image, "image-good");
  });

  it("binds a preparation to what it was sent with, keeps its first report, and keeps an environment only from its own project's preparation", () => {
    const db = workspace();
    const project = randomUUID();
    const preparation = preparationFor(project);
    insertPreparation(db, preparation);
    setPreparationHome(db, preparation.id, "home-1");
    const runId = randomUUID();
    recordPreparationRun(db, preparation.id, runId);
    const BOUND = "a preparation keeps what it was bound to, and its first report";
    assert.equal(refusal(() => db.db.prepare("UPDATE preparations SET spec_json = '{\"filters\":[]}' WHERE id = ?").run(preparation.id)), BOUND);
    assert.equal(refusal(() => db.db.prepare("UPDATE preparations SET preview = ? WHERE id = ?").run("d".repeat(64), preparation.id)), BOUND);
    assert.equal(refusal(() => db.db.prepare("UPDATE preparations SET home_id = 'home-2' WHERE id = ?").run(preparation.id)), BOUND);
    assert.equal(refusal(() => db.db.prepare("UPDATE preparations SET run_id = ? WHERE id = ?").run(randomUUID(), preparation.id)), BOUND);
    assert.equal(refusal(() => db.db.prepare("UPDATE preparations SET status = 'failed' WHERE id = ?").run(preparation.id)), "CHECK constraint failed: (status IN ('submitting', 'running')) = (settled_at IS NULL)");
    const report = reportOf(preparation.id, runId, "prepared", "image-good");
    settlePreparation(db, preparation.id, { status: "answered" }, { report, prepared: report.prepared }, LATER);
    assert.equal(refusal(() => db.db.prepare("UPDATE preparations SET report_json = '{}' WHERE id = ?").run(preparation.id)), BOUND);
    // An environment from another project's preparation, or from one with no report, is refused.
    const elsewhere = randomUUID();
    const KEPT = "a prepared environment comes from a preparation of its own project";
    assert.equal(refusal(() => db.db.prepare("INSERT INTO environments (project_id, spec_json, prepared_json, prepared_by, updated_at) VALUES (?, '{}', '{}', ?, ?)").run(elsewhere, preparation.id, AT)), KEPT);
    const unreported = preparationFor(elsewhere);
    insertPreparation(db, unreported);
    assert.equal(refusal(() => db.db.prepare("UPDATE environments SET prepared_json = '{}', prepared_by = ? WHERE project_id = ?").run(unreported.id, elsewhere)), KEPT);
    assert.equal(refusal(() => db.db.prepare("UPDATE environments SET prepared_json = '{}', prepared_by = ? WHERE project_id = ?").run(preparation.id, elsewhere)), KEPT);
    assert.equal(refusal(() => db.db.prepare("UPDATE environments SET project_id = ? WHERE project_id = ?").run(randomUUID(), project)), KEPT);
  });

  it("keeps the first stop's reason, and takes back only a stop that failed, while the preparation is open", () => {
    const db = workspace();
    const preparation = preparationFor(randomUUID());
    insertPreparation(db, preparation);
    assert.deepEqual([requestPreparationStop(db, preparation.id, "uploads"), requestPreparationStop(db, preparation.id, "person")], [true, true]);
    assert.deepEqual([getPreparation(db, preparation.id)?.cancelRequested, getPreparation(db, preparation.id)?.cancelReason], [true, "uploads"]);
    withdrawPreparationStop(db, preparation.id, "person");
    assert.equal(getPreparation(db, preparation.id)?.cancelReason, "uploads", "another reason's withdrawal leaves it");
    withdrawPreparationStop(db, preparation.id, "uploads");
    assert.deepEqual([getPreparation(db, preparation.id)?.cancelRequested, getPreparation(db, preparation.id)?.cancelReason], [false, null]);
    requestPreparationStop(db, preparation.id, "removal");
    settlePreparation(db, preparation.id, { status: "cancelled" }, { report: null, prepared: null }, LATER);
    withdrawPreparationStop(db, preparation.id, "removal");
    assert.deepEqual([getPreparation(db, preparation.id)?.cancelReason, requestPreparationStop(db, preparation.id, "person")], ["removal", false], "an ended one keeps its stop");
  });
});
