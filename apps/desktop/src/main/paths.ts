/**
 * Where a folder picked in the native dialog is worked on (D17): the operating system that owns its filesystem decides,
 * once, when the folder is added. A folder on a Windows drive belongs to the Windows engine, one inside a WSL
 * distribution to that distribution's engine, and there is no choice to get wrong later. Paths are converted here and
 * nowhere else. Pure, so it is tested directly.
 */

export type PickedFolder =
  | { kind: "local"; nativePath: string; notice: string | null }
  | { kind: "wsl"; distro: string; nativePath: string }
  | { kind: "refused"; reason: string };

const WSL_UNC = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i;
const DRIVE = /^[A-Za-z]:[\\/]/;
const MOUNT = /^\/mnt\/([A-Za-z])(\/.*)?$/;

const SLOW_MOUNT =
  "This folder is on a Windows drive, which is slow from Linux: git and builds will run noticeably slower. For speed, keep the repository inside the distribution.";

/** Which engine a picked folder belongs to, and its path in that engine's own form. */
export function classifyPicked(picked: string, host: { platform: NodeJS.Platform; insideWsl: boolean }): PickedFolder {
  if (host.platform === "win32") {
    const unc = WSL_UNC.exec(picked);
    if (unc) {
      const [, distro, rest] = unc as unknown as [string, string, string | undefined];
      const posix = (rest ?? "\\").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
      // A Windows drive seen through WSL is still Windows' to write (D15).
      const drive = driveFromMount(posix);
      if (drive) {
        return {
          kind: "local",
          nativePath: drive,
          notice: `This folder is on drive ${drive[0]}:, so it runs on Windows, which owns that drive. To use Linux tools on it, move the repository into ${distro} and add it from there.`,
        };
      }
      return { kind: "wsl", distro, nativePath: posix };
    }
    if (DRIVE.test(picked)) return { kind: "local", nativePath: picked, notice: null };
    if (picked.startsWith("\\\\")) {
      return { kind: "refused", reason: "That folder is on a network share. Nivra works on folders on this computer: copy the repository to a local drive or into a WSL distribution, then add it." };
    }
    return { kind: "refused", reason: `Nivra can't use "${picked}". Choose a folder on a local drive or inside a WSL distribution.` };
  }
  if (!picked.startsWith("/")) return { kind: "refused", reason: `Nivra can't use "${picked}". Choose a folder by its full path.` };
  return { kind: "local", nativePath: picked, notice: host.insideWsl && MOUNT.test(picked) ? SLOW_MOUNT : null };
}

/** `/mnt/c/a b` as Windows writes it (`C:\a b`); null for anything that isn't a drive mount (`/mnt/wsl/…`). */
export function driveFromMount(posix: string): string | null {
  const match = MOUNT.exec(posix);
  if (!match) return null;
  const [, letter, rest] = match as unknown as [string, string, string | undefined];
  return `${letter.toUpperCase()}:\\${(rest ?? "").replace(/^\/+/, "").replace(/\//g, "\\")}`;
}

/** Whether two recorded paths are the same folder. Windows folders ignore case and the slash style; others don't. */
export function sameFolder(a: string, b: string, windowsFolder: boolean): boolean {
  const normalise = (path: string) => (windowsFolder ? path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : path.replace(/\/+$/, ""));
  return normalise(a) === normalise(b);
}

/** The folder's last name, for a project's label. */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}
