import type {
  ConstraintEntry,
  ConstraintKind,
  DocumentFacts,
  JurisdictionPack,
  PageFacts,
  PreflightCheck,
  PreflightReport,
  PreflightStatus,
  PortalPreflightCheck,
  PortalPreflightStatus,
  RectInches,
  RulePreflightCheck,
  RulePreflightStatus,
} from "./types";

const SIZE_TOLERANCE_IN = 0.01;

export function preflight(document: DocumentFacts, pack: JurisdictionPack): PreflightReport {
  return {
    checks: [
      checkPageSizeAndOrientation(document, pack),
      checkSearchableText(document, pack),
      checkFileSize(document, pack),
      checkClerkStampSpace(document, pack),
      checkPdfA(document, pack),
    ],
  };
}

function checkPageSizeAndOrientation(
  document: DocumentFacts,
  pack: JurisdictionPack,
): PreflightCheck {
  const mismatchedPages = document.pages.filter((page) => {
    return (
      !sameSize(page.size, pack.pageSize) ||
      page.orientation !== pack.orientation
    );
  });

  if (document.pages.length === 0) {
    return buildCheck(pack, "page-size-orientation", {
      status: "unknown",
      detail: "No page facts were provided for page-size and orientation validation.",
    });
  }

  return buildCheck(pack, "page-size-orientation", {
    status: mismatchedPages.length === 0 ? "pass" : "warn",
    detail: mismatchedPages.length === 0
      ? `All ${document.pages.length} pages are ${pack.pageSize.w} x ${pack.pageSize.h} in ${pack.orientation}.`
      : `Pages ${formatPageNumbers(mismatchedPages)} are not ${pack.pageSize.w} x ${pack.pageSize.h} in ${pack.orientation}.`,
  });
}

function checkSearchableText(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (!pack.searchableTextRequired) {
    return buildCheck(pack, "searchable-text", {
      status: "pass",
      detail: "Searchable text is not required for this jurisdiction pack.",
    });
  }

  if (document.searchableText === undefined) {
    return buildCheck(pack, "searchable-text", {
      status: "unknown",
      detail: "No searchable-text facts were provided.",
    });
  }

  return buildCheck(pack, "searchable-text", {
    status: document.searchableText ? "pass" : "warn",
    detail: document.searchableText
      ? "The document has searchable text."
      : "The document facts report no searchable text.",
  });
}

function checkFileSize(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (document.fileBytes === undefined) {
    return buildCheck(pack, "file-size", {
      status: "unknown",
      detail: "No file-size facts were provided.",
    });
  }

  if (document.fileBytes > pack.maxFileBytes) {
    return buildCheck(pack, "file-size", {
      status: "fix",
      detail: `The document is ${formatBytes(document.fileBytes)}, exceeding the ${formatBytes(pack.maxFileBytes)} portal cap.`,
    });
  }

  if (document.fileBytes > pack.recommendedMaxFileBytes) {
    return buildCheck(pack, "file-size", {
      status: "fix",
      detail: `The document is ${formatBytes(document.fileBytes)}, under the portal cap but above the ${formatBytes(pack.recommendedMaxFileBytes)} mechanical safety margin.`,
    });
  }

  return buildCheck(pack, "file-size", {
    status: "pass",
    detail: `The document is ${formatBytes(document.fileBytes)}, within the ${formatBytes(pack.recommendedMaxFileBytes)} safety margin.`,
  });
}

function checkClerkStampSpace(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (document.clerkStampSpaceBlank !== undefined) {
    return buildCheck(pack, "clerk-stamp-space", {
      status: document.clerkStampSpaceBlank ? "pass" : "warn",
      detail: document.clerkStampSpaceBlank
        ? "The first-page clerk stamp space is reported blank."
        : "The first-page clerk stamp space is reported occupied.",
    });
  }

  const firstPage = document.pages[0];

  if (!firstPage) {
    return buildCheck(pack, "clerk-stamp-space", {
      status: "unknown",
      detail: "The document has no first page to reserve clerk stamp space.",
    });
  }

  if (!firstPage.occupiedRegions) {
    return buildCheck(pack, "clerk-stamp-space", {
      status: "unknown",
      detail: "No first-page occupancy facts were provided for geometric stamp-space validation.",
    });
  }

  const requiredSpace = pack.clerkStampSpace.firstPage;
  const overlaps = firstPage.occupiedRegions.some((region) => intersects(region, requiredSpace));

  return buildCheck(pack, "clerk-stamp-space", {
    status: overlaps ? "warn" : "pass",
    detail: overlaps
      ? "Text or image facts overlap the required first-page top-right 3 x 3 in clerk stamp space."
      : "No text or image facts overlap the required first-page top-right 3 x 3 in clerk stamp space.",
  });
}

function checkPdfA(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (document.pdfaCompliant === true) {
    return buildCheck(pack, "pdfa", {
      status: "pass",
      detail: `The document is reported PDF/A compliant for preferred flavor ${pack.pdfa.flavor}.`,
    });
  }

  if (document.pdfaCompliant === undefined) {
    return buildCheck(pack, "pdfa", {
      status: "unknown",
      detail: `PDF/A ${pack.pdfa.flavor} compliance facts were not provided.`,
    });
  }

  if (pack.pdfa.required || pack.pdfa.preferred) {
    return buildCheck(pack, "pdfa", {
      status: "fix",
      detail: pack.pdfa.required
        ? `PDF/A ${pack.pdfa.flavor} is required and the document is reported non-compliant.`
        : `PDF/A ${pack.pdfa.flavor} is preferred by the portal and the document is reported non-compliant.`,
    });
  }

  return buildCheck(pack, "pdfa", {
    status: "pass",
    detail: "PDF/A is not required or preferred for this jurisdiction pack.",
  });
}

function sameSize(actual: PageFacts["size"], expected: JurisdictionPack["pageSize"]): boolean {
  return (
    Math.abs(actual.w - expected.w) <= SIZE_TOLERANCE_IN &&
    Math.abs(actual.h - expected.h) <= SIZE_TOLERANCE_IN &&
    actual.in === expected.in
  );
}

function intersects(a: RectInches, b: RectInches): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function buildCheck(
  pack: JurisdictionPack,
  checkId: string,
  result: { status: PreflightStatus; detail: string },
): PreflightCheck {
  const constraint = findConstraint(pack, checkId);

  const base = {
    checkId,
    label: constraint.label,
    authority: constraint.authority,
    detail: result.detail,
  };

  if (constraint.kind === "rule") {
    return {
      ...base,
      kind: "rule",
      status: toRuleStatus(result.status),
    } satisfies RulePreflightCheck;
  }

  return {
    ...base,
    kind: "portal",
    status: toPortalStatus(result.status),
  } satisfies PortalPreflightCheck;
}

function findConstraint(pack: JurisdictionPack, checkId: string): ConstraintEntry {
  const constraint = pack.constraints.find((entry) => entry.id === checkId);

  if (constraint) {
    return constraint;
  }

  return {
    id: checkId,
    label: checkId,
    kind: "rule" satisfies ConstraintKind,
    authority: "Unspecified",
    lastVerified: "1970-01-01",
    applicability: { scope: "statewide" },
  };
}

function toRuleStatus(status: PreflightStatus): RulePreflightStatus {
  return status === "fix" ? "warn" : status;
}

function toPortalStatus(status: PreflightStatus): PortalPreflightStatus {
  return status === "warn" ? "fix" : status;
}

function formatPageNumbers(pages: readonly PageFacts[]): string {
  return pages.map((page) => page.pageIndex + 1).join(", ");
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
