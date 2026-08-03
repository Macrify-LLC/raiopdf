// The renderer half of the `build_production_set` IPC contract.
//
// Extracted from `App.tsx` so the payload can be asserted without a Tauri
// runtime. The shell deserializes this into `ProductionSetShellArgs`
// (apps/shell/src-tauri/src/mcp.rs) with `deny_unknown_fields`, so a field
// added here that the shell does not know about fails loudly instead of being
// dropped, and a field renamed on either side fails the fixture test rather
// than silently arriving as `None`.
//
// Two shape rules this file exists to hold steady:
//   - Sources travel as opaque GRANTS, never filesystem paths. The shell
//     resolves a grant to a path and that path never crosses back over IPC.
//   - `continuationOverrideReason` is FLAT here and becomes nested
//     `continuationOverride { reason }` on the far side of the shell.

import type {
  ProductionSetRunInput,
  ProductionSourceStatus,
} from "../components/ProductionSetWorkspace";

/** One source as the shell receives it: a grant plus its per-file choices. */
export interface ProductionSetSourceArgs {
  grant: string;
  designation?: string | undefined;
  designationPages?: string | undefined;
  status?: ProductionSourceStatus | undefined;
  privilegeAsserted?: string | undefined;
  basis?: string | undefined;
}

/**
 * Mirrors `ProductionSetShellArgs` in the shell crate.
 *
 * Derived from `ProductionSetRunInput` rather than retyped so the workspace's
 * unions (`ProductionDuplicateHandling`, `WithheldHandling`) keep their narrow
 * types all the way to the IPC boundary, and so a new production option is a
 * one-place change here instead of four. Only two fields genuinely differ:
 * `files` becomes grant-bearing `sources`, and `volumeSizeMb` loses its `null`
 * (the key is omitted instead).
 */
export type ProductionSetArgs = Omit<ProductionSetRunInput, "files" | "volumeSizeMb"> & {
  sources: ProductionSetSourceArgs[];
  volumeSizeMb?: number | undefined;
};

/** Message shown when a file in the run has no desktop grant behind it. */
export const MISSING_GRANT_MESSAGE =
  "Production package output needs PDFs opened from local desktop paths.";

/**
 * Build the exact object sent as `invoke("build_production_set", { args })`.
 *
 * `sourceGrants` is positional against `input.files` — index `n` is the grant
 * for file `n`. A hole means the file was never opened from a real desktop
 * path, which is a hard error rather than a silently skipped document.
 */
export function buildProductionSetArgs(
  input: ProductionSetRunInput,
  sourceGrants: ReadonlyArray<string | undefined>,
): ProductionSetArgs {
  return {
    sources: input.files.map((file, index) => {
      const grant = sourceGrants[index];
      if (!grant) {
        throw new Error(MISSING_GRANT_MESSAGE);
      }

      const produced = file.status === "produce";

      return {
        grant,
        designation: file.designation || undefined,
        // A range without a designation is meaningless — never forward one.
        designationPages: file.designation ? file.designationPages || undefined : undefined,
        // "produce" is the backend default too -- omit it so the common
        // case sends the same shape it always has.
        status: produced ? undefined : file.status,
        // Privilege text is sensitive work product — a value left over
        // from a reverted Withhold choice is never forwarded for a
        // produced document.
        privilegeAsserted: produced ? undefined : file.privilegeAsserted || undefined,
        basis: produced ? undefined : file.basis || undefined,
      };
    }),
    outputDir: input.outputDir,
    prefix: input.prefix,
    start: input.start,
    digits: input.digits,
    includeIndex: input.includeIndex,
    includeFilenameInIndex: input.includeFilenameInIndex,
    combinedPdf: input.combinedPdf,
    volumeSizeMb: input.volumeSizeMb ?? undefined,
    batesPlacement: input.batesPlacement,
    designationPlacement: input.designationPlacement,
    stampFontSizePt: input.stampFontSizePt,
    continueFrom: input.continueFrom,
    continuationOverrideReason: input.continuationOverrideReason,
    duplicateHandling: input.duplicateHandling,
    includeLoadFiles: input.includeLoadFiles,
    includeFilenameInPrivilegeLog: input.includeFilenameInPrivilegeLog,
    withheldHandling: input.withheldHandling,
  };
}
