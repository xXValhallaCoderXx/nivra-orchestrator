import { StoredEnvironmentInput, type EnvironmentReport, type EnvironmentStopCode } from "@nivra/domain";

/**
 * An environment's preparation report and its stops (NIV-49, D41). What a person reads about a stopped preparation is
 * chosen by its code (D29): Nivra's own words, never a path, git's words, the service's or the install's, which the
 * report keeps apart, as the end of the install's log. Only a stop before anything was sent says nothing was sent.
 */

/** A preparation's input as the engine reads it back from its store, masked, so only its shape is checked. */
export function readEnvironmentInput(input: unknown): StoredEnvironmentInput | null {
  const parsed = StoredEnvironmentInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export const ENVIRONMENT_STOP_MESSAGES: Readonly<Record<EnvironmentStopCode, string>> = {
  consent: "This project doesn't allow uploading to Nebius Sandboxes, so nothing was sent. Allow uploads for it, then prepare the environment again.",
  credentials: "Preparing an environment needs your Nebius key and project id, and they aren't both set, so nothing was sent. Add them in Settings, then prepare it again.",
  "native-windows": "Preparing an environment on Windows itself isn't available yet, so nothing was sent. Add the repository from a WSL distribution, then prepare it there.",
  preview: "What preparing would send changed since you previewed it, or can't be sent as it is now, so nothing was sent. Preview the environment again.",
  layout: "This commit can't be prepared from its manifests alone, so nothing was sent. Preview the environment to see why.",
  git: "Git couldn't be run on this checkout, so nothing was sent. Make sure git is installed there, then prepare the environment again.",
  image: "Nebius couldn't provide Nivra's Node image in your project, so no environment was made. What Nebius keeps is listed below. Try again later.",
  install: "The install in the sandbox didn't finish, so no environment was made. The end of its log is below: fix what it says in the repository, commit, then prepare the environment again.",
  versions: "The prepared environment doesn't have the Node or pnpm version it was pinned to, so it wasn't kept. Prepare it again; if it keeps happening, report it.",
  cancelled: "Cancelled.",
  uncertain: "It isn't known whether part of the preparation started in Nebius, so it was never sent again, and no environment was made. Anything still open is listed below, for you to follow up.",
  "sandbox-failed": "Nebius Sandboxes couldn't run the preparation, so no environment was made. Try again later; what Nebius keeps is listed below.",
  fault: "Something inside Nivra failed during the preparation, so no environment was made. Try again; if it keeps happening, report it with the engine log.",
  inspect: "The base image doesn't hold what the recipe asks for, so nothing was uploaded and no environment was made. What it found is below: preview the environment again, and choose a version the image has.",
  bootstrap: "The sandbox couldn't install the package manager the recipe pins, so no environment was made. The end of its log is below: check the version exists, then prepare the environment again.",
  readiness: "The prepared environment didn't pass its checks with networking off, so it wasn't kept. What failed is below: prepare it again, and if it keeps happening, report it.",
};

/** A report for a preparation that stopped before anything was sent, or one still going, in the same shape. */
export function earlyEnvironmentReport(input: { outcome: EnvironmentReport["outcome"]; code: EnvironmentStopCode | null; step: string | null; request: EnvironmentReport["request"]; now: Date; finished: boolean }): EnvironmentReport {
  return {
    outcome: input.outcome,
    stopped: input.code ? { code: input.code, step: input.step, message: ENVIRONMENT_STOP_MESSAGES[input.code] } : null,
    prepared: null,
    install: null,
    steps: [],
    cleanup: null,
    request: input.request,
    updatedAt: input.now.toISOString(),
    finishedAt: input.finished ? input.now.toISOString() : null,
  };
}
