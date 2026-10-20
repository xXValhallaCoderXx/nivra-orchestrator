import { posix } from "node:path";
import { LIMITS, type RepoReader } from "./files.ts";
import { RepoError } from "./paths.ts";

/**
 * The model's starting point (NIV-9, D22): what the repository is made of, built fresh for every run, so it can't
 * describe another branch or checkout. File counts, the manifests (names, scripts and dependencies, read through the
 * same checked reader and hashed), and which convention and configuration files exist, by name and size. The model
 * reads the ones it needs; nothing here is a file's content beyond the manifests' names.
 */

export const MAP_LIMITS = { chars: 16_000, folders: 25, extensions: 20, manifests: 12, names: 40, conventionFiles: 60, workspaceLines: 20 } as const;

/** Files worth knowing about from the start, matched on the file name, up to three folders deep. */
const CONVENTION_FILES: readonly RegExp[] = [
  /^readme(\..*)?$/i,
  /^agents\.md$/i,
  /^claude\.md$/i,
  /^contributing(\..*)?$/i,
  /^tsconfig.*\.json$/i,
  /^(eslint\.config\.[cm]?[jt]s|\.eslintrc.*)$/i,
  /^(vitest|jest|playwright|vite|next|babel|metro|tailwind|postcss)\.config\.[cm]?[jt]s$/i,
  /^app\.(json|config\.[cm]?[jt]s)$/i,
  /^(\.prettierrc.*|prettier\.config\.[cm]?[jt]s|biome\.jsonc?)$/i,
  /^(turbo\.json|nx\.json|lerna\.json|pnpm-workspace\.yaml)$/i,
  /^(dockerfile|makefile|pyproject\.toml|cargo\.toml|go\.mod|requirements.*\.txt|gemfile|pom\.xml|build\.gradle(\.kts)?)$/i,
];

export interface MapSource {
  path: string;
  sha256: string;
  lines: number;
}

export interface RepoMap {
  /** JSON, at most `MAP_LIMITS.chars` characters, as the model receives it. */
  text: string;
  /** The files read to build it whose content is still in what is sent, with the hashes of the bytes read (D23). */
  sources: MapSource[];
  /**
   * Files the model is never given, by reason, counted from the reader whatever the map had room for (D23). Only the
   * first `LIMITS.statFiles` tracked files have their size checked, so `tooLarge` is a lower bound when
   * `tooLargePartial` is set.
   */
  hidden: { secret: number; output: number; tooLarge: number; tooLargePartial: boolean };
}

const depth = (path: string) => path.split("/").length;
const byDepth = (a: string, b: string) => depth(a) - depth(b) || a.localeCompare(b);
const counted = (counts: Map<string, number>, limit: number) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name, count]) => ({ name, count }));

export async function buildMap(reader: RepoReader, head: string | null): Promise<RepoMap> {
  const files = [...reader.readable];
  const folders = new Map<string, number>();
  const extensions = new Map<string, number>();
  for (const path of files) {
    const top = path.includes("/") ? `${path.slice(0, path.indexOf("/"))}/` : "(top level)";
    folders.set(top, (folders.get(top) ?? 0) + 1);
    const ext = posix.extname(path).toLowerCase() || "(none)";
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
  }
  const hidden = { secret: 0, output: 0 };
  for (const reason of reader.hidden.values()) hidden[reason]++;

  const sources: MapSource[] = [];
  const manifests: Array<Record<string, unknown>> = [];
  for (const path of files.filter((p) => posix.basename(p) === "package.json").sort(byDepth).slice(0, MAP_LIMITS.manifests)) {
    try {
      const { text, lines, sha256 } = await reader.text(path);
      // A manifest that isn't valid JSON is sent as its path alone, so it is no source of what the model was given.
      const json = JSON.parse(text) as Record<string, unknown>;
      sources.push({ path, sha256, lines });
      const names = (value: unknown) => (value && typeof value === "object" ? Object.keys(value).slice(0, MAP_LIMITS.names) : []);
      manifests.push({
        path,
        name: typeof json["name"] === "string" ? json["name"] : null,
        scripts: names(json["scripts"]),
        dependencies: names(json["dependencies"]),
        devDependencies: names(json["devDependencies"]),
        ...(json["workspaces"] ? { workspaces: json["workspaces"] } : {}),
      });
    } catch (error) {
      if (!(error instanceof RepoError) && !(error instanceof SyntaxError)) throw error;
      manifests.push({ path, unreadable: error instanceof RepoError ? error.message : "not valid JSON" });
    }
  }

  let workspace: string[] | null = null;
  const workspaceFile = files.filter((p) => posix.basename(p) === "pnpm-workspace.yaml").sort(byDepth)[0];
  if (workspaceFile) {
    try {
      const { text, lines, sha256 } = await reader.text(workspaceFile);
      sources.push({ path: workspaceFile, sha256, lines });
      workspace = text.split("\n").slice(0, MAP_LIMITS.workspaceLines);
    } catch (error) {
      if (!(error instanceof RepoError)) throw error;
    }
  }

  const conventionPaths = files.filter((p) => depth(p) <= 4 && CONVENTION_FILES.some((pattern) => pattern.test(posix.basename(p)))).sort(byDepth).slice(0, MAP_LIMITS.conventionFiles);
  const conventionFiles = await Promise.all(conventionPaths.map(async (path) => ({ path, bytes: await reader.size(path) })));

  const map = {
    head,
    trackedFiles: files.length,
    hiddenFiles: hidden,
    tooLargeToRead: reader.oversized.size,
    folders: counted(folders, MAP_LIMITS.folders),
    extensions: counted(extensions, MAP_LIMITS.extensions),
    manifests,
    ...(workspace ? { pnpmWorkspace: { path: workspaceFile, lines: workspace } } : {}),
    conventionFiles,
  };
  // Shrink the longest lists until the map fits: it is a starting point, and the tools reach everything else.
  let text = JSON.stringify(map);
  while (text.length > MAP_LIMITS.chars && (map.conventionFiles.length > 10 || map.manifests.length > 1)) {
    if (map.conventionFiles.length > 10) map.conventionFiles = map.conventionFiles.slice(0, Math.floor(map.conventionFiles.length * 0.75));
    else map.manifests = map.manifests.slice(0, map.manifests.length - 1);
    text = JSON.stringify(map);
  }
  const counts = { ...hidden, tooLarge: reader.oversized.size, tooLargePartial: reader.readable.size > LIMITS.statFiles };
  if (text.length > MAP_LIMITS.chars) {
    // The fallback sends no manifest or workspace content, so no file is a source of what the model was given.
    text = JSON.stringify({ head, trackedFiles: files.length, hiddenFiles: hidden, folders: map.folders, extensions: map.extensions, note: "The map was too large; use list_files." });
    return { text, sources: [], hidden: counts };
  }
  // A manifest cut to make the map fit was never sent, so it isn't a source either.
  const sent = new Set([...map.manifests.map((manifest) => manifest["path"]), ...(workspace ? [workspaceFile] : [])]);
  return { text, sources: sources.filter((source) => sent.has(source.path)), hidden: counts };
}
