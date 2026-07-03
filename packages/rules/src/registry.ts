import { floridaPack } from "./florida";
import manifestJson from "../data/packs.manifest.json";
import type { PackIntegrityIssue, PackManifest } from "./packIntegrity";
import { verifyBundledPackIntegrity } from "./packIntegrity";
import type { JurisdictionPack, JurisdictionPackId } from "./types";

export const DEFAULT_PACK_ID = "florida";
export const UNKNOWN_PACK_ID = "unknown";

export const unknownPack: JurisdictionPack = {
  id: UNKNOWN_PACK_ID,
  name: "Rules unavailable",
  packVersion: "0.0.0",
  guidanceNote: "Jurisdiction pack integrity could not be verified. Confirm filing requirements outside RaioPDF.",
  constraints: [
    unknownConstraint("page-size-orientation", "Letter portrait pages", "rule"),
    unknownConstraint("searchable-text", "Searchable text", "rule"),
    unknownConstraint("file-size", "Portal file size cap", "portal"),
    unknownConstraint("clerk-stamp-space", "First-page clerk stamp space", "rule"),
    unknownConstraint("pdfa", "PDF/A preference", "portal"),
  ],
  pageSize: { w: 8.5, h: 11, in: true },
  orientation: "portrait",
  clerkStampSpace: {
    firstPage: { x: 5.5, y: 8, w: 3, h: 3 },
    laterPages: null,
  },
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  recommendedMaxFileBytes: Number.MAX_SAFE_INTEGER,
  pdfa: {
    required: false,
    preferred: false,
    flavor: "pdfa-2b",
  },
  searchableTextRequired: false,
  splitNaming: "{name} — Part {n} of {total}",
};

const packIntegrityIssues: PackIntegrityIssue[] = [];
const packs = new Map<JurisdictionPackId, JurisdictionPack>();

registerBundledPack(floridaPack);

export function getPack(id: JurisdictionPackId = DEFAULT_PACK_ID): JurisdictionPack {
  const pack = packs.get(id);

  if (!pack) {
    if (id === DEFAULT_PACK_ID && packIntegrityIssues.length > 0) {
      return unknownPack;
    }

    throw new Error(`Unknown jurisdiction pack: ${id}`);
  }

  return pack;
}

export function listPacks(): readonly JurisdictionPack[] {
  return packs.size > 0 ? [...packs.values()] : [unknownPack];
}

export function getPackIntegrityIssues(): readonly PackIntegrityIssue[] {
  return packIntegrityIssues;
}

export function getPackIntegrityBanner(): string | null {
  if (packIntegrityIssues.length === 0) {
    return null;
  }

  return "Jurisdiction rules could not be verified against the bundled pack manifest. Preflight statuses are unknown until the pack is restored.";
}

function registerBundledPack(pack: JurisdictionPack): void {
  const issue = verifyBundledPackIntegrity(manifestJson as PackManifest, pack.id, pack);

  if (issue) {
    packIntegrityIssues.push(issue);
    return;
  }

  packs.set(pack.id, pack);
}

function unknownConstraint(
  id: string,
  label: string,
  kind: "rule" | "portal",
): JurisdictionPack["constraints"][number] {
  return {
    id,
    label,
    kind,
    authority: "Pack integrity unavailable",
    lastVerified: "1970-01-01",
    applicability: { scope: "varies", note: "Pack refused by integrity verification." },
  };
}
