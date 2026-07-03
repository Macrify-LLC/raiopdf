import type {
  ConstraintApplicability,
  ConstraintEntry,
  ConstraintKind,
  JurisdictionPack,
  JurisdictionPackId,
  PageOrientation,
  PageSizeInches,
  PdfARequirement,
  RectInches,
} from "./types";

export type PackJsonSource = {
  readPackJson: (packId: JurisdictionPackId) => string | undefined;
};

export function loadJurisdictionPackFromJson(json: string, sourceName: string): JurisdictionPack {
  let raw: unknown;

  try {
    raw = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName}: invalid JSON: ${message}`, { cause: error });
  }

  return validateJurisdictionPack(raw, sourceName);
}

export function validateJurisdictionPack(raw: unknown, sourceName: string): JurisdictionPack {
  const pack = requireObject(raw, sourceName);

  const id = readString(pack, "id", sourceName) as JurisdictionPackId;
  const name = readString(pack, "name", sourceName);
  const packVersion = readSemver(pack, "packVersion", sourceName);
  const guidanceNote = readString(pack, "guidanceNote", sourceName);
  const maxFileBytes = readPositiveInteger(pack, "maxFileBytes", sourceName);
  const recommendedMaxFileBytes = readPositiveInteger(pack, "recommendedMaxFileBytes", sourceName);

  if (recommendedMaxFileBytes > maxFileBytes) {
    throw new Error(`${sourceName}.recommendedMaxFileBytes must be less than or equal to maxFileBytes`);
  }

  return {
    id,
    name,
    packVersion,
    guidanceNote,
    constraints: readConstraints(pack, sourceName),
    pageSize: readPageSize(pack, "pageSize", sourceName),
    orientation: readOrientation(pack, "orientation", sourceName),
    clerkStampSpace: readClerkStampSpace(pack, sourceName),
    maxFileBytes,
    recommendedMaxFileBytes,
    pdfa: readPdfA(pack, sourceName),
    searchableTextRequired: readBoolean(pack, "searchableTextRequired", sourceName),
    splitNaming: readString(pack, "splitNaming", sourceName),
  };
}

function readConstraints(pack: Record<string, unknown>, sourceName: string): readonly ConstraintEntry[] {
  const constraints = pack.constraints;

  if (!Array.isArray(constraints) || constraints.length === 0) {
    throw new Error(`${sourceName}.constraints must be a non-empty array`);
  }

  return constraints.map((entry, index) => {
    const path = `${sourceName}.constraints[${index}]`;
    const constraint = requireObject(entry, path);

    return {
      id: readString(constraint, "id", path),
      label: readString(constraint, "label", path),
      kind: readConstraintKind(constraint, "kind", path),
      authority: readString(constraint, "authority", path),
      lastVerified: readDateString(constraint, "lastVerified", path),
      applicability: readApplicability(constraint, path),
    };
  });
}

function readApplicability(
  constraint: Record<string, unknown>,
  sourceName: string,
): ConstraintApplicability {
  const applicability = requireObject(constraint.applicability, `${sourceName}.applicability`);
  const scope = applicability.scope;

  if (scope !== "statewide" && scope !== "varies") {
    throw new Error(`${sourceName}.applicability.scope must be "statewide" or "varies"`);
  }

  const note = applicability.note;

  if (note !== undefined && typeof note !== "string") {
    throw new Error(`${sourceName}.applicability.note must be a string when present`);
  }

  return note === undefined ? { scope } : { scope, note };
}

function readClerkStampSpace(
  pack: Record<string, unknown>,
  sourceName: string,
): JurisdictionPack["clerkStampSpace"] {
  const stampSpace = requireObject(pack.clerkStampSpace, `${sourceName}.clerkStampSpace`);
  const laterPages = stampSpace.laterPages;

  if (laterPages !== null) {
    requireObject(laterPages, `${sourceName}.clerkStampSpace.laterPages`);
  }

  return {
    firstPage: readRect(stampSpace, "firstPage", `${sourceName}.clerkStampSpace`),
    laterPages: laterPages === null
      ? null
      : readRect(stampSpace, "laterPages", `${sourceName}.clerkStampSpace`),
  };
}

function readPdfA(pack: Record<string, unknown>, sourceName: string): PdfARequirement {
  const pdfa = requireObject(pack.pdfa, `${sourceName}.pdfa`);
  const flavor = pdfa.flavor;

  if (flavor !== "pdfa-1" && flavor !== "pdfa-2b" && flavor !== "pdfa-3b") {
    throw new Error(`${sourceName}.pdfa.flavor must be "pdfa-1", "pdfa-2b", or "pdfa-3b"`);
  }

  return {
    required: readBoolean(pdfa, "required", `${sourceName}.pdfa`),
    preferred: readBoolean(pdfa, "preferred", `${sourceName}.pdfa`),
    flavor,
  };
}

function readPageSize(
  object: Record<string, unknown>,
  key: string,
  sourceName: string,
): PageSizeInches {
  const size = requireObject(object[key], `${sourceName}.${key}`);
  const inUnit = size.in;

  if (inUnit !== true) {
    throw new Error(`${sourceName}.${key}.in must be true`);
  }

  return {
    w: readPositiveNumber(size, "w", `${sourceName}.${key}`),
    h: readPositiveNumber(size, "h", `${sourceName}.${key}`),
    in: true,
  };
}

function readRect(object: Record<string, unknown>, key: string, sourceName: string): RectInches {
  const rect = requireObject(object[key], `${sourceName}.${key}`);

  return {
    x: readNumber(rect, "x", `${sourceName}.${key}`),
    y: readNumber(rect, "y", `${sourceName}.${key}`),
    w: readPositiveNumber(rect, "w", `${sourceName}.${key}`),
    h: readPositiveNumber(rect, "h", `${sourceName}.${key}`),
  };
}

function readOrientation(
  object: Record<string, unknown>,
  key: string,
  sourceName: string,
): PageOrientation {
  const orientation = object[key];

  if (orientation !== "portrait" && orientation !== "landscape") {
    throw new Error(`${sourceName}.${key} must be "portrait" or "landscape"`);
  }

  return orientation;
}

function readConstraintKind(
  object: Record<string, unknown>,
  key: string,
  sourceName: string,
): ConstraintKind {
  const kind = object[key];

  if (kind !== "rule" && kind !== "portal") {
    throw new Error(`${sourceName}.${key} must be "rule" or "portal"`);
  }

  return kind;
}

function readString(object: Record<string, unknown>, key: string, sourceName: string): string {
  const value = object[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${sourceName}.${key} must be a non-empty string`);
  }

  return value;
}

