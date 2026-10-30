import { Anchor, Badge, Button, createTheme, defaultVariantColorsResolver, Modal, Paper, Table, type CSSVariablesResolver, type MantineColorsTuple } from "@mantine/core";

/**
 * Charcoal surfaces and a green action accent, in light and dark. Outcome colours are separate from selection and
 * actions: choosing something never says it passed a check. Fonts stay bundled, and labels stay sentence case.
 */

const gray: MantineColorsTuple = ["#FAFAFA", "#F5F5F5", "#EDEDED", "#E5E5E5", "#D4D4D4", "#A3A3A3", "#737373", "#525252", "#262626", "#0A0A0A"];
const dark: MantineColorsTuple = ["#F2F5F3", "#B6C1BA", "#96A69B", "#78867C", "#3A443D", "#28312B", "#1A201C", "#111513", "#0C100D", "#080C09"];
const brand: MantineColorsTuple = ["#F3FAEB", "#E9F4DE", "#DBEEC6", "#C7E6A5", "#B0DD82", "#A0D66A", "#8FCB50", "#80BC42", "#54882F", "#37691D"];
const badgeTones = new Set(["gray", "blue", "yellow", "green", "red", "indigo", "orange"]);

export const theme = createTheme({
  colors: { gray, dark, brand },
  primaryColor: "brand",
  primaryShade: 6,
  autoContrast: true,
  black: "#142011",
  focusClassName: "nivra-focus",
  variantColorResolver: (input) => {
    const resolved = defaultVariantColorsResolver(input);
    if (input.variant === "default") return { ...resolved, border: "1px solid var(--nivra-control-border)" };
    if ((input.color ?? input.theme.primaryColor) === "brand" && input.variant === "filled") {
      return { background: "var(--nivra-action)", hover: "var(--nivra-action-hover)", color: "var(--nivra-on-action)", border: "1px solid var(--nivra-action-edge)" };
    }
    if (input.variant === "light" && input.color && badgeTones.has(input.color)) {
      return { background: `var(--nivra-badge-${input.color}-bg)`, hover: `var(--nivra-badge-${input.color}-bg)`, color: `var(--nivra-badge-${input.color}-fg)`, border: "1px solid transparent" };
    }
    return resolved;
  },
  defaultRadius: "md",
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px" },
  fontFamily: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontFamilyMonospace: "'IBM Plex Mono', ui-monospace, monospace",
  fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "15px", xl: "20px" },
  lineHeights: { xs: "1.34", sm: "1.54", md: "1.57", lg: "1.47", xl: "1.4" },
  headings: {
    fontFamily: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontWeight: "600",
    sizes: { h1: { fontSize: "24px", lineHeight: "1.34" }, h2: { fontSize: "20px", lineHeight: "1.4" }, h3: { fontSize: "15px", lineHeight: "1.47" } },
  },
  components: {
    Anchor: Anchor.extend({ defaultProps: { c: "var(--nivra-link)" } }),
    Badge: Badge.extend({ defaultProps: { color: "gray", variant: "light" }, styles: { root: { textTransform: "none", fontWeight: 500, letterSpacing: 0 } } }),
    Button: Button.extend({ defaultProps: { variant: "filled" }, styles: { root: { fontWeight: 500 } } }),
    Paper: Paper.extend({ defaultProps: { radius: "lg" }, styles: { root: { backgroundColor: "var(--nivra-surface)" } } }),
    Modal: Modal.extend({ styles: { content: { background: "var(--nivra-surface)" }, header: { background: "var(--nivra-surface)" }, title: { fontWeight: 600 } } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: "xs", horizontalSpacing: "md" } }),
  },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    "--nivra-action": "#8FCB50",
    "--nivra-action-hover": "#80BC42",
    "--nivra-on-action": "#142011",
    "--nivra-control-border": "#78867C",
    "--mantine-color-brand-light": "var(--nivra-nav-active)",
    "--mantine-color-brand-light-hover": "var(--nivra-hover)",
    "--mantine-color-brand-light-color": "var(--nivra-link)",
    "--mantine-color-brand-outline": "var(--nivra-link)",
    "--mantine-color-brand-outline-hover": "var(--nivra-nav-active)",
    "--mantine-color-anchor": "var(--nivra-link)",
  },
  light: {
    "--mantine-color-body": "#F6F7F6",
    "--mantine-color-text": "#171C19",
    "--mantine-color-default": "#FFFFFF",
    "--mantine-color-default-color": "#171C19",
    "--mantine-color-default-border": "#DDE2DE",
    "--mantine-color-default-hover": "#EDF1ED",
    "--mantine-color-dimmed": "#5F6E64",
    "--mantine-color-disabled": "#E9EDE9",
    "--mantine-color-disabled-color": "#59665D",
    "--mantine-color-disabled-border": "#78867C",
    "--nivra-surface": "#FFFFFF",
    "--nivra-subtle": "#EEF1EE",
    "--nivra-hover": "#EDF1ED",
    "--nivra-nav-active": "#E9F4DE",
    "--nivra-border": "#DDE2DE",
    "--nivra-text-2": "#4D5951",
    "--nivra-text-3": "#5F6E64",
    "--nivra-link": "#37691D",
    "--nivra-focus": "#37691D",
    "--nivra-action-edge": "#37691D",
    "--nivra-success": "#16A34A",
    "--nivra-warning": "#B45309",
    "--nivra-error": "#B91C1C",
    "--nivra-error-icon": "#DC2626",
    "--nivra-diff-added": "#ECFDF3",
    "--nivra-diff-removed": "#FEF2F2",
    "--nivra-badge-gray-bg": "#F5F5F5",
    "--nivra-badge-gray-fg": "#404040",
    "--nivra-badge-blue-bg": "#E7F0FF",
    "--nivra-badge-blue-fg": "#1D4ED8",
    "--nivra-badge-yellow-bg": "#FEF3C7",
    "--nivra-badge-yellow-fg": "#92400E",
    "--nivra-badge-green-bg": "#DCFCE7",
    "--nivra-badge-green-fg": "#166534",
    "--nivra-badge-red-bg": "#FEE2E2",
    "--nivra-badge-red-fg": "#B91C1C",
    "--nivra-badge-indigo-bg": "#E0E7FF",
    "--nivra-badge-indigo-fg": "#3730A3",
    "--nivra-badge-orange-bg": "#FFEDD5",
    "--nivra-badge-orange-fg": "#9A3412",
  },
  dark: {
    "--mantine-color-body": "#111513",
    "--mantine-color-text": "#F2F5F3",
    "--mantine-color-default": "#1A201C",
    "--mantine-color-default-color": "#F2F5F3",
    "--mantine-color-default-border": "#3A443D",
    "--mantine-color-default-hover": "#28312B",
    "--mantine-color-dimmed": "#96A69B",
    "--mantine-color-disabled": "#28312B",
    "--mantine-color-disabled-color": "#96A69B",
    "--mantine-color-disabled-border": "#78867C",
    "--nivra-surface": "#1A201C",
    "--nivra-subtle": "#171D19",
    "--nivra-hover": "#28312B",
    "--nivra-nav-active": "#233321",
    "--nivra-border": "#3A443D",
    "--nivra-text-2": "#B6C1BA",
    "--nivra-text-3": "#96A69B",
    "--nivra-link": "#A5DD70",
    "--nivra-focus": "#A5DD70",
    "--nivra-action-edge": "#8FCB50",
    "--nivra-success": "#22C55E",
    "--nivra-warning": "#FBBF24",
    "--nivra-error": "#F87171",
    "--nivra-error-icon": "#EF4444",
    "--nivra-diff-added": "#0B2B17",
    "--nivra-diff-removed": "#3A1212",
    "--nivra-badge-gray-bg": "#262626",
    "--nivra-badge-gray-fg": "#D4D4D4",
    "--nivra-badge-blue-bg": "#172554",
    "--nivra-badge-blue-fg": "#BFDBFE",
    "--nivra-badge-yellow-bg": "#422006",
    "--nivra-badge-yellow-fg": "#FDE68A",
    "--nivra-badge-green-bg": "#052E16",
    "--nivra-badge-green-fg": "#BBF7D0",
    "--nivra-badge-red-bg": "#450A0A",
    "--nivra-badge-red-fg": "#FECACA",
    "--nivra-badge-indigo-bg": "#1E1B4B",
    "--nivra-badge-indigo-fg": "#C7D2FE",
    "--nivra-badge-orange-bg": "#431407",
    "--nivra-badge-orange-fg": "#FED7AA",
  },
});
