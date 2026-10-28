import type { DraftStore, DraftWrite } from "../app/routes";
import { holdsCredential } from "./credentials.ts";

/**
 * The drafts kept across navigation and restarts (NIV-56, R30): on this computer only, in the window's local storage,
 * never sent anywhere. Pages reach it through shell/drafts (`useDrafts`, `DraftNotice`); this file is the store itself,
 * free of React and of the window, so node --test drives it over a fake storage.
 *
 * Stored format, version 1. One entry per draft:
 *   key:   "nivra.drafts.v1:" + the draft's key, for example "nivra.drafts.v1:home-composer:project:<id>"
 *   value: JSON {"label": string, "savedAt": ISO 8601 time, "value": the page's own value}
 * Nothing else is stored, and nothing moves these entries anywhere: a later move to another store needs its own tested
 * migration, which finds them by this prefix and keeps every draft (Nate, 28 Oct). A new format takes a new prefix.
 *
 * Every storage access is guarded: storage that throws (full, turned off, unreadable) never breaks the page. A write it
 * refused says so (`reason: "storage"`), as does a draft that looks like it holds a credential (`reason: "credential"`),
 * which is never stored; any copy of that draft kept before is removed, so a restart never brings back an older version
 * as if it were the latest. A refused write never touches the text being edited: that stays the page's.
 */

/** The part of the Web Storage interface the store uses; `window.localStorage` is one. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

export interface ShellDraftStore extends DraftStore {
  /** False when the storage couldn't be read when the store was made: drafts can't be kept on this computer now. */
  readonly available: boolean;
  /** Called after every write and discard, so the sidebar's list follows. */
  subscribe(listener: () => void): () => void;
  /** Counts the changes; a snapshot for React's useSyncExternalStore. */
  version(): number;
}

/** `storage` is null when even reaching it threw (a browser that refuses local storage). */
export function createDraftStore(storage: KeyValueStorage | null, now: () => Date = () => new Date()): ShellDraftStore {
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

  const remove = (key: string) => {
    if (!storage) return;
    try {
      storage.removeItem(DRAFT_PREFIX + key);
    } catch {
      // Nothing to do: a draft that can't be removed is still listed, and the person can discard it again.
    }
  };

  return {
    get available() {
      return available;
    },
    read<T>(key: string): T | null {
      if (!storage) return null;
      try {
        const stored = parse(storage.getItem(DRAFT_PREFIX + key));
        return stored ? (stored.value as T) : null;
      } catch {
        return null;
      }
    },
    write<T>(key: string, value: T, label: string): DraftWrite {
      if (holdsCredential(value) || holdsCredential(label)) {
        remove(key);
        changed();
        return { kept: false, reason: "credential" };
      }
      if (!storage) return { kept: false, reason: "storage" };
      try {
        storage.setItem(DRAFT_PREFIX + key, JSON.stringify({ label, savedAt: now().toISOString(), value } satisfies Stored));
      } catch {
        return { kept: false, reason: "storage" };
      }
      changed();
      return { kept: true };
    },
    discard(key: string) {
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
          const stored = parse(storage.getItem(name));
          if (stored) drafts.push({ key: name.slice(DRAFT_PREFIX.length), label: stored.label, savedAt: stored.savedAt });
        }
      } catch {
        return [];
      }
      return drafts.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => changes,
  };
}
