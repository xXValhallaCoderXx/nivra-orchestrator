import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EnvironmentReport, PreparedEnvironmentV2 } from "@nivra/domain";
import {
  acceptBuilds,
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
import { preparedOf, setupOf } from "./fixtures/environment-recipe.ts";

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A workspace at the current schema, with the environments' tables (D41, NIV-55). */
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
const SETUP = await setupOf();
const OTHER_SETUP = { ...SETUP, choices: { runtime: "24.20.0" } };
const preparationFor = (projectId: string, id: string = randomUUID()) => ({ id, projectId, sessionId: "s", targetId: "wsl:Ubuntu", setup: SETUP, preview: "e".repeat(64), createdAt: AT });
const prepared = (image: string, builds?: PreparedEnvironmentV2["verified"]["builds"]): Promise<PreparedEnvironmentV2> => preparedOf(image, builds ? { builds } : {});
/** A report as the engine keeps one: `environment` holds one whatever the outcome, so the store's own rule shows. */
const reportOf = async (id: string, runId: string, outcome: EnvironmentReport["outcome"], image: string): Promise<EnvironmentReport> => ({
  outcome,
  stopped: outcome === "prepared" ? null : { code: "install", step: "preparation", message: "The install in the sandbox didn't finish, so no environment was made." },
  prepared: null,
  environment: await prepared(image),
  install: { exitCode: outcome === "prepared" ? 0 : 1, logTail: "installed\n" },
  steps: [],
  cleanup: null,
  request: { runId, clientRequestId: id },
  updatedAt: LATER,
  finishedAt: LATER,
});
/** D41's records, as a workspace written before NIV-55 holds them. */
const D41_SPEC = '{"filters":["@mono/data..."]}';
const D41_PREPARED = JSON.stringify({ image: "img-d41", base: { tag: "node:22.23.4-alpine3.24", image: "img-imported", imported: true }, node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64", baseline: "a".repeat(40), inputsDigest: "b".repeat(64), spec: { filters: [] }, installArgs: ["--frozen-lockfile"], projectFingerprint: "f".repeat(64), preparedAt: LATER });
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("a project's environment in the workspace (D41, NIV-55)", () => {
  it("keeps what each preparation was started with as the project's choices, and takes one open preparation of a project at a time", () => {
    const db = workspace();
    const project = randomUUID();
    const other = randomUUID();
    const first = preparationFor(project);
    assert.equal(insertPreparation(db, first), true);
    assert.equal(insertPreparation(db, { ...preparationFor(project), setup: OTHER_SETUP }), false, "one open preparation per project");
    assert.equal(insertPreparation(db, preparationFor(other)), true, "another project's is its own");
    assert.deepEqual([environmentOf(db, project)?.setup, environmentOf(db, project)?.prepared, environmentOf(db, project)?.legacy, latestPreparation(db, project)?.id], [SETUP, null, false, first.id]);
    assert.deepEqual(openPreparations(db, { projectId: project }).map((one) => [one.id, one.status, one.homeId, one.runId]), [[first.id, "submitting", null, null]]);
    assert.deepEqual(openPreparations(db, { targetId: "wsl:Ubuntu" }).length, 2);
    // Written past the function, a second open one is refused by the schema itself.
    const raw = (id: string) => db.db.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, created_at) VALUES (?, ?, 's', 'local', 'running', '{\"filters\":[]}', 'x', ?)").run(id, project, AT);
    assert.match(refusal(() => raw(randomUUID())), /UNIQUE constraint failed/);
    // Sent, run, and ended: the next one may start, and what it was started with becomes the project's.
    assert.deepEqual([setPreparationHome(db, first.id, "home-1"), setPreparationHome(db, first.id, "home-2")], [true, false]);
    const runId = randomUUID();
    assert.deepEqual([recordPreparationRun(db, first.id, runId), preparationByRun(db, runId)?.id], [true, first.id]);
    assert.equal(settlePreparation(db, first.id, { status: "failed", errorMessage: "The install failed." }, { report: null, prepared: null }, LATER), true);
    const next = { ...preparationFor(project), setup: OTHER_SETUP, createdAt: LATER };
    assert.equal(insertPreparation(db, next), true);
    assert.deepEqual([environmentOf(db, project)?.setup, latestPreparation(db, project)?.id, getPreparation(db, first.id)?.status], [OTHER_SETUP, next.id, "failed"]);
  });

  it("keeps a prepared environment only from a report whose outcome is prepared, and keeps it while a later preparation fails", async () => {
    const db = workspace();
    const project = randomUUID();
    const run = async (outcome: EnvironmentReport["outcome"], image: string, status: "answered" | "failed") => {
      const preparation = preparationFor(project);
      insertPreparation(db, preparation);
      const runId = randomUUID();
      recordPreparationRun(db, preparation.id, runId);
      const report = await reportOf(preparation.id, runId, outcome, image);
      // The host keeps it only on `prepared`; here the report's outcome alone is enough for the store to refuse it.
      settlePreparation(db, preparation.id, { status }, { report, prepared: report.environment ?? null }, LATER);
      return preparation.id;
    };
    const imageOf = () => environmentOf(db, project)?.prepared?.verified.images.prepared;
    const failed = await run("failed", "image-failed", "failed");
    assert.deepEqual([environmentOf(db, project)?.prepared, getPreparation(db, failed)?.report?.outcome], [null, "failed"]);
    const good = await run("prepared", "image-good", "answered");
    assert.deepEqual([imageOf(), environmentOf(db, project)?.preparedBy, environmentOf(db, project)?.legacy], ["image-good", good, false]);
    await run("failed", "image-later", "failed");
    assert.deepEqual([imageOf(), environmentOf(db, project)?.preparedBy], ["image-good", good], "a failed preparation leaves the prepared one as it was");
    // An ended preparation keeps its first outcome and report.
    assert.equal(settlePreparation(db, good, { status: "unknown" }, { report: await reportOf(good, randomUUID(), "prepared", "image-other"), prepared: await prepared("image-other") }, LATER), false);
    assert.equal(getPreparation(db, good)?.report?.environment?.verified.images.prepared, "image-good");
  });

  it("binds a preparation to what it was sent with, keeps its first report, and keeps an environment only from its own project's preparation", async () => {
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
    const report = await reportOf(preparation.id, runId, "prepared", "image-good");
    settlePreparation(db, preparation.id, { status: "answered" }, { report, prepared: report.environment ?? null }, LATER);
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

  it("reads D41's records as legacy and a record it can't read as none, never as anything a run would use (NIV-55)", async () => {
    const db = workspace();
    const project = randomUUID();
    const id = randomUUID();
    const report = JSON.stringify({ outcome: "prepared", stopped: null, prepared: JSON.parse(D41_PREPARED), install: { exitCode: 0, logTail: "" }, steps: [], cleanup: null, request: { runId: randomUUID(), clientRequestId: id }, updatedAt: LATER, finishedAt: LATER });
    db.db.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, report_json, reported_at, created_at, settled_at) VALUES (?, ?, 's', 'local', 'answered', ?, 'x', ?, ?, ?, ?)").run(id, project, D41_SPEC, report, LATER, AT, LATER);
    db.db.prepare("INSERT INTO environments (project_id, spec_json, prepared_json, prepared_by, updated_at) VALUES (?, ?, ?, ?, ?)").run(project, D41_SPEC, D41_PREPARED, id, LATER);
    assert.deepEqual(environmentOf(db, project), { projectId: project, setup: null, prepared: null, legacy: true, preparedBy: id, builds: null, updatedAt: LATER });
    // D41's report still reads as the report it was, so its preparation is shown as it ended.
    assert.deepEqual([getPreparation(db, id)?.setup, getPreparation(db, id)?.report?.prepared?.image], [null, "img-d41"]);
    // A row that isn't JSON, or isn't a shape Nivra knows, is none of it.
    const broken = randomUUID();
    const brokenId = randomUUID();
    db.db.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, report_json, reported_at, created_at, settled_at) VALUES (?, ?, 's', 'local', 'answered', 'not json', 'x', '{\"outcome\":\"prepared\"}', ?, ?, ?)").run(brokenId, broken, LATER, AT, LATER);
    db.db.prepare("INSERT INTO environments (project_id, spec_json, prepared_json, prepared_by, updated_at) VALUES (?, 'not json', '{\"format\":\"nivra.environment-prepared.v9\"}', ?, ?)").run(broken, brokenId, LATER);
    assert.deepEqual([environmentOf(db, broken)?.setup, environmentOf(db, broken)?.prepared, environmentOf(db, broken)?.legacy, getPreparation(db, brokenId)?.setup, getPreparation(db, brokenId)?.report], [null, null, true, null, null]);
  });

  it("takes an acceptance of missing builds only for the environment kept now, and ends it when another environment lands (NIV-55)", async () => {
    const db = workspace();
    const project = randomUUID();
    const land = async (image: string, builds: PreparedEnvironmentV2["verified"]["builds"]) => {
      const preparation = preparationFor(project);
      insertPreparation(db, preparation);
      const runId = randomUUID();
      recordPreparationRun(db, preparation.id, runId);
      const environment = await prepared(image, builds);
      const report = { ...(await reportOf(preparation.id, runId, "prepared", image)), environment };
      settlePreparation(db, preparation.id, { status: "answered" }, { report, prepared: environment }, LATER);
      return environment;
    };
    const first = await land("image-1", { state: "missing", missing: ["sharp"] });
    const acceptance = { verified: first.verifiedDigest, missing: ["sharp"], acceptedAt: LATER };
    assert.equal(acceptBuilds(db, project, { ...acceptance, verified: "0".repeat(64) }, LATER), false, "an acceptance for another environment");
    assert.equal(acceptBuilds(db, project, acceptance, LATER), true);
    assert.deepEqual(environmentOf(db, project)?.builds, acceptance);
    const BUILDS = "an acceptance of missing builds names the environment it was given for";
    assert.equal(refusal(() => db.db.prepare("UPDATE environments SET builds_json = ? WHERE project_id = ?").run(JSON.stringify({ ...acceptance, verified: "0".repeat(64) }), project)), BUILDS);
    assert.equal(refusal(() => db.db.prepare("INSERT INTO environments (project_id, spec_json, updated_at, builds_json) VALUES (?, '{}', ?, ?)").run(randomUUID(), AT, JSON.stringify(acceptance))), BUILDS);
    // Another environment lands: the acceptance was for the one before, so it ends.
    const second = await land("image-2", { state: "missing", missing: ["sharp"] });
    assert.deepEqual([environmentOf(db, project)?.prepared?.verifiedDigest, environmentOf(db, project)?.builds], [second.verifiedDigest, null]);
    assert.equal(refusal(() => db.db.prepare("UPDATE environments SET builds_json = ? WHERE project_id = ?").run(JSON.stringify(acceptance), project)), BUILDS, "the old acceptance can't be put back");
    assert.equal(acceptBuilds(db, randomUUID(), { ...acceptance, verified: second.verifiedDigest }, LATER), false, "a project with no environment");
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
