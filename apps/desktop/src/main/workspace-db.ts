import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { renameRetrying } from "./host-store.ts";

/**
 * The host's workspace (D26): conversations, their messages and turns, native tasks, the versions of plans and briefs,
 * the reviews of plan versions (D31) and research of their assumptions (D37), and each project's environment (D41), in
 * one SQLite file beside `nivra.json`.
 * The host is its only owner and opens it only on its own OS (D7); the engines keep their own run records. Built on
 * Node's own `node:sqlite`, so Electron's main process loads no addon (D6). Opened like an engine's database: WAL,
 * SQLite's exclusive lock taken at once and held until close (so a second Nivra on the same profile is refused instead
 * of waiting), foreign keys enforced, and deleted rows overwritten.
 *
 * Opening never throws. A file that can't be used is reported as state, so everything that doesn't need the workspace
 * keeps working, and only a damaged file is ever moved: kept aside with its journal files, never deleted. A file that
 * isn't a SQLite database at all is recognised by its header before SQLite opens it, because SQLite removes a stray WAL
 * file when it closes such a connection. For the same reason a database that a session left a journal beside (it
 * didn't close cleanly) is read first through a read-only connection, which can't fold the journal in or remove it, so a
 * damaged one is kept aside as it was found. A schema written by a newer Nivra is refused before anything is changed.
 */

