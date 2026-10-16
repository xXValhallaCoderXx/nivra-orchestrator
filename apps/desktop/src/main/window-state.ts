/**
 * Window size and zoom rules, from Hird's window-state.ts (provenance.md). Pure (no Electron imports), so they can be
 * tested directly.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The zoom levels the shortcuts step through (like a browser's). */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/**
 * The zoom to start with when none was chosen. Windows and macOS report display scaling, so 100% is right there.
 * WSLg and X11 without scaling report a scale of 1 even on a 4K screen, so such screens start larger (Hird D11).
 */
export function defaultZoom(platform: string, display: { scaleFactor: number; size: { width: number } }): number {
  if (platform !== "linux" || display.scaleFactor !== 1) return 1;
  if (display.size.width >= 5000) return 2;
  if (display.size.width >= 3800) return 1.5;
  return 1;
}

/** The next zoom level in or out from `current` (which may sit between steps), clamped to the range. */
export function stepZoom(current: number, direction: "in" | "out"): number {
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? MIN_ZOOM;
}

/** A first-launch window: most of the screen's work area, centred. */
export function defaultWindowBounds(workArea: Rect): Rect {
  const width = Math.min(1200, Math.round(workArea.width * 0.75));
  const height = Math.min(860, Math.round(workArea.height * 0.85));
  return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height };
}

/** Whether enough of a saved window would be visible to grab it (screens change between launches). */
export function isOnScreen(bounds: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some((area) => {
    const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapWidth >= 200 && overlapHeight >= 100;
  });
}

/**
 * Where to open the window: the saved place if enough of it is on a screen; otherwise the saved size (capped to the
 * screen) centred on the primary screen (WSLg can report a window at about -32000,-32000); with nothing saved, the
 * first-launch default.
 */
export function restoreBounds(saved: Rect | undefined, workAreas: readonly Rect[], primary: Rect): Rect {
  if (!saved) return defaultWindowBounds(primary);
  if (isOnScreen(saved, workAreas)) return saved;
  const width = Math.min(saved.width, primary.width);
  const height = Math.min(saved.height, primary.height);
  return { x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2), width, height };
}
