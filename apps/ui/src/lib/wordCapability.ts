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
 * Presence gate: whether Microsoft Word can be *attempted* on this PC. Looser
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
  if (capability.reason) {
    return `Microsoft Word isn't available: ${capability.reason}`;
  }
  return "Microsoft Word isn't available.";
}
