import type { PdfApplyEditsOptions, PdfEdit } from "@raiopdf/engine-api";

import {
  pathOpApplyEdits,
  pathOpDecrypt,
  pathOpReleaseOutput,
  type PathOpsFileGrant,
} from "./pathOps";

interface StageStreamedProtectedCopyEditsOptions {
  sourceGrant: PathOpsFileGrant;
  ownerRestricted: boolean;
  edits: readonly PdfEdit[];
  applyOptions: PdfApplyEditsOptions;
  outputName: string;
  flatten: boolean;
}

interface StagedStreamedProtectedCopyEdits {
  inputGrant: PathOpsFileGrant;
  temporaryGrants: PathOpsFileGrant[];
}

/**
 * Materialize pending streamed-document edits for protection. pdf-lib cannot
 * open encrypted inputs, so an owner-restricted source is decrypted first and
 * every intermediate grant is returned for deterministic cleanup.
 */
export async function stageStreamedProtectedCopyEdits(
  options: StageStreamedProtectedCopyEditsOptions,
): Promise<StagedStreamedProtectedCopyEdits> {
  const temporaryGrants: PathOpsFileGrant[] = [];
  let inputGrant = options.sourceGrant;

  if (options.ownerRestricted) {
    const decrypted = await pathOpDecrypt(inputGrant, "");
    inputGrant = decrypted.outputGrant;
    temporaryGrants.push(inputGrant);
  }

  try {
    const staged = await pathOpApplyEdits(
      inputGrant,
      options.edits,
      options.applyOptions,
      options.outputName,
      options.flatten,
    );
    temporaryGrants.push(staged.outputGrant);
    return { inputGrant: staged.outputGrant, temporaryGrants };
  } catch (error) {
    for (const grant of temporaryGrants.reverse()) {
      await pathOpReleaseOutput(grant).catch(() => undefined);
    }
    throw error;
  }
}
