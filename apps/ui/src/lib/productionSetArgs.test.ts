// The renderer half of the `build_production_set` IPC seam.
//
// This file does two jobs:
//   1. Asserts the payload shape directly (grants not paths, omitted defaults,
//      privilege text never forwarded for a produced document).
//   2. Pins that payload to a fixture the SHELL also reads. The Rust side
//      deserializes the same file into `ProductionSetShellArgs`
//      (apps/shell/src-tauri/src/mcp.rs) in `production_set_args_fixture`.
//
// Why a shared fixture rather than a shared schema: the renderer and the MCP
// tool intentionally differ (grants vs paths, flat vs nested continuation
// override), so there is no single schema both sides could validate against.
// The fixture is the contract. If either side renames a field, one of the two
// tests fails — instead of Tauri silently binding nothing and the option being
// dropped from a real production.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProductionSetFile, ProductionSetRunInput } from "../components/ProductionSetWorkspace";
import { MISSING_GRANT_MESSAGE, buildProductionSetArgs } from "./productionSetArgs";

// apps/ui/src/lib -> repo root
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE_PATH = path.join(
  repoRoot,
  "apps/shell/src-tauri/fixtures/production-set-shell-args.json",
);

function file(overrides: Partial<ProductionSetFile> & { id: string }): ProductionSetFile {
  return {
    name: `${overrides.id}.pdf`,
    path: `C:/matters/${overrides.id}.pdf`,
    pages: 3,
    designation: "",
    designationPages: "",
    status: "produce",
    privilegeAsserted: "",
    basis: "",
    ...overrides,
  } as ProductionSetFile;
}

/**
 * A run that exercises every transported field and all three per-file
 * statuses. This is the input the committed fixture is generated from.
 */
function maximalInput(): ProductionSetRunInput {
  return {
    files: [
      file({ id: "produced", designation: "CONFIDENTIAL", designationPages: "1-2,5" }),
      file({
        id: "redacted",
        status: "produce-redacted",
        privilegeAsserted: "Work product",
        basis: "Redacted per protective order",
      }),
      file({
        id: "withheld",
        status: "withhold",
        privilegeAsserted: "Attorney-client privilege",
        basis: "Counsel advice re settlement",
      }),
    ],
    prefix: "SMITH",
    start: 100,
    digits: 6,
    outputDir: "C:/matters/out",
    includeIndex: true,
    includeFilenameInIndex: true,
    combinedPdf: false,
    volumeSizeMb: 250,
    batesPlacement: { edge: "footer", align: "right" },
    designationPlacement: { edge: "header", align: "center" },
    stampFontSizePt: 10,
    continueFrom: "dir-grant-prior",
    continuationOverrideReason: "Reserved 100 numbers for a rolling production",
    duplicateHandling: "produce-once",
    includeLoadFiles: true,
    includeFilenameInPrivilegeLog: true,
    withheldHandling: "slip-sheet",
  } as ProductionSetRunInput;
}

const GRANTS = ["grant-produced", "grant-redacted", "grant-withheld"];

describe("buildProductionSetArgs", () => {
  it("sends opaque grants, never filesystem paths", () => {
    const args = buildProductionSetArgs(maximalInput(), GRANTS);

    expect(args.sources.map((source) => source.grant)).toEqual(GRANTS);
    // A path leaking into the payload would defeat the grant model entirely.
    expect(JSON.stringify(args)).not.toMatch(/C:\/matters\/\w+\.pdf/);
  });

  it("omits status and privilege text for a produced document", () => {
    const args = buildProductionSetArgs(maximalInput(), GRANTS);
    const produced = args.sources[0]!;

    expect(produced.status).toBeUndefined();
    // Sensitive work product left over from a reverted Withhold choice must
    // never ride along on a document that is being produced.
    expect(produced.privilegeAsserted).toBeUndefined();
    expect(produced.basis).toBeUndefined();
  });

  it("forwards status and privilege text for withheld and redacted documents", () => {
    const args = buildProductionSetArgs(maximalInput(), GRANTS);

    expect(args.sources[1]).toMatchObject({
      status: "produce-redacted",
      privilegeAsserted: "Work product",
    });
    expect(args.sources[2]).toMatchObject({
      status: "withhold",
      privilegeAsserted: "Attorney-client privilege",
    });
  });

  it("drops a page range that has no designation behind it", () => {
    const input = maximalInput();
    const files = [...input.files] as ProductionSetFile[];
    files[0] = { ...files[0]!, designation: "", designationPages: "1-2" };

    const args = buildProductionSetArgs({ ...input, files }, GRANTS);

    expect(args.sources[0]!.designationPages).toBeUndefined();
  });

  it("keeps continuationOverrideReason flat (the shell nests it)", () => {
    const args = buildProductionSetArgs(maximalInput(), GRANTS);

    expect(args.continuationOverrideReason).toBe(
      "Reserved 100 numbers for a rolling production",
    );
    expect(args).not.toHaveProperty("continuationOverride");
  });

  it("normalizes a null volume size to undefined so the key is omitted", () => {
    const args = buildProductionSetArgs({ ...maximalInput(), volumeSizeMb: null }, GRANTS);

    expect(args.volumeSizeMb).toBeUndefined();
  });

  it("refuses a file with no desktop grant rather than skipping it", () => {
    expect(() => buildProductionSetArgs(maximalInput(), ["grant-produced", undefined, "g"])).toThrow(
      MISSING_GRANT_MESSAGE,
    );
  });

  it("matches the fixture the shell deserializes", () => {
    const args = buildProductionSetArgs(maximalInput(), GRANTS);
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

    // JSON round-trip drops `undefined` keys, which is exactly what reaches
    // the shell — compare on that basis.
    expect(JSON.parse(JSON.stringify(args))).toEqual(fixture);
  });
});
