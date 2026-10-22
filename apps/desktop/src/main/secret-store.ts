import { readFileSync, writeFileSync } from "node:fs";
import type { SecretName } from "@nivra/domain";
import { renameRetrying } from "./host-store.ts";

/**
 * API keys, owned by the host (D8), in `<userData>/secrets.json`, and handed to the engine in `initialize` and
 * `secrets.update`, never through the environment or a file the engine reads. Encryption comes from `KeyCrypto`
 * (Electron's `safeStorage` in the app; a stand-in in tests), so this module does not import Electron.
 *
 * What the person is told follows how each key is actually stored, not what the system could do now: a key saved
 * while no keychain was available stays unencrypted until it is re-encrypted, which happens as soon as a keychain
 * protects new data (`migrate`, and on every read).
 */

/** Electron's `safeStorage`, reduced to what the store needs. */
export interface KeyCrypto {
  /** Whether what is encrypted now is really protected. Linux's `basic_text` and `unknown` backends protect nothing. */
  protects(): boolean;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** How a saved key is kept: not at all, encrypted by the keychain, unencrypted, or encrypted by a keychain this session cannot reach. */
export type KeyState = "none" | "encrypted" | "unencrypted" | "unreadable";

type Stored = { scheme: "safeStorage" | "plain"; value: string };

export class SecretStore {
  readonly #path: string;
  readonly #crypto: KeyCrypto;

  constructor(path: string, crypto: KeyCrypto) {
    this.#path = path;
    this.#crypto = crypto;
  }

  keychain(): "available" | "unavailable" {
    return this.#crypto.protects() ? "available" : "unavailable";
  }

  #read(): Partial<Record<SecretName, Stored>> {
    try {
      return JSON.parse(readFileSync(this.#path, "utf8")) as Partial<Record<SecretName, Stored>>;
    } catch {
      return {};
    }
  }

  #write(data: Partial<Record<SecretName, Stored>>): void {
    const temp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameRetrying(temp, this.#path);
  }

  /** Re-encrypts every unencrypted key once a keychain protects new data. Call when the app is ready. */
  async migrate(): Promise<void> {
    if (!this.#crypto.protects()) return;
    for (const [name, stored] of Object.entries(this.#read()) as Array<[SecretName, Stored]>) {
      if (stored.scheme === "plain") await this.set(name, Buffer.from(stored.value, "base64").toString("utf8"));
    }
  }

  async state(name: SecretName): Promise<KeyState> {
    const stored = this.#read()[name];
    if (!stored) return "none";
    if (stored.scheme === "plain") return "unencrypted";
    return (await this.get(name)) === null ? "unreadable" : "encrypted";
  }

  /** What to tell the person about how their key is kept, or null when there is nothing to say. */
  note(state: KeyState): string | null {
    if (state === "unencrypted") {
      return `Your key is stored unencrypted in ${this.#path}, because this system has no keychain Nivra can use. Anyone who can read your files can read it.`;
    }
    if (state === "unreadable") return "Your saved key can't be read here: it was encrypted by a keychain this session can't reach. Enter it again.";
    if (state === "none" && !this.#crypto.protects()) {
      return `This system has no keychain Nivra can use, so a key you save will be stored unencrypted in ${this.#path}.`;
    }
    return null;
  }

  /** The key, or null when it is not set or can no longer be decrypted (then it must be entered again). */
  async get(name: SecretName): Promise<string | null> {
    const stored = this.#read()[name];
    if (!stored) return null;
    if (stored.scheme === "plain") {
      const value = Buffer.from(stored.value, "base64").toString("utf8");
      if (this.#crypto.protects()) await this.set(name, value);
      return value;
    }
    try {
      const result = await this.#crypto.decrypt(Buffer.from(stored.value, "base64"));
      if (result.shouldReEncrypt) await this.set(name, result.result);
      return result.result;
    } catch {
      return null;
    }
  }

  async set(name: SecretName, value: string | null): Promise<void> {
    const data = this.#read();
    if (value === null) delete data[name];
    else if (this.#crypto.protects()) data[name] = { scheme: "safeStorage", value: (await this.#crypto.encrypt(value)).toString("base64") };
    else data[name] = { scheme: "plain", value: Buffer.from(value, "utf8").toString("base64") };
    this.#write(data);
  }

  /** Every saved secret that can be read: the key, and the project id Nebius Sandboxes needs with it (D36). */
  async all(): Promise<Partial<Record<SecretName, string>>> {
    const names: readonly SecretName[] = ["NEBIUS_API_KEY", "NEBIUS_PROJECT_ID"];
    const values = await Promise.all(names.map(async (name) => [name, await this.get(name)] as const));
    return Object.fromEntries(values.filter(([, value]) => value !== null)) as Partial<Record<SecretName, string>>;
  }
}
