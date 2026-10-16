import { encodeMessage, type ErrorMessage, type NotificationMessage, type ResultMessage } from "@nivra/domain";

/** Writes one chunk to the protocol stream; the callback runs once the chunk is handed to the OS. */
export type RawWrite = (chunk: string, callback: (error?: Error | null) => void) => boolean;

/** The writer `main.mjs` kept for the protocol before redirecting stdout (D2). */
export function launcherWrite(): RawWrite | null {
  const write = (globalThis as Record<symbol, unknown>)[Symbol.for("nivra.protocol.write")];
  return typeof write === "function" ? (write as RawWrite) : null;
}

/**
 * The engine's only way onto stdout. Each message is one line; `send` resolves once the line is handed to the OS, so
 * the engine can wait for its last reply before exiting. After a write fails (the host closed the pipe), further
 * messages are dropped and `onBroken` has been told once.
 */
export class ProtocolOutput {
  readonly #write: RawWrite;
  readonly #onBroken: (error: Error) => void;
  #broken = false;

  constructor(write: RawWrite, onBroken: (error: Error) => void = () => undefined) {
    this.#write = write;
    this.#onBroken = onBroken;
  }

  get broken(): boolean {
    return this.#broken;
  }

  send(message: ResultMessage | ErrorMessage | NotificationMessage): Promise<void> {
    if (this.#broken) return Promise.resolve();
    const line = encodeMessage(message);
    return new Promise((resolve) => {
      try {
        this.#write(line, (error) => {
          if (error) this.fail(error);
          resolve();
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        resolve();
      }
    });
  }

  /** The stream is gone (EPIPE or a failed write). */
  fail(error: Error): void {
    if (this.#broken) return;
    this.#broken = true;
    this.#onBroken(error);
  }
}
