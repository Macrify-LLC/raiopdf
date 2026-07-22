const STORAGE_KEY = "raiopdf.uiPreferences.v1";

export interface UiPreferences {
  experimentalFeaturesEnabled: boolean;
}

export function readUiPreferences(): UiPreferences {
  if (typeof window === "undefined") {
    return { experimentalFeaturesEnabled: false };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    const experimentalFeaturesEnabled = Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).experimentalFeaturesEnabled === true,
    );

    return { experimentalFeaturesEnabled };
  } catch {
    return { experimentalFeaturesEnabled: false };
  }
}

export function writeUiPreferences(preferences: UiPreferences): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
