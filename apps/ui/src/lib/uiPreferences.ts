const STORAGE_KEY = "raiopdf.uiPreferences.v1";

export interface UiPreferences {
  experimentalFeaturesEnabled: boolean;
  /** The right-hand Tools panel was last left hidden. */
  toolPanelCollapsed: boolean;
  /** The left-hand Pages/Bookmarks panel was last left hidden. */
  navPanelCollapsed: boolean;
}

const DEFAULT_PREFERENCES: UiPreferences = {
  experimentalFeaturesEnabled: false,
  toolPanelCollapsed: false,
  navPanelCollapsed: false,
};

export function readUiPreferences(): UiPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_PREFERENCES };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    const stored =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
      experimentalFeaturesEnabled: stored.experimentalFeaturesEnabled === true,
      toolPanelCollapsed: stored.toolPanelCollapsed === true,
      navPanelCollapsed: stored.navPanelCollapsed === true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Merges `changes` into the stored preferences, so each caller only names what it owns. */
export function writeUiPreferences(changes: Partial<UiPreferences>): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readUiPreferences(), ...changes }),
    );
    return true;
  } catch {
    return false;
  }
}
