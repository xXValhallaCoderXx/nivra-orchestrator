import type { DraftStore, DraftWrite } from "../app/routes";
import { holdsCredential } from "./credentials.ts";

/**
 * The drafts kept across navigation and restarts (NIV-56, R30): on this computer only, in the window's local storage,
 * never sent anywhere. Pages reach it through shell/drafts (`useDraft`, `DraftNotice`); this file is the store itself,
 * free of React and of the window, so node --test drives it over a fake storage and a fake check.
 *
 * Stored format, version 1. One entry per draft:
 *   key:   "nivra.drafts.v1:" + the draft's key, for example "nivra.drafts.v1:home-composer:project:<id>"
 *   value: JSON {"label": string, "savedAt": ISO 8601 time, "value": the page's own value}
 * Nothing else is stored, and nothing moves these entries anywhere: a later move to another store needs its own tested
 * migration, which finds them by this prefix and keeps every draft (Nate, 28 Oct). A new format takes a new prefix.
 *
 * What is kept is checked first (Nate, 29 Oct): for a recognised credential format, here, and then, through main, for
 * one of the API keys Nivra keeps, whole, anywhere in the draft's text or label. Only text that passes both is stored,
 * and only if it is still that draft's latest text when the answer comes: an older answer never stores newer text or
 * overwrites a newer copy. A draft that holds a key or a recognised format isn't kept, and the copy kept before it is
 * removed; one that couldn't be checked isn't kept either, and the copy kept before it stays. Stored copies are checked
 * again before they are restored or listed, at start and whenever a key is saved: one that fails is removed, and one
 * whose check errors stays stored but out of sight. The text being edited is never touched: it is the page's.
 * Every storage access is guarded, so storage that throws never breaks a page.
 */

/** The part of the Web Storage interface the store uses; `window.localStorage` is one. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Main's answer to whether text holds one of the saved API keys; it throws when it couldn't check. */
export type SavedKeyCheck = (text: string) => Promise<boolean>;

export const DRAFT_PREFIX = "nivra.drafts.v1:";

interface Stored {
  label: string;
  savedAt: string;
  value: unknown;
}

function parse(text: string | null): Stored | null {
  if (text === null) return null;
  try {
    const stored = JSON.parse(text) as Partial<Stored> | null;
    if (!stored || typeof stored.label !== "string" || typeof stored.savedAt !== "string" || !("value" in stored)) return null;
    return { label: stored.label, savedAt: stored.savedAt, value: stored.value };
  } catch {
    return null;
  }
}

/** Every string a draft holds, its label first, one a line: what main checks. A key never spans two of them. */
function textOf(label: string, value: unknown): string {
  const strings: string[] = [label];
  const walk = (item: unknown) => {
    if (typeof item === "string") strings.push(item);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object") Object.values(item).forEach(walk);
  };
  walk(value);
  return strings.join("\n");
}

export interface ShellDraftStore extends DraftStore {
  /** False when the storage couldn't be read when the store was made: drafts can't be kept on this computer now. */
  readonly available: boolean;
  /** True when a stored copy couldn't be checked against the saved keys, so it is kept out of sight for now. */
  readonly unchecked: boolean;
  /** Checks every stored copy against the current keys again: at start, and whenever a key is saved or removed. */
  recheck(): Promise<void>;
  /** Called after every change of what is stored or shown, so the sidebar's list follows. */
  subscribe(listener: () => void): () => void;
  /** Counts the changes; a snapshot for React's useSyncExternalStore. */
  version(): number;
}

