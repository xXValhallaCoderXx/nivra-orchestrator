import { Badge, Button, createTheme, Paper, Table, virtualColor, type CSSVariablesResolver, type MantineColorsTuple } from "@mantine/core";

/**
 * Nivra's design tokens, from Hird's design system v1 (provenance.md): mono, light and dark. Ink carries structure;
 * colour is kept for outcomes and boundaries, so those always stand out. Labels are sentence case.
 */

const gray: MantineColorsTuple = ["#FAFAFA", "#F5F5F5", "#EDEDED", "#E5E5E5", "#D4D4D4", "#A3A3A3", "#737373", "#525252", "#262626", "#0A0A0A"];
const dark: MantineColorsTuple = ["#FAFAFA", "#A3A3A3", "#8A8A8A", "#5C5C5C", "#262626", "#1A1A1A", "#111111", "#0A0A0A", "#050505", "#000000"];
const inkLight: MantineColorsTuple = ["#FAFAFA", "#F5F5F5", "#E5E5E5", "#D4D4D4", "#A3A3A3", "#737373", "#0A0A0A", "#262626", "#262626", "#262626"];
const inkDark: MantineColorsTuple = ["#FAFAFA", "#F5F5F5", "#E5E5E5", "#D4D4D4", "#A3A3A3", "#8A8A8A", "#737373", "#525252", "#FAFAFA", "#E5E5E5"];

export const theme = createTheme({
  colors: { gray, dark, inkLight, inkDark, ink: virtualColor({ name: "ink", light: "inkLight", dark: "inkDark" }) },
  primaryColor: "ink",
  primaryShade: { light: 6, dark: 8 },
  autoContrast: true,
  black: "#0A0A0A",
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
    Badge: Badge.extend({ styles: { root: { textTransform: "none", fontWeight: 500, letterSpacing: 0 } } }),
    Button: Button.extend({ styles: { root: { fontWeight: 500 } } }),
    Paper: Paper.extend({ defaultProps: { radius: "lg" } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: "xs", horizontalSpacing: "md" } }),
  },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-body": "#FFFFFF",
    "--mantine-color-text": "#0A0A0A",
    "--mantine-color-default-border": "#E5E5E5",
    "--mantine-color-default-hover": "#F5F5F5",
    "--nivra-subtle": "#FAFAFA",
    "--nivra-hover": "#F5F5F5",
    "--nivra-border": "#E5E5E5",
    "--nivra-text-2": "#525252",
    "--nivra-text-3": "#737373",
    "--nivra-success": "#16A34A",
    "--nivra-warning": "#B45309",
    "--nivra-error": "#B91C1C",
    "--nivra-error-icon": "#DC2626",
  },
  dark: {
    "--mantine-color-body": "#0A0A0A",
    "--mantine-color-text": "#FAFAFA",
    "--mantine-color-default": "#111111",
    "--mantine-color-default-border": "#262626",
    "--mantine-color-default-hover": "#1A1A1A",
    "--nivra-subtle": "#111111",
    "--nivra-hover": "#1A1A1A",
    "--nivra-border": "#262626",
    "--nivra-text-2": "#A3A3A3",
    "--nivra-text-3": "#8A8A8A",
    "--nivra-success": "#22C55E",
    "--nivra-warning": "#FBBF24",
    "--nivra-error": "#F87171",
    "--nivra-error-icon": "#EF4444",
  },
});
