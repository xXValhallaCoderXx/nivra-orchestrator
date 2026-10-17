/**
 * Files Nivra never reads (D20, D22), from Hird's deny list (`projects/repo.ts` @ 45c0057) with what it lacked: more
 * secret-bearing files, and dependency and build output at any depth. Two reasons, kept apart so a model and the
 * person are told which applies. One function decides; the git excludes for a search are built from its answers.
 */

export type HiddenReason = "secret" | "output";

const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/,
  /^\.envrc$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|asc|kdbx)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/,
  /^secrets(\..*)?$/,
  /^credentials(\..*)?$/,
  /^\.(npmrc|netrc|pgpass|pypirc|git-credentials|htpasswd)$/,
  /^service-account.*\.json$/,
  /^\.mcp\.json$/,
  /\.tfvars$/,
  /\.tfstate(\..*)?$/,
];
const ALLOWED_NAMES: readonly RegExp[] = [/^\.env\.example$/];
const SECRET_PATHS: readonly RegExp[] = [/(^|\/)\.aws\/credentials$/, /(^|\/)\.docker\/config\.json$/, /(^|\/)\.ssh\//, /(^|\/)\.kube\/config$/];

/** Folders whose contents are dependency or build output, wherever they are. */
export const OUTPUT_DIRS: readonly string[] = ["node_modules", "dist", "build", "out", ".next", ".expo", ".turbo", "coverage", "vendor", "target"];

/** Why a repository-relative path is never read, or null when it may be. Any folder, any case. */
export function hiddenReason(relPath: string): HiddenReason | null {
  const lower = relPath.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? "";
  if (!ALLOWED_NAMES.some((pattern) => pattern.test(name)) && (SECRET_NAMES.some((pattern) => pattern.test(name)) || SECRET_PATHS.some((pattern) => pattern.test(lower)))) {
    return "secret";
  }
  return segments.slice(0, -1).some((segment) => OUTPUT_DIRS.includes(segment)) ? "output" : null;
}

/** The output folder that hides a path (`apps/web/dist`), so one git exclude can cover everything under it. */
export function outputRoot(relPath: string): string | null {
  const segments = relPath.split("/");
  const index = segments.slice(0, -1).findIndex((segment) => OUTPUT_DIRS.includes(segment.toLowerCase()));
  return index < 0 ? null : segments.slice(0, index + 1).join("/");
}

export const HIDDEN_WHY: Readonly<Record<HiddenReason, string>> = {
  secret: "is hidden: its name suggests it may hold credentials, so Nivra never reads it",
  output: "is hidden: it is dependency or build output, which Nivra never reads",
};