export type Row = Record<string, SQLOutputValue>;
export const str = (value: SQLOutputValue | undefined): string => String(value);
export const strOrNull = (value: SQLOutputValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
export const num = (value: SQLOutputValue | undefined): number => Number(value);

/** The schema, one entry per version. Append only: a released version is never edited. */
export const WORKSPACE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('general', 'project')),
    project_id TEXT,
    project_label TEXT,
    target_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((kind = 'general') = (project_id IS NULL))
  ) STRICT;
  CREATE INDEX conversations_updated ON conversations(updated_at);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'active', 'review', 'completed')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- Plans belong to the conversation they came from, briefs to their task. A row is never changed: an edit is a new
  -- version in the same lineage.
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('plan', 'brief')),
    lineage_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    content_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT,
    run_link_id TEXT,
    derived_from TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (lineage_id, version),
    CHECK ((kind = 'plan') = (conversation_id IS NOT NULL)),
    CHECK ((kind = 'brief') = (task_id IS NOT NULL))
  ) STRICT;
  CREATE TRIGGER artifacts_immutable BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifact versions are immutable'); END;

  -- One attempt at a run: a conversation's turn now, a task's attempt later. Its id is the clientRequestId, saved before
  -- runs.start is sent, so a send whose answer was lost can be found again on its own engine.
  CREATE TABLE run_links (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    brief_id TEXT REFERENCES artifacts(id),
    session_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    home_id TEXT,
    run_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('submitting', 'running', 'answered', 'failed', 'cancelled', 'interrupted', 'not-sent', 'unknown')),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    cancel_reason TEXT CHECK (cancel_reason IN ('person', 'sharing', 'removal', 'deletion')),
    error_kind TEXT,
    error_message TEXT,
    preferences_json TEXT NOT NULL,
    history_json TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    CHECK ((conversation_id IS NULL) <> (task_id IS NULL)),
    CHECK ((task_id IS NULL) = (brief_id IS NULL))
  ) STRICT;
  CREATE INDEX run_links_open ON run_links(status) WHERE status IN ('submitting', 'running');

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('person', 'assistant')),
    text TEXT NOT NULL,
    reply_json TEXT,
    run_link_id TEXT REFERENCES run_links(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, seq)
  ) STRICT;
  -- A turn has one question and at most one answer, so projecting an answer twice still leaves one.
  CREATE UNIQUE INDEX messages_one_per_turn ON messages(run_link_id, role) WHERE run_link_id IS NOT NULL;
  `,
  `
  -- A review of one saved plan version (D31): a run link with workflow 'review', and what it was bound to when it was
  -- asked for. The plan is referenced, never copied (its versions are immutable), and the packet's text isn't kept: its
  -- fingerprint is. The engine's report, masked again, is kept once, when the review ends.
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY REFERENCES run_links(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    plan_lineage TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
    plan_sha256 TEXT NOT NULL,
    panel TEXT NOT NULL CHECK (panel IN ('council', 'single')),
    packet_digest TEXT NOT NULL,
    preferences_digest TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('general', 'project')),
    project_id TEXT,
    project_label TEXT,
    head_at_start TEXT,
    report_json TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((scope_kind = 'general') = (project_id IS NULL)),
    CHECK ((report_json IS NULL) = (reported_at IS NULL))
  ) STRICT;
  CREATE INDEX reviews_conversation ON reviews(conversation_id, created_at);
  CREATE TRIGGER reviews_bound BEFORE INSERT ON reviews
  WHEN NOT EXISTS (SELECT 1 FROM run_links WHERE id = NEW.id AND workflow_id = 'review' AND conversation_id = NEW.conversation_id)
    OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.plan_id AND kind = 'plan' AND conversation_id = NEW.conversation_id AND lineage_id = NEW.plan_lineage AND version = NEW.plan_version AND sha256 = NEW.plan_sha256
    )
  BEGIN SELECT RAISE(ABORT, 'a review is bound to a review run and to a plan version of its own conversation'); END;
  CREATE TRIGGER reviews_frozen BEFORE UPDATE ON reviews
  WHEN NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_lineage IS NOT OLD.plan_lineage
    OR NEW.plan_version IS NOT OLD.plan_version OR NEW.plan_sha256 IS NOT OLD.plan_sha256 OR NEW.panel IS NOT OLD.panel OR NEW.packet_digest IS NOT OLD.packet_digest
    OR NEW.preferences_digest IS NOT OLD.preferences_digest OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.project_id IS NOT OLD.project_id
    OR NEW.project_label IS NOT OLD.project_label OR NEW.head_at_start IS NOT OLD.head_at_start OR NEW.created_at IS NOT OLD.created_at
    OR OLD.report_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a review never changes what it was bound to, and keeps its first report'); END;
  -- A run link's workflow and owner are set once: a turn never becomes a review, or moves to another conversation.
  CREATE TRIGGER run_links_fixed BEFORE UPDATE OF workflow_id, conversation_id, task_id, brief_id ON run_links
  WHEN NEW.workflow_id IS NOT OLD.workflow_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.task_id IS NOT OLD.task_id OR NEW.brief_id IS NOT OLD.brief_id
  BEGIN SELECT RAISE(ABORT, 'a run link keeps its workflow and its owner'); END;
  `,
  `
  -- Research of one saved plan version's assumptions (NIV-45): a run link with workflow 'research', and what it was
  -- bound to. A stop's cause and token, the report and the amended plan are the only things that change afterwards.
  CREATE TABLE research (
    id TEXT PRIMARY KEY REFERENCES run_links(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    plan_lineage TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
    plan_sha256 TEXT NOT NULL,
    packet_digest TEXT NOT NULL,
    queries_json TEXT NOT NULL,
    sites_json TEXT,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('general', 'project')),
    project_id TEXT,
    project_label TEXT,
    head_at_start TEXT,
    stop_cause TEXT CHECK (stop_cause IN ('person', 'web-research', 'model-sharing', 'removal', 'deletion')),
    stop_token TEXT,
    amended_plan_id TEXT,
    report_json TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((scope_kind = 'general') = (project_id IS NULL)),
    CHECK ((report_json IS NULL) = (reported_at IS NULL)),
    CHECK ((stop_cause IS NULL) = (stop_token IS NULL))
  ) STRICT;
  CREATE INDEX research_conversation ON research(conversation_id, created_at);
  CREATE TRIGGER research_bound BEFORE INSERT ON research
  WHEN NOT EXISTS (SELECT 1 FROM run_links WHERE id = NEW.id AND workflow_id = 'research' AND conversation_id = NEW.conversation_id)
    OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.plan_id AND kind = 'plan' AND conversation_id = NEW.conversation_id AND lineage_id = NEW.plan_lineage AND version = NEW.plan_version AND sha256 = NEW.plan_sha256
    )
    OR NEW.stop_cause IS NOT NULL OR NEW.amended_plan_id IS NOT NULL OR NEW.report_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'research is bound to a research run and to a plan version of its own conversation'); END;
  CREATE TRIGGER research_frozen BEFORE UPDATE ON research
  WHEN NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_lineage IS NOT OLD.plan_lineage
    OR NEW.plan_version IS NOT OLD.plan_version OR NEW.plan_sha256 IS NOT OLD.plan_sha256 OR NEW.packet_digest IS NOT OLD.packet_digest
    OR NEW.queries_json IS NOT OLD.queries_json OR NEW.sites_json IS NOT OLD.sites_json OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.project_id IS NOT OLD.project_id
    OR NEW.project_label IS NOT OLD.project_label OR NEW.head_at_start IS NOT OLD.head_at_start OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.report_json IS NOT NULL AND (NEW.report_json IS NOT OLD.report_json OR NEW.reported_at IS NOT OLD.reported_at))
    OR (OLD.amended_plan_id IS NOT NULL AND NEW.amended_plan_id IS NOT OLD.amended_plan_id)
    -- The amended plan comes from a report, and is a version of the researched plan derived from it.
    OR (OLD.amended_plan_id IS NULL AND NEW.amended_plan_id IS NOT NULL AND (NEW.report_json IS NULL OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.amended_plan_id AND kind = 'plan' AND conversation_id = OLD.conversation_id AND lineage_id = OLD.plan_lineage AND derived_from = OLD.plan_id
    )))
    -- A stop is asked for, or withdrawn, only while the run is open.
    OR ((NEW.stop_cause IS NOT OLD.stop_cause OR NEW.stop_token IS NOT OLD.stop_token)
      AND NOT EXISTS (SELECT 1 FROM run_links WHERE id = OLD.id AND status IN ('submitting', 'running')))
  BEGIN SELECT RAISE(ABORT, 'research never changes what it was bound to, keeps its first report and its amended plan, and changes its stop only while it runs'); END;
  `,
  `
  -- What became of a task's attempt (D40), recorded apart: how its run ended, kept when it ended, so the history shows
  -- without its engine; the person's decision on its proposal; its apply, by the request id saved before task.apply is
  -- sent and the repository it was sent for, with the engine's last answer about it (or the host's own note when the
  -- engine couldn't say); a settling of it (accepted, dismissed, kept, or a restore), saved before it is sent, so a
  -- restart reads its end back rather than sending it again; and the person's acceptance of an applied change, with why
  -- it didn't complete the task when the task had moved on since the run.
  CREATE TABLE attempt_records (
    attempt_id TEXT PRIMARY KEY REFERENCES run_links(id) ON DELETE CASCADE,
    outcome TEXT,
    verified INTEGER CHECK (verified IN (0, 1)),
    proposal_hash TEXT,
    baseline TEXT,
    outcome_at TEXT,
    decision TEXT CHECK (decision IN ('approved', 'rejected', 'revision')),
    decided_at TEXT,
    revision_note TEXT,
    apply_request_id TEXT UNIQUE,
    apply_project_id TEXT,
    apply_json TEXT,
    apply_read_at TEXT,
    apply_note TEXT,
    settle_intent TEXT CHECK (settle_intent IN ('accepted', 'dismissed', 'kept', 'restore')),
    settle_requested_at TEXT,
    accepted_at TEXT,
    accept_note TEXT,
    CHECK ((outcome IS NULL) = (outcome_at IS NULL)),
    CHECK ((decision IS NULL) = (decided_at IS NULL)),
    CHECK ((apply_project_id IS NULL) = (apply_request_id IS NULL)),
    CHECK ((apply_json IS NULL) = (apply_read_at IS NULL)),
    CHECK (revision_note IS NULL OR decision = 'revision'),
    CHECK (accepted_at IS NULL OR (decision = 'approved' AND apply_request_id IS NOT NULL)),
    CHECK ((settle_intent IS NULL) = (settle_requested_at IS NULL)),
    CHECK (settle_intent IS NULL OR (decision = 'approved' AND apply_request_id IS NOT NULL)),
    CHECK (accept_note IS NULL OR accepted_at IS NOT NULL)
  ) STRICT;
  CREATE TRIGGER attempt_records_task BEFORE INSERT ON attempt_records
  WHEN NOT EXISTS (SELECT 1 FROM run_links WHERE id = NEW.attempt_id AND workflow_id = 'task')
  BEGIN SELECT RAISE(ABORT, 'an attempt record belongs to a task run'); END;
  `,
  `
  -- A project's environment (D41): the spec the person accepted for it, and the environment its last successful
  -- preparation left; and each preparation, kept as a task's attempt is: its id is the request id, saved before
  -- runs.start is sent, the engine store it went to is recorded just before, and its engine's report, masked again, is
  -- kept when it ends. Projects live in nivra.json, so both name theirs by id; a removed project's rows stay, as its
  -- conversations do.
  CREATE TABLE environments (
    project_id TEXT PRIMARY KEY,
    spec_json TEXT NOT NULL,
    prepared_json TEXT,
    prepared_by TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((prepared_json IS NULL) = (prepared_by IS NULL))
  ) STRICT;

  CREATE TABLE preparations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    home_id TEXT,
    run_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('submitting', 'running', 'answered', 'failed', 'cancelled', 'interrupted', 'not-sent', 'unknown')),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    cancel_reason TEXT CHECK (cancel_reason IN ('person', 'uploads', 'removal')),
    error_kind TEXT,
    error_message TEXT,
    spec_json TEXT NOT NULL,
    preview TEXT NOT NULL,
    report_json TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    CHECK ((report_json IS NULL) = (reported_at IS NULL)),
    CHECK ((status IN ('submitting', 'running')) = (settled_at IS NULL))
  ) STRICT;
  CREATE INDEX preparations_project ON preparations(project_id, created_at);
  -- One preparation of a project at a time, however quickly two arrive.
  CREATE UNIQUE INDEX preparations_one_open ON preparations(project_id) WHERE status IN ('submitting', 'running');
  CREATE TRIGGER preparations_bound BEFORE UPDATE ON preparations
  WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.session_id IS NOT OLD.session_id OR NEW.target_id IS NOT OLD.target_id
    OR NEW.spec_json IS NOT OLD.spec_json OR NEW.preview IS NOT OLD.preview OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.home_id IS NOT NULL AND NEW.home_id IS NOT OLD.home_id) OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
    OR (OLD.report_json IS NOT NULL AND (NEW.report_json IS NOT OLD.report_json OR NEW.reported_at IS NOT OLD.reported_at))
  BEGIN SELECT RAISE(ABORT, 'a preparation keeps what it was bound to, and its first report'); END;
  -- The environment kept is one that a preparation of the same project reported.
  CREATE TRIGGER environments_prepared BEFORE INSERT ON environments
  WHEN NEW.prepared_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM preparations WHERE id = NEW.prepared_by AND project_id = NEW.project_id AND report_json IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'a prepared environment comes from a preparation of its own project'); END;
  CREATE TRIGGER environments_kept BEFORE UPDATE ON environments
  WHEN NEW.project_id IS NOT OLD.project_id
    OR (NEW.prepared_by IS NOT NULL AND NEW.prepared_by IS NOT OLD.prepared_by
      AND NOT EXISTS (SELECT 1 FROM preparations WHERE id = NEW.prepared_by AND project_id = NEW.project_id AND report_json IS NOT NULL))
  BEGIN SELECT RAISE(ABORT, 'a prepared environment comes from a preparation of its own project'); END;
  `,
  `
  -- Missions (NIV-52): what a piece of work is for, in immutable versions, with a backlog of native tasks. A mission
  -- needs no repository. Its review plans and their reviews belong to a general conversation of its own, because a plan
  -- and a review's run link belong to a conversation (D26, D31); that conversation has no messages and isn't listed. No
  -- table before this one changes.
  CREATE TABLE missions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER missions_conversation BEFORE INSERT ON missions
  WHEN NOT EXISTS (SELECT 1 FROM conversations WHERE id = NEW.conversation_id AND kind = 'general')
    OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = NEW.conversation_id)
  BEGIN SELECT RAISE(ABORT, 'a mission owns a general conversation of its own, with no messages'); END;
  CREATE TRIGGER missions_fixed BEFORE UPDATE ON missions BEGIN SELECT RAISE(ABORT, 'a mission keeps its conversation'); END;
  CREATE TABLE mission_versions (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    content_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (mission_id, version)
  ) STRICT;
  CREATE TRIGGER mission_versions_immutable BEFORE UPDATE ON mission_versions BEGIN SELECT RAISE(ABORT, 'mission versions are immutable'); END;
  -- A task is in at most one mission's backlog. Leaving it, or the mission going, leaves the task as it was.
  CREATE TABLE mission_tasks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX mission_tasks_mission ON mission_tasks(mission_id, added_at);
  `,
  `
  -- A coaching of one task (NIV-53): a run link with workflow 'coach', owned by the task and bound to the brief version
  -- the coach read, and what it was bound to when it was asked for. The packet isn't kept: its fingerprint is, with the
  -- context binding's and the preferences'. The engine's report, masked again, is kept once, when the run ends; the
  -- brief version the person's ticked changes made, and which fields, once, after the report.
  CREATE TABLE coachings (
    id TEXT PRIMARY KEY REFERENCES run_links(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    brief_version INTEGER NOT NULL CHECK (brief_version >= 1),
    brief_sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    project_id TEXT,
    binding_json TEXT NOT NULL,
    binding_digest TEXT NOT NULL,
    packet_digest TEXT NOT NULL,
    preferences_digest TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    profile_version INTEGER NOT NULL CHECK (profile_version >= 1),
    mission_json TEXT,
    findings INTEGER NOT NULL CHECK (findings >= 0),
    preferences INTEGER NOT NULL CHECK (preferences >= 0),
    report_json TEXT,
    reported_at TEXT,
    applied_brief_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
    applied_fields_json TEXT,
    applied_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((report_json IS NULL) = (reported_at IS NULL)),
    CHECK ((applied_brief_id IS NULL) = (applied_at IS NULL)),
    CHECK ((applied_brief_id IS NULL) = (applied_fields_json IS NULL)),
    CHECK (applied_brief_id IS NULL OR report_json IS NOT NULL)
  ) STRICT;
  CREATE INDEX coachings_task ON coachings(task_id, created_at);
  CREATE TRIGGER coachings_bound BEFORE INSERT ON coachings
  WHEN NOT EXISTS (SELECT 1 FROM run_links WHERE id = NEW.id AND workflow_id = 'coach' AND task_id = NEW.task_id AND brief_id = NEW.brief_id)
    OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.brief_id AND kind = 'brief' AND task_id = NEW.task_id AND lineage_id = NEW.task_id AND version = NEW.brief_version AND sha256 = NEW.brief_sha256
    )
    OR NEW.report_json IS NOT NULL OR NEW.applied_brief_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a coaching is bound to a coach run of its own task and to a version of that task''s brief'); END;
  CREATE TRIGGER coachings_frozen BEFORE UPDATE ON coachings
  WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.brief_id IS NOT OLD.brief_id OR NEW.brief_version IS NOT OLD.brief_version
    OR NEW.brief_sha256 IS NOT OLD.brief_sha256 OR NEW.title IS NOT OLD.title OR NEW.project_id IS NOT OLD.project_id
    OR NEW.binding_json IS NOT OLD.binding_json OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.packet_digest IS NOT OLD.packet_digest
    OR NEW.preferences_digest IS NOT OLD.preferences_digest OR NEW.profile_id IS NOT OLD.profile_id OR NEW.profile_version IS NOT OLD.profile_version
    OR NEW.mission_json IS NOT OLD.mission_json OR NEW.findings IS NOT OLD.findings OR NEW.preferences IS NOT OLD.preferences
    OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.report_json IS NOT NULL AND (NEW.report_json IS NOT OLD.report_json OR NEW.reported_at IS NOT OLD.reported_at))
    OR (OLD.applied_brief_id IS NOT NULL AND (NEW.applied_brief_id IS NOT OLD.applied_brief_id OR NEW.applied_fields_json IS NOT OLD.applied_fields_json OR NEW.applied_at IS NOT OLD.applied_at))
    -- Saved changes come from a report, as the next version of the same task's brief, made from the version the coach read.
    OR (OLD.applied_brief_id IS NULL AND NEW.applied_brief_id IS NOT NULL AND (NEW.report_json IS NULL OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.applied_brief_id AND kind = 'brief' AND task_id = OLD.task_id AND version > OLD.brief_version AND derived_from = OLD.brief_id
    )))
  BEGIN SELECT RAISE(ABORT, 'a coaching never changes what it was bound to, keeps its first report, and records its saved changes once, after its report'); END;
