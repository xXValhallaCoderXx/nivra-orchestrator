/**
 * Text split at its code spans, as Nivra's own messages mark a command (for example "Run `wsl --update` in a terminal"):
 * the plain parts and the code parts, in order, so a page can show each command as code with a copy button beside it.
 * It reads the text's markup only; it never decides what kind of failure a message is about (AGENTS.md: WSL failures
 * are told apart by their code).
 */
export function codeSpans(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const span = /`([^`\n]+)`/g;
  let from = 0;
  for (let match = span.exec(text); match; match = span.exec(text)) {
    if (match.index > from) parts.push({ code: false, text: text.slice(from, match.index) });
    parts.push({ code: true, text: match[1]! });
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push({ code: false, text: text.slice(from) });
  return parts;
}
