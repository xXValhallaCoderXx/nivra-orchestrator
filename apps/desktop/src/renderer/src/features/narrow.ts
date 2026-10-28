import { useMediaQuery } from "@mantine/hooks";

/**
 * Whether the window is narrower than the design's breakpoint, 48em: 547 px wide at 150% zoom, for example (NIV-56, G3:
 * NW1, NW3). Below it, dialogs fill the window with their buttons in view, and the task page's columns stack.
 */
export const useNarrow = () => useMediaQuery("(max-width: 48em)") ?? false;
