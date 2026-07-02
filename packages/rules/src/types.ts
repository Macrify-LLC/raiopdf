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

export type PdfARequirement = {
  required: boolean;
  preferred: boolean;
  flavor: "pdfa-1" | "pdfa-2b" | "pdfa-3b";
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
