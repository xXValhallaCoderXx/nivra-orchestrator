import { Alert, Text } from "@mantine/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DraftWrite } from "../app/routes";
import { createDraftStore, duringKeyChange, type KeyValueStorage, type SavedKeyCheck, type ShellDraftStore } from "./draft-store";

/**
 * Drafts for pages (NIV-56, R30). `useDraft` keeps one draft for a page: it writes on change, a moment after the last
 * keystroke, gives the page the stored copy to restore (once, and never over what was typed), and only the latest
 * text's result; `DraftNotice` says, in one wording for every page, when a draft wasn't kept. The store, its checks and
 * the format it keeps drafts in are in ./draft-store.ts.
 *
 *   import { DraftNotice, useDraft } from "../shell/drafts";
 *   const draft = useDraft<{ title: string }>(key);
 *   useEffect(() => { if (draft.restore) setTitle(draft.restore.title); }, [draft.restore]);
 *   onChange: setTitle(next); draft.change({ title: next }, next);   // or draft.discard() when it is empty
 *   render: <DraftNotice result={draft.result} />
 *
 * A draft that isn't kept never changes what is in the field: the page keeps its own text, and only tells the person.
 */

/** The window's local storage, or null when even reaching it throws. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Main's check of a draft against the saved API keys (draftHasSavedKey). */
const savedKeyCheck: SavedKeyCheck = (text) => window.nivra.draftHasSavedKey(text);

const DraftsContext = createContext<ShellDraftStore | null>(null);

/** The store for the window. Its stored copies are checked against the saved keys at start, before any is shown. */
export function DraftsProvider({ storage, children }: { storage: KeyValueStorage | null; children: ReactNode }) {
  const store = useMemo(() => createDraftStore(storage, savedKeyCheck), [storage]);
  useEffect(() => {
    void store.recheck();
  }, [store]);
  return <DraftsContext.Provider value={store}>{children}</DraftsContext.Provider>;
}

export function useDrafts(): ShellDraftStore {
  const store = useContext(DraftsContext);
  if (!store) throw new Error("useDrafts needs the shell's DraftsProvider above it.");
  return store;
}

/** The drafts listed for the sidebar (checked against the saved keys), newest first, and what keeps any out of sight. */
export function useDraftList() {
  const store = useDrafts();
  const version = useSyncExternalStore(store.subscribe, store.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => store.list(), [store, version]);
  return { available: store.available, unchecked: store.unchecked, list };
}

/** Runs a key's save or removal, wherever it is made, with the drafts out of sight until it settles (duringKeyChange). */
export function useKeySave(): <T>(save: () => Promise<T>) => Promise<T> {
  const store = useDrafts();
  return useCallback(<T,>(save: () => Promise<T>) => duringKeyChange(store, save), [store]);
}

/** How long typing pauses before a draft is written. */
export const DRAFT_WRITE_MS = 300;

/**
 * One page's draft under `key`:
 * - `restore`: the stored copy, checked against the saved keys, for the page to show; null when there is none, and null
 *   for good once the page has changed the draft, so it never lands over what was typed.
 * - `result`: the latest text's result, null until its check ends; an older text's result never shows.
 * - `change(value, label)`: writes the draft a moment after the last change; a pending write is made at once when the
 *   page closes, so nothing typed is lost by leaving.
 * - `discard()`: removes the draft, and any write still pending.
 */
export function useDraft<T>(key: string): { restore: T | null; result: DraftWrite | null; change(value: T, label: string): void; discard(): void } {
  const store = useDrafts();
  const version = useSyncExternalStore(store.subscribe, store.version);
  const [changed, setChanged] = useState(false);
  const [result, setResult] = useState<DraftWrite | null>(null);
  const pending = useRef<{ value: T; label: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ask = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const restore = useMemo(() => (changed ? null : store.read<T>(key)), [store, key, changed, version]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    const mine = ++ask.current;
    void store.write(key, next.value, next.label).then((written) => {
      if (mine === ask.current) setResult(written);
    });
  }, [store, key]);

  // Leaving the page makes a pending write at once.
  useEffect(() => flush, [flush]);

  const change = useCallback(
    (value: T, label: string) => {
      setChanged(true);
      setResult(null);
      ask.current += 1;
      pending.current = { value, label };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, DRAFT_WRITE_MS);
    },
    [flush],
  );

  const discard = useCallback(() => {
    setChanged(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    ask.current += 1;
    setResult(null);
    store.discard(key);
  }, [store, key]);

  return { restore, result, change, discard };
}

export const DRAFT_NOT_KEPT = {
  credential: "This draft isn't kept: it contains one of your saved keys or text in a recognised credential format. What you typed is still here.",
  unchecked: "This draft couldn't be checked against your saved keys, so it isn't kept. What you typed is still here.",
  storage: "This draft couldn't be kept on this computer. What you typed is still here. An earlier copy may still be listed under Unsaved drafts.",
} as const;

/**
 * What a page shows after a draft wasn't kept, under the field it came from; nothing when it was. It never repeats what
 * was typed, and promises nothing about a restart.
 */
export function DraftNotice({ result }: { result: DraftWrite | null }) {
  if (!result || result.kept) return null;
  return (
    <Alert color="yellow" variant="light" data-testid="draft-not-kept" data-reason={result.reason}>
      <Text size="sm">{DRAFT_NOT_KEPT[result.reason]}</Text>
    </Alert>
  );
}
