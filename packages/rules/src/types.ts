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
  note?: string;
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
 * A jurisdiction's documented posture toward a filing constraint.
 *
 * - "required"   — the court or portal requires this property.
 * - "preferred"  — the court or portal accepts alternatives but asks for this property.
 * - "accepted"   — this property passes the portal's checks but carries no documented
 *                  benefit over the ordinary filing copy.
 * - "prohibited" — the court or portal rejects this property outright.
 * - "unknown"    — the jurisdiction's stance is unresearched, silent, or unverified.
 */
export type ConstraintStance = "required" | "preferred" | "accepted" | "prohibited" | "unknown";
export type PdfAStance = ConstraintStance;
export type PrepDefault = "on" | "off" | "n_a";

export type PolicyConstraint = {
  stance: ConstraintStance;
  condition?: string;
  prepDefault: PrepDefault;
  authority?: string;
  lastVerified?: string;
  note?: string;
};

/**
 * PDF/A adds a flavor to the shared policy-constraint shape. Prepare for Filing
 * keys conversion from both axes: the documented stance and Raio's prep default.
 */
export type PdfARequirement = PolicyConstraint & {
  flavor: "pdfa-1" | "pdfa-2b" | "pdfa-3b";
};

export type JurisdictionPack = {
  id: JurisdictionPackId;
  schemaVersion: 2;
  name: string;
  packVersion: string;
  jurisdiction: string;
  courtSystem: string;
  portal: string;
  scopeNote: string;
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
  maxEnvelopeBytes?: number;
  filenameMaxChars?: number;
  filenameCharset?: string;
  userConfigurable?: {
    maxFileBytes?: boolean;
    maxEnvelopeBytes?: boolean;
  };
  pdfa: PdfARequirement;
  activeContent: PolicyConstraint;
  encryption: PolicyConstraint;
  embeddedFiles: PolicyConstraint;
  metadataScrub: PolicyConstraint;
  ocr: PolicyConstraint;
  flattenForms: PolicyConstraint;
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
  filename?: string;
  fileBytes?: number;
  searchableText?: boolean;
  pdfaCompliant?: boolean;
  clerkStampSpaceBlank?: boolean;
};

export type SelectionFileFacts = {
  filename: string;
  fileBytes?: number;
};

export type SelectionFacts = {
  files: readonly SelectionFileFacts[];
};

export type PreflightStatus = "pass" | "warn" | "unknown";

export type PreflightCheckBase = {
  checkId: string;
  label: string;
  authority: string;
  detail: string;
  kind: ConstraintKind;
  status: PreflightStatus;
};

export type PreflightCheck = PreflightCheckBase;

export type PreflightReport = {
  checks: readonly PreflightCheck[];
  selectionChecks?: readonly PreflightCheck[];
};
