import type { JurisdictionPackId, PrepPlanStepId } from "@raiopdf/rules";
import type { PdfCoverStyle } from "@raiopdf/engine-api";

const STORAGE_KEY = "raiopdf.filingPreferences.v1";

export interface CourtProfile {
  id: string;
  packId: JurisdictionPackId;
  name: string;
  maxFileBytes: number;
}

export interface FilingPreferences {
  defaultPackId?: JurisdictionPackId;
  defaultCoverStyle?: PdfCoverStyle;
  packetLayoutMode?: "separate-files" | "combined-pdf";
  packetPrefixFilenames?: boolean;
  courtProfiles: readonly CourtProfile[];
  lastCourtProfileByPack: Record<string, string>;
  stepDefaultOverridesByPack: Record<string, Partial<Record<PrepPlanStepId, boolean>>>;
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
    const stepDefaultOverridesByPack = readStepDefaultOverridesByPack(object.stepDefaultOverridesByPack);
    const defaultPackId = typeof object.defaultPackId === "string"
      ? object.defaultPackId as JurisdictionPackId
      : undefined;
    const defaultCoverStyle = readCoverStyle(object.defaultCoverStyle);
    const packetLayoutMode = object.packetLayoutMode === "combined-pdf" ||
      object.packetLayoutMode === "separate-files"
      ? object.packetLayoutMode
      : undefined;
    const packetPrefixFilenames = typeof object.packetPrefixFilenames === "boolean"
      ? object.packetPrefixFilenames
      : undefined;

    return {
      ...(defaultPackId ? { defaultPackId } : {}),
      defaultCoverStyle,
      ...(packetLayoutMode ? { packetLayoutMode } : {}),
      ...(packetPrefixFilenames === undefined ? {} : { packetPrefixFilenames }),
      courtProfiles,
      lastCourtProfileByPack,
      stepDefaultOverridesByPack,
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

export function selectDefaultCoverStyle(
  preferences: FilingPreferences,
  style: PdfCoverStyle,
): FilingPreferences {
  return {
    ...preferences,
    defaultCoverStyle: style,
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

export function setPrepStepDefaultOverrides(
  preferences: FilingPreferences,
  packId: JurisdictionPackId,
  overrides: Partial<Record<PrepPlanStepId, boolean>>,
): FilingPreferences {
  return {
    ...preferences,
    stepDefaultOverridesByPack: {
      ...preferences.stepDefaultOverridesByPack,
      [packId]: overrides,
    },
  };
}

function emptyPreferences(): FilingPreferences {
  return {
    defaultCoverStyle: "minimal",
    courtProfiles: [],
    lastCourtProfileByPack: {},
    stepDefaultOverridesByPack: {},
  };
}

function readCoverStyle(value: unknown): PdfCoverStyle {
  return value === "labeled" || value === "bordered" || value === "minimal"
    ? value
    : "minimal";
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

function readStepDefaultOverridesByPack(
  value: unknown,
): Record<string, Partial<Record<PrepPlanStepId, boolean>>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, Partial<Record<PrepPlanStepId, boolean>>] => (
        typeof entry[0] === "string" &&
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1])
      ))
      .map(([packId, overrides]) => [
        packId,
        readBooleanStepMap(overrides),
      ]),
  );
}

function readBooleanStepMap(value: Partial<Record<PrepPlanStepId, unknown>>): Partial<Record<PrepPlanStepId, boolean>> {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [PrepPlanStepId, boolean] => typeof entry[1] === "boolean"),
  ) as Partial<Record<PrepPlanStepId, boolean>>;
}
