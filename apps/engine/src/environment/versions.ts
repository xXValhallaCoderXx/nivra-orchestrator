/** Exact versions (x.y.z), as the release index and a resolved recipe hold them (NIV-55). */

/** An exact version's parts, or null when it isn't x.y.z (an optional leading v is allowed). */
export function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Compares two exact versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) throw new Error(`not an exact version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