`,
  `
  -- The shared monthly budget (NIV-66): one ledger for every paid activity this installation sends, kept by the host
  -- alone (D7). Engines get finite grants and journal their own operations. This keeps what the person chose, the
  -- months, the price lists, every grant, and the operations each grant's sealed journal reported. The ledger's id and
  -- its authority revision are written with its first change, and the revision moves forward with every change to
  -- spending authority, so a guard kept outside this file can tell a ledger that was replaced or put back. No table
  -- before this one changes.
  CREATE TABLE budget_authority (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    ledger_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER budget_authority_forward BEFORE UPDATE ON budget_authority
  WHEN NEW.ledger_id IS NOT OLD.ledger_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision <= OLD.revision
  BEGIN SELECT RAISE(ABORT, 'the budget ledger keeps its id, and its revision only moves forward'); END;
  CREATE TRIGGER budget_authority_kept BEFORE DELETE ON budget_authority BEGIN SELECT RAISE(ABORT, 'the budget ledger is kept'); END;

  -- What the person chose, one immutable version at a time. A change is the next version and resets nothing.
  CREATE TABLE budget_policies (
    version INTEGER PRIMARY KEY CHECK (version >= 1),
    policy_json TEXT NOT NULL,
    replaces INTEGER REFERENCES budget_policies(version),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    CHECK ((version = 1) = (replaces IS NULL)),
    CHECK (replaces IS NULL OR replaces = version - 1)
  ) STRICT;
  CREATE TRIGGER budget_policies_kept BEFORE UPDATE ON budget_policies BEGIN SELECT RAISE(ABORT, 'a policy version is immutable'); END;
  CREATE TRIGGER budget_policies_not_removed BEFORE DELETE ON budget_policies BEGIN SELECT RAISE(ABORT, 'policy versions are kept'); END;

  -- Budget months, in the policy's time zone. Only the first opens without evidence; every later one needs the
  -- provider's clock past its start, or the person's word. The index only moves forward.
  CREATE TABLE budget_periods (
    idx INTEGER PRIMARY KEY CHECK (idx >= 0),
    label TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    opened_by TEXT NOT NULL CHECK (opened_by IN ('first', 'corroborated', 'confirmed')),
    evidence_json TEXT,
    opened_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    CHECK ((opened_by = 'first') = (evidence_json IS NULL))
  ) STRICT;
  CREATE TRIGGER budget_periods_forward BEFORE INSERT ON budget_periods
  WHEN EXISTS (SELECT 1 FROM budget_periods WHERE idx >= NEW.idx)
    OR ((NEW.opened_by = 'first') <> (NOT EXISTS (SELECT 1 FROM budget_periods)))
  BEGIN SELECT RAISE(ABORT, 'budget months only move forward, and only the first opens without evidence'); END;
  CREATE TRIGGER budget_periods_kept BEFORE UPDATE ON budget_periods BEGIN SELECT RAISE(ABORT, 'a budget month is kept as it was opened'); END;
  CREATE TRIGGER budget_periods_not_removed BEFORE DELETE ON budget_periods BEGIN SELECT RAISE(ABORT, 'budget months are kept'); END;

  -- What the clocks said: jumps of the computer's clock, and the provider's times that an engine recorded.
  CREATE TABLE budget_clock (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('jump-forward', 'jump-back', 'provider')),
    wall_at TEXT NOT NULL,
    provider_at TEXT,
    delta_ms INTEGER,
    recorded_at TEXT NOT NULL,
    CHECK ((kind = 'provider') = (provider_at IS NOT NULL))
  ) STRICT;
  CREATE TRIGGER budget_clock_kept BEFORE UPDATE ON budget_clock BEGIN SELECT RAISE(ABORT, 'clock records are kept as written'); END;

  CREATE TABLE price_catalogues (
    version TEXT PRIMARY KEY,
    catalogue_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    registered_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER price_catalogues_kept BEFORE UPDATE ON price_catalogues BEGIN SELECT RAISE(ABORT, 'a price list version is immutable'); END;

  -- Every spendable call's grant, written before anything is sent, with the request id it is sent under and the engine
  -- store (home id) recorded when it is marked dispatching. What it was written with never changes; its state only
  -- moves forward; and its journal's rows are recorded once, with its seal.
  CREATE TABLE budget_grants (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    workflow TEXT NOT NULL,
    target_id TEXT NOT NULL,
    home_id TEXT,
    period_idx INTEGER NOT NULL REFERENCES budget_periods(idx),
    policy_version INTEGER REFERENCES budget_policies(version),
    catalogue_version TEXT NOT NULL REFERENCES price_catalogues(version),
    grant_json TEXT NOT NULL,
    attribution_json TEXT NOT NULL,
    feature TEXT NOT NULL,
    project_id TEXT,
    attempt_id TEXT,
    queue_id TEXT,
    profile_id TEXT,
    model TEXT,
    productive_micros INTEGER CHECK (productive_micros >= 0),
    finalisation_micros INTEGER CHECK (finalisation_micros >= 0),
    extends_id TEXT REFERENCES budget_grants(id),
    need TEXT,
    state TEXT NOT NULL CHECK (state IN ('written', 'dispatching', 'accepted', 'settled', 'released', 'uncertain', 'written-off')),
    seal_kind TEXT CHECK (seal_kind IN ('complete', 'interrupted')),
    recorded_micros INTEGER CHECK (recorded_micros >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((productive_micros IS NULL) = (finalisation_micros IS NULL)),
    CHECK ((extends_id IS NULL) = (need IS NULL)),
    CHECK (state IN ('written', 'released') OR home_id IS NOT NULL),
    CHECK (state <> 'settled' OR seal_kind = 'complete'),
    CHECK (seal_kind IS NULL OR recorded_micros IS NOT NULL OR productive_micros IS NULL)
  ) STRICT;
  CREATE INDEX budget_grants_period ON budget_grants(period_idx, state);
  CREATE INDEX budget_grants_request ON budget_grants(request_id);
  CREATE UNIQUE INDEX budget_grants_one_per_need ON budget_grants(extends_id, need) WHERE extends_id IS NOT NULL;
  CREATE TRIGGER budget_grants_moves BEFORE UPDATE ON budget_grants
  WHEN NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.workflow IS NOT OLD.workflow OR NEW.target_id IS NOT OLD.target_id
    OR NEW.period_idx IS NOT OLD.period_idx OR NEW.policy_version IS NOT OLD.policy_version OR NEW.catalogue_version IS NOT OLD.catalogue_version
    OR NEW.grant_json IS NOT OLD.grant_json OR NEW.attribution_json IS NOT OLD.attribution_json OR NEW.feature IS NOT OLD.feature
    OR NEW.project_id IS NOT OLD.project_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.queue_id IS NOT OLD.queue_id
    OR NEW.profile_id IS NOT OLD.profile_id OR NEW.model IS NOT OLD.model
    OR NEW.productive_micros IS NOT OLD.productive_micros OR NEW.finalisation_micros IS NOT OLD.finalisation_micros
    OR NEW.extends_id IS NOT OLD.extends_id OR NEW.need IS NOT OLD.need OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.home_id IS NOT NULL AND NEW.home_id IS NOT OLD.home_id)
    OR (OLD.seal_kind IS NOT NULL AND (NEW.seal_kind IS NOT OLD.seal_kind OR NEW.recorded_micros IS NOT OLD.recorded_micros))
    OR NEW.revision <= OLD.revision
    OR (NEW.state IS NOT OLD.state AND NOT (
      (OLD.state = 'written' AND NEW.state IN ('dispatching', 'released'))
      OR (OLD.state = 'dispatching' AND NEW.state IN ('accepted', 'settled', 'uncertain'))
      OR (OLD.state = 'accepted' AND NEW.state IN ('settled', 'uncertain'))
      OR (OLD.state = 'uncertain' AND NEW.state IN ('settled', 'written-off'))
    ))
  BEGIN SELECT RAISE(ABORT, 'a grant keeps what it was written with, and its state only moves forward'); END;
  CREATE TRIGGER budget_grants_not_removed BEFORE DELETE ON budget_grants BEGIN SELECT RAISE(ABORT, 'grants are kept'); END;

  -- The operations a grant's sealed journal reported, each once, closed: never reserved or sent. They arrive with
  -- the seal, so a grant that already has its seal takes no more.
  CREATE TABLE budget_operations (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES budget_grants(id),
    seq INTEGER NOT NULL CHECK (seq >= 1),
    kind TEXT NOT NULL,
    model TEXT,
    state TEXT NOT NULL CHECK (state IN ('unsent', 'reported', 'partial', 'unknown')),
    amount_micros INTEGER CHECK (amount_micros >= 0),
    units INTEGER CHECK (units >= 0),
    operation_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (grant_id, seq)
  ) STRICT;
  CREATE INDEX budget_operations_grant ON budget_operations(grant_id, seq);
  CREATE TRIGGER budget_operations_sealed BEFORE INSERT ON budget_operations
  WHEN NOT EXISTS (SELECT 1 FROM budget_grants WHERE id = NEW.grant_id AND seal_kind IS NULL AND state IN ('dispatching', 'accepted', 'uncertain'))
  BEGIN SELECT RAISE(ABORT, 'a grant takes its operations once, with its seal, after it was dispatched'); END;
  CREATE TRIGGER budget_operations_kept BEFORE UPDATE ON budget_operations BEGIN SELECT RAISE(ABORT, 'a recorded operation is kept as it was reported'); END;
  CREATE TRIGGER budget_operations_not_removed BEFORE DELETE ON budget_operations BEGIN SELECT RAISE(ABORT, 'recorded operations are kept'); END;

  -- A history the person chose to start again after a loss: when, why, and the allowance they set for the rest of
  -- that month (null: wait for the next). Spend before it is unknown, never zero.
  CREATE TABLE budget_adjustments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('history-lost')),
    period_idx INTEGER NOT NULL,
    reason TEXT NOT NULL,
    remaining_micros INTEGER CHECK (remaining_micros >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER budget_adjustments_kept BEFORE UPDATE ON budget_adjustments BEGIN SELECT RAISE(ABORT, 'a recorded loss is kept as written'); END;
  CREATE TRIGGER budget_adjustments_not_removed BEFORE DELETE ON budget_adjustments BEGIN SELECT RAISE(ABORT, 'recorded losses are kept'); END;
`,
];

export type WorkspaceOpening =
  | { state: "ready"; db: WorkspaceDb; schemaVersion: number; sqlite: string; notice: string | null }
  | { state: "unavailable"; reason: string };

/** An open workspace. Transactions nest as savepoints, as the engine's database does. */
export class WorkspaceDb {
  readonly path: string;
  readonly #db: DatabaseSync;
  #depth = 0;
  #closed = false;

  constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  get db(): DatabaseSync {
    if (this.#closed) throw new Error("Nivra's history is closed.");
    return this.#db;
  }

  tx<T>(work: (db: DatabaseSync) => T): T {
    const db = this.db;
    const savepoint = `sp${this.#depth}`;
    db.exec(this.#depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = work(db);
      this.#depth--;
      db.exec(this.#depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth--;
      if (this.#depth === 0) {
        if (db.isTransaction) db.exec("ROLLBACK");
      } else {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    }
  }

  /** Writes the WAL back into the file and empties it, so deleted rows, already overwritten, leave no copy there. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/** A schema version this app doesn't know: a newer Nivra wrote it. */
class NewerSchema extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`schema v${version}`);
    this.version = version;
  }
}

