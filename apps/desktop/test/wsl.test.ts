import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../src/main/targets/process.ts";
import { decodeToolText, engineEnv, wslErrorCode } from "../src/main/targets/process.ts";
import { TargetUnavailableError } from "../src/main/targets/types.ts";
import { discoverWsl, mergeDistros, parseListQuiet, parseLxssRegistry, type WslDistro } from "../src/main/targets/wsl-discovery.ts";
import { INSTALL_SCRIPT, instancePattern, parseProbe, problemsOf, PROBE_SCRIPT, WslTarget } from "../src/main/targets/wsl.ts";

const ok = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const failed = (code: number, stdout = "", stderr = ""): RunResult => ({ code, signal: null, stdout, stderr, timedOut: false });

// Captured from `reg query ...\Lxss /s` on the developer machine (2026-10-16).
const REGISTRY = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss
    DefaultDistribution    REG_SZ    {d51251d0-165e-435a-ab5e-03d63a99dc25}

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{7e734a3d-9037-4ea2-afa8-a560fa4f1ba3}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    docker-desktop
    Version    REG_DWORD    0x2
    DefaultUid    REG_DWORD    0x0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{d51251d0-165e-435a-ab5e-03d63a99dc25}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    Ubuntu
    Version    REG_DWORD    0x2
    BasePath    REG_SZ    C:\\Users\\renat\\AppData\\Local\\Packages\\CanonicalGroupLimited.Ubuntu_79rhkp1fndgsc\\LocalState
    DefaultUid    REG_DWORD    0x3e8
    OsVersion    REG_SZ    24.04
