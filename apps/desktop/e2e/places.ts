import { expect, type Page } from "@playwright/test";

/**
 * Getting around the window's shell (NIV-56) in the specs, by test id only: each step presses a sidebar link, a Settings
 * section's link or a Home button, then waits, within expect's limit, for a test id only the place it opened shows,
 * before the spec presses anything there. Nothing here sends anything or changes any setting.
 */
export type Place =
  | "home"
  | "tasks"
  | "conversations"
  | "environment"
  | "missions"
  | "explain"
  | "settings-connections"
  | "settings-sharing"
  | "settings-preferences"
  | "settings-budget"
  | "settings-diagnostics";

/** The sidebar link of each place that has one. */
const LINKS = { home: "nav-home", tasks: "nav-tasks", conversations: "nav-planning", environment: "nav-environment", missions: "nav-missions" } as const;

export async function goTo(page: Page, place: Place): Promise<void> {
  switch (place) {
    case "settings-connections":
    case "settings-sharing":
    case "settings-preferences":
    case "settings-budget":
    case "settings-diagnostics": {
      const section = place.slice("settings-".length);
      await page.getByTestId("nav-settings").click();
      await expect(page.getByTestId("page-settings")).toBeVisible();
      await page.getByTestId(`settings-tab-${section}`).click();
      await expect(page.getByTestId(`settings-${section}`)).toBeVisible();
      return;
    }
    case "explain":
      await goTo(page, "home");
      await page.getByTestId("home-explain").click();
      await expect(page.getByTestId("page-explain")).toBeVisible();
      return;
    default:
      await page.getByTestId(LINKS[place]).click();
      await expect(page.getByTestId(`page-${place}`)).toBeVisible();
  }
}

/** Opens the project switcher, where Add project… (project-add) and the projects are, and waits for its list. */
export async function openSwitcher(page: Page): Promise<void> {
  const list = page.getByTestId("project-switcher-list");
  if (!(await list.isVisible())) await page.getByTestId("project-select").click();
  await expect(list).toBeVisible();
}
