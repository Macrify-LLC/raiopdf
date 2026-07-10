import type { PdfCaptionData, PdfCaptionParty } from "@raiopdf/engine-api";

const STORAGE_KEY = "raio.caseProfiles.v1";

export interface CaseProfile {
  id: string;
  name: string;
  caption: PdfCaptionData;
  preferredStyleId?: string | undefined;
}

interface CaseProfileStore {
  profiles: readonly CaseProfile[];
  lastUsedProfileId?: string | undefined;
}

export function readCaseProfiles(): readonly CaseProfile[] {
  return readStore().profiles;
}

export function readLastUsedCaseProfile(): CaseProfile | null {
  const store = readStore();
  const profile = store.lastUsedProfileId
    ? store.profiles.find((candidate) => candidate.id === store.lastUsedProfileId)
    : store.profiles[0];

  return profile ?? null;
}

export function upsertCaseProfile(
  profile: Omit<CaseProfile, "id"> & { id?: string | undefined },
): CaseProfile {
  const store = readStore();
  const id = profile.id ?? makeCaseProfileId();
  const nextProfile: CaseProfile = {
    id,
    name: profile.name,
    caption: profile.caption,
    ...(profile.preferredStyleId ? { preferredStyleId: profile.preferredStyleId } : {}),
  };
  const profiles = [
    ...store.profiles.filter((existing) => existing.id !== id),
    nextProfile,
  ];

  writeStore({ profiles, lastUsedProfileId: id });
  return nextProfile;
}

export function selectLastUsedCaseProfile(profileId: string): void {
  const store = readStore();
  writeStore({ ...store, lastUsedProfileId: profileId });
}

export function deleteCaseProfile(profileId: string): void {
  const store = readStore();
  const profiles = store.profiles.filter((profile) => profile.id !== profileId);
  writeStore({
    profiles,
    ...(store.lastUsedProfileId === profileId ? {} : { lastUsedProfileId: store.lastUsedProfileId }),
  });
}

function readStore(): CaseProfileStore {
  if (typeof window === "undefined") {
    return emptyStore();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyStore();
    }

    const object = parsed as Record<string, unknown>;
    const profiles = Array.isArray(object.profiles)
      ? object.profiles.map(readCaseProfile).filter((profile): profile is CaseProfile => profile !== null)
      : [];
    const lastUsedProfileId = typeof object.lastUsedProfileId === "string"
      ? object.lastUsedProfileId
      : undefined;

    return {
      profiles,
      ...(lastUsedProfileId ? { lastUsedProfileId } : {}),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: CaseProfileStore): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function emptyStore(): CaseProfileStore {
  return { profiles: [] };
}

function makeCaseProfileId(): string {
  return `case:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function readCaseProfile(value: unknown): CaseProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Record<string, unknown>;
  const caption = readCaptionData(object.caption);

  if (
    typeof object.id !== "string" ||
    typeof object.name !== "string" ||
    !caption
  ) {
    return null;
  }

  return {
    id: object.id,
    name: object.name,
    caption,
    ...(typeof object.preferredStyleId === "string" ? { preferredStyleId: object.preferredStyleId } : {}),
  };
}

function readCaptionData(value: unknown): PdfCaptionData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Record<string, unknown>;
  const parties = Array.isArray(object.parties)
    ? object.parties.map(readCaptionParty).filter((party): party is PdfCaptionParty => party !== null)
    : [];

  if (
    typeof object.courtName !== "string" ||
    typeof object.documentTitle !== "string"
  ) {
    return null;
  }

  return {
    courtName: object.courtName,
    ...(typeof object.county === "string" ? { county: object.county } : {}),
    parties,
    ...(typeof object.caseNumber === "string" ? { caseNumber: object.caseNumber } : {}),
    ...(typeof object.division === "string" ? { division: object.division } : {}),
    ...(typeof object.judge === "string" ? { judge: object.judge } : {}),
    documentTitle: object.documentTitle,
    ...(Array.isArray(object.signatureBlockLines)
      ? { signatureBlockLines: object.signatureBlockLines.filter((line): line is string => typeof line === "string") }
      : {}),
  };
}

function readCaptionParty(value: unknown): PdfCaptionParty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Record<string, unknown>;
  const names = Array.isArray(object.names)
    ? object.names.filter((name): name is string => typeof name === "string")
    : [];

  if (typeof object.role !== "string" || names.length === 0) {
    return null;
  }

  return {
    role: object.role,
    names,
    ...(typeof object.etAl === "boolean" ? { etAl: object.etAl } : {}),
  };
}
