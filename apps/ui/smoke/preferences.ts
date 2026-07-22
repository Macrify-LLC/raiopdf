import type { Page } from "@playwright/test";

const UI_PREFERENCES_STORAGE_KEY = "raiopdf.uiPreferences.v1";

/** Opt into experimental tools before the app reads its persisted preferences. */
export async function enableExperimentalFeatures(page: Page): Promise<void> {
  await page.addInitScript(
    ({ storageKey }) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ experimentalFeaturesEnabled: true }),
      );
    },
    { storageKey: UI_PREFERENCES_STORAGE_KEY },
  );
}
