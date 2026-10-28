/**
 * The shell's one breakpoint (SH9): below 48em (768 CSS px; an 820 px window at 150% zoom is 547) the sidebar folds
 * behind a menu button in a narrow top bar. Mantine's AppShell collapses its navbar just under its "sm" breakpoint
 * (48em less 0.1 px), and this query matches the same widths, so the shell and the pages agree on which layout is shown.
 */
export const NARROW_QUERY = "(max-width: 47.99375em)";

/** The sidebar's width at wide widths, and over the page when it opens in a narrow window. */
export const SIDEBAR_WIDTH = 272;
