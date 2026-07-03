import type {
  DocumentFacts,
  JurisdictionPack,
  PreflightCheck,
  PreflightReport,
  SelectionFacts,
} from "@raiopdf/rules";

export interface FilingOutputPreflightPart {
  bytes: Uint8Array;
  fileName: string;
}

export async function runFilingOutputPreflights(
  parts: readonly FilingOutputPreflightPart[],
  pack: JurisdictionPack,
  readFacts: (part: FilingOutputPreflightPart) => Promise<DocumentFacts>,
  runPreflight: (
    facts: DocumentFacts,
    pack: JurisdictionPack,
    selection?: SelectionFacts,
  ) => PreflightReport,
): Promise<PreflightReport[]> {
  const selectionFacts = buildOutputSelectionFacts(parts);
  const reports: PreflightReport[] = [];

  for (const [index, part] of parts.entries()) {
    reports.push(runPreflight(
      await readFacts(part),
      pack,
      index === 0 ? selectionFacts : undefined,
    ));
  }

  return reports;
}

export function buildOutputSelectionFacts(
  parts: readonly FilingOutputPreflightPart[],
): SelectionFacts {
  return {
    files: parts.map((part) => ({
      filename: part.fileName,
      fileBytes: part.bytes.byteLength,
    })),
  };
}

export function aggregateOutputReports(reports: readonly PreflightReport[]): PreflightReport {
  const [firstReport] = reports;

  if (!firstReport) {
    return { checks: [] };
  }

  const selectionChecks = aggregateSelectionChecks(reports);

  return {
    checks: firstReport.checks.map((firstCheck) => {
      const matchingChecks = reports
        .map((report) => report.checks.find((check) => check.checkId === firstCheck.checkId))
        .filter((check): check is PreflightCheck => Boolean(check));
      const failedChecks = matchingChecks.filter((check) => check.status !== "pass");

      return {
        ...firstCheck,
        status: aggregateStatus(matchingChecks),
        detail: failedChecks.length === 0
          ? `All ${reports.length} output ${reports.length === 1 ? "file passes" : "files pass"}.`
          : failedChecks.map((check, index) => `Part ${index + 1}: ${check.detail}`).join(" "),
      } as PreflightCheck;
    }),
    ...(selectionChecks ? { selectionChecks } : {}),
  };
}

function aggregateSelectionChecks(
  reports: readonly PreflightReport[],
): readonly PreflightCheck[] | undefined {
  const selectionReports = reports
    .map((report) => report.selectionChecks)
    .filter((checks): checks is readonly PreflightCheck[] => Boolean(checks));
  const [firstSelectionReport] = selectionReports;

  if (!firstSelectionReport) {
    return undefined;
  }

  return firstSelectionReport.map((firstCheck) => {
    const matchingChecks = selectionReports
      .map((checks) => checks.find((check) => check.checkId === firstCheck.checkId))
      .filter((check): check is PreflightCheck => Boolean(check));
    const failedChecks = matchingChecks.filter((check) => check.status !== "pass");

    return {
      ...firstCheck,
      status: aggregateStatus(matchingChecks),
      detail: failedChecks.length === 0
        ? "The complete output set passes this selection check."
        : failedChecks.map((check) => check.detail).join(" "),
    } as PreflightCheck;
  });
}

function aggregateStatus(
  checks: readonly PreflightCheck[],
): PreflightCheck["status"] {
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }

  if (checks.some((check) => check.status === "unknown")) {
    return "unknown";
  }

  return "pass";
}
