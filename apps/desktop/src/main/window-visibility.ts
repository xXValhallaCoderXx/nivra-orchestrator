/** A window's startup lifecycle, kept free of Electron imports so missing readiness can be tested directly. */
interface StartupWindow {
  once(event: "ready-to-show" | "show" | "close" | "closed", listener: () => void): unknown;
  removeListener(event: "ready-to-show" | "show" | "close" | "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
}

export const WINDOW_SHOW_FALLBACK_MS = 5_000;

/** Show once on readiness or the deadline: a locked GNOME session may never paint a hidden window as ready. */
export function showWindowWhenReady(window: StartupWindow): void {
  if (window.isDestroyed() || window.isVisible()) return;
  let settled = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (settled) return;
    settled = true;
    clearTimeout(fallback);
    window.removeListener("ready-to-show", reveal);
    window.removeListener("show", cancel);
    window.removeListener("close", cancel);
    window.removeListener("closed", cancel);
  };
  const reveal = () => {
    if (settled) return;
    cancel();
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  };
  window.once("ready-to-show", reveal);
  window.once("show", cancel);
  window.once("close", cancel);
  window.once("closed", cancel);
  fallback = setTimeout(reveal, WINDOW_SHOW_FALLBACK_MS);
}
