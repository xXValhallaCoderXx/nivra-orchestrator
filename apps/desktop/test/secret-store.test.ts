import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SecretStore, type KeyCrypto } from "../src/main/secret-store.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for safeStorage: "encrypts" by reversing, and can lose its keychain or refuse to decrypt. With a `gate`,
 * the next encryption waits for it, as a slow keychain would.
 */
function fakeCrypto(): KeyCrypto & { keychain: boolean; broken: boolean; gate: Promise<void> | null } {
  const crypto = {
    keychain: false,
    broken: false,
    gate: null as Promise<void> | null,
    protects: () => crypto.keychain,
    encrypt: async (text: string) => {
      const gate = crypto.gate;
      crypto.gate = null;
      await gate;
      return Buffer.from(`enc:${[...text].reverse().join("")}`);
    },
    decrypt: async (data: Buffer) => {
      if (crypto.broken) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return { result: [...data.toString().slice(4)].reverse().join(""), shouldReEncrypt: false };
    },
  };
  return crypto;
}

function store() {
  const dir = mkdtempSync(join(tmpdir(), "nivra secrets "));
  dirs.push(dir);
  const path = join(dir, "secrets.json");
  const crypto = fakeCrypto();
  return { secrets: new SecretStore(path, crypto), crypto, file: () => readFileSync(path, "utf8") };
}

const KEY = "nebius-test-key-0123456789";
const TAVILY = "tavily-test-key-0123456789";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Holds the store's next encryption until the returned function is called. */
function hold(crypto: { gate: Promise<void> | null }): () => void {
  let release!: () => void;
  crypto.gate = new Promise<void>((resolve) => (release = resolve));
  return release;
}

describe("SecretStore", () => {
  it("says a key saved without a keychain is unencrypted, and where it is", async () => {
    const { secrets } = store();
    assert.match(secrets.note("none") ?? "", /a key you save will be stored unencrypted/);
    await secrets.set("NEBIUS_API_KEY", KEY);
    const state = await secrets.state("NEBIUS_API_KEY");
    assert.equal(state, "unencrypted");
    assert.match(secrets.note(state) ?? "", /stored unencrypted in .*secrets\.json/);
  });

  it("re-encrypts an unencrypted key once a keychain is available, and only then stops warning", async () => {
    const { secrets, crypto, file } = store();
    await secrets.set("NEBIUS_API_KEY", KEY);
    crypto.keychain = true;
    // The review's case: before migrating, the stored scheme still says unencrypted, whatever the system can do now.
    assert.equal(await secrets.state("NEBIUS_API_KEY"), "unencrypted");
    await secrets.migrate();
    assert.equal(await secrets.state("NEBIUS_API_KEY"), "encrypted");
    assert.equal(secrets.note("encrypted"), null);
    assert.equal(file().includes(Buffer.from(KEY).toString("base64")), false, "no plaintext copy is left in the file");
    assert.equal(await secrets.get("NEBIUS_API_KEY"), KEY);
  });

  it("calls a key it cannot decrypt unreadable, and asks for it again", async () => {
    const { secrets, crypto } = store();
    crypto.keychain = true;
    await secrets.set("NEBIUS_API_KEY", KEY);
    crypto.broken = true;
    assert.equal(await secrets.get("NEBIUS_API_KEY"), null);
    const state = await secrets.state("NEBIUS_API_KEY");
    assert.equal(state, "unreadable");
    assert.match(secrets.note(state) ?? "", /Enter it again/);
  });

  it("forgets a removed key", async () => {
    const { secrets } = store();
    await secrets.set("NEBIUS_API_KEY", KEY);
    await secrets.set("NEBIUS_API_KEY", null);
    assert.equal(await secrets.state("NEBIUS_API_KEY"), "none");
    assert.deepEqual(await secrets.all(), {});
  });

  it("keeps both keys when two are saved at once, the first held by a slow keychain", async () => {
    const { secrets, crypto } = store();
    crypto.keychain = true;
    const release = hold(crypto);
    const first = secrets.set("NEBIUS_API_KEY", KEY);
    const second = secrets.set("TAVILY_API_KEY", TAVILY);
    await pause(20);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(await secrets.all(), { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY });
  });

  it("never brings back a key removed while another was being saved", async () => {
    const { secrets, crypto } = store();
    crypto.keychain = true;
    await secrets.set("TAVILY_API_KEY", TAVILY);
    const release = hold(crypto);
    const saving = secrets.set("NEBIUS_API_KEY", KEY);
    const removing = secrets.set("TAVILY_API_KEY", null);
    await pause(20);
    release();
    await Promise.all([saving, removing]);
    assert.deepEqual(await secrets.all(), { NEBIUS_API_KEY: KEY });
  });

  it("never brings back a key removed before a read's re-encryption of it ran", async () => {
    const { secrets, crypto, file } = store();
    await secrets.set("TAVILY_API_KEY", TAVILY);
    crypto.keychain = true;
    const release = hold(crypto);
    const saving = secrets.set("NEBIUS_API_KEY", KEY);
    const removing = secrets.set("TAVILY_API_KEY", null);
    // Read while the removal waits its turn: the read gives the key it read, and its re-encryption comes after the
    // removal.
    const reading = secrets.get("TAVILY_API_KEY");
    await pause(20);
    release();
    assert.equal(await reading, TAVILY);
    await Promise.all([saving, removing]);
    assert.deepEqual([await secrets.all(), file().includes("TAVILY_API_KEY")], [{ NEBIUS_API_KEY: KEY }, false]);
  });
});
