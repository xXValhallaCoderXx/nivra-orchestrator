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

/** A stand-in for safeStorage: "encrypts" by reversing, and can lose its keychain or refuse to decrypt. */
function fakeCrypto(): KeyCrypto & { keychain: boolean; broken: boolean } {
  const crypto = {
    keychain: false,
    broken: false,
    protects: () => crypto.keychain,
    encrypt: async (text: string) => Buffer.from(`enc:${[...text].reverse().join("")}`),
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
});
