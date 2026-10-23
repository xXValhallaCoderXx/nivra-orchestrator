import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PROBE_SCRIPT } from "../src/exec/check.ts";
import { PREPARE_SCRIPT } from "../src/exec/nebius/session.ts";
import { COLLECT_SCRIPT } from "../src/exec/patch.ts";
import { TOOLCHAIN_SCRIPT, WRITE_SCRIPT } from "../src/task/scripts.ts";
import { FakeService, succeed, type Behaviour } from "./fake-sandboxes.ts";
import { scratch } from "./workspace-fixtures.ts";

/**
 * A guest for the fake service that really runs each command (NIV-7): every image is a folder on this machine, and an
 * operation runs `/bin/sh` with this machine's own tools in a copy of the folder of the image it starts from. The
 * engine's own scripts are given their paths inside that copy; any other command (an acceptance case, a repository
 * check) runs as it is, in the copy's workspace. It is for tests only, on fixtures the tests write: the commands it
 * runs are the fixtures', never a model's or a person's. Busybox isn't assumed here, so the engine's scripts are given
 * an empty applets argument, as `guestRun` gives them.
 */
export class RealGuest {
  readonly baseImage: string;
  readonly service: FakeService;
  readonly root = scratch("real guest");
  /** Each image's folder, by the image's id. */
  readonly images = new Map<string, string>();
  /** Each command as the guest ran it, by label, in order. */
  readonly ran: Array<{ label: string; disposable: boolean; script: string | null; args: string[] }> = [];
  /**
   * A test's change to a command before it runs: a behaviour given here stands for the command's whole result, and the
   * image keeps the folder it started from, so whatever the command was meant to change, it didn't.
   */
  intercept: (command: { label: string; args: readonly string[]; body: Record<string, unknown> }) => Behaviour | undefined = () => undefined;
  /** A test's change to how a command that ran is reported: a hang, a lost answer, a failure. */
  override: (command: { label: string; args: readonly string[]; body: Record<string, unknown> }) => Partial<Behaviour> | undefined = () => undefined;
  /** A test's change to an image after its command ran, before its files are kept: something Nivra didn't write. */
  alter: (command: { label: string; args: readonly string[] }, folder: string) => void = () => {};
  /** Each operation that ends on its own ends at its first read. */
  quick = false;
  #images = 0;

  constructor(baseImage = "base-image") {
    this.baseImage = baseImage;
    this.service = new FakeService((body) => this.#behave(body));
  }

  /** A file's bytes in an image's workspace, or null. */
  read(image: string, path: string): Buffer | null {
    const folder = this.images.get(image);
    try {
      return folder ? readFileSync(join(folder, path)) : null;
    } catch {
      return null;
    }
  }

  #behave(body: Record<string, unknown>): Behaviour {
    const program = String(body["command"]);
    const args = ((body["args"] as string[] | undefined) ?? []).map(String);
    const from = String(body["image"]);
    const label = labelOf(args);
    this.ran.push({ label, disposable: body["disposable"] !== false, script: args[0] === "-c" ? (args[1] ?? null) : null, args });
    const parent = from === this.baseImage ? null : this.images.get(from);
    if (from !== this.baseImage && !parent) return { statuses: ["PENDING", "FAILED"] };
    const folder = mkdtempSync(join(this.root, "image-"));
    if (parent) cpSync(parent, folder, { recursive: true, verbatimSymlinks: true });
    const image = `img-real-${++this.#images}`;
    const intercepted = this.intercept({ label, args, body });
    if (intercepted) {
      this.images.set(image, folder);
      return { ...intercepted, resultImage: image, files: filesOf(folder) };
    }
    for (const [path, reference] of Object.entries((body["files"] as Record<string, { uuid: string }> | undefined) ?? {})) {
      const bytes = this.service.uploadsById.get(reference.uuid);
      if (!bytes) return { statuses: ["PENDING", "FAILED"] };
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), bytes);
    }
    if (program !== "/bin/sh") return { statuses: ["PENDING", "FAILED"] };
    const cwd = join(folder, String(body["cwd"] ?? "/"));
    mkdirSync(cwd, { recursive: true });
    const ran = spawnSync("/bin/sh", mapped(args, folder), {
      cwd,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C", HOME: folder },
      timeout: Number(body["timeout"] ?? 60) * 1000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const timedOut = ran.error !== undefined && (ran.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    this.alter({ label, args }, folder);
    const behaviour: Behaviour = {
      ...succeed({ exitCode: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "", timedOut, ...(ran.signal && !timedOut ? { signal: 9 } : {}) }),
      resultImage: image,
      files: filesOf(folder),
      ...this.override({ label, args, body }),
    };
    if (body["disposable"] === false) this.images.set(image, folder);
    else rmSync(folder, { recursive: true, force: true });
    return this.quick && !behaviour.waits ? { ...behaviour, statuses: [behaviour.statuses.at(-1)!] } : behaviour;
  }
}

/** The engine's own scripts, by their text: which of their arguments are paths on the guest. */
const PATHS = new Map<string, readonly number[]>([
  [PREPARE_SCRIPT, [3, 4, 6]],
  [COLLECT_SCRIPT, [3, 4, 6]],
  [WRITE_SCRIPT, [3]],
  [PROBE_SCRIPT, [3]],
  [TOOLCHAIN_SCRIPT, []],
]);

/** A command's label, as the tests name it: the engine's script by its `$0`, anything else `command`. */
function labelOf(args: readonly string[]): string {
  return args[0] === "-c" && args[1] !== undefined && PATHS.has(args[1]) ? (args[2] ?? "script") : "command";
}

/** The arguments, the engine's paths on the guest given inside `folder`. */
function mapped(args: readonly string[], folder: string): string[] {
  const positions = args[0] === "-c" && args[1] !== undefined ? PATHS.get(args[1]) : undefined;
  return args.map((arg, index) => (positions?.includes(index) && arg.startsWith("/") ? join(folder, arg) : arg));
}

/** Every regular file in an image, by its path on the guest. */
function filesOf(folder: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) files[`/${relative(folder, path)}`] = new Uint8Array(readFileSync(path));
    }
  };
  walk(folder);
  return files;
}
