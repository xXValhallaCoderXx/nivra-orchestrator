/**
 * Shapes of common credentials, masked wherever they appear: repository files before a model sees them, what the
 * engine stores, and what the host keeps in its workspace (D26). Known key values are masked by whoever holds them (the
 * engine's vault, the host's secret store); these catch secrets Nivra has never been given. Shared by the engine and
 * the host, so both apply one definition. Ported from Hird's `config/secrets.ts` (lines 81-168) @ 45c0057; the
 * file-based secret store around it is not (D8). Detection is by pattern, so it can't recognise every secret: the
 * consent text says so (D22).
 */

/** A private key block's first and last line, as pattern sources. The name between the dashes holds no dash. */
export const KEY_HEADER = "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----";
export const KEY_FOOTER = "-----END [A-Z0-9 ]*PRIVATE KEY-----";

const HEADER = new RegExp(KEY_HEADER, "g");
const FOOTER = new RegExp(KEY_FOOTER, "g");

/** The first private key block at or after `from`: the leftmost header, to the end of the first footer after it. */
function keyBlockFrom(text: string, from: number): { start: number; end: number } | null {
  HEADER.lastIndex = from;
  const header = HEADER.exec(text);
  if (!header) return null;
  FOOTER.lastIndex = header.index + header[0].length;
  const footer = FOOTER.exec(text);
  // No footer after the leftmost header means no block at all, so the text is read once (linear time).
  return footer ? { start: header.index, end: footer.index + footer[0].length } : null;
}

/** `text` with every private key block replaced by `replacement`'s result, in time linear in the text. */
export function replaceKeyBlocks(text: string, replacement: (block: string) => string): string {
  const parts: string[] = [];
  let from = 0;
  for (let block = keyBlockFrom(text, from); block; block = keyBlockFrom(text, from)) {
    parts.push(text.slice(from, block.start), `${replacement(text.slice(block.start, block.end))}`);
    from = block.end;
  }
  return parts.length ? parts.join("") + text.slice(from) : text;
}

export function hasKeyBlock(text: string): boolean {
  return keyBlockFrom(text, 0) !== null;
}

/** Each shape has a name, so a check can say which it found without quoting it. A private key block comes first. */
const SECRET_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "api-key", pattern: /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: "slack-token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { id: "linear-token", pattern: /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g },
  { id: "tavily-key", pattern: /\btvly-[A-Za-z0-9_-]{16,}/g },
];

/**
 * `text` with every known credential shape replaced by `[redacted]`. With `keepLines`, a masked block keeps its line
 * breaks, so `path:line` citations into the rest of a file stay right.
 */
export function maskSecretPatterns(text: string, options: { keepLines?: boolean } = {}): string {
  const replacement = options.keepLines ? (match: string) => `[redacted]${"\n".repeat(match.split("\n").length - 1)}` : () => "[redacted]";
  return SECRET_PATTERNS.reduce((masked, { pattern }) => masked.replace(pattern, replacement), replaceKeyBlocks(text, replacement));
}

/** The names of the credential shapes found in `text`, a private key block first. */
export function secretShapes(text: string): string[] {
  const found = SECRET_PATTERNS.filter(({ pattern }) => text.search(pattern) >= 0).map(({ id }) => id);
  return hasKeyBlock(text) ? ["private-key", ...found] : found;
}

/** How text is masked before a model sees it, or before it is stored. `keepLines` keeps line breaks in masked blocks. */
export type Mask = (text: string, options?: { keepLines?: boolean }) => string;

/** The vault's known values, then the credential shapes. */
export function combinedMask(knownValues: (text: string) => string): Mask {
  return (text, options) => maskSecretPatterns(knownValues(text), options);
}

/**
 * `text` with each known secret value replaced by `[secret:<name>]`, the longest first, so a value inside another is
 * replaced whole. The engine's vault and the host's workspace mask the same way.
 */
export function maskKnownValues(text: string, values: ReadonlyArray<readonly [name: string, value: string]>): string {
  let masked = text;
  for (const [name, value] of [...values].filter(([, value]) => value.length > 0).sort((a, b) => b[1].length - a[1].length)) {
    if (masked.includes(value)) masked = masked.split(value).join(`[secret:${name}]`);
  }
  return masked;
}