type Problem = "corrupt" | "locked" | "access" | "disk" | "newer" | "other";

/**
 * What kind of failure an error is, from SQLite's primary result code (`node:sqlite` reports it in `errcode`) or the
 * file system's errno code, never from message text.
 */
export function classifyWorkspaceError(error: unknown): { problem: Problem; code: string } {
  if (error instanceof NewerSchema) return { problem: "newer", code: `schema v${error.version}` };
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    const code = `SQLite error ${errcode}`;
    if (primary === 11 || primary === 26) return { problem: "corrupt", code };
    if (primary === 5 || primary === 6) return { problem: "locked", code };
    if (primary === 3 || primary === 8 || primary === 14 || primary === 23) return { problem: "access", code };
    if (primary === 10 || primary === 13) return { problem: "disk", code };
    return { problem: "other", code };
  }
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string") {
    if (errno === "EACCES" || errno === "EPERM" || errno === "EROFS") return { problem: "access", code: errno };
    if (errno === "ENOSPC" || errno === "EIO" || errno === "EDQUOT") return { problem: "disk", code: errno };
    return { problem: "other", code: errno };
  }
  return { problem: "other", code: error instanceof Error ? error.name : "an unknown error" };
}

/** The files SQLite may keep beside a database. */
const COMPANIONS = ["", "-wal", "-shm", "-journal"] as const;
/** The journals a session leaves beside the database when it doesn't close cleanly; closing removes them. */
const JOURNALS = ["-wal", "-journal"] as const;
const SQLITE_HEADER = "SQLite format 3\0";