function readSemver(object: Record<string, unknown>, key: string, sourceName: string): string {
  const value = readString(object, key, sourceName);

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${sourceName}.${key} must be a semver string`);
  }

  return value;
}

function readDateString(object: Record<string, unknown>, key: string, sourceName: string): string {
  const value = readString(object, key, sourceName);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${sourceName}.${key} must use YYYY-MM-DD format`);
  }

  return value;
}

function readBoolean(object: Record<string, unknown>, key: string, sourceName: string): boolean {
  const value = object[key];

  if (typeof value !== "boolean") {
    throw new Error(`${sourceName}.${key} must be a boolean`);
  }

  return value;
}

function readPositiveInteger(object: Record<string, unknown>, key: string, sourceName: string): number {
  const value = readNumber(object, key, sourceName);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${sourceName}.${key} must be a positive integer`);
  }

  return value;
}

function readPositiveNumber(object: Record<string, unknown>, key: string, sourceName: string): number {
  const value = readNumber(object, key, sourceName);

  if (value <= 0) {
    throw new Error(`${sourceName}.${key} must be greater than 0`);
  }

  return value;
}

function readNumber(object: Record<string, unknown>, key: string, sourceName: string): number {
  const value = object[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${sourceName}.${key} must be a finite number`);
  }

  return value;
}

function requireObject(raw: unknown, sourceName: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${sourceName} must be an object`);
  }

  return raw as Record<string, unknown>;
}
