import type { SnapshotFile } from "../exec/snapshot.ts";

/**
 * A Node project's setup files, read as data (NIV-55, NIV-58): manifests, lockfiles, the workspace file and version files.
 * Nothing here runs anything or reaches the network. Each reader says what it couldn't read instead of guessing.
 */

/** Lockfiles by package manager, in the order each manager prefers them. */
export const LOCKFILES: Readonly<Record<string, readonly string[]>> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["npm-shrinkwrap.json", "package-lock.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};
/** The managers Nivra prepares. yarn and bun are recognised so they can be refused by name. */
export const SUPPORTED_MANAGERS = ["npm", "pnpm"] as const;
export const VERSION_FILES = [".nvmrc", ".node-version", ".tool-versions"] as const;
export const PNPMFILES = [".pnpmfile.cjs", ".pnpmfile.mjs"] as const;
const TOP_LEVEL_SETUP = new Set<string>([...Object.values(LOCKFILES).flat(), "pnpm-workspace.yaml", ...VERSION_FILES, ...PNPMFILES]);

/**
 * Whether a path is part of a Node project's setup configuration: a package.json at any depth, or one of the top-level
 * lockfiles, workspace file, version files and pnpmfiles. The worker may neither create nor edit such a path, whether or
 * not it exists at the commit.
 */
export const isNodeSetupPath = (path: string): boolean => path === "package.json" || path.endsWith("/package.json") || TOP_LEVEL_SETUP.has(path);

/** Scripts a package manager runs from the project's own manifests during an install: each needs the sources. */
export const INSTALL_HOOKS = ["pnpm:devPreinstall", "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish"] as const;

export const textOf = (file: SnapshotFile): string => Buffer.from(file.bytes).toString("utf8");

export interface Manifest {
  path: string;
  /** The package's folder, "" for the project's top. */
  folder: string;
  json: Record<string, unknown>;
}

/** A field's value as a plain object, or an empty one. */
export const objectAt = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
/** A field's value as a string, or null. */
export const stringAt = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The first line a version file names, without comments: what nvm and friends read. */
export function versionFileValue(name: string, text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (name === ".tool-versions") {
      const [tool, version] = line.split(/\s+/);
      if (tool === "nodejs" || tool === "node") return version ?? null;
      continue;
    }
    return line;
  }
  return null;
}

export type YamlValue = string | boolean | null | string[] | Record<string, string | boolean | null>;

/**
 * The top-level keys of a simple YAML file, as pnpm-workspace.yaml writes them: scalars, lists of scalars, maps of scalars,
 * and flow lists or maps of scalars. A key whose value is any other shape is listed as unreadable rather than guessed.
 * Only the first document is read.
 */