/**
 * What is wrong with the files at `path` before SQLite touches them, or null: a main file that isn't a SQLite database
 * (an empty one is a new database, unless a journal says it had content), or journal files with no database to belong
 * to.
 */
function damageBeforeOpening(path: string): string | null {
  if (!existsSync(path)) return COMPANIONS.some((suffix) => suffix && existsSync(`${path}${suffix}`)) ? "journal files without a database" : null;
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size === 0) return JOURNALS.some((suffix) => existsSync(`${path}${suffix}`)) ? "journal files without a database" : null;
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, header, 0, header.length, 0);
    return read < header.length || header.toString("latin1") !== SQLITE_HEADER ? "not a SQLite database" : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens the workspace at `path`, creating it on first use. A damaged file is kept aside as `<name>.unreadable-<ms>`,
 * with each journal file under the same name plus its own suffix, so SQLite can still open the set together; a fresh
 * workspace then starts, with a notice. Every other failure leaves the files alone.
 */
export function openWorkspace(path: string, now: () => number = Date.now): WorkspaceOpening {
  const folder = dirname(path);
  let notice: string | null = null;
  let damage: string | null;
  try {
    damage = damageBeforeOpening(path);
  } catch (error) {
    const { problem, code } = classifyWorkspaceError(error);
    return { state: "unavailable", reason: unavailableReason(problem, code, folder) };
  }
  if (damage) {
    const kept = setAside(path, damage, now);
    if ("reason" in kept) return { state: "unavailable", reason: kept.reason };
    notice = kept.notice;
  } else {
    const found = checkLeftBehind(path);
    if (found) {
      const { problem, code } = classifyWorkspaceError(found);
      if (problem !== "corrupt") return { state: "unavailable", reason: unavailableReason(problem, code, folder) };
      const kept = setAside(path, code, now);
      if ("reason" in kept) return { state: "unavailable", reason: kept.reason };
      notice = kept.notice;
    }
  }
  const first = tryOpen(path);
  if ("db" in first) return { state: "ready", ...first, notice };
  const { problem, code } = classifyWorkspaceError(first.error);
  // SQLite itself found damage the header didn't show: keep aside what is there, once, and start again.
  if (problem !== "corrupt" || notice) return { state: "unavailable", reason: [notice, unavailableReason(problem, code, folder)].filter(Boolean).join(" ") };
  const kept = setAside(path, code, now);
  if ("reason" in kept) return { state: "unavailable", reason: kept.reason };
  const second = tryOpen(path);
  if ("db" in second) return { state: "ready", ...second, notice: kept.notice };
  const again = classifyWorkspaceError(second.error);
  return { state: "unavailable", reason: `${kept.notice} The new one couldn't be opened either: ${unavailableReason(again.problem, again.code, folder)}` };
}

