// WSL engine homes for test runs (D27). Each run of a Windows check gets a home of its own below ~/.nivra-test in the
// distribution, removes it when it is done, and checks that the release's home, ~/.nivra, is as it was: no database
// migrated, no runtime added or pruned. Shared by verify:windows (whose harness runs these scripts through wsl.exe),
// test:windows and verify:interrupt. Each script is run as `sh -c <script> sh <args…>`.
import { randomUUID } from "node:crypto";

/** A new home for one run, below the distribution's $HOME. */
export function testWslHome(kind: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `.nivra-test/${kind}-${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * What a test could change in the release's home: each database file's size, time and hash, and each runtime folder
 * with its time. Prints nothing when the distribution has no release home.
 */
export const RELEASE_HOME_STATE = [
  'cd "$HOME/.nivra" 2>/dev/null || exit 0',
  'for f in nivra.db nivra.db-wal nivra.db-shm nivra.db-journal mastra.db mastra.db-wal mastra.db-shm mastra.db-journal; do',
  '  if [ -e "$f" ]; then printf "%s %s %s\\n" "$f" "$(stat -c "%s %Y" "$f")" "$(sha256sum "$f" | cut -c1-16)"; fi',
  "done",
  'if [ -d runtime ]; then for d in runtime/*; do if [ -e "$d" ]; then printf "%s %s\\n" "$d" "$(stat -c %Y "$d")"; fi; done; fi',
].join("\n");

/** Removes homes that interrupted runs left, once they are a day old, so no run still going is touched. */
export const STALE_TEST_HOMES = 'if [ -d "$HOME/.nivra-test" ]; then find "$HOME/.nivra-test" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} +; fi';

/** Removes one run's home, `$1`, which must be below .nivra-test. */
export const REMOVE_TEST_HOME = 'case "$1" in *..*) echo "not a test home: $1" >&2; exit 2 ;; .nivra-test/?*) rm -rf "$HOME/$1" ;; *) echo "not a test home: $1" >&2; exit 2 ;; esac';

/** Says what changed in the release's home, in words a person can act on; null when nothing did. */
export function releaseHomeChange(before: string, after: string): string | null {
  if (before === after) return null;
  const lines = (text: string) => new Set(text.split("\n").filter(Boolean));
  const was = lines(before);
  const now = lines(after);
  const gone = [...was].filter((line) => !now.has(line));
  const added = [...now].filter((line) => !was.has(line));
  return `~/.nivra changed during this run (before: ${gone.join("; ") || "nothing"}; after: ${added.join("; ") || "nothing"}). If the installed Nivra was running, close it and run this again; otherwise this run reached the release's home.`;
}
