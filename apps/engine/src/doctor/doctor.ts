import type { DoctorCheck, DoctorReport } from "@nivra/domain";
import { installGitAdvice } from "../advice.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import { findOnPath } from "../exec/find-executable.ts";
import type { SecretVault } from "../secrets/vault.ts";
import { ENGINE_VERSION } from "../version.ts";

export interface DoctorDeps {
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** The environment tools are looked up in (WSL's leaked Windows folders already removed). */
  toolEnv: NodeJS.ProcessEnv;
  findGit: () => string | null;
  backend: ExecutionBackend;
  vault: SecretVault;
}

/** What works on this target, and what to do about what doesn't. Checks only detect; nothing is changed. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    { id: "engine", status: "ok", title: "Engine", detail: `Nivra engine ${ENGINE_VERSION} on ${deps.platform}/${deps.arch}, Node ${process.versions.node}`, fix: null },
    { id: "home", status: "ok", title: "Engine data", detail: `Stored in ${deps.home}`, fix: null },
  ];

  const git = deps.findGit();
  if (!git) {
    checks.push({ id: "git", status: "fail", title: "Git", detail: "Git isn't installed on this target, or isn't on its PATH.", fix: installGitAdvice(deps.platform) });
  } else {
    const session = await deps.backend.open({ workspace: deps.home });
    try {
      const result = await session.exec({ argv: [git, "--version"], cwd: deps.home, timeoutMs: 10_000, maxOutputBytes: 4_096 });
      checks.push(
        result.exitCode === 0
          ? { id: "git", status: "ok", title: "Git", detail: `${result.stdout.trim()} (${git})`, fix: null }
          : { id: "git", status: "fail", title: "Git", detail: `${git} --version failed (exit ${String(result.exitCode)}).`, fix: installGitAdvice(deps.platform) },
      );
    } finally {
      await session.close();
    }
  }

  // Execution boundaries this target could offer (D9). Detection only: nothing here starts a sandbox.
  const find = (name: string) => findOnPath(name, { env: deps.toolEnv, platform: deps.platform });
  const openshell = deps.platform === "win32" ? null : find("openshell");
  const runtime = find("docker") ?? find("podman");
  const nebius = deps.vault.has("NEBIUS_API_KEY");
  const lines = [
    "No isolation: always available, enforces nothing.",
    nebius ? "Nebius Sandboxes: credentials set; access not checked yet." : "Nebius Sandboxes: no credentials set.",
    deps.platform === "win32"
      ? "OpenShell: not available on native Windows."
      : openshell
        ? `OpenShell: CLI found at ${openshell}${runtime ? "" : ", but no Docker or Podman was found"}.`
        : "OpenShell: not installed.",
  ];
  checks.push({
    id: "boundaries",
    status: nebius || openshell ? "ok" : "warn",
    title: "Execution boundaries",
    detail: lines.join(" "),
    fix: nebius || openshell ? null : "Coding work that installs packages needs a sandbox: add your Nebius key in Settings, or install OpenShell (Linux and WSL).",
  });
  return { checks };
}
