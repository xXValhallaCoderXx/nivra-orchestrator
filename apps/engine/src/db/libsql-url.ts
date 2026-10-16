/**
 * The `file:` URL libsql needs for a database path. libsql reads the text after `file:` as a URL, so `%`, `#` and `?`
 * in a folder name (legal on every OS) must be escaped; everything else, Windows backslashes and drive letters
 * included, stays as it is (Hird D20; checked 2026-10-16 with a path holding a space, "ü", "%" and "#").
 */
export const libsqlFileUrl = (path: string): string => `file:${path.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
