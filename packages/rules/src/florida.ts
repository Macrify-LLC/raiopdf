import type { JurisdictionPack } from "./types";

const LAST_VERIFIED = "2026-07-02";
const MEBIBYTE = 1024 * 1024;

export const floridaPack = {
  id: "florida",
  name: "Florida",
  constraints: [
    {
      id: "page-size-orientation",
      label: "Letter portrait pages",
      kind: "rule",
      authority: "Fla. R. Gen. Prac. & Jud. Admin. 2.520",
      lastVerified: LAST_VERIFIED,
    },
    {
      id: "clerk-stamp-space",
      label: "First-page clerk stamp space",
      kind: "rule",
      authority: "Fla. R. Gen. Prac. & Jud. Admin. 2.520",
      lastVerified: LAST_VERIFIED,
    },
    {
      id: "searchable-text",
      label: "Searchable text",
      kind: "rule",
      authority: "Fla. R. Gen. Prac. & Jud. Admin. 2.525",
      lastVerified: LAST_VERIFIED,
    },
    {
      id: "file-size",
      label: "Portal file size cap",
      kind: "portal",
      authority: "https://www.myflcourtaccess.com/",
      lastVerified: LAST_VERIFIED,
    },
    {
      id: "pdfa",
      label: "PDF/A preference",
      kind: "portal",
      authority: "https://www.myflcourtaccess.com/",
      lastVerified: LAST_VERIFIED,
    },
  ],
  pageSize: { w: 8.5, h: 11, in: true },
  orientation: "portrait",
  clerkStampSpace: {
    firstPage: { x: 5.5, y: 8, w: 3, h: 3 },
    laterPages: null,
  },
  maxFileBytes: 25 * MEBIBYTE,
  recommendedMaxFileBytes: 24 * MEBIBYTE,
  pdfa: {
    required: false,
    preferred: true,
    flavor: "pdfa-2b",
  },
  searchableTextRequired: true,
  splitNaming: "{name} — Part {n} of {total}",
} as const satisfies JurisdictionPack;
