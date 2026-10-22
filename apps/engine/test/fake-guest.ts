import { createHash } from "node:crypto";
import { PROBE_SCRIPT } from "../src/exec/check.ts";
import { listingDigest, PREPARE_SCRIPT, type ListingEntry } from "../src/exec/nebius/session.ts";
import { COLLECT_SCRIPT, RESULT_ARCHIVE, RESULT_LISTING } from "../src/exec/patch.ts";
import { readTar, writeTar, type TarEntry } from "../src/exec/tar.ts";
import { OUTPUT_DIRS } from "../src/repo/deny.ts";
import { applyFixedEdit, CHECK_SCRIPT, checkOutcome, EDIT_SCRIPT, FAIL_SCRIPT, NETWORK_SCRIPT, type GuestNode } from "../scripts/sandbox-fixture.ts";
import { FakeService, succeed, type Behaviour } from "./fake-sandboxes.ts";

/**
 * A guest for the fake service (NIV-43): each image is a workspace, a map from path to file or link, and each command
 * of the fixture's recipe is done here in JavaScript, on a copy of the workspace of the image it starts from. It tests
 * the orchestration only. The prepare, collect and edit scripts themselves run on this machine's tools in other tests,
 * and on busybox in the live check.
 */
export type Workspace = Map<string, GuestNode>;

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const ordered = (a: string, b: string) => Buffer.compare(Buffer.from(`./${a}`), Buffer.from(`./${b}`));

export class FakeGuest {
  readonly baseImage: string;
  readonly service: FakeService;
  /** Each image's workspace, by the image's id. */
  readonly workspaces = new Map<string, Workspace>();
  /** A test's change to how a command behaves: a hang, a lost answer, a failure. */
  override: (command: { program: string; args: readonly string[]; body: Record<string, unknown> }) => Partial<Behaviour> | undefined = () => undefined;
  /** Commands whose result image is gone once made, so a spawn from it answers 410. */
  expiresAfter: (program: string, args: readonly string[]) => boolean = () => false;
  /** Each operation that ends on its own ends at its first read, as a real engine's tests want: they wait in real time. */
  quick = false;
  #images = 0;

  constructor(baseImage = "base-image") {
    this.baseImage = baseImage;
    this.service = new FakeService((body) => this.#behave(body));
  }

  #behave(body: Record<string, unknown>): Behaviour {
    const program = String(body["command"]);
    const args = (body["args"] as string[] | undefined) ?? [];
    const from = String(body["image"]);
    const parent = from === this.baseImage ? new Map<string, GuestNode>() : this.workspaces.get(from);
    if (!parent) return { statuses: ["PENDING", "FAILED"] };
    const workspace: Workspace = new Map(parent);
    const outcome = this.#run(program, args, workspace, body);
    const image = `img-guest-${++this.#images}`;
    this.workspaces.set(image, workspace);
    if (this.expiresAfter(program, args)) this.service.expiredImages.add(image);
    const behaviour: Behaviour = { ...outcome, ...this.override({ program, args, body }), resultImage: image };
    return this.quick && !behaviour.waits ? { ...behaviour, statuses: [behaviour.statuses.at(-1)!] } : behaviour;
  }

