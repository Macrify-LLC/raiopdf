// Pins the public, AI-client-facing descriptions of `build_production_set`'s
// withhold surface.
//
// Why this file exists: these descriptions are the only thing an AI client reads
// to decide how to call the tool, and two of them drifted out of sync with the
// implementation when slip sheets landed. Both said a withheld document "never
// appears in upload/, the index, or the DAT and consumes no Bates number" -- which
// is the `withheldHandling: "omit"` behaviour, not the default. The default is
// "slip-sheet": a Bates-stamped placeholder that DOES appear in all three and
// consumes exactly one number (packages/production-set/src/index.ts:97-113,
// docs/PRODUCTION-SETS.md "Slip sheets").
//
// A description that confidently states the wrong contract is worse than a vague
// one, because a client acts on it. These assertions are semantic rather than
// exact-string so that rewording stays free while re-introducing the specific
// contradiction does not.

import { describe, expect, it } from "vitest";
import { productionSetInputSchema } from "../src/tools/legal.js";

/** Description text for a field on the `sources[]` element. */
function sourceFieldDescription(field: string): string {
  const sources = productionSetInputSchema.sources as unknown as {
    element?: { shape?: Record<string, { description?: string }> };
  };
  const description = sources.element?.shape?.[field]?.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`sources[].${field} has no description to pin`);
  }
  return description;
}

/** Description text for a top-level field on the tool's input schema. */
function topLevelDescription(field: keyof typeof productionSetInputSchema): string {
  const description = (productionSetInputSchema[field] as { description?: string }).description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`${String(field)} has no description to pin`);
  }
  return description;
}

describe("build_production_set withhold metadata", () => {
  it("does not present the omit-only behaviour as unconditional", () => {
    const status = sourceFieldDescription("status");

    // The failure this guards: a blanket "never in the DAT / consumes no Bates
    // number" claim with no mention that it depends on withheldHandling.
    const claimsNothingConsumed = /consum\w*\s+no\s+bates/i.test(status);
    const claimsNeverAppears = /never\s+(?:in|appears)/i.test(status);

    if (claimsNothingConsumed || claimsNeverAppears) {
      expect(
        status,
        "status must tie any never-appears / consumes-no-Bates claim to withheldHandling, " +
          'because that is only true under "omit" -- the default is "slip-sheet"',
      ).toMatch(/withheldHandling/);
      expect(status).toMatch(/omit/);
    }
  });

  it("points callers at withheldHandling for what a withheld document leaves behind", () => {
    expect(sourceFieldDescription("status")).toMatch(/withheldHandling/);
  });

  it("documents the slip-sheet default and what it consumes", () => {
    const handling = topLevelDescription("withheldHandling");
    expect(handling).toMatch(/slip-sheet/i);
    expect(handling, "the default must be stated").toMatch(/default/i);
    // The load-bearing half: the placeholder is produced and consumes a number.
    expect(handling).toMatch(/one\s+bates\s+number|exactly\s+one/i);
    expect(handling).toMatch(/upload\//);
  });

  it("still documents omit as the pure-omission escape hatch", () => {
    const handling = topLevelDescription("withheldHandling");
    expect(handling).toMatch(/"omit"|\bomit\b/);
    expect(handling).toMatch(/no\s+bates\s+number|consuming\s+no/i);
  });

  it("keeps produce-redacted honest about performing no redaction", () => {
    // Separate promise, same blast radius: a caller must not believe this tool
    // redacts anything on their behalf.
    expect(sourceFieldDescription("status")).toMatch(/no\s+redaction/i);
  });
});