/**
 * Reads a database that a session left a journal beside, through a read-only connection: its schema version and its
 * schema, which is what opening reads. A writing connection that finds damage would fold the journal into the file, or
 * remove it, as it closes; a read-only one can do neither, so whatever it finds, the files are as they were. Returns
 * what went wrong, or null when there is nothing to read first or nothing wrong.
 */
function checkLeftBehind(path: string): unknown {
  if (!existsSync(path) || !JOURNALS.some((suffix) => existsSync(`${path}${suffix}`))) return null;
  // The connection may make the shared-memory index it reads the journal with. Nothing else uses one (Nivra's own
  // connection keeps its index in memory), so one it made is removed, and a damaged set is kept as it was found.
  const index = `${path}-shm`;
  const hadIndex = existsSync(index);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    const version = num(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (version > WORKSPACE_MIGRATIONS.length) return new NewerSchema(version);
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    return null;
  } catch (error) {
    return error;
  } finally {
    try {
      db?.close();
      if (!hadIndex) rmSync(index, { force: true });
    } catch {
      // A read-only connection that can't close, or an index that stays, changes nothing in the files that matter.
    }
  }
}

/** Moves the database and its journal files aside together, under one name, and says so. Nothing is deleted. */
function setAside(path: string, why: string, now: () => number): { notice: string } | { reason: string } {
  const aside = `${path}.unreadable-${now()}`;
  let journals = false;
  try {
    for (const suffix of COMPANIONS) {
      if (!existsSync(`${path}${suffix}`)) continue;
      renameRetrying(`${path}${suffix}`, `${aside}${suffix}`);
      journals ||= (JOURNALS as readonly string[]).includes(suffix);
    }
  } catch (error) {
    return { reason: `Nivra couldn't read its history file (${why}) and couldn't move it aside (${classifyWorkspaceError(error).code}). Move ${basename(path)} and the files beside it that start with that name out of ${dirname(path)}, then open Nivra again.` };
  }
  // The journal files are named only when they were there to keep.
  return { notice: `Nivra couldn't read its history file (${why}), so it kept it aside as ${basename(aside)}${journals ? ", with its journal files," : ""} and started a new one. Your projects, preferences and key are kept separately and weren't affected.` };
}