  #run(program: string, args: readonly string[], workspace: Workspace, body: Record<string, unknown>): Behaviour {
    const script = args[0] === "-c" ? args[1] : undefined;
    if (program === "/bin/sh" && script === PREPARE_SCRIPT) return this.#prepare(args, workspace, body);
    if (program === "/bin/sh" && script === COLLECT_SCRIPT) return this.#collect(workspace);
    if (program === "/bin/sh" && script === EDIT_SCRIPT) {
      applyFixedEdit(workspace);
      return succeed();
    }
    if (program === "/bin/sh" && script === NETWORK_SCRIPT) return this.#network(args, body);
    if (program === "/bin/sh" && script === CHECK_SCRIPT) return succeed(checkOutcome(workspace));
    if (program === "/bin/sh" && script === FAIL_SCRIPT) return succeed({ exitCode: 1, stdout: "FAIL: this check fails on purpose\n" });
    if (program === "/bin/sh" && script === PROBE_SCRIPT) return this.#probe(workspace);
    // A sleep longer than its timeout is ended by the service, as live (SUCCESS, exit -1, signal 9); a shorter one
    // runs until something stops it.
    if (program === "/bin/sleep") return Number(args[0]) > Number(body["timeout"]) ? succeed({ timedOut: true }) : { ...succeed(), waits: true };
    return { statuses: ["PENDING", "FAILED"] };
  }

  /** The prepare step: the uploaded archive, extracted, and its listing's digest printed. */
  #prepare(args: readonly string[], workspace: Workspace, body: Record<string, unknown>): Behaviour {
    const reference = (body["files"] as Record<string, { uuid: string }> | undefined)?.[args[4] ?? ""];
    const archive = reference ? this.service.uploadsById.get(reference.uuid) : undefined;
    if (!archive) return succeed({ exitCode: 1, stderr: "tar: can't open the archive\n" });
    const listing: ListingEntry[] = [];
    for (const entry of readTar(archive, { maxEntries: 100_000, maxBytes: 64 * 1024 * 1024, maxEntryBytes: 16 * 1024 * 1024, maxPathBytes: 4_096 })) {
      if (entry.kind === "file") {
        workspace.set(entry.path, { kind: "file", bytes: entry.bytes, executable: entry.executable });
        listing.push({ path: entry.path, kind: "file", executable: entry.executable, sha256: sha(entry.bytes) });
      } else if (entry.kind === "link") {
        workspace.set(entry.path, { kind: "link", target: entry.target });
        listing.push({ path: entry.path, kind: "link", target: entry.target });
      }
    }
    const { digest, entries } = listingDigest(listing);
    return succeed({ stdout: `entries ${entries}\ndigest ${digest}\n` });
  }

  /** The collect step: the workspace's archive and listing, output folders left out, both kept in the result image. */
  #collect(workspace: Workspace): Behaviour {
    const kept = [...workspace.entries()].filter(([path]) => !path.split("/").slice(0, -1).some((segment) => OUTPUT_DIRS.includes(segment))).sort(([a], [b]) => ordered(a, b));
    const listing = new TextEncoder().encode(kept.map(([path, node]) => (node.kind === "link" ? `l ${node.target} ./${path}\n` : `f ${sha(node.bytes)} ./${path}\n`)).join(""));
    const archive = writeTar(kept.map(([path, node]): TarEntry => (node.kind === "link" ? { path, kind: "link", target: node.target } : { path, kind: "file", executable: node.executable, bytes: node.bytes })));
    return succeed({ stdout: `entries ${kept.length}\nlisting ${sha(listing)}\narchive ${sha(archive)}\n`, files: { [RESULT_ARCHIVE]: archive, [RESULT_LISTING]: listing } });
  }

  /** The sandbox check's probe (D36): which busybox, and what the workspace holds. */
  #probe(workspace: Workspace): Behaviour {
    const nodes = [...workspace.values()];
    return succeed({ stdout: `busybox: BusyBox v1.36.1 (the fake guest)\nfiles: ${nodes.filter((node) => node.kind === "file").length}\nlinks: ${nodes.filter((node) => node.kind === "link").length}\n` });
  }

  /** The network attempt: refused with networking off, as D28 saw live; reached with it on, which fails the step. */
  #network(args: readonly string[], body: Record<string, unknown>): Behaviour {
    const [byName, byIp] = [args[3] ?? "", args[4] ?? ""];
    const head = `cwd: ${String(body["cwd"] ?? "/")}\n`;
    const busybox = "busybox: BusyBox v1.36.1 (the fake guest)";
    if ((body["networking"] as { enabled?: boolean } | undefined)?.enabled === true) return succeed({ exitCode: 1, stdout: `${head}interfaces: eth0 lo \n${busybox}\nREACHED ${byName}\nREACHED ${byIp}\n` });
    return succeed({ stdout: `${head}interfaces: lo \n${busybox}\nBLOCKED ${byName}: wget: bad address 'example.com'\nBLOCKED ${byIp}: wget: can't connect to remote host: Network unreachable\n` });
  }
}