/** `storage` is null when even reaching it threw (a browser that refuses local storage). */
export function createDraftStore(storage: KeyValueStorage | null, hasSavedKey: SavedKeyCheck, now: () => Date = () => new Date()): ShellDraftStore {
  let available = storage !== null;
  if (storage) {
    try {
      void storage.length;
      storage.getItem(`${DRAFT_PREFIX}probe`);
    } catch {
      available = false;
    }
  }
  const listeners = new Set<() => void>();
  let changes = 0;
  const changed = () => {
    changes += 1;
    for (const listener of listeners) listener();
  };
  // Each draft's latest write: an answer to an older one changes nothing.
  const latest = new Map<string, number>();
  // The stored copies checked against the current keys, by draft key, as the exact text stored; and those whose check
  // errored, which stay stored but out of sight.
  const checked = new Map<string, string>();
  const hidden = new Set<string>();
  let rechecking = 0;
  // Counts the rechecks begun, each after the saved keys changed: a write whose answer came from older keys asks again.
  let keysEpoch = 0;

  const raw = (key: string): string | null => {
    if (!storage) return null;
    try {
      return storage.getItem(DRAFT_PREFIX + key);
    } catch {
      return null;
    }
  };
  const remove = (key: string) => {
    checked.delete(key);
    hidden.delete(key);
    if (!storage) return;
    try {
      storage.removeItem(DRAFT_PREFIX + key);
    } catch {
      // Nothing to do: a draft that can't be removed is still kept out of sight until it is checked again.
    }
  };
  /** A stored copy, if it is the one that was checked. */
  const shown = (key: string): Stored | null => {
    const text = raw(key);
    return text !== null && checked.get(key) === text ? parse(text) : null;
  };

  return {
    get available() {
      return available;
    },
    get unchecked() {
      return hidden.size > 0;
    },
    read<T>(key: string): T | null {
      const stored = shown(key);
      return stored ? (stored.value as T) : null;
    },
    async write<T>(key: string, value: T, label: string): Promise<DraftWrite> {
      const mine = (latest.get(key) ?? 0) + 1;
      latest.set(key, mine);
      // 1. The recognised formats, here, at once.
      if (holdsCredential(value) || holdsCredential(label)) {
        remove(key);
        changed();
        return { kept: false, reason: "credential" };
      }
      // 2. The saved keys, through main, on exactly the text that would be stored.
      const record = JSON.stringify({ label, savedAt: now().toISOString(), value } satisfies Stored);
      const text = textOf(label, value);
      let holdsKey: boolean;
      try {
        let epoch = keysEpoch;
        holdsKey = await hasSavedKey(text);
        // The keys changed while it was asked (a key saved, so a recheck began): ask again with the current ones, so
        // no copy is kept on an answer about keys that are gone or missing a key that is new.
        while (epoch !== keysEpoch && latest.get(key) === mine) {
          epoch = keysEpoch;
          holdsKey = await hasSavedKey(text);
        }
      } catch {
        // Not checked, so not kept; the copy kept before stays as it is.
        return { kept: false, reason: "unchecked" };
      }
      // A newer write took its place while it was checked: it changes nothing, and only the newer one's answer counts.
      if (latest.get(key) !== mine) return { kept: false, reason: "unchecked" };
      if (holdsKey) {
        remove(key);
        changed();
        return { kept: false, reason: "credential" };
      }
      // 3. Both passed: store it.
      if (!storage) return { kept: false, reason: "storage" };
      try {
        storage.setItem(DRAFT_PREFIX + key, record);
      } catch {
        return { kept: false, reason: "storage" };
      }
      checked.set(key, record);
      hidden.delete(key);
      changed();
      return { kept: true };
    },
    discard(key: string) {
      latest.set(key, (latest.get(key) ?? 0) + 1);
      remove(key);
      changed();
    },
    list() {
      if (!storage) return [];
      const drafts: Array<{ key: string; label: string; savedAt: string }> = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const name = storage.key(index);
          if (!name?.startsWith(DRAFT_PREFIX)) continue;
          const key = name.slice(DRAFT_PREFIX.length);
          const stored = shown(key);
          if (stored) drafts.push({ key, label: stored.label, savedAt: stored.savedAt });
        }
      } catch {
        return [];
      }
      return drafts.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    },
    async recheck() {
      if (!storage) return;
      const pass = ++rechecking;
      keysEpoch += 1;
      let entries: Array<[key: string, text: string]>;
      try {
        entries = [];
        for (let index = 0; index < storage.length; index += 1) {
          const name = storage.key(index);
          const text = name?.startsWith(DRAFT_PREFIX) ? storage.getItem(name) : null;
          if (name && text !== null) entries.push([name.slice(DRAFT_PREFIX.length), text]);
        }
      } catch {
        return;
      }
      // Until a copy is checked against the current keys, it is out of sight.
      checked.clear();
      changed();
      for (const [key, text] of entries) {
        const stored = parse(text);
        if (!stored || holdsCredential(stored.value) || holdsCredential(stored.label)) {
          if (stored) remove(key);
          continue;
        }
        let holdsKey: boolean;
        try {
          holdsKey = await hasSavedKey(textOf(stored.label, stored.value));
        } catch {
          // Kept, out of sight, until a check can be made.
          if (raw(key) === text) hidden.add(key);
          continue;
        }
        // A newer pass, or a write meanwhile, has the last word on this copy.
        if (pass !== rechecking || raw(key) !== text) continue;
        if (holdsKey) remove(key);
        else {
          checked.set(key, text);
          hidden.delete(key);
        }
      }
      changed();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => changes,
  };
}
