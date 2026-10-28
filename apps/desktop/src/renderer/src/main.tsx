import "@mantine/core/styles.css";
import "./app/fonts.css";
import "./shell/shell.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { cssVariablesResolver, theme } from "./app/theme";
import { colorSchemeManager } from "./shell/Appearance";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element in index.html");

createRoot(root).render(
  <StrictMode>
    {/* System by default; the choice is kept by our own manager, which says when it couldn't be (no ColorSchemeScript: the CSP forbids inline scripts). */}
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto" colorSchemeManager={colorSchemeManager}>
      <App />
    </MantineProvider>
  </StrictMode>,
);