export function simpleYaml(text: string): { values: Map<string, YamlValue>; unreadable: string[] } {
  const values = new Map<string, YamlValue>();
  const unreadable: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let index = 0;
  const scalar = (raw: string): string | boolean | null => {
    const value = raw.replace(/(^|\s+)#.*$/, "").trim();
    if (value === "" || value === "~" || value === "null") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    const quoted = /^'(.*)'$|^"(.*)"$/.exec(value);
    return quoted ? (quoted[1] ?? quoted[2] ?? "") : value;
  };
  const flow = (raw: string): YamlValue | undefined => {
    const value = raw.replace(/(^|\s+)#.*$/, "").trim();
    const list = /^\[(.*)\]$/.exec(value);
    if (list) return list[1]!.trim() === "" ? [] : list[1]!.split(",").map((item) => String(scalar(item) ?? ""));
    const map = /^\{(.*)\}$/.exec(value);
    if (map) {
      const out: Record<string, string | boolean | null> = {};
      for (const entry of map[1]!.split(",").filter((part) => part.trim())) {
        const pair = /^\s*(['"]?)([^'":]+)\1\s*:\s*(.*)$/.exec(entry);
        if (!pair) return undefined;
        out[pair[2]!.trim()] = scalar(pair[3]!);
      }
      return out;
    }
    return scalar(value);
  };
  if (lines[0]?.trim() === "---") index = 1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "---" || line.trim() === "...") break;
    const top = /^([A-Za-z0-9_@./-]+|'[^']+'|"[^"]+"):(?:\s+(.*))?$/.exec(line);
    if (!top || /^\s/.test(line)) {
      index++;
      continue;
    }
    const key = top[1]!.replace(/^['"]|['"]$/g, "");
    const inline = (top[2] ?? "").replace(/(^|\s+)#.*$/, "").trim();
    index++;
    if (inline !== "") {
      const value = flow(inline);
      if (value === undefined) unreadable.push(key);
      else values.set(key, value);
      continue;
    }
    // A block: list items or map entries, one level deep. A list's items may also start at the key's own column.
    const items: string[] = [];
    const entries: Record<string, string | boolean | null> = {};
    let shape: "list" | "map" | null = null;
    let broken = false;
    while (index < lines.length && (/^\s+\S/.test(lines[index]!) || /^-\s/.test(lines[index]!) || lines[index]!.trim() === "" || /^\s*#/.test(lines[index]!))) {
      const inner = lines[index]!;
      index++;
      if (inner.trim() === "" || /^\s*#/.test(inner)) continue;
      const item = /^\s*-\s+(.*)$/.exec(inner);
      const entry = /^\s+(['"]?)([^'":]+)\1\s*:\s*(.*)$/.exec(inner);
      if (item && shape !== "map" && !/:\s/.test(item[1]!.replace(/^(['"]).*\1$/, ""))) {
        shape = "list";
        items.push(String(scalar(item[1]!) ?? ""));
      } else if (entry && shape !== "list" && entry[3]!.trim() !== "") {
        shape = "map";
        entries[entry[2]!.trim()] = scalar(entry[3]!);
      } else {
        broken = true;
      }
    }
    if (broken) unreadable.push(key);
    else values.set(key, shape === "list" ? items : shape === "map" ? entries : null);
  }
  return { values, unreadable };
}

/** The longest workspace glob Nivra reads, and the most patterns its brace lists may stand for. */
const MAX_GLOB = 1_024;
const MAX_EXPANSIONS = 256;
/**
 * The most steps expanding one pattern's brace lists may take, counted before each. Work is what's limited, not results:
 * {a,a} written forty times stands for one folder, yet expanding it list by list would take 2^40 steps.
 */
const MAX_BRACE_STEPS = 4_096;
/** Glob syntax Nivra doesn't read in a workspace pattern: character classes, extglobs and groups, and escapes. */
const UNREAD_GLOB = /[[\]()|\\]/;

/**
 * A workspace glob's brace lists expanded as pnpm and npm expand them, nested ones included: `packages/{a,b}` stands for
 * `packages/a` and `packages/b`. Null when the braces don't pair, a pair holds no list (a range such as {1..3}, or a
 * single name), the pattern is longer than MAX_GLOB or stands for more than MAX_EXPANSIONS, or expanding it would take
 * more than MAX_BRACE_STEPS steps.
 */
export function expandBraces(pattern: string): string[] | null {
  if (pattern.length > MAX_GLOB) return null;
  let steps = MAX_BRACE_STEPS;
  const expand = (text: string): string[] | null => {
    if (--steps < 0) return null;
    const open = text.indexOf("{");
    if (open === -1) return text.includes("}") ? null : [text];
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let index = open; index < text.length && close === -1; index++) {
      const char = text[index];
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) close = index;
      else if (char === "," && depth === 1) commas.push(index);
    }
    if (close === -1 || commas.length === 0) return null;
    const out = new Set<string>();
    let start = open + 1;
    for (const end of [...commas, close]) {
      // The limit is checked before each step down, so no pattern takes more than MAX_BRACE_STEPS of them.
      if (steps <= 0) return null;
      const expanded = expand(`${text.slice(0, open)}${text.slice(start, end)}${text.slice(close + 1)}`);
      if (expanded === null) return null;
      for (const item of expanded) out.add(item);
      if (out.size > MAX_EXPANSIONS) return null;
      start = end + 1;
    }
    return [...out];
  };
  return expand(pattern);
}

/** The first workspace glob Nivra can't read, or null. One it can't read is refused, never matched as nothing. */
export function unreadGlob(globs: readonly string[]): string | null {
  return (
    globs.find((glob) => {
      const body = glob.replace(/^!/, "");
      return body.length > MAX_GLOB || UNREAD_GLOB.test(body) || expandBraces(body) === null;
    }) ?? null
  );
}

/**
 * A workspace glob as a matcher for package folders: `*` is one segment or part of one, `**` any number of them, `?` one
 * character, and a brace list any of its patterns. Check the glob with unreadGlob first: other syntax is matched as text.
 */
export function globMatcher(pattern: string): RegExp {
  const bodies = (expandBraces(pattern) ?? [pattern]).map((item) =>
    item
      .replace(/^\.\//, "")
      .replace(/\/+$/, "")
      .split("/")
      .map((segment) => (segment === "**" ? "\u0000" : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
      .join("/")
      .replace(/\u0000\//g, "(?:[^/]+/)*")
      .replace(/\/\u0000$/, "(?:/[^/]+)*")
      .replace(/\u0000/g, "(?:[^/]+(?:/[^/]+)*)?"),
  );
  return new RegExp(`^(?:${bodies.join("|")})$`);
}

/** The workspace's member folders: package folders that the globs include and no negated glob excludes. */
export function workspaceMembers(globs: readonly string[], folders: readonly string[]): string[] {
  const include = globs.filter((glob) => !glob.startsWith("!")).map(globMatcher);
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => globMatcher(glob.slice(1)));
  return folders.filter((folder) => folder !== "" && include.some((re) => re.test(folder)) && !exclude.some((re) => re.test(folder)));
}

/** What a lockfile says about the install, as far as Nivra reads it. */
export interface LockfileFacts {
  /** The format, as the lockfile names it ("9.0", 3). */
  format: string | null;
  /** Registry hosts the lockfile resolves packages from. */
  hosts: string[];
  /** Packages resolved from a git repository. */
  git: string[];
  /** Packages resolved from a local file or folder outside the workspace's own links. */
  local: string[];
  /** Dependencies' own engines.node, by package. */
  engines: Array<{ name: string; range: string }>;
  /** Packages whose install scripts the manager would run (npm records them). */
  installScripts: string[];
  /** Platform packages and the libc they need, where the lockfile records it. */
  libc: Array<{ name: string; libc: string[] }>;
  /**
   * Entries Nivra couldn't read where they're fetched from, or what they need, each with the field: refused, never
   * skipped, since a private registry or a git dependency could hide in one.
   */
  unreadable: string[];
  /** The workspace's projects as the lockfile records them, by folder from the repository's top, the root left out. */
  workspaces: string[];
  /** pnpm: each importer's links (`version: link:PATH`), by folder from the repository's top, "" for the root. */
  links: Map<string, string[]>;
  /** pnpm: whether a link is recorded outside the importers, as linkWorkspacePackages deep writes them. */
  deepLinks: boolean;
  /** pnpm: whether the lockfile's own settings say links were left out of it (excludeLinksFromLockfile). */
  excludesLinks: boolean;
  /** pnpm: the pnpm that the lockfile's own env document names as the project's package manager, or null. */
  writer: string | null;
  /** npm: every entry, by its location, as resolving what a workspace reaches needs it; null for pnpm. */
  tree: Map<string, NpmLockEntry> | null;
}

/** An npm lockfile entry, for following what a workspace package reaches (NIV-55). */
export interface NpmLockEntry {
  /** A link to a folder in the repository: a workspace package. */
  link: boolean;
  resolved: string | null;
  /** Its dependencies by name, and whether an install can go without each (optional dependencies, and peers). */
  requires: Array<{ name: string; optional: boolean }>;
  /** The peers it declares optional, by name: npm/cli 9847 installs those even for another workspace's install. */
  optionalPeers: string[];
}

/** A link's target from the repository's top, "" for the top itself, or null when it leaves the repository. */
export function linkedFolder(from: string, relative: string): string | null {
  const parts: string[] = [];
  for (const segment of `${from}/${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

/** How many of each kind of fact a lockfile reader keeps. Every entry is still read: a cap never hides a refusal. */
const MAX_FACTS = 5_000;
const keep = <T>(list: T[], item: T) => {
  if (list.length < MAX_FACTS) list.push(item);
};
/** Whether a path from the repository's top, after joining, leaves the repository. */
const escapes = (from: string, relative: string) => {
  const parts: string[] = [];
  for (const segment of `${from}/${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return true;
      parts.pop();
    } else parts.push(segment);
  }
  return false;
};
const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname : null;
  } catch {
    return null;
  }
};

/** An npm lockfile's facts (package-lock.json or npm-shrinkwrap.json), or null when it isn't a JSON object. */
export function npmLockFacts(text: string): LockfileFacts | null {
  let lock: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    lock = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const facts: LockfileFacts = { format: lock["lockfileVersion"] === undefined ? null : String(lock["lockfileVersion"]), hosts: [], git: [], local: [], engines: [], installScripts: [], libc: [], unreadable: [], workspaces: [], links: new Map(), deepLinks: false, excludesLinks: false, writer: null, tree: new Map() };
  const hosts = new Set<string>();
  for (const [key, raw] of Object.entries(objectAt(lock["packages"]))) {
    facts.tree!.set(key, npmEntry(key, objectAt(raw)));
    if (key === "") continue;
    const entry = objectAt(raw);
    if (!key.includes("node_modules/") && !escapes("", key)) facts.workspaces.push(key);
    const name = key.replace(/^.*node_modules\//, "");
    const resolved = stringAt(entry["resolved"]);
    if (entry["resolved"] !== undefined && resolved === null) keep(facts.unreadable, `${key} (resolved)`);
    if (resolved) {
      if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(resolved) || /codeload\.github\.com/.test(resolved)) keep(facts.git, name);
      else if (resolved.startsWith("file:")) keep(facts.local, name);
      // A link to a folder: a workspace package inside the repository, or a folder outside it that a sandbox won't have.
      else if (entry["link"] === true) {
        if (escapes("", resolved)) keep(facts.local, name);
      } else {
        // Anything else is fetched from an address: one that isn't http or https can't be told, so it isn't passed over.
        const host = hostOf(resolved);
        if (host) hosts.add(host);
        else keep(facts.unreadable, `${key} (resolved)`);
      }
    }
    // A key outside node_modules is a folder the lockfile installs from: outside the repository, a sandbox won't have it.
    if (!key.includes("node_modules/") && escapes("", key)) keep(facts.local, key);
    const engines = entry["engines"];
    const range = typeof engines === "object" && engines !== null && !Array.isArray(engines) ? stringAt(objectAt(engines)["node"]) : null;
    if (range) keep(facts.engines, { name, range: range.slice(0, 200) });
    if (entry["hasInstallScript"] === true) keep(facts.installScripts, name);
    if (Array.isArray(entry["libc"])) keep(facts.libc, { name, libc: entry["libc"].filter((item): item is string => typeof item === "string") });
  }
  facts.hosts = [...hosts].sort();
  facts.workspaces.sort();
  return facts;
}

/**
 * An npm lockfile entry's dependencies, as npm installs them: a folder's own entry (the root, a workspace package) keeps
 * its devDependencies, anything else has none recorded. A peer counts as optional: npm installs one the lockfile holds,
 * and one it doesn't hold was left out on purpose (legacy-peer-deps) or makes npm ci fail by itself.
 */
function npmEntry(key: string, entry: Record<string, unknown>): NpmLockEntry {
  const names = (field: string) => Object.keys(objectAt(entry[field]));
  const meta = objectAt(entry["peerDependenciesMeta"]);
  const optionalPeers = names("peerDependencies").filter((name) => objectAt(meta[name])["optional"] === true);
  const required = new Set([...names("dependencies"), ...(key.includes("node_modules/") ? [] : names("devDependencies"))]);
  const optional = [...names("optionalDependencies"), ...names("peerDependencies")].filter((name) => !required.has(name));
  return {
    link: entry["link"] === true,
    resolved: stringAt(entry["resolved"]),
    requires: [...[...required].map((name) => ({ name, optional: false })), ...unique(optional).map((name) => ({ name, optional: true }))],
    optionalPeers,
  };
}

const unique = <T>(items: readonly T[]) => [...new Set(items)];

/** A lockfile line beneath an entry: its indentation, and its text without it. */
interface LockLine {
  indent: number;
  text: string;
}
/** A field of a lockfile entry: what follows its key on the line, and the lines beneath it. */
interface LockField {
  inline: string;
  block: LockLine[];
}

/**
 * A YAML scalar as pnpm writes one, plain or quoted, unquoted; null for anything else (an anchor, an alias, a tag, a
 * block scalar, a collection, an escape, an empty value), which the caller reads as unreadable.
 */
function lockScalar(raw: string): string | null {
  const text = raw.trim();
  const single = /^'((?:[^']|'')*)'$/.exec(text);
  if (single) return single[1]!.replaceAll("''", "'");
  const double = /^"([^"\\]*)"$/.exec(text);
  if (double) return double[1]!;
  if (text === "" || text === "~" || text === "null" || /^[-?:](\s|$)|^[&*!|>'"%@`{}[\],#]/.test(text) || /:\s|\s#|[{}[\],]/.test(text)) return null;
  return text;
}

/** A flow collection's items, split at its commas outside quotes; null when it isn't one, or holds another collection. */
function flowItems(text: string, open: "{" | "[", close: "}" | "]"): string[] | null {
  const body = text.trim();
  if (body[0] !== open || body.at(-1) !== close) return null;
  const items: string[] = [];
  let item = "";
  // Whether the next character starts a scalar, where a quote opens a quoted one.
  let start = true;
  for (let index = 1; index < body.length - 1; index++) {
    const char = body[index]!;
    if (start && (char === "'" || char === '"')) {
      let end = index + 1;
      for (; end < body.length - 1; end++) {
        if (body[end] !== char) continue;
        if (char === "'" && body[end + 1] === "'") {
          end++;
          continue;
        }
        break;
      }
      if (end >= body.length - 1) return null;
      item += body.slice(index, end + 1);
      index = end;
      start = false;
      continue;
    }
    if ("{}[]".includes(char)) return null;
    if (char === ",") {
      items.push(item.trim());
      item = "";
      start = true;
      continue;
    }
    item += char;
    if (char === ":" && /\s/.test(body[index + 1] ?? "")) start = true;
    else if (!/\s/.test(char)) start = false;
  }
  if (item.trim() !== "") items.push(item.trim());
  return items;
}

/** One `key: value` of scalars, or null. */
function lockPair(text: string): [string, string] | null {
  const at = text.search(/:(\s|$)/);
  const key = at > 0 ? lockScalar(text.slice(0, at)) : null;
  const value = key === null ? null : lockScalar(text.slice(at + 1));
  return key === null || value === null ? null : [key, value];
}

/**
 * A field's flow collection as one text: on the field's line, which may run on below it, or starting on the line beneath
 * it, as formatters write a long one. Null when the field's value doesn't start with one.
 */
function flowText(field: LockField, open: "{" | "["): string | null {
  const lines = [field.inline, ...field.block.map((line) => line.text)].filter((text) => text !== "");
  return lines[0]?.startsWith(open) ? lines.join(" ") : null;
}
/** Whether a field's lines beneath it are all at one indentation: a block of one level. */
const oneLevel = (field: LockField) => field.inline === "" && field.block.length > 0 && field.block.every((line) => line.indent === field.block[0]!.indent);

/**
 * A field's value as a map of scalars, in either of YAML's styles: a flow mapping (`resolution: {integrity: …, tarball:
 * …}`, also across lines), or one key a line beneath it. Null for any other shape, or a key given twice.
 */
function lockMap(field: LockField): Record<string, string> | null {
  const flow = flowText(field, "{");
  const items = flow !== null ? flowItems(flow, "{", "}") : oneLevel(field) ? field.block.map((line) => line.text) : null;
  if (items === null) return null;
  const out: Record<string, string> = {};
  for (const item of items) {
    const pair = lockPair(item);
    if (pair === null || pair[0] in out) return null;
    out[pair[0]] = pair[1];
  }
  return out;
}

/** A field's value as a list of scalars, as a flow list (also across lines) or one `- item` a line beneath it; null otherwise. */
function lockList(field: LockField): string[] | null {
  const flow = flowText(field, "[");
  const items = flow !== null ? flowItems(flow, "[", "]") : oneLevel(field) && field.block.every((line) => /^-\s/.test(line.text)) ? field.block.map((line) => line.text.replace(/^-\s+/, "")) : null;
  if (items === null) return null;
  const out = items.map(lockScalar);
  return out.every((item) => item !== null) ? (out as string[]) : null;
}

/**
 * A pnpm lockfile's facts: the format, tarball hosts, git and local resolutions, and each package's engines.node and
 * libc. The packages and importers sections are read by their indentation, and the fields that matter in either of
 * YAML's styles; a field written any other way, or a line that doesn't fit the layout, is listed as unreadable, never
 * passed over. pnpm records a registry tarball's address only when it isn't the standard one.
 */
export function pnpmLockFacts(text: string): LockfileFacts {
  const facts: LockfileFacts = { format: null, hosts: [], git: [], local: [], engines: [], installScripts: [], libc: [], unreadable: [], workspaces: [], links: new Map(), deepLinks: false, excludesLinks: false, writer: null, tree: null };
  facts.format = /^lockfileVersion:\s*['"]?([0-9.]+)['"]?\s*$/m.exec(text)?.[1] ?? null;
  const hosts = new Set<string>();
  const entries: Array<{ section: string; key: string; body: LockLine[] }> = [];
  let section: string | null = null;
  let entryIndent = 0;
  let entry: { section: string; key: string; body: LockLine[] } | null = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+$/, "");
    const indent = line.length - line.trimStart().length;
    if (/^ *\t/.test(line)) {
      keep(facts.unreadable, "a line indented with a tab");
      entry = null;
      continue;
    }
    if (indent === 0) {
      // A section, or the start or end of a document: pnpm can write more than one, and every one is read.
      entry = null;
      entryIndent = 0;
      if (line === "---" || line === "...") {
        section = null;
        continue;
      }
      const top = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
      section = top ? top[1]! : null;
      if (!top) keep(facts.unreadable, "a line outside any section");
      else if ((section === "packages" || section === "importers") && top[2] !== undefined && top[2].trim() !== "{}") keep(facts.unreadable, `the ${section} section`);
      continue;
    }
    // A link recorded beside a package's own dependencies: linkWorkspacePackages deep, which Nivra doesn't follow. Only a
    // value counts, never a name that ends in link, such as terminal-link.
    if ((section === "packages" || section === "snapshots") && /:\s*['"]?link:/.test(line)) facts.deepLinks = true;
    if (section === "settings" && /^\s+excludeLinksFromLockfile:\s*true\s*$/.test(line)) facts.excludesLinks = true;
    if (section !== "packages" && section !== "importers") continue;
    if (entryIndent === 0) entryIndent = indent;
    if (indent === entryIndent) {
      const key = /^(['"]?)(.+?)\1:(?:\s+(.*))?$/.exec(line.trim());
      entry = key && (key[3] === undefined || key[3].trim() === "{}") ? { section, key: key[2]!, body: [] } : null;
      if (entry) entries.push(entry);
      else keep(facts.unreadable, key ? key[2]! : `the ${section} section`);
    } else if (indent < entryIndent) {
      keep(facts.unreadable, `the ${section} section`);
      entry = null;
    } else entry?.body.push({ indent, text: line.trim() });
  }

  const readPackage = (key: string, body: readonly LockLine[]): void => {
    // A package's name, from its key: any peer suffix and its version dropped.
    const name = key.replace(/\(.*$/, "").replace(/^\//, "").replace(/(?<=.)@[^@]*$/, "");
    const fields = new Map<string, LockField>();
    const fieldIndent = body[0]?.indent ?? 0;
    let field: LockField | null = null;
    for (const line of body) {
      const pair = line.indent === fieldIndent ? /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line.text) : null;
      if (pair) {
        if (fields.has(pair[1]!)) return keep(facts.unreadable, `${key} (${pair[1]})`);
        field = { inline: pair[2] ?? "", block: [] };
        fields.set(pair[1]!, field);
      } else if (field && (line.indent > fieldIndent || (line.indent === fieldIndent && /^-\s/.test(line.text) && field.inline === ""))) {
        // A field's own lines, and a list's items at the field's own column.
        field.block.push(line);
      } else return keep(facts.unreadable, key);
    }
    const resolution = fields.get("resolution");
    if (resolution) {
      const map = lockMap(resolution);
      if (map === null) return keep(facts.unreadable, `${key} (resolution)`);
      const type = map["type"];
      if (type === "git" || "repo" in map || "commit" in map) keep(facts.git, name);
      else if (type === "directory" || "directory" in map) keep(facts.local, name);
      else if (type !== undefined) return keep(facts.unreadable, `${key} (resolution)`);
      const tarball = map["tarball"];
      if (tarball !== undefined) {
        if (tarball.startsWith("file:")) keep(facts.local, name);
        else if (/codeload\.github\.com/.test(tarball)) keep(facts.git, name);
        else {
          const host = hostOf(tarball);
          if (host) hosts.add(host);
          else keep(facts.unreadable, `${key} (resolution)`);
        }
      }
    }
    const engines = fields.get("engines");
    if (engines) {
      const map = lockMap(engines);
      if (map === null) return keep(facts.unreadable, `${key} (engines)`);
      if (map["node"]) keep(facts.engines, { name, range: map["node"].slice(0, 200) });
    }
    const libc = fields.get("libc");
    if (libc) {
      const list = lockList(libc);
      if (list === null) return keep(facts.unreadable, `${key} (libc)`);
      keep(facts.libc, { name, libc: list });
    }
  };

  for (const { section: where, key, body } of entries) {
    if (where === "packages") {
      readPackage(key, body);
      continue;
    }
    // An importer's links, in either style: one to a folder outside the repository is one a sandbox won't have.
    const folder = key === "." ? "" : key;
    if (folder !== "" && !facts.workspaces.includes(folder)) facts.workspaces.push(folder);
    const links = facts.links.get(folder) ?? [];
    for (const line of body) {
      for (const linked of line.text.matchAll(/(?:^|[\s{,])version:\s*['"]?link:([^'"\s,}]+)/g)) {
        const target = linkedFolder(folder, linked[1]!);
        if (target === null) keep(facts.local, `link:${linked[1]}`);
        else if (!links.includes(target)) links.push(target);
      }
    }
    facts.links.set(folder, links);
    if (folder === "") facts.writer = packageManagerPnpm(body) ?? facts.writer;
  }
  facts.hosts = [...hosts].sort();
  facts.workspaces.sort();
  return facts;
}

/**
 * The pnpm version a pnpm 11 lockfile's env document names under packageManagerDependencies, in either style, or null:
 * the release the project manages itself with, and so most likely the one that wrote the lockfile.
 */
function packageManagerPnpm(body: readonly LockLine[]): string | null {
  const start = body.findIndex((line) => /^packageManagerDependencies:/.test(line.text));
  if (start === -1) return null;
  const under = body[start]!.indent;
  for (let index = start + 1; index < body.length && body[index]!.indent > under; index++) {
    const line = body[index]!.text;
    const flow = /^['"]?pnpm['"]?:\s*\{(.*)\}$/.exec(line);
    if (flow) return /(?:^|[\s,])version:\s*['"]?(\d+\.\d+\.\d+)/.exec(flow[1]!)?.[1] ?? null;
    if (/^['"]?pnpm['"]?:$/.test(line)) {
      const depth = body[index]!.indent;
      for (let next = index + 1; next < body.length && body[next]!.indent > depth; next++) {
        const version = /^version:\s*['"]?(\d+\.\d+\.\d+)/.exec(body[next]!.text);
        if (version) return version[1]!;
      }
      return null;
    }
  }
  return null;
}

/**
 * A dependency spec that installs from a local file or folder rather than the registry or the workspace: file: and
 * link:, and the plain paths npm reads as folders (./x, ../x, /x, ~/x).
 */
export const isLocalSpec = (spec: string): boolean => /^(file:|link:|\.\.?\/|\/|~\/)/.test(spec) || spec === "." || spec === "..";

/** Every dependency of a manifest, from all four lists, by name. */
export function dependencySpecs(manifest: Record<string, unknown>): Array<{ name: string; spec: string; list: string }> {
  const out: Array<{ name: string; spec: string; list: string }> = [];
  for (const list of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(objectAt(manifest[list]))) if (typeof spec === "string") out.push({ name, spec, list });
  }
  return out;
}
