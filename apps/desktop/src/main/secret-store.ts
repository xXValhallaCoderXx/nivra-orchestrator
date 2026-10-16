import { readFileSync, writeFileSync } from "node:fs";
import { safeStorage } from "electron";
import type { SecretName } from "@nivra/domain";
import { renameRetrying } from "./host-store.ts";

/**
 * API keys, owned by the host (D8): encrypted with Electron's `safeStorage` (DPAPI on Windows, the Keychain on macOS,
 * libsecret on Linux) in `<userData>/secrets.json`, and handed to the engine in `initialize` and `secrets.update`,
 * never through the environment or a file the engine reads. On Linux, the `basic_text` and `unknown` backends
 * protect nothing (WSLg and Xvfb report `basic_text`): such keys are recorded as unencrypted and the UI says so.
 */

type Stored = { scheme: "safeStorage" | "plain"; value: string };

export class SecretStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** Whether keys are really encrypted on this machine. Call only once the app is ready. */
  encryption(): "encrypted" | "unencrypted" {
    if (!safeStorage.isEncryptionAvailable()) return "unencrypted";
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === "basic_text" || backend === "unknown") return "unencrypted";
    }
    return "encrypted";
  }

  note(): string | null {
    return this.encryption() === "encrypted"
      ? null
      : `This system has no keychain Nivra can use, so keys are stored unencrypted in ${this.#path}. Anyone who can read your files can read them.`;
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

  has(name: SecretName): boolean {
    return Boolean(this.#read()[name]);
  }

  /** The key, or null when it is not set or can no longer be decrypted (then it must be entered again). */
  async get(name: SecretName): Promise<string | null> {
    const stored = this.#read()[name];
    if (!stored) return null;
    if (stored.scheme === "plain") return Buffer.from(stored.value, "base64").toString("utf8");
    try {
      const result = await safeStorage.decryptStringAsync(Buffer.from(stored.value, "base64"));
      if (result.shouldReEncrypt) await this.set(name, result.result);
      return result.result;
    } catch {
      return null;
    }
  }

  async set(name: SecretName, value: string | null): Promise<void> {
    const data = this.#read();
    if (value === null) delete data[name];
    else if (this.encryption() === "encrypted") data[name] = { scheme: "safeStorage", value: (await safeStorage.encryptStringAsync(value)).toString("base64") };
    else data[name] = { scheme: "plain", value: Buffer.from(value, "utf8").toString("base64") };
    this.#write(data);
  }

  async all(): Promise<Partial<Record<SecretName, string>>> {
    const nebius = await this.get("NEBIUS_API_KEY");
    return nebius ? { NEBIUS_API_KEY: nebius } : {};
  }
}
