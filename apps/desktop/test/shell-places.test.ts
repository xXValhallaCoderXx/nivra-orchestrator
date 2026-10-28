import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Route, Scope } from "../src/renderer/src/app/routes.ts";
import { composerDraftKey, newTaskDraftKey, openTaskCount, placeOfDraft, projectOnly, routeAfterSwitch, scopeKey, sectionOf, sharedNames, shownSection } from "../src/renderer/src/shell/places.ts";

const general: Scope = { kind: "general" };
const alpha: Scope = { kind: "project", projectId: "p-alpha" };

const ROUTES: Route[] = [
  { kind: "home" },
  { kind: "tasks" },
  { kind: "task", id: "t1", tab: "coach" },
  { kind: "new-task", draftKey: "new-task:general", plan: null, title: "Add CSV export" },
  { kind: "conversations" },
  { kind: "conversation", id: "c1" },
  { kind: "environment" },
  { kind: "explain" },
  { kind: "missions" },
  { kind: "mission", id: "m1" },
  { kind: "settings", section: "sharing" },
];

/** The shell's routes without a router (NIV-56): which link is lit, and where switching scope leaves the window. */
describe("the shell's places (NIV-56)", () => {
  it("names a scope as one string, and tells scopes apart by it", () => {
    assert.deepEqual([scopeKey(general), scopeKey(alpha)], ["general", "project:p-alpha"]);
  });

  it("lights the link each route belongs to: a task page under Tasks, Explain under Home", () => {
    assert.deepEqual(
      ROUTES.map(sectionOf),
      ["home", "tasks", "tasks", "tasks", "conversations", "conversations", "environment", "home", "missions", "missions", "settings"],
    );
  });

  it("keeps a list or a place everywhere when the scope changes, and sends one piece of work's page back to its list", () => {
    assert.deepEqual(
      ROUTES.map((route) => routeAfterSwitch(route, alpha).kind),
      ["home", "tasks", "tasks", "tasks", "conversations", "conversations", "environment", "explain", "missions", "mission", "settings"],
    );
    assert.deepEqual(routeAfterSwitch({ kind: "settings", section: "diagnostics" }, general), { kind: "settings", section: "diagnostics" });
  });

  it("never leaves General on a place only a project has", () => {
    assert.deepEqual(
      ROUTES.filter(projectOnly).map((route) => routeAfterSwitch(route, general)),
      [{ kind: "home" }, { kind: "home" }],
    );
  });

  it("opens Connections for a Settings section this build has no page for", () => {
    assert.deepEqual([shownSection("budget"), shownSection("agents"), shownSection("diagnostics")], ["connections", "connections", "diagnostics"]);
  });

  it("finds where each kind of draft is edited from its key, and nothing for a key it doesn't know", () => {
    assert.deepEqual(placeOfDraft(composerDraftKey(alpha)), { kind: "New task", scope: alpha, route: { kind: "home" } });
    assert.deepEqual(placeOfDraft(newTaskDraftKey(general)), { kind: "New task", scope: general, route: { kind: "new-task", draftKey: "new-task:general", plan: null, title: "" } });
    assert.deepEqual(placeOfDraft("brief:t-42:3"), { kind: "Brief", scope: null, route: { kind: "task", id: "t-42", tab: "brief" } });
    assert.deepEqual([placeOfDraft("mission:m1"), placeOfDraft("home-composer:elsewhere"), placeOfDraft("no-colon"), placeOfDraft("new-task:project:")], [null, null, null, null]);
  });

  it("counts a scope's open tasks: its own that aren't completed, and General's with no repository", () => {
    const tasks = [
      { projectId: "p-alpha", state: "draft" },
      { projectId: "p-alpha", state: "review" },
      { projectId: "p-alpha", state: "completed" },
      { projectId: "p-beta", state: "ready" },
      { projectId: null, state: "active" },
    ] as const;
    assert.deepEqual([openTaskCount(tasks, alpha), openTaskCount(tasks, general), openTaskCount(tasks, { kind: "project", projectId: "p-gone" })], [2, 1, 0]);
  });

  it("shows the folder only for projects that share a name", () => {
    const shared = sharedNames([
      { id: "a", label: "api" },
      { id: "b", label: "api" },
      { id: "c", label: "billing-service" },
    ]);
    assert.deepEqual([...shared].sort(), ["a", "b"]);
  });
});
