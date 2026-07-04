// Over-cap split canary: verifies that a REAL filing that exceeds the portal
// file-size cap is split into portal-legal parts — the whole point of the
// split-by-size feature. Runs the shipped split engine (LocalPdfEngine, pdf-lib)
// directly in Node, so it can handle files far too large for the browser to open.
//
// Uses `oversized-*.pdf` fixtures. A file with few large pages (e.g. a plat) is
// ideal: genuinely over the cap, but fast to split. Very high page counts are
// slow — the split re-serializes the accumulating document per page (O(n^2)).

import { expect, test } from "@playwright/test";
import { LocalPdfEngine } from "@raiopdf/engine-local";
import { localFixture, localFixtureNames, saveCanaryArtifact } from "./helpers";

// packages/rules/data/florida.json → maxFileBytes (the hard portal cap).
const FLORIDA_MAX_BYTES = 26_214_400; // 25 MiB

// Engine-level (no browser), so accept much larger files than the browser cap.
const oversizedFixtures = localFixtureNames(/^oversized.*\.pdf$/i, 128 * 1024 * 1024);

if (oversizedFixtures.length === 0) {
  test.skip("Split-by-size over the portal cap (no oversized-*.pdf in fixtures — skipped)", () => {});
}

for (const name of oversizedFixtures) {
  test(`Split-by-size: a real over-cap filing splits into portal-legal parts: ${name}`, async () => {
    test.setTimeout(300_000);
    const bytes = localFixture(name)!;
    expect(bytes.byteLength, "fixture should be over the portal cap to be meaningful").toBeGreaterThan(
      FLORIDA_MAX_BYTES,
    );

    const engine = new LocalPdfEngine();
    const handle = await engine.open(bytes);
    const result = await engine.splitByMaxBytes(handle, FLORIDA_MAX_BYTES);

    // Split parts are document handles — save each to bytes to inspect + review.
    const parts = await Promise.all(
      result.parts.map(async (part) => ({
        bytes: await engine.saveToBytes(part.document),
        oversized: part.oversized,
      })),
    );

    // Every non-oversized part fits the cap. A part is only allowed over the cap
    // if it's a single page that can't be split further — the genuine "one
    // exhibit page is bigger than the portal allows" edge, worth surfacing.
    expect(parts.length, "an over-cap file must produce at least one part").toBeGreaterThanOrEqual(1);
    for (const part of parts) {
      if (!part.oversized) {
        expect(
          part.bytes.byteLength,
          "a non-oversized part must fit under the portal cap",
        ).toBeLessThanOrEqual(FLORIDA_MAX_BYTES);
      }
    }

    const multiPart = parts.length >= 2;
    const unsplittableOversizedPage = parts.some((part) => part.oversized);
    expect(
      multiPart || unsplittableOversizedPage,
      "an over-cap filing should split into parts, or flag an unsplittable oversized page",
    ).toBe(true);

    // Save every part for human review.
    parts.forEach((part, index) => {
      const mb = (part.bytes.byteLength / 1_048_576).toFixed(1);
      saveCanaryArtifact(
        `split over-cap: ${name}`,
        `${name}-part-${index + 1}-of-${parts.length}${part.oversized ? "-OVER-CAP" : ""}.pdf`,
        part.bytes,
        part.oversized
          ? `part ${index + 1}: ${mb} MB — STILL over cap (single unsplittable page)`
          : `part ${index + 1}: ${mb} MB — under the ${(FLORIDA_MAX_BYTES / 1_048_576).toFixed(0)} MB cap`,
      );
    });
  });
}
