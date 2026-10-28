import { PRUNE_LINES } from "../exec/nebius/session.ts";

/**
 * The fixed scripts a recipe's preparation runs besides the install (NIV-55), each with networking off and thrown away
 * afterwards, given everything as positional arguments, and the readers of what they print. Nothing here is
 * interpolated into a script, and nothing they print is taken as an instruction.
 *
 * - The inspect step runs on the base image before anything is uploaded: what Node, npm and corepack it holds, its
 *   machine and its libc. A recipe whose facts the image doesn't have stops there.
 * - The readiness step runs on the prepared image with the task operations' own variables: the tools a session needs,
 *   the versions again, whether pnpm reads the switches that keep it from installing or changing version, and what the
 *   workspace holds besides the folders the install writes, which must be the setup files and nothing else: a task's
 *   session would read anything more as the commit's own, and refuse it.
 */

/** What the inspect step prints, one fact a line. */
export const INSPECT_SCRIPT = [
  'echo "node $(node --version 2>/dev/null || echo none)"',
  'echo "npm $(npm --version 2>/dev/null || echo none)"',
  'echo "corepack $(corepack --version 2>/dev/null || echo none)"',
  'echo "arch $(uname -m)"',
  'echo "os $( (sed -n "s/^PRETTY_NAME=//p" /etc/os-release 2>/dev/null || true) | tr -d "\\"" | head -n 1)"',
  'if ldd --version 2>&1 | grep -qi musl; then echo "libc musl"; elif ldd --version 2>&1 | grep -qi -e glibc -e "gnu libc"; then echo "libc glibc"; else echo "libc unknown"; fi',
].join("\n");

/** The most files the readiness step lists; one more says there are more. */
export const READINESS_FILES = 1_000;

/**
 * What the readiness step prints. $1 the package manager, $2 how many settings to read back from pnpm, then those
 * settings, then the folders the install writes, left out of the workspace's listing at any depth.
 */
export const READINESS_SCRIPT = [
  'manager="$1"; count="$2"; shift 2',
  "cd /workspace",
  'echo "node $(node --version 2>/dev/null || echo none)"',
  'echo "npm $(npm --version 2>/dev/null || echo none)"',
  'if [ "$manager" = "pnpm" ]; then echo "pnpm $(pnpm --version 2>/dev/null || echo none)"; fi',
  'for tool in sh tar find sha256sum gzip sort; do if /bin/busybox --list 2>/dev/null | grep -qx "$tool"; then echo "tool $tool ok"; else echo "tool $tool missing"; fi; done',
  'i=0; while [ "$i" -lt "$count" ]; do key="$1"; shift; echo "setting $key $(pnpm config get "$key" 2>/dev/null | tail -n 1)"; i=$((i + 1)); done',
  ...PRUNE_LINES,
  `find . "$@" \\( -type f -o -type l \\) -print | LC_ALL=C sort | head -n ${READINESS_FILES + 1} | sed 's/^/file /'`,
  'echo "listed"',
].join("\n");

/** The lines a script printed as name and value, the first of each name winning. */
export function printedFacts(stdout: string, names: readonly string[]): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^([a-z]+) (.+)$/.exec(line.trim());
    if (match && names.includes(match[1]!) && !(match[1]! in facts)) facts[match[1]!] = match[2]!.trim();
  }
  return facts;
}

/** What the inspect step found. Versions without their leading v; null where the image has none. */
export interface ImageFacts {
  node: string | null;
  npm: string | null;
  corepack: string | null;
  arch: string | null;
  os: string | null;
  libc: "musl" | "glibc" | null;
}

const versionOf = (value: string | undefined) => {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(value ?? "");
  return match ? match[1]! : null;
};
/** A machine's name as uname prints it, such as x86_64; anything else is unknown, never shown. */
const archOf = (value: string | undefined) => (value && /^[a-z0-9_]{1,32}$/.test(value) ? value : null);

export function imageFacts(stdout: string): ImageFacts {
  const facts = printedFacts(stdout, ["node", "npm", "corepack", "arch", "os", "libc"]);
  const libc = facts["libc"] === "musl" || facts["libc"] === "glibc" ? facts["libc"] : null;
  // The OS release is the image's own words: kept only when it reads as a release's name does.
  const os = facts["os"] && /^[A-Za-z0-9 ._()/+-]{1,100}$/.test(facts["os"]) ? facts["os"] : null;
  return { node: versionOf(facts["node"]), npm: versionOf(facts["npm"]), corepack: versionOf(facts["corepack"]), arch: archOf(facts["arch"]), os, libc };
}

/** What the preparation's own script printed: how pnpm was activated, the versions and the machine. */
export function preparedFacts(stdout: string): { via: string | null; node: string | null; npm: string | null; pnpm: string | null; arch: string | null } {
  const facts = printedFacts(stdout, ["via", "node", "npm", "pnpm", "arch"]);
  return { via: facts["via"] ?? null, node: versionOf(facts["node"]), npm: versionOf(facts["npm"]), pnpm: versionOf(facts["pnpm"]), arch: archOf(facts["arch"]) };
}

/**
 * Which bootstrap the preparation's script says failed, before it printed any version: its own line, and nothing an
 * install printed later could stand in for, since the versions are printed before the install starts.
 */
