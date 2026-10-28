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

/** A workspace glob as a matcher for package folders: `*` is one segment, `**` any number of them. */
export function globMatcher(pattern: string): RegExp {
  const body = pattern
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .map((segment) => (segment === "**" ? "\u0000" : segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/")
    .replace(/\u0000\//g, "(?:[^/]+/)*")
    .replace(/\/\u0000$/, "(?:/[^/]+)*")
    .replace(/\u0000/g, "(?:[^/]+(?:/[^/]+)*)?");
  return new RegExp(`^${body}$`);
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
  const facts: LockfileFacts = { format: lock["lockfileVersion"] === undefined ? null : String(lock["lockfileVersion"]), hosts: [], git: [], local: [], engines: [], installScripts: [], libc: [] };
  const hosts = new Set<string>();
  for (const [key, raw] of Object.entries(objectAt(lock["packages"]))) {
    if (key === "") continue;
    const entry = objectAt(raw);
    const name = key.replace(/^.*node_modules\//, "");
    const resolved = stringAt(entry["resolved"]);
    if (resolved) {
      if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(resolved) || /codeload\.github\.com/.test(resolved)) keep(facts.git, name);
      else if (resolved.startsWith("file:")) keep(facts.local, name);
      // A link to a folder: a workspace package inside the repository, or a folder outside it that a sandbox won't have.
      else if (entry["link"] === true) {
        if (escapes("", resolved)) keep(facts.local, name);
      } else {
        const host = hostOf(resolved);
        if (host) hosts.add(host);
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
  return facts;
}

/**
 * A pnpm lockfile's facts, read from its text line by line: the format, tarball hosts, git and local resolutions, and
 * each package's engines.node. pnpm records a registry tarball's address only when it isn't the standard one.
 */
export function pnpmLockFacts(text: string): LockfileFacts {
  const facts: LockfileFacts = { format: null, hosts: [], git: [], local: [], engines: [], installScripts: [], libc: [] };
  facts.format = /^lockfileVersion:\s*['"]?([0-9.]+)['"]?\s*$/m.exec(text)?.[1] ?? null;
  const hosts = new Set<string>();
  let section: string | null = null;
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z]+):\s*$/.exec(line);
    if (top) {
      section = top[1]!;
      current = null;
      continue;
    }
    if (section === "importers") {
      // An importer's link to a folder outside the repository: a sandbox won't have it.
      const importer = /^ {2}(?! )(['"]?)(.+?)\1:\s*$/.exec(line);
      if (importer) current = importer[2]!;
      const linked = /^\s+version:\s*['"]?link:([^'"\s]+)/.exec(line);
      if (linked && current !== null && escapes(current === "." ? "" : current, linked[1]!)) keep(facts.local, `link:${linked[1]}`);
      continue;
    }
    if (section !== "packages") continue;
    const key = /^ {2}(?! )(['"]?)(.+?)\1:\s*$/.exec(line);
    if (key) {
      current = key[2]!;
      continue;
    }
    if (current === null) continue;
    // A package's name, from its key: any peer suffix and its version dropped.
    const name = current.replace(/\(.*$/, "").replace(/^\//, "").replace(/(?<=.)@[^@]*$/, "");
    if (/^ {4}resolution:/.test(line)) {
      if (/\btype:\s*git\b/.test(line) || /\brepo:/.test(line) || /codeload\.github\.com/.test(line)) keep(facts.git, name);
      else if (/\bdirectory:/.test(line) || /tarball:\s*['"]?file:/.test(line)) keep(facts.local, name);
      const tarball = /tarball:\s*['"]?(https?:\/\/[^\s'",}]+)/.exec(line)?.[1];
      const host = tarball ? hostOf(tarball) : null;
      if (host) hosts.add(host);
    }
    const engines = /^ {4}engines:\s*\{(.*)\}\s*$/.exec(line);
    if (engines) {
      const node = /(?:^|,)\s*node:\s*['"]?([^'",}]+)['"]?/.exec(engines[1]!)?.[1]?.trim();
      if (node) keep(facts.engines, { name, range: node.slice(0, 200) });
    }
    const libc = /^ {4}libc:\s*\[(.*)\]\s*$/.exec(line);
    if (libc) keep(facts.libc, { name, libc: libc[1]!.split(",").map((item) => item.trim()).filter(Boolean) });
  }
  facts.hosts = [...hosts].sort();
  return facts;
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
