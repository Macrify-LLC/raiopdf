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
