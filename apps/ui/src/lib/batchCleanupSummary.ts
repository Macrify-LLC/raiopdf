import type { BatchCleanupStatus } from "../components/BatchCleanupWorkspace";

/**
 * Completion copy for a finished batch-cleanup run.
 *
 * The batch queue reports per-file outcomes rather than throwing, so a run can
 * resolve "successfully" while individual files failed. The summary therefore
 * has to name the failed count -- an earlier version counted only invalidated
 * signatures, which meant a run where every file failed still read "Batch
 * cleanup finished for N file(s)." and the failures were discoverable only by
 * scanning per-file chips one at a time.
 */

/**
 * The only fields of a batch result file this summary reads.
 *
 * `status` uses the UI's own `BatchCleanupStatus` union rather than a bare
 * `string`: widening it would mean that renaming or adding a terminal status
 * silently drops `failedCount` to 0 and reverts the banner to reading like a
 * success -- the exact regression the tests below guard -- with nothing failing
 * to typecheck.
 */
export interface BatchCleanupSummaryFile {
  status?: BatchCleanupStatus | undefined;
  signatureInvalidated?: boolean | undefined;
}

export function batchCleanupCompletionMessage(
  files: readonly BatchCleanupSummaryFile[],
): string {
  const failedCount = files.filter((file) => file.status === "failed").length;
  const invalidatedCount = files.filter((file) => file.signatureInvalidated).length;
  const parts: string[] = [];

  if (files.length > 0 && failedCount === files.length) {
    parts.push(`Batch cleanup could not process any of the ${files.length} file(s).`);
  } else if (failedCount > 0) {
    parts.push(
      `Batch cleanup finished ${files.length - failedCount} of ${files.length} file(s) — ${failedCount} could not be processed.`,
    );
  } else {
    parts.push(`Batch cleanup finished for ${files.length} file(s).`);
  }

  if (invalidatedCount > 0) {
    parts.push(`${invalidatedCount} had digital signatures invalidated.`);
  }

  return parts.join(" ");
}
