import type { DoctorCheck, DoctorReport, ModelEndpoint } from "@nivra/domain";
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
  /** Where this engine sends model requests (D22). */
  endpoint: { url: string; kind: ModelEndpoint };
}

/** What works on this target, and what to do about what doesn't. Checks only detect; nothing is changed. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    { id: "engine", status: "ok", title: "Engine", detail: `Nivra engine ${ENGINE_VERSION} on ${deps.platform}/${deps.arch}, Node ${process.versions.node}`, fix: null },
    { id: "home", status: "ok", title: "Engine data", detail: `Stored in ${deps.home}`, fix: null },
    deps.endpoint.kind === "token-factory"
      ? { id: "models", status: "ok", title: "Model endpoint", detail: `Nebius Token Factory (${deps.endpoint.url})`, fix: null }
      : {
          id: "models",
          status: "warn",
          title: "Model endpoint",
          detail: `A test endpoint on this machine (${deps.endpoint.url}), not Token Factory`,
          fix: "This engine was started for testing. Start Nivra normally to use Token Factory.",
        },
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
  // A sandbox needs the project id as well as the key (D36).
  const key = deps.vault.has("NEBIUS_API_KEY");
  const nebius = key && deps.vault.has("NEBIUS_PROJECT_ID");
  const lines = [
    "No isolation: always available, enforces nothing.",
    nebius ? "Nebius Sandboxes: key and project id set; access not checked yet." : key ? "Nebius Sandboxes: the key is set, but not the project id." : "Nebius Sandboxes: no credentials set.",
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
    fix: nebius || openshell ? null : "Coding work that installs packages needs a sandbox: add your Nebius key and project id in Settings, or install OpenShell (Linux and WSL).",
  });
  return { checks };
}
