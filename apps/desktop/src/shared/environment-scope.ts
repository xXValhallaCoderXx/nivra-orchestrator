import type { EnvironmentChoices, EnvironmentPreviewV2, EnvironmentRecipe, InstallScope, InstallSelection, ScopeMode, WorkspaceFacts } from "@nivra/domain";

/**
 * What a project's environment installs (NIV-55, D52): the whole project, which is the default; workspace packages
 * ticked in a list the project's engine sends, by folder, with or without the root's own dependencies; or, under
 * Advanced, the packages of a pnpm workspace that up to eight typed selectors pick, each as `pnpm install --filter`
 * takes it, sent exactly as typed. The engine says which of these a project supports and why not, so nothing here
 * reads a refusal's words or a manager's name; the host and the engine decide by the domain's own rules, and their
 * refusal, in their words, is the one shown. The window imports the domain for its types only (zod's runtime check
 * trips the CSP), so the limits and the selectors' rule are copied here, and a test holds them to the domain's. Pure,
 * so it is tested without a window.
 */

/** The most selectors a scope holds: the domain's `ENVIRONMENT_LIMITS.filters`. */
export const MAX_SELECTORS = 8;
/** The most workspace packages a chosen install installs, those reached included: the domain's `ENVIRONMENT_LIMITS.packages`. */
export const MAX_PACKAGES = 20;

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

/** A package as the window names it: its name with its folder, or the folder alone. */
const labelOf = (item: { folder: string; name: string | null }) => (item.name ? `${item.name} (${item.folder})` : item.folder);

/** What a recipe installs, in words, from its selection when it has one: chosen, reached, and the root's or not. */
export function installsText(recipe: Pick<EnvironmentRecipe, "scope" | "selection">): string {
  if (!recipe.selection) return recipe.scope.kind === "selected" ? `${scopeText(recipe.scope)}, and the workspace root, which pnpm always installs` : scopeText(recipe.scope);
  return selectionText(recipe.selection);
}

/** A chosen install's selection, in words. */
export function selectionText(selection: InstallSelection): string {
  const chosen = selection.packages.filter((item) => item.chosen).map(labelOf);
  const reached = selection.packages.filter((item) => !item.chosen).map(labelOf);
  return [
    `${selectorList(chosen)}${reached.length ? `, with ${selectorList(reached)}, linked from ${chosen.length === 1 ? "it" : "them"}${selection.root ? " or from the workspace root" : ""}` : ""}`,
    selection.root ? "and the workspace root's own dependencies" : "without the workspace root's own dependencies",
  ].join(", ");
}

/** The folders chosen with one ticked or unticked: each once, in the order the domain takes. */
export function toggled(folders: readonly string[], folder: string, on: boolean): string[] {
  const next = new Set(folders);
  if (on) next.add(folder);
  else next.delete(folder);
  return [...next].sort();
}

/**
 * The chosen folders the workspace's list doesn't hold: shown flagged, and kept until unticked, never dropped. A list cut
 * short (more than it shows) can't tell, so nothing is flagged then, and the engine decides at the next preview.
 */
export const flaggedFolders = (scope: InstallScope, facts: WorkspaceFacts | null): string[] =>
  scope.kind !== "packages" || facts === null || facts.more > 0 ? [] : scope.packages.filter((folder) => !facts.packages.some((item) => item.folder === folder));

/** The workspace's facts an answer carries, or null: a refusal carries them only once the workspace was read. */
export const factsOf = (answer: EnvironmentPreviewV2): WorkspaceFacts | null => (answer.status === "refused" ? (answer.workspace ?? null) : answer.workspace);

/** One way of choosing, as the facts say: available or not, and why not. Unknown before any preview. */
export const modeOf = (facts: WorkspaceFacts | null, mode: ScopeMode) => facts?.modes.find((item) => item.mode === mode) ?? null;
