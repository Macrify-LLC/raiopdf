import { useState } from "react";

/** Single source of the disable/validation reason for a missing Bates prefix. */
export const BATES_PREFIX_GATE_MESSAGE =
  'Enter a Bates prefix, or check "No prefix (numbers only)".';

/**
 * Shared Bates-prefix gating state (BatesPanel, Production Set builder).
 *
 * No sample default: a prefix names a matter, and a pre-filled "SMITH"
 * invites stamping the wrong matter's name across a whole document set.
 * The user either types their prefix or explicitly opts into numbers-only —
 * `prefixMissing` is the gate callers wire to their Apply/Build action.
 */
export function useBatesPrefix() {
  const [prefix, setPrefix] = useState("");
  const [noPrefix, setNoPrefix] = useState(false);
  const effectivePrefix = noPrefix ? "" : prefix;
  const prefixMissing = !noPrefix && prefix.trim().length === 0;

  return {
    prefix,
    setPrefix,
    noPrefix,
    setNoPrefix,
    effectivePrefix,
    prefixMissing,
    gateMessage: BATES_PREFIX_GATE_MESSAGE,
  };
}
