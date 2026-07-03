import type { JurisdictionPackId } from "@raiopdf/rules";

const STORAGE_KEY = "raiopdf.filingPreferences.v1";

export interface CourtProfile {
  id: string;
  packId: JurisdictionPackId;
  name: string;
  maxFileBytes: number;
}

export interface FilingPreferences {
  defaultPackId?: JurisdictionPackId;
  packetLayoutMode?: "separate-files" | "combined-pdf";
  packetPrefixFilenames?: boolean;
  courtProfiles: readonly CourtProfile[];
  lastCourtProfileByPack: Record<string, string>;
}

export function readFilingPreferences(): FilingPreferences {
  if (typeof window === "undefined") {
    return emptyPreferences();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyPreferences();
    }

    const object = parsed as Record<string, unknown>;
    const courtProfiles = Array.isArray(object.courtProfiles)
      ? object.courtProfiles.map(readCourtProfile).filter((profile): profile is CourtProfile => profile !== null)
      : [];
    const lastCourtProfileByPack = readStringMap(object.lastCourtProfileByPack);
    const defaultPackId = typeof object.defaultPackId === "string"
      ? object.defaultPackId as JurisdictionPackId
      : undefined;
    const packetLayoutMode = object.packetLayoutMode === "combined-pdf" ||
      object.packetLayoutMode === "separate-files"
      ? object.packetLayoutMode
      : undefined;
    const packetPrefixFilenames = typeof object.packetPrefixFilenames === "boolean"
      ? object.packetPrefixFilenames
      : undefined;

    return {
      ...(defaultPackId ? { defaultPackId } : {}),
      ...(packetLayoutMode ? { packetLayoutMode } : {}),
      ...(packetPrefixFilenames === undefined ? {} : { packetPrefixFilenames }),
      courtProfiles,
      lastCourtProfileByPack,
    };
  } catch {
    return emptyPreferences();
  }
}

export function writeFilingPreferences(preferences: FilingPreferences): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function upsertCourtProfile(
  preferences: FilingPreferences,
  profile: Omit<CourtProfile, "id"> & { id?: string },
): FilingPreferences {
  const id = profile.id ?? `${profile.packId}:${Date.now().toString(36)}`;
  const nextProfile: CourtProfile = { ...profile, id };
  const courtProfiles = [
    ...preferences.courtProfiles.filter((existing) => existing.id !== id),
    nextProfile,
  ];

  return {
    ...preferences,
    courtProfiles,
    lastCourtProfileByPack: {
      ...preferences.lastCourtProfileByPack,
      [profile.packId]: id,
    },
  };
}

export function selectDefaultPack(
  preferences: FilingPreferences,
  packId: JurisdictionPackId,
): FilingPreferences {
  return {
    ...preferences,
    defaultPackId: packId,
  };
}

export function selectCourtProfile(
  preferences: FilingPreferences,
  packId: JurisdictionPackId,
  profileId: string,
): FilingPreferences {
  return {
    ...preferences,
    lastCourtProfileByPack: {
      ...preferences.lastCourtProfileByPack,
      [packId]: profileId,
    },
  };
}

export function setPacketPreferences(
  preferences: FilingPreferences,
  packet: { layoutMode: "separate-files" | "combined-pdf"; prefixFilenames: boolean },
): FilingPreferences {
  return {
    ...preferences,
    packetLayoutMode: packet.layoutMode,
    packetPrefixFilenames: packet.prefixFilenames,
  };
}

function emptyPreferences(): FilingPreferences {
  return {
    courtProfiles: [],
    lastCourtProfileByPack: {},
  };
}

function readCourtProfile(value: unknown): CourtProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Record<string, unknown>;
  const maxFileBytes = object.maxFileBytes;

  if (
    typeof object.id !== "string" ||
    typeof object.packId !== "string" ||
    typeof object.name !== "string" ||
    typeof maxFileBytes !== "number" ||
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes <= 0
  ) {
    return null;
  }

  return {
    id: object.id,
    packId: object.packId as JurisdictionPackId,
    name: object.name,
    maxFileBytes,
  };
}

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
