export type JurisdictionPackId = "florida" | (string & {});

export type ConstraintKind = "rule" | "portal";

export type ConstraintApplicability = {
  scope: "statewide" | "varies";
  note?: string;
};

export type ConstraintEntry = {
  id: string;
  label: string;
  kind: ConstraintKind;
  authority: string;
  lastVerified: string;
  applicability: ConstraintApplicability;
};

export type PageSizeInches = {
  w: number;
  h: number;
  in: true;
};

export type PageOrientation = "portrait" | "landscape";

export type RectInches = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * A jurisdiction's documented posture toward PDF/A submissions.
 *
 * - "required"   — the portal rejects non-PDF/A files; conversion is mandatory.
 * - "preferred"  — the portal accepts plain PDF but asks for PDF/A; conversion is beneficial.
 * - "accepted"   — PDF/A passes the portal's checks but carries no benefit over plain PDF;
 *                  conversion is skipped because it can only destroy (forms, annotations,
 *                  signatures), never help.
 * - "prohibited" — the portal rejects PDF/A outright (e.g. Missouri); conversion must not run.
 * - "unknown"    — the jurisdiction's stance is unresearched or unverified; conversion is
 *                  skipped rather than run on unverified data.
 */
export type PdfAStance = "required" | "preferred" | "accepted" | "prohibited" | "unknown";

export type PdfARequirement = {
  stance: PdfAStance;
  flavor: "pdfa-1" | "pdfa-2b" | "pdfa-3b";
  note?: string;
};

export type JurisdictionPack = {
  id: JurisdictionPackId;
  name: string;
  packVersion: string;
  guidanceNote: string;
  constraints: readonly ConstraintEntry[];
  pageSize: PageSizeInches;
  orientation: PageOrientation;
  clerkStampSpace: {
    firstPage: RectInches;
    laterPages: RectInches | null;
  };
  maxFileBytes: number;
  recommendedMaxFileBytes: number;
  pdfa: PdfARequirement;
  searchableTextRequired: boolean;
  splitNaming: string;
};

export type PageFacts = {
  pageIndex: number;
  size: PageSizeInches;
  orientation: PageOrientation;
  occupiedRegions?: readonly RectInches[];
};

export type DocumentFacts = {
  pages: readonly PageFacts[];
  fileBytes?: number;
  searchableText?: boolean;
  pdfaCompliant?: boolean;
  clerkStampSpaceBlank?: boolean;
};

export type RulePreflightStatus = "pass" | "warn" | "unknown";
export type PortalPreflightStatus = "pass" | "fix" | "unknown";
export type PreflightStatus = RulePreflightStatus | PortalPreflightStatus;

export type PreflightCheckBase = {
  checkId: string;
  label: string;
  authority: string;
  detail: string;
};

export type RulePreflightCheck = PreflightCheckBase & {
  kind: "rule";
  status: RulePreflightStatus;
};

export type PortalPreflightCheck = PreflightCheckBase & {
  kind: "portal";
  status: PortalPreflightStatus;
};

export type PreflightCheck = RulePreflightCheck | PortalPreflightCheck;

export type PreflightReport = {
  checks: readonly PreflightCheck[];
};
