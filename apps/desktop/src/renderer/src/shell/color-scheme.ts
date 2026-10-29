import type { KeyValueStorage } from "./draft-store.ts";

/**
 * Appearance (R29): System, Light or Dark, kept in the window's local storage. Mantine's own localStorage manager
 * swallows a failed save, so this one says so: Appearance then tells the person the choice applies until Nivra closes
 * (Nate, 28 Oct). The choice applies either way: Mantine changes the scheme before it asks the manager to keep it.
 *
 * Stored format, version 1: the key "nivra.color-scheme.v1" holds "auto" (System), "light" or "dark". Nothing moves it
 * anywhere; a later move needs its own tested migration, which finds it by this key.
 *
 * It has the shape of Mantine's MantineColorSchemeManager, written out here so node --test can drive it without Mantine.
 */

export type ColorScheme = "auto" | "light" | "dark";

export const COLOR_SCHEME_KEY = "nivra.color-scheme.v1";

const isScheme = (value: unknown): value is ColorScheme => value === "auto" || value === "light" || value === "dark";

export interface ColorSchemeManager {
  get(defaultValue: ColorScheme): ColorScheme;
  set(value: ColorScheme): void;
  subscribe(onUpdate: (value: ColorScheme) => void): void;
  unsubscribe(): void;
  clear(): void;
  /** Whether the last choice couldn't be kept; listeners hear each change of it. */
  saveFailed(): boolean;
  onSaveFailedChange(listener: () => void): () => void;
}

/** `storage` is read each time, and may throw or be null: a window that refuses local storage still works. */
export function createColorSchemeManager(storage: () => KeyValueStorage | null): ColorSchemeManager {
  let failed = false;
  const listeners = new Set<() => void>();
  const report = (next: boolean) => {
    if (next === failed) return;
    failed = next;
    for (const listener of listeners) listener();
  };
  return {
    get(defaultValue) {
      try {
        const stored = storage()?.getItem(COLOR_SCHEME_KEY) ?? null;
        return isScheme(stored) ? stored : defaultValue;
      } catch {
        return defaultValue;
      }
    },
    set(value) {
      try {
        const target = storage();
        if (!target) throw new Error("no storage");
        target.setItem(COLOR_SCHEME_KEY, value);
        report(false);
      } catch {
        report(true);
      }
    },
    // One window: no other page writes the choice, so there is nothing to follow.
    subscribe() {},
    unsubscribe() {},
    clear() {
      try {
        storage()?.removeItem(COLOR_SCHEME_KEY);
      } catch {
        // Nothing kept means nothing to clear.
      }
    },
    saveFailed: () => failed,
    onSaveFailedChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
