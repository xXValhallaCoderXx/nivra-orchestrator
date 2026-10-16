import { LineTooLongError, MAX_LINE_LENGTH } from "./protocol.ts";

/**
 * Splits a byte stream into lines of UTF-8 text, for the protocol (D2). A multi-byte character split across chunks is
 * decoded once both halves arrive, and a line may end in `\n` or `\r\n`.
 *
 * Partial lines are kept as a list of pieces and joined only when the line ends, so a long line arriving in many small
 * chunks is copied once rather than once per chunk. A line longer than `maxLength` throws `LineTooLongError`; the
 * splitter's state is then undefined, and the stream must be treated as broken.
 */
export class LineSplitter {
  readonly #decoder = new TextDecoder("utf-8");
  #pieces: string[] = [];
  #pending = 0;

  readonly maxLength: number;

  constructor(maxLength: number = MAX_LINE_LENGTH) {
    this.maxLength = maxLength;
  }

  /** Feeds one chunk; returns the lines it completed, without their line endings. */
  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end === -1) break;
      lines.push(this.#finish(text.slice(start, end)));
      start = end + 1;
    }
    if (start < text.length) this.#keep(text.slice(start));
    return lines;
  }

  /** Ends the stream; returns a last line that had no line ending, or null when there was none. */
  end(): string | null {
    const tail = this.#decoder.decode();
    if (tail) this.#keep(tail);
    if (this.#pending === 0) return null;
    return this.#finish("");
  }

  #keep(piece: string): void {
    this.#pieces.push(piece);
    this.#pending += piece.length;
    if (this.#pending > this.maxLength) throw new LineTooLongError(this.#pending, this.maxLength);
  }

  #finish(last: string): string {
    let line = this.#pieces.length > 0 ? this.#pieces.join("") + last : last;
    this.#pieces = [];
    this.#pending = 0;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > this.maxLength) throw new LineTooLongError(line.length, this.maxLength);
    return line;
  }
}
