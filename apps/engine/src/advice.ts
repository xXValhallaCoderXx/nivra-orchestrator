/** What to do when git is missing, in the target's own terms. */
export function installGitAdvice(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Install Git for Windows from https://git-scm.com/download/win, then try again.";
  if (platform === "darwin") return "Install Git with `xcode-select --install` or Homebrew, then try again.";
  return "Install Git with your distribution's package manager (for example `sudo apt install git`), then try again.";
}
