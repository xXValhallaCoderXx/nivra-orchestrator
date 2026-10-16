/**
 * What a folder picked in the native dialog means for a target (D1). Paths are converted here and nowhere else: a
 * project is recorded in the target's own form, and a command never runs somewhere the person did not choose.
 * Pure, so it is tested directly.
 */

export type WslPick =
  | { kind: "posix"; path: string }
  /** A Windows drive folder: `wslpath -u` inside the distribution turns it into `/mnt/<drive>/…`, which is slow. */
  | { kind: "drive"; windowsPath: string }
  | { kind: "refused"; reason: string };

const WSL_UNC = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i;

/** Where a picked folder is for a WSL target: inside the distribution, on a Windows drive, or somewhere unusable. */
export function wslPick(picked: string, distro: string): WslPick {
  const unc = WSL_UNC.exec(picked);
  if (unc) {
    const [, pickedDistro, rest] = unc as unknown as [string, string, string | undefined];
    if (pickedDistro.toLowerCase() !== distro.toLowerCase()) {
      return { kind: "refused", reason: `That folder is in ${pickedDistro}, not ${distro}. Choose ${pickedDistro} · WSL as the target to work on it.` };
    }
    const path = (rest ?? "\\").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    return { kind: "posix", path };
  }
  if (/^[A-Za-z]:[\\/]/.test(picked)) return { kind: "drive", windowsPath: picked };
  return { kind: "refused", reason: "Nivra can't use a network folder. Choose a folder inside the distribution, or on a local drive." };
}

/** Why a picked folder cannot be used by the native Windows engine, or null when it can. */
export function windowsPickProblem(picked: string): string | null {
  const unc = WSL_UNC.exec(picked);
  if (unc) return `That folder is inside WSL (${unc[1]}). Choose ${unc[1]} · WSL as the target to work on it: its tools run there.`;
  if (picked.startsWith("\\\\")) return "Nivra can't use a network folder. Choose a folder on a local drive.";
  return null;
}

/** The distribution's home as Windows sees it, where the picker opens for a WSL target. */
export const uncHome = (distro: string, posixHome: string): string => `\\\\wsl.localhost\\${distro}${posixHome.replace(/\//g, "\\")}`;

/** The folder's last name, for a project's label. */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}
