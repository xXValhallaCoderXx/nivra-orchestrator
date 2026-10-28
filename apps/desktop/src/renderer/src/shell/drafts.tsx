import { Alert, Text } from "@mantine/core";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { DraftWrite } from "../app/routes";
import { createDraftStore, type KeyValueStorage, type ShellDraftStore } from "./draft-store";

/**
 * Drafts for pages (NIV-56, R30): `useDrafts()` reaches the store, and `DraftNotice` says, in one wording for every
 * page, when a draft wasn't kept. The store, and the format it keeps drafts in, are in ./draft-store.ts.
 *
 *   import { DraftNotice, useDrafts } from "../shell/drafts";
 *   const drafts = useDrafts();
 *   const [result, setResult] = useState<DraftWrite | null>(null);
 *   onChange: setResult(drafts.write(key, value, label));
 *   render: <DraftNotice result={result} />
 *
 * A refused draft never changes what is in the field: the page keeps its own text, and only tells the person.
 */

/** The window's local storage, or null when even reaching it throws. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const DraftsContext = createContext<ShellDraftStore | null>(null);

export function DraftsProvider({ storage, children }: { storage: KeyValueStorage | null; children: ReactNode }) {
  const store = useMemo(() => createDraftStore(storage), [storage]);
  return <DraftsContext.Provider value={store}>{children}</DraftsContext.Provider>;
}

export function useDrafts(): ShellDraftStore {
  const store = useContext(DraftsContext);
  if (!store) throw new Error("useDrafts needs the shell's DraftsProvider above it.");
  return store;
}

/** The drafts that exist, newest first, and whether drafts can be kept at all; follows every write and discard. */
export function useDraftList() {
  const store = useDrafts();
  const version = useSyncExternalStore(store.subscribe, store.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => store.list(), [store, version]);
  return { available: store.available, list };
}

export const DRAFT_NOT_KEPT = {
  credential:
    "This draft isn't kept: it looks like it holds a key or token, and Nivra never keeps one on this computer. What you typed is still in the field. Remove the key or token to keep the draft.",
  storage: "This draft couldn't be kept on this computer. What you typed is still here.",
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
