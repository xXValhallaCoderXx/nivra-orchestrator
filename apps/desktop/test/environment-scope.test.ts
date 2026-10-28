import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ENVIRONMENT_FILTER, ENVIRONMENT_LIMITS, EnvironmentChoices, InstallScope } from "@nivra/domain";
import { MAX_SELECTORS, sameScope, scopeOf, scopeText, SELECTOR_RULE, selectorHint, selectorList, withScope } from "../src/shared/environment-scope.ts";

/**
 * What an environment installs, as the window chooses it (NIV-55, option a1): the whole project unless the person names
 * packages, the names sent as typed, and a hint under each that the domain's own rule decides.
 */
const selected = (...selectors: string[]): InstallScope => ({ kind: "selected", selectors });
/** Selectors on either side of the rule: what pnpm's selectors look like, and what a person might type by mistake. */
const SAMPLES = [
  "@scope/app...",
  "./packages/data",
  "!@scope/web",
  "...^@scope/core",
  "app",
  "a".repeat(200),
  "",
  " app",
  "app ",
  "web app",
  "-r",
  "--filter",
  "{packages/*}",
  "app[origin/main]",
  "a=b",
  "a".repeat(201),
  "é",
  "app\n",
];

describe("what an environment installs, as the window chooses it (NIV-55)", () => {
  it("installs the whole project unless packages are chosen, and choosing it again sends no scope at all", () => {
    assert.deepEqual(scopeOf({}), { kind: "whole" });
    assert.deepEqual(scopeOf({ runtime: "22.23.4" }), { kind: "whole" });
    const chosen = withScope({ runtime: "22.23.4" }, selected("@scope/app..."));
    assert.deepEqual(chosen, { runtime: "22.23.4", scope: selected("@scope/app...") });
    const whole = withScope(chosen, { kind: "whole" });
    assert.deepEqual([whole, "scope" in whole], [{ runtime: "22.23.4" }, false]);
    // The whole project, chosen, is what the domain takes with no choice made.
    assert.equal(EnvironmentChoices.safeParse(whole).success, true);
  });

  it("keeps the selectors as typed, in order, and a copy of them, so a later edit can't change what was sent", () => {
    const typed = ["./packages/web", " app", ""];
    const chosen = withScope({}, { kind: "selected", selectors: typed });
    typed.push("later");
    assert.deepEqual(chosen.scope, selected("./packages/web", " app", ""));
  });

  it("holds its limit and its hint to the domain's own rule: the same pattern, the same limit, and the same answer for each selector", () => {
    assert.deepEqual([SELECTOR_RULE.source, SELECTOR_RULE.flags], [ENVIRONMENT_FILTER.source, ENVIRONMENT_FILTER.flags]);
    assert.equal(MAX_SELECTORS, ENVIRONMENT_LIMITS.filters);
    const many = (count: number) => Array.from({ length: count }, (_, index) => `@scope/p${index}`);
    assert.deepEqual([InstallScope.safeParse(selected(...many(MAX_SELECTORS))).success, InstallScope.safeParse(selected(...many(MAX_SELECTORS + 1))).success], [true, false]);
    for (const selector of SAMPLES) {
      const domain = InstallScope.safeParse(selected(selector)).success;
      assert.equal(EnvironmentChoices.safeParse({ scope: selected(selector) }).success, domain, JSON.stringify(selector));
      assert.equal(selectorHint(selector) === null, domain, JSON.stringify(selector));
    }
  });

  it("says why the rule doesn't take a selector, and what to do, for each way it refuses one", () => {
    assert.equal(selectorHint(""), "Type a selector here, such as @scope/app..., or remove this row.");
    assert.equal(selectorHint("-r"), "A selector can't start with -, which pnpm would read as an option. Start it with the package's name or folder.");
    assert.equal(selectorHint("a".repeat(201)), "This selector has 201 characters, and a selector has at most 200. Shorten it.");
    assert.equal(selectorHint("web app"), "A selector holds only letters, digits and @ . _ / ^ ~ * ! -. Take the space out of it.");
    assert.equal(selectorHint("{packages/*}"), "A selector holds only letters, digits and @ . _ / ^ ~ * ! -. Take the { out of it.");
    assert.equal(selectorHint("@scope/app..."), null);
  });

  it("compares scopes by kind, then by selectors in order", () => {
    assert.equal(sameScope({ kind: "whole" }, { kind: "whole" }), true);
    assert.equal(sameScope({ kind: "whole" }, selected("app")), false);
    assert.equal(sameScope(selected("app"), { kind: "whole" }), false);
    assert.equal(sameScope(selected("a", "b"), selected("a", "b")), true);
    assert.equal(sameScope(selected("a", "b"), selected("b", "a")), false);
    assert.equal(sameScope(selected("a"), selected("a", "b")), false);
  });

  it("says what a scope installs in words", () => {
    assert.equal(scopeText({ kind: "whole" }), "the whole project");
    assert.equal(scopeText(selected("@scope/app...")), "only the workspace packages that @scope/app... select");
    assert.equal(scopeText(selected("@scope/app...", "./packages/data", "!@scope/web")), "only the workspace packages that @scope/app..., ./packages/data and !@scope/web select");
    assert.deepEqual([selectorList([]), selectorList(["a"]), selectorList(["a", "b"])], ["", "a", "a and b"]);
  });

  it("imports the domain for types only, in the window and in these helpers: zod's runtime check trips the CSP", () => {
    for (const path of ["../src/shared/environment-scope.ts", "../src/renderer/src/features/environment.tsx"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.equal(/^import (?!type )[^;]*from "@nivra\/domain"/m.test(source), false, path);
    }
  });
});
