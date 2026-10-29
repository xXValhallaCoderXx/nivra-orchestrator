import type { KeyValueStorage } from "../../src/renderer/src/shell/draft-store.ts";

/** A Web Storage stand-in. `fail` makes the named operations throw, as a full or refused local storage does. */
export class FakeStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  fail = new Set<"read" | "write" | "remove">();
  get length() {
    if (this.fail.has("read")) throw new Error("SecurityError");
    return this.entries.size;
  }
  key(index: number) {
    if (this.fail.has("read")) throw new Error("SecurityError");
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string) {
    if (this.fail.has("read")) throw new Error("SecurityError");
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.fail.has("write")) throw new Error("QuotaExceededError");
    this.entries.set(key, value);
  }
  removeItem(key: string) {
    if (this.fail.has("remove")) throw new Error("SecurityError");
    this.entries.delete(key);
  }
}
