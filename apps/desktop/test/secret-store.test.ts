import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SECRETS_UNREADABLE, SecretStore, type KeyCrypto } from "../src/main/secret-store.ts";

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

/**
 * The draft check's own read (NIV-56; Nate: an unreadable key or a failed check never counts as safe): strict where every
 * other read takes a file it can't read as no keys, and read-only, since it runs on every change to a draft.
 */
describe("SecretStore's strict read for the draft check (NIV-56)", () => {
  const NAMES = ["NEBIUS_API_KEY", "TAVILY_API_KEY"] as const;
  function strict() {
    const dir = mkdtempSync(join(tmpdir(), "nivra secrets strict "));
    dirs.push(dir);
    const path = join(dir, "secrets.json");
    const crypto = fakeCrypto();
    return { secrets: new SecretStore(path, crypto), crypto, path };
  }
  /** The read fails in its fixed words, which hold none of `secrets`. */
  async function refused(read: Promise<string[]>, ...secrets: string[]) {
    await assert.rejects(read, (error: Error) => {
      assert.equal(error.message, SECRETS_UNREADABLE);
      assert.deepEqual(secrets.filter((text) => error.message.includes(text)), []);
      return true;
    });
  }

  it("reads no keys from a missing file", async () => {
    assert.deepEqual(await strict().secrets.draftCheckValues(NAMES), []);
  });

  it("returns an unencrypted and an encrypted key's values, and skips a name that isn't saved", async () => {
    const { secrets, crypto } = strict();
    await secrets.set("NEBIUS_API_KEY", KEY);
    crypto.keychain = true;
    await secrets.set("TAVILY_API_KEY", TAVILY);
    assert.deepEqual([await secrets.draftCheckValues(NAMES), await secrets.draftCheckValues(["NEBIUS_PROJECT_ID", "TAVILY_API_KEY"])], [[KEY, TAVILY], [TAVILY]]);
  });

  it("never writes: no re-encryption of an unencrypted key under a keychain, or of one the keychain asks to re-encrypt", async () => {
    const { secrets, crypto, path } = strict();
    await secrets.set("NEBIUS_API_KEY", KEY);
    crypto.keychain = true;
    await secrets.set("TAVILY_API_KEY", TAVILY);
    const decrypt = crypto.decrypt;
    crypto.decrypt = async (data) => ({ ...(await decrypt(data)), shouldReEncrypt: true });
    const before = [readFileSync(path, "utf8"), statSync(path).mtimeMs];
    assert.deepEqual(await secrets.draftCheckValues(NAMES), [KEY, TAVILY]);
    await pause(20);
    assert.deepEqual([readFileSync(path, "utf8"), statSync(path).mtimeMs], before);
  });

  it("throws on a file it can't read, never taking it as no keys", async () => {
    const { secrets, path } = strict();
    mkdirSync(path);
    await refused(secrets.draftCheckValues(NAMES));
  });

  it("throws on a file that isn't the store's JSON, in words that hold none of it", async () => {
    const { secrets, path } = strict();
    const fragment = Buffer.from("secret-fragment").toString("base64");
    const files = [`{"NEBIUS_API_KEY": {"scheme": "plain", "value": "${fragment}`, "null", "[]", '"text"', '{"NEBIUS_API_KEY": {"scheme": "other", "value": "x"}}', '{"TAVILY_API_KEY": null}'];
    for (const text of files) {
      writeFileSync(path, text);
      await refused(secrets.draftCheckValues(NAMES), fragment, "secret-fragment");
    }
  });

  it("throws when a saved key can't be decrypted, where the other reads give no key", async () => {
    const { secrets, crypto } = strict();
    crypto.keychain = true;
    await secrets.set("NEBIUS_API_KEY", KEY);
    crypto.broken = true;
    await refused(secrets.draftCheckValues(NAMES), KEY);
    assert.deepEqual([await secrets.get("NEBIUS_API_KEY"), await secrets.state("NEBIUS_API_KEY")], [null, "unreadable"]);
  });
});
