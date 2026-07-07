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
