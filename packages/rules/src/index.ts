export {
  DEFAULT_PACK_ID,
  getPack,
  getPackIntegrityBanner,
  getPackIntegrityIssues,
  listPacks,
  UNKNOWN_PACK_ID,
  unknownPack,
} from "./registry.js";
export {
  canonicalPackJson,
  packJsonSha256,
  verifyAppDataPackIntegrity,
  verifyBundledPackIntegrity,
} from "./packIntegrity.js";
export { preflight, shouldConvertToPdfA } from "./preflight.js";
export {
  buildDocumentFacts,
  detectEncryptionState,
  detectSignatureFacts,
  hasEmbeddedSignatureMarkers,
} from "./documentFacts.js";
export { resolvePrepPlan } from "./prepPlan.js";
export {
  GARBLE_ALPHA_RATIO_THRESHOLD,
  GARBLE_MIN_NON_WHITESPACE_CHARS,
  GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD,
  GARBLE_VOWELLESS_TOKEN_RATIO_THRESHOLD,
  scoreGarbledPage,
} from "./garbleScore.js";
export type {
  ActiveContentSignals,
  BuildDocumentFactsOptions,
  ConstraintApplicability,
  ConstraintEntry,
  ConstraintKind,
  ConstraintStance,
  DocumentFactError,
  DocumentFactName,
  DocumentFacts,
  DocumentFactsTextExtractor,
  EncryptionState,
  FormFieldFacts,
  GarbledPageInfo,
  GarbleReason,
  JurisdictionPack,
  JurisdictionPackId,
  PageFacts,
  PageTextByPage,
  PageOrientation,
  PageSizeInches,
  PdfARequirement,
  PdfAStance,
  PolicyConstraint,
  PossibleUnappliedRedactions,
  PrepDefault,
  PrepPlanStance,
  PrepPlanStep,
  PrepPlanStepId,
  PreflightCheck,
  PreflightReport,
  PreflightStatus,
  RectInches,
  RequiredPhraseConstraint,
  SelectionFacts,
  SelectionFileFacts,
  SignatureDetectionFacts,
  TextLayerCoverage,
  TextLayerQuality,
  TrivialTextImagePageInfo,
} from "./types.js";
export { deriveTextLayerQuality } from "./types.js";
export type {
  AppDataPackIntegrityResult,
  PackAcknowledgmentStore,
  PackIntegrityIssue,
  PackManifest,
  PackManifestEntry,
} from "./packIntegrity.js";
