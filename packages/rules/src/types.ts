export type JurisdictionPackId = "florida" | (string & {});

export type ConstraintKind = "rule" | "portal";

export type ConstraintEntry = {
  id: string;
  label: string;
  kind: ConstraintKind;
  authority: string;
  lastVerified: string;
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
  fileBytes: number;
  searchableText: boolean;
  pdfaCompliant?: boolean;
  clerkStampSpaceBlank?: boolean;
};

export type PreflightStatus = "pass" | "fail" | "warn";

export type PreflightCheck = {
  checkId: string;
  label: string;
  kind: ConstraintKind;
  authority: string;
  status: PreflightStatus;
  detail: string;
};

export type PreflightReport = {
  checks: readonly PreflightCheck[];
};
