import type { EnvironmentChoices, InstallScope } from "@nivra/domain";

/**
 * What a project's environment installs (NIV-55, option a1): the whole project, which is the default, or the packages of
 * a pnpm workspace that the person names with up to eight selectors, each as `pnpm install --filter` takes it. The
 * window sends the selectors exactly as they were typed, and the host and the engine decide by the domain's own rule:
 * their refusal, in their words, is the one shown. The window imports the domain for its types only (zod's runtime check
 * trips the CSP), so the limit and the rule are copied here for a hint under each selector, and a test holds them to the
 * domain's. Pure, so it is tested without a window.
 */

/** The most selectors a scope holds: the domain's `ENVIRONMENT_LIMITS.filters`. */
export const MAX_SELECTORS = 8;

/** The domain's `ENVIRONMENT_FILTER`, for the hint only: a selector it refuses is still sent, and the host refuses it. */
export const SELECTOR_RULE = /^(?!-)[A-Za-z0-9@._/^~*!-]{1,200}$/;
const SELECTOR_CHARACTER = /^[A-Za-z0-9@._/^~*!-]$/;

/** The scope a set of choices asks for: none chosen is the whole project. */
export const scopeOf = (choices: EnvironmentChoices): InstallScope => choices.scope ?? { kind: "whole" };

/** The choices with this scope. The whole project is the default, so choosing it leaves the field out, as before any choice. */
export function withScope(choices: EnvironmentChoices, scope: InstallScope): EnvironmentChoices {
  const next = { ...choices };
  if (scope.kind === "whole") delete next.scope;
  else next.scope = scope.kind === "selected" ? { kind: "selected", selectors: [...scope.selectors] } : { kind: "packages", packages: [...scope.packages], root: scope.root };
  return next;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** Whether two scopes install the same: the same kind, the same selectors or packages in the same order, and the same root. */
export function sameScope(a: InstallScope, b: InstallScope): boolean {
  if (a.kind === "whole" || b.kind === "whole") return a.kind === b.kind;
  if (a.kind === "selected") return b.kind === "selected" && sameList(a.selectors, b.selectors);
  return b.kind === "packages" && a.root === b.root && sameList(a.packages, b.packages);
}

/**
 * Why the domain's rule doesn't take a typed selector, in plain words, or null when it does. Only a hint: the selector
 * is sent as typed, and the host's refusal is the one that counts.
 */
export function selectorHint(selector: string): string | null {
  if (SELECTOR_RULE.test(selector)) return null;
  if (selector === "") return "Type a selector here, such as @scope/app..., or remove this row.";
  if (selector.startsWith("-")) return "A selector can't start with -, which pnpm would read as an option. Start it with the package's name or folder.";
  if (selector.length > 200) return `This selector has ${selector.length.toLocaleString()} characters, and a selector has at most 200. Shorten it.`;
  const odd = [...selector].find((character) => !SELECTOR_CHARACTER.test(character)) ?? "";
  return `A selector holds only letters, digits and @ . _ / ^ ~ * ! -. Take ${/^\s$/.test(odd) ? "the space" : `the ${odd}`} out of it.`;
}

/** Selectors as a list in words: a, b and c. */
export const selectorList = (selectors: readonly string[]): string => (selectors.length < 2 ? selectors.join("") : `${selectors.slice(0, -1).join(", ")} and ${selectors.at(-1)}`);

/** What a scope installs, in words. */
export const scopeText = (scope: InstallScope): string =>
  scope.kind === "whole"
    ? "the whole project"
    : scope.kind === "selected"
      ? `only the workspace packages that ${selectorList(scope.selectors)} select`
      : `the workspace packages in ${selectorList(scope.packages)}${scope.root ? ", with the workspace root's own dependencies" : ""}`;
