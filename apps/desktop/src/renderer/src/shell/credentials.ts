/**
 * Whether typed text looks like it holds a credential, so a draft holding one is never kept (NIV-56). The shapes are
 * copied from packages/domain/src/credentials.ts (KEY_HEADER, KEY_FOOTER and SECRET_PATTERNS): domain imports in the
 * renderer are type-only (AGENTS.md), so the renderer can't import them. Keep the two in step:
 * test/shell-drafts.test.ts checks that this copy finds exactly what the domain's `secretShapes` finds. Like the
 * domain's, it can't recognise every secret, and it never sees the keys Nivra holds: only their shapes.
 */

const KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_FOOTER = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

const SHAPES: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/,
  /\btvly-[A-Za-z0-9_-]{16,}/,
];

/** A private key block: a header, then a footer after it (the domain's rule: no footer after the header, no block). */
function hasKeyBlock(text: string): boolean {
  const header = KEY_HEADER.exec(text);
  return header !== null && KEY_FOOTER.test(text.slice(header.index + header[0].length));
}

export function looksLikeCredential(text: string): boolean {
  return hasKeyBlock(text) || SHAPES.some((shape) => shape.test(text));
}

/** Every string inside a value, wherever it sits, checked the same way: a draft is refused if any of them is one. */
export function holdsCredential(value: unknown): boolean {
  if (typeof value === "string") return looksLikeCredential(value);
  if (Array.isArray(value)) return value.some(holdsCredential);
  if (value && typeof value === "object") return Object.values(value).some(holdsCredential);
  return false;
}