`;

const UBUNTU: WslDistro = { name: "Ubuntu", version: 2, isDefault: true, defaultUid: 1000, osVersion: "24.04" };
const HEALTHY = { arch: "x86_64", libc: "glibc 2.39", home: "/home/odin", user: "odin", uid: "1000", shell: "/usr/bin/zsh", git: "/usr/bin/git", tar: "/usr/bin/tar", runtime: "absent" };
const probeText = (facts: Record<string, string>) => Object.entries(facts).map(([k, v]) => `${k}=${v}`).join("\n");

describe("decoding what Windows tools print", () => {
  it("reads UTF-16LE (wsl.exe without WSL_UTF8) and UTF-8 alike, with LF line endings", () => {
    assert.equal(decodeToolText(Buffer.from("Ubuntu\r\ndocker-desktop\r\n", "utf16le")), "Ubuntu\ndocker-desktop\n");
    assert.equal(decodeToolText(Buffer.from("\ufeffUbuntu\r\n", "utf16le")), "Ubuntu\n");
    assert.equal(decodeToolText(Buffer.from("Ubuntu\r\n", "utf8")), "Ubuntu\n");
  });

  it("finds a WSL error by its code, never its words", () => {
    assert.equal(wslErrorCode("There is no distribution with the supplied name.\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n"), "WSL_E_DISTRO_NOT_FOUND");
    assert.equal(wslErrorCode("Es gibt keine Distribution mit dem angegebenen Namen."), null);
  });

  it("gives engines and wsl.exe an environment without keys, NODE_OPTIONS or Electron's variables, with one PATH key", () => {
    const env = engineEnv({ Path: "C:\\Windows", PATH: "C:\\other", NEBIUS_API_KEY: "k", NODE_OPTIONS: "--x", ELECTRON_RUN_AS_NODE: "1", SystemRoot: "C:\\Windows" }, "win32", { WSL_UTF8: "1" });
    assert.deepEqual(Object.keys(env).sort(), ["Path", "SystemRoot", "WSL_UTF8"]);
  });
});

describe("WSL discovery", () => {
  it("reads the registry for version, default and default user, and hides Docker Desktop's distributions", () => {
    const distros = mergeDistros(parseListQuiet("Ubuntu\ndocker-desktop\n\n"), parseLxssRegistry(REGISTRY));
    assert.deepEqual(distros, [UBUNTU]);
  });

  it("says what to do when WSL is missing, only built in, or not answering", async () => {
    const missing = await discoverWsl({ env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" }, exists: () => false });
    assert.equal(missing.status, "missing");
    const inbox = await discoverWsl({ env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" }, exists: (path) => path.includes("System32") });
    assert.equal(inbox.status, "inbox-only");
    const broken = await discoverWsl({ env: {}, exists: () => true, run: async () => failed(1, "Error code: Wsl/Service/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED") });
    assert.equal(broken.status, "broken");
    assert.match(broken.status === "broken" ? broken.message : "", /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/);
  });

  it("lists the distributions of a working WSL", async () => {
    const run = async (command: string, args: readonly string[]) =>
      args[0] === "--version" ? ok("WSL version: 2.7.8.0") : args[0] === "--list" ? ok("Ubuntu\ndocker-desktop\n") : command.endsWith("reg.exe") ? ok(REGISTRY) : failed(1);
    const ready = await discoverWsl({ env: {}, exists: () => true, run });
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.distros, [UBUNTU]);
  });

  it("reports no distributions only when the registry confirms none are registered", async () => {
    const EMPTY_LXSS = "\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\n";
    const none = await discoverWsl({
      env: {},
      exists: () => true,
      run: async (command, args) => (args[0] === "--version" ? ok("") : command.endsWith("reg.exe") ? ok(EMPTY_LXSS) : failed(1, "Error code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND")),
    });
    assert.deepEqual([none.status, none.distros.length], ["ready", 0]);
  });

  it("keeps a failed listing visible, with WSL's code and what to do, instead of calling it empty", async () => {
    const serviceError = await discoverWsl({
      env: {},
      exists: () => true,
      run: async (command, args) => (args[0] === "--version" ? ok("") : command.endsWith("reg.exe") ? ok(REGISTRY) : failed(1, "Error code: Wsl/Service/WSL_E_SERVICE_NOT_RUNNING")),
    });
    assert.equal(serviceError.status, "broken");
    assert.equal(serviceError.status === "broken" ? serviceError.code : null, "WSL_E_SERVICE_NOT_RUNNING");
    assert.match(serviceError.status === "broken" ? serviceError.message : "", /wsl --shutdown/);
    const timeout = await discoverWsl({
      env: {},
      exists: () => true,
      run: async (command, args) => (args[0] === "--version" ? ok("") : command.endsWith("reg.exe") ? ok("") : { code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true }),
    });
    assert.equal(timeout.status, "broken");
    assert.match(timeout.status === "broken" ? timeout.message : "", /within 15 s/);
  });
});

describe("WSL probe rules", () => {
  it("reads the probe's facts", () => {
    assert.deepEqual(parseProbe(probeText(HEALTHY)), HEALTHY);
  });

  it("refuses WSL 1, other architectures, musl and old glibc, and warns about git and root", () => {
    const codes = (distro: WslDistro, facts: Record<string, string>) => problemsOf(distro, facts).map((p) => `${p.code}:${p.severity}`);
    assert.deepEqual(codes(UBUNTU, HEALTHY), []);
    assert.deepEqual(codes({ ...UBUNTU, version: 1 }, HEALTHY), ["wsl1:blocking"]);
    assert.deepEqual(codes(UBUNTU, { ...HEALTHY, arch: "aarch64" }), ["arch-unsupported:blocking"]);
    assert.deepEqual(codes(UBUNTU, { ...HEALTHY, libc: "unknown" }), ["musl:blocking"]);
    assert.deepEqual(codes(UBUNTU, { ...HEALTHY, libc: "glibc 2.27" }), ["glibc-too-old:blocking"]);
    assert.deepEqual(codes(UBUNTU, { ...HEALTHY, git: "", tar: "" }), ["no-tar:blocking", "no-git:warning"]);
    assert.deepEqual(codes({ ...UBUNTU, defaultUid: 0 }, { ...HEALTHY, uid: "0" }), ["root-user:warning"]);
  });

  it("matches one engine's command line and never the pkill that carries the pattern", () => {
    const id = "5e54f0a0-5c2b-44d8-a33c-b75bbe61cb3d";
    const pattern = new RegExp(instancePattern(id));
    assert.equal(pattern.test(`/home/u/.nivra/runtime/abc/node/bin/node main.mjs --stdio --instance ${id} --heartbeat-ms 30000`), true);
    assert.equal(pattern.test(`pkill -f -- ${instancePattern(id)}`), false);
  });
});

describe("WslTarget", () => {
  function target(responses: { probe: Record<string, string> | RunResult; install?: RunResult }) {
    const calls: Array<{ args: readonly string[]; input: boolean }> = [];
    const wsl = new WslTarget({
      distro: UBUNTU,
      wslExe: "C:\\Program Files\\WSL\\wsl.exe",
      runtime: { tarball: process.execPath, contentHash: "abc123" },
      runWsl: async (args, options) => {
        calls.push({ args, input: Boolean(options.input) });
        options.input?.destroy();
        const script = args[args.indexOf("-c") + 1];
        if (script === PROBE_SCRIPT) return "code" in responses.probe ? (responses.probe as RunResult) : ok(probeText(responses.probe as Record<string, string>));
        if (script === INSTALL_SCRIPT) return responses.install ?? ok("installed\n");
        return ok("");
      },
    });
    return { wsl, calls };
  }

  it("provisions an absent runtime from stdin, then launches with absolute paths from the distribution's $HOME", async () => {
    const { wsl, calls } = target({ probe: HEALTHY });
    const launch = await wsl.prepare({ instanceId: "11111111-1111-4111-8111-111111111111", heartbeatMs: 30_000 });
    const install = calls.find((call) => call.args.includes(INSTALL_SCRIPT))!;
    assert.deepEqual(install.args.slice(-3), ["sh", "abc123", "keep"]);
    assert.equal(install.input, true);
    assert.equal(launch.command, "C:\\Program Files\\WSL\\wsl.exe");
    assert.deepEqual(launch.args.slice(0, 6), ["-d", "Ubuntu", "--cd", "/home/odin", "--exec", "/home/odin/.nivra/runtime/abc123/node/bin/node"]);
    assert.ok(launch.args.includes("/home/odin/.nivra/runtime/abc123/engine/main.mjs"));
    assert.equal(launch.args[launch.args.indexOf("--home") + 1], "/home/odin/.nivra");
    assert.equal(launch.args.some((arg) => arg.includes("~")), false, "no ~: --exec runs no shell");
    assert.equal(launch.env["WSL_UTF8"], "1");
  });

  it("skips provisioning when the runtime is there, and forces it when asked", async () => {
    const present = target({ probe: { ...HEALTHY, runtime: "present" } });
    await present.wsl.prepare({ instanceId: "11111111-1111-4111-8111-111111111111", heartbeatMs: 0 });
    assert.equal(present.calls.some((call) => call.args.includes(INSTALL_SCRIPT)), false);
    const forced = target({ probe: { ...HEALTHY, runtime: "present" } });
    await forced.wsl.prepare({ instanceId: "11111111-1111-4111-8111-111111111111", heartbeatMs: 0, reprovision: true });
    assert.deepEqual(forced.calls.find((call) => call.args.includes(INSTALL_SCRIPT))!.args.slice(-1), ["force"]);
  });

  it("refuses to start on a blocking problem or a failed install, saying what to do", async () => {
    await assert.rejects(target({ probe: { ...HEALTHY, libc: "unknown" } }).wsl.prepare({ instanceId: "x", heartbeatMs: 0 }), (error: unknown) => {
      assert.ok(error instanceof TargetUnavailableError);
      assert.match(error.message, /Ubuntu or Debian/);
      return true;
    });
    await assert.rejects(target({ probe: HEALTHY, install: failed(5, "", "The engine could not load") }).wsl.prepare({ instanceId: "x", heartbeatMs: 0 }), /Installing the engine into Ubuntu · WSL failed: The engine could not load/);
    const unreachable = await target({ probe: failed(4294967295, "Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND") }).wsl.probe();
    assert.deepEqual(unreachable.problems.map((p) => p.code), ["WSL_E_DISTRO_NOT_FOUND"]);
  });
});
