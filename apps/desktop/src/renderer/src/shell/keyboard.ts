import { useEffect, useRef } from "react";

/**
 * The window's shortcuts (R28, PN5): Ctrl+K (Cmd+K on a Mac) opens the project switcher, F6 and Shift+F6 move the focus
 * between the sidebar and the page, and Ctrl+comma opens Settings. Esc is left to what is open (the switcher, a menu, a
 * dialog, the sidebar over the page), which closes and keeps what was typed; no shortcut stops a run, approves, applies
 * or sends anything. Zoom keeps its own keys, which main handles before the page sees them: Ctrl with =, minus or 0, and
 * Ctrl with the wheel.
 */
export interface Shortcuts {
  openSwitcher(): void;
  /** The two regions F6 moves between, in order: the sidebar (or the narrow top bar) and the page. */
  regions(): [HTMLElement | null, HTMLElement | null];
  openSettings(): void;
}

/** The first thing in a region the focus can go to, or the region itself. */
function focusInto(region: HTMLElement) {
  const target = region.matches("main")
    ? region
    : (region.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? region);
  target.focus();
}

export function useShortcuts(shortcuts: Shortcuts) {
  const current = useRef(shortcuts);
  current.current = shortcuts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        current.current.openSwitcher();
      } else if (mod && !event.altKey && event.key === ",") {
        event.preventDefault();
        current.current.openSettings();
      } else if (event.key === "F6" && !mod && !event.altKey) {
        const regions = current.current.regions().filter((region): region is HTMLElement => region !== null);
        if (!regions.length) return;
        event.preventDefault();
        const at = regions.findIndex((region) => region.contains(document.activeElement));
        const step = event.shiftKey ? -1 : 1;
        const next = at < 0 ? regions[0]! : regions[(at + step + regions.length) % regions.length]!;
        focusInto(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