export function bootstrapFailure(stdout: string): "npm" | "pnpm" | null {
  const said = /^bootstrap-failed (npm|pnpm)$/m.exec(stdout)?.[1] ?? null;
  return said !== null && preparedFacts(stdout).node === null ? (said as "npm" | "pnpm") : null;
}

/**
 * The dependency builds pnpm says it didn't run, from what `pnpm ignored-builds` printed between the preparation's
 * markers: none, a list of packages, or unknown when there is no such section or Nivra can't read it.
 */
export function ignoredBuilds(stdout: string): { state: "complete" | "missing" | "unknown"; missing: string[] } {
  // The last section: the script's own comes after the install's log, which could hold one that looks like it.
  const section = [...stdout.matchAll(/builds-begin\n([\s\S]*?)builds-end/g)].at(-1)?.[1];
  if (section === undefined) return { state: "unknown", missing: [] };
  const lines = section.split("\n").map((line) => line.replace(/\s+$/, ""));
  const header = lines.findIndex((line) => /ignored builds/i.test(line));
  if (header < 0) return { state: "unknown", missing: [] };
  const names: string[] = [];
  for (const line of lines.slice(header + 1)) {
    const match = /^\s+(\S+)$/.exec(line);
    if (!match) break;
    if (/^none$/i.test(match[1]!)) return { state: "complete", missing: [] };
    names.push(match[1]!.slice(0, 214));
  }
  return names.length ? { state: "missing", missing: names.slice(0, 200) } : { state: "unknown", missing: [] };
}

/**
 * What the readiness step found: missing tools, the versions, each setting pnpm read back, and the files the workspace
 * holds besides the install's folders, null when the listing didn't finish.
 */
export function readinessFacts(stdout: string): { tools: Record<string, boolean>; node: string | null; npm: string | null; pnpm: string | null; settings: Record<string, string>; files: string[] | null } {
  const tools: Record<string, boolean> = {};
  const settings: Record<string, string> = {};
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const tool = /^tool (\S+) (ok|missing)$/.exec(line.trim());
    if (tool) tools[tool[1]!] = tool[2] === "ok";
    const setting = /^setting (\S+) ?(.*)$/.exec(line.trim());
    if (setting && !(setting[1]! in settings)) settings[setting[1]!] = setting[2]!.trim();
    const file = /^file \.\/(.+)$/.exec(line);
    if (file) files.push(file[1]!);
  }
  const facts = printedFacts(stdout, ["node", "npm", "pnpm"]);
  return { tools, node: versionOf(facts["node"]), npm: versionOf(facts["npm"]), pnpm: versionOf(facts["pnpm"]), settings, files: stdout.split("\n").includes("listed") ? files : null };
}

/**
 * What a failed install's log says, in Nivra's own words, for the failures whose fix is known: the first signature
 * found wins, and nothing from the log is repeated. Null when none is recognised; the log's end is shown either way.
 */
const INSTALL_SIGNATURES: ReadonlyArray<{ managers: ReadonlyArray<"npm" | "pnpm">; pattern: RegExp; words: string }> = [
  {
    managers: ["npm"],
    pattern: /\bERESOLVE\b/,
    words: "npm couldn't settle the dependencies' peer requirements. If the lockfile was made with legacy-peer-deps, for example set in an .npmrc, turn on that install option, then prepare again.",
  },
  {
    managers: ["npm"],
    pattern: /can only install packages when your package\.json and (package-lock\.json|npm-shrinkwrap\.json)/,
    words: "The lockfile doesn't match package.json. Run npm install in the repository, commit the lockfile, then prepare again.",
  },
  {
    managers: ["pnpm"],
    pattern: /\bERR_PNPM_OUTDATED_LOCKFILE\b/,
    words: "pnpm-lock.yaml doesn't match package.json. Run pnpm install in the repository, commit pnpm-lock.yaml, then prepare again.",
  },
  {
    managers: ["pnpm"],
    pattern: /\bERR_PNPM_IGNORED_BUILDS\b/,
    words: "pnpm stopped because some dependencies have build scripts the project's build policy doesn't decide. Approve or decline them with pnpm approve-builds in the repository, commit what it changes, then prepare again.",
  },
  {
    managers: ["npm", "pnpm"],
    pattern: /\b(ERR_PNPM_UNSUPPORTED_ENGINE|EBADENGINE)\b/,
    words: "A package asks for a different Node than the environment's. Preview the environment again, and choose a Node version every package accepts.",
  },
  {
    managers: ["npm", "pnpm"],
    pattern: /gyp ERR!|\b(make|g\+\+|gcc|python3?): (command )?not found\b/,
    words: "A dependency's build needs a tool the image doesn't have, such as python3, make or g++, and adding system packages to an environment isn't available yet. If the project works without that build, leave it out of its build policy, or for npm turn on ignore-scripts, then prepare again.",
  },
  {
    managers: ["npm", "pnpm"],
    pattern: /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/,
    words: "The install couldn't reach the package registry from the sandbox. Try again later; if it keeps happening, check Nebius's status.",
  },
];

export function installDiagnosis(manager: "npm" | "pnpm", log: string): string | null {
  return INSTALL_SIGNATURES.find((signature) => signature.managers.includes(manager) && signature.pattern.test(log))?.words ?? null;
}
