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
  check?: RequiredPhraseConstraint;
};

export type RequiredPhraseConstraint = {
  type: "required-phrase";
  appliesWhen: {
    filenameIncludesAny?: readonly string[];
    firstPageHeadingIncludesAny?: readonly string[];
  };
  phrasesAny: readonly string[];
  missingDetail: string;
  noTextDetail: string;
  passDetail?: string;
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
  maxFileBytes?: number;
  recommendedMaxFileBytes?: number;
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

export type EncryptionState = "none" | "encrypted" | "usage_restricted" | "detector_failed";

export type ActiveContentSignals = {
  possiblyPresent: boolean;
  signals: readonly string[];
};

export type FormFieldFacts = {
  count: number;
  anyFilled: boolean;
};

export type PossibleUnappliedRedactions = {
  redactAnnotationCount: number;
  blackRectangleAnnotationCount: number;
  possiblyPresent: boolean;
};

export type SignatureDetectionFacts = {
  standardAcroFormSignatureCount: number;
  hasByteRangeOrContentsMarkers: boolean;
  hasCertificationDictionary: boolean;
};

export type TextLayerCoverage = {
  imageOnlyPages: readonly number[];
  mixedPages: readonly number[];
  textPages: readonly number[];
  garbledPages: readonly GarbledPageInfo[];
  trivialTextImagePages?: readonly TrivialTextImagePageInfo[];
};

export type GarbleReason = "pua_glyphs" | "replacement_chars" | "low_alpha_entropy" | "combined";

export type GarbledPageInfo = {
  pageIndex: number;
  confidence: number;
  reason: GarbleReason;
  puaRatio: number;
  replacementRatio: number;
  alphaRatio: number;
};

export type TrivialTextImagePageInfo = {
  pageIndex: number;
  textCharacterCount: number;
  imageCoverageRatio: number;
};

export type TextLayerQuality = {
  cleanPages: number;
  garbledPages: number;
  imageOnlyPages: number;
  totalPages: number;
  verdict: "clean" | "garbled" | "image_only" | "mixed" | "unknown";
};

export function deriveTextLayerQuality(coverage: TextLayerCoverage): TextLayerQuality {
  const imageOnlyPages =
    coverage.imageOnlyPages.length + (coverage.trivialTextImagePages?.length ?? 0);
  const garbledPages = coverage.garbledPages.length;
  const totalPages = coverage.imageOnlyPages.length + coverage.mixedPages.length + coverage.textPages.length;
  const cleanPages = Math.max(0, totalPages - imageOnlyPages - garbledPages);

  if (totalPages === 0) {
    return { cleanPages, garbledPages, imageOnlyPages, totalPages, verdict: "unknown" };
  }
  if (imageOnlyPages === totalPages) {
    return { cleanPages, garbledPages, imageOnlyPages, totalPages, verdict: "image_only" };
  }
  if (garbledPages === totalPages) {
    return { cleanPages, garbledPages, imageOnlyPages, totalPages, verdict: "garbled" };
  }
  if (cleanPages === totalPages) {
    return { cleanPages, garbledPages, imageOnlyPages, totalPages, verdict: "clean" };
  }

  return { cleanPages, garbledPages, imageOnlyPages, totalPages, verdict: "mixed" };
}

export type PageTextByPage = readonly { pageIndex: number; text: string }[];

export type DocumentFactsTextExtractor = {
  extractTextLayerCoverage: (bytes: Uint8Array) => Promise<TextLayerCoverage>;
  extractPageTextByPage?: (bytes: Uint8Array) => Promise<PageTextByPage>;
};

export type BuildDocumentFactsOptions = {
  textExtractor?: DocumentFactsTextExtractor;
};

export type DocumentFactName =
  | "pages"
  | "activeContentSignals"
  | "embeddedFileCount"
  | "formFields"
  | "annotationCount"
  | "signatureFieldCount"
  | "signatureDetection"
  | "possibleUnappliedRedactions"
  | "textLayerCoverage";

export type DocumentFactError = {
  fact: DocumentFactName;
  reason: string;
};

export type DocumentFacts = {
  pages: readonly PageFacts[];
  filename?: string;
  fileBytes?: number;
  searchableText?: boolean;
  pdfaCompliant?: boolean;
  clerkStampSpaceBlank?: boolean;
  encryptionState?: EncryptionState;
  activeContentSignals?: ActiveContentSignals;
  embeddedFileCount?: number;
  formFields?: FormFieldFacts;
  annotationCount?: number;
  signatureFieldCount?: number;
  signatureDetection?: SignatureDetectionFacts;
  possibleUnappliedRedactions?: PossibleUnappliedRedactions;
  textLayerCoverage?: TextLayerCoverage;
  pageTextByPage?: PageTextByPage;
  errors?: readonly DocumentFactError[];
};

export type SelectionFileFacts = {
  filename: string;
  fileBytes?: number;
};

export type SelectionFacts = {
  files: readonly SelectionFileFacts[];
  envelopeBytes?: number;
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

export type PrepPlanStepId =
  | "remove-encryption"
  | "normalize-pages"
  | "sanitize-content"
  | "scrub-metadata"
  | "make-searchable"
  | "flatten-forms"
  | "convert-pdfa"
  | "split-by-size";

export type PrepPlanStance = ConstraintStance | "standard";

export type PrepPlanStep = {
  id: PrepPlanStepId;
  label: string;
  /**
   * Raw stance from the jurisdiction pack for policy-backed steps. Some pack
   * slots describe a document property rather than the preparation action.
   */
  stance: PrepPlanStance;
  /** Stance normalized to the preparation action represented by this step. */
  actionStance: PrepPlanStance;
  condition?: string;
  authority: string;
  lastVerified: string;
  note?: string;
  prepDefault: PrepDefault;
  defaultChecked: boolean;
  disabledReason?: string;
  destructive: boolean;
  impact: string;
};