function tryOpen(path: string): { db: WorkspaceDb; schemaVersion: number; sqlite: string } | { error: unknown } {
  let db: DatabaseSync | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Created private before SQLite opens it: the WAL file copies its mode. (Windows ignores modes.)
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    db = new DatabaseSync(path, { timeout: 0 });
    // Exclusive before anything is read, so no shared-memory file is made and a second Nivra is refused at once.
    db.exec("PRAGMA locking_mode = EXCLUSIVE;");
    const version = num(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    // A newer schema is refused before anything is written, the journal mode included.
    if (version > WORKSPACE_MIGRATIONS.length) throw new NewerSchema(version);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    db.exec("BEGIN IMMEDIATE; COMMIT;");
    migrate(db, version);
    const sqlite = str(db.prepare("SELECT sqlite_version() AS v").get()?.["v"]);
    return { db: new WorkspaceDb(path, db), schemaVersion: WORKSPACE_MIGRATIONS.length, sqlite };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Closing a connection that failed to open can fail too; the first error is the one that matters.
    }
    return { error };
  }
}

function migrate(db: DatabaseSync, from: number): void {
  for (let next = from; next < WORKSPACE_MIGRATIONS.length; next++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(WORKSPACE_MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function unavailableReason(problem: Problem, code: string, folder: string): string {
  switch (problem) {
    case "newer":
      return `Your history was saved by a newer version of Nivra (${code}; this version knows v${WORKSPACE_MIGRATIONS.length}), so this version won't read or change it. Update Nivra to use your conversations and tasks.`;
    case "locked":
      return `Another copy of Nivra is using your history (${code}), so conversations and tasks aren't available here. Close the other Nivra, then open this one again.`;
    case "access":
      return `Nivra can't open its history in ${folder} (${code}). Check that the folder exists and that you can write to it, then open Nivra again.`;
    case "disk":
      return `The disk holding Nivra's history is full or reporting errors (${code}), so conversations and tasks aren't available. Free some space or check the disk, then open Nivra again.`;
    default:
      return `Nivra couldn't open its history (${code}). Open Nivra again; if this keeps happening, the history file is in ${folder}.`;
  }
}
