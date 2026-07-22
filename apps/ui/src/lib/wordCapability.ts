import { invokePathOp } from "./pathOps";

export type WordCapabilityState =
  | "notApplicable"
  | "notDetected"
  | "detected"
  | "available"
  | "unavailable";

export interface WordCapability {
  state: WordCapabilityState;
  reason: string | null;
}

export function getWordCapability(force = false): Promise<WordCapability> {
  return invokePathOp("word_capability", { force });
}

/**
 * Presence gate: whether Microsoft Word can be *attempted* on this computer. Looser
 * than `shouldRefuseWordReflow` (wordReflow.ts), which requires a confirmed
 * launch (`available`) before running a conversion. `detected` (Word registered)
 * or `available` both count as present for proactively graying the Word-only
 * menu items; the deep click-time check stays the real gate before any op runs.
 */
export function isWordPresent(capability: WordCapability): boolean {
  return capability.state === "detected" || capability.state === "available";
}

/**
 * The click-time gate for actually running a Word conversion: refuse unless Word
 * launched cleanly (`available`). Stricter than `isWordPresent` (which also
 * accepts a merely-registered `detected` Word) — a registered Word can still
 * fail to start, so any real conversion re-checks with `force: true` first.
 */
export function shouldRefuseWord(capability: WordCapability): boolean {
  return capability.state !== "available";
}

/**
 * The canonical "Word can't run" message. Callers add their own context sentence
 * (e.g. "The document was not imported.") so all Word surfaces read consistently.
 */
export function wordUnavailableMessage(capability: WordCapability): string {
  if (capability.state === "notApplicable") {
    return "Microsoft Word isn't available on this computer.";
  }

  const reason = capability.reason?.trim();
  const guidance = reason ? wordRequirementGuidance(reason) : null;
  if (guidance) {
    return guidance;
  }
  if (reason) {
    return `Microsoft Word isn't available: ${reason}`;
  }
  return capability.state === "notDetected"
    ? "Microsoft Word isn't available. Install Microsoft Word, then sign in with a license that allows desktop apps."
    : "Microsoft Word isn't available.";
}

/**
 * Turns a failed Word conversion into a safe, actionable message. Capability
 * probes do not send an Apple Event on macOS, so denied Automation consent is
 * discovered at conversion time rather than during the initial availability
 * check. All Word workflows use this helper for that case.
 */
export function wordOperationGuidance(error: unknown): string | null {
  const code = errorCode(error);
  if (code === "WORD_AUTOMATION_DENIED") {
    return MACOS_AUTOMATION_DENIED_MESSAGE;
  }

  const reason = errorMessage(error);
  return reason ? wordRequirementGuidance(reason) : null;
}

const MACOS_AUTOMATION_DENIED_MESSAGE =
  "macOS denied RaioPDF permission to control Microsoft Word. In System Settings, go to Privacy & Security > Automation and allow RaioPDF to control Microsoft Word. Retrying before you allow it will not show the macOS permission prompt again; allow it there, then retry.";

function wordRequirementGuidance(reason: string): string | null {
  if (isMacAutomationDenied(reason)) {
    return MACOS_AUTOMATION_DENIED_MESSAGE;
  }
  if (isWordVersionProblem(reason)) {
    return `Microsoft Word needs a supported version to work with RaioPDF: ${reason}`;
  }
  if (isWordLicenseProblem(reason)) {
    return `Microsoft Word needs to be signed in and licensed before RaioPDF can use it: ${reason}`;
  }
  return null;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : null;
}

function isMacAutomationDenied(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("automation") &&
    (normalized.includes("denied") || normalized.includes("permission"))
  ) || normalized.includes("not authorised to send apple events") || normalized.includes("not authorized to send apple events");
}

function isWordVersionProblem(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes("unsupported version") ||
    normalized.includes("too old") ||
    normalized.includes("update microsoft word") ||
    normalized.includes("update word");
}

function isWordLicenseProblem(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes("license") ||
    normalized.includes("licence") ||
    normalized.includes("activation") ||
    normalized.includes("subscription") ||
    normalized.includes("sign in") ||
    normalized.includes("signin to word") ||
    normalized.includes("read-only");
}
