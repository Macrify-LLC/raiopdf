import type {
  ConstraintEntry,
  ConstraintKind,
  DocumentFacts,
  JurisdictionPack,
  PageFacts,
  PreflightCheck,
  PreflightReport,
  PreflightStatus,
  RectInches,
  SelectionFacts,
} from "./types.js";

const SIZE_TOLERANCE_IN = 0.01;

export function preflight(
  document: DocumentFacts,
  pack: JurisdictionPack,
  selection?: SelectionFacts,
): PreflightReport {
  if (pack.id === "unknown") {
    return {
      checks: pack.constraints.map((constraint) => ({
        checkId: constraint.id,
        label: constraint.label,
        authority: constraint.authority,
        detail: "This check is unknown because the jurisdiction pack failed integrity verification.",
        kind: constraint.kind,
        status: "unknown",
      })),
      ...(selection ? { selectionChecks: buildUnknownSelectionChecks(pack) } : {}),
    };
  }

  return {
    checks: [
      checkPageSizeAndOrientation(document, pack),
      checkSearchableText(document, pack),
      checkFileSize(document, pack),
      checkFilename(document, pack),
      checkClerkStampSpace(document, pack),
      checkPdfA(document, pack),
    ],
    ...(selection ? { selectionChecks: checkSelection(selection, pack) } : {}),
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
  if (pack.ocr.stance === "unknown") {
    return buildCheck(pack, "searchable-text", {
      status: "unknown",
      detail: "This jurisdiction's searchable-text stance is unverified.",
    });
  }

  if (pack.ocr.stance === "accepted" || pack.ocr.stance === "prohibited") {
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
      status: "warn",
      detail: `The document is ${formatBytes(document.fileBytes)}, exceeding the ${formatBytes(pack.maxFileBytes)} portal cap.`,
    });
  }

  if (document.fileBytes > pack.recommendedMaxFileBytes) {
    return buildCheck(pack, "file-size", {
      status: "warn",
      detail: `The document is ${formatBytes(document.fileBytes)}, under the portal cap but above the ${formatBytes(pack.recommendedMaxFileBytes)} mechanical safety margin.`,
    });
  }

  return buildCheck(pack, "file-size", {
    status: "pass",
    detail: `The document is ${formatBytes(document.fileBytes)}, within the ${formatBytes(pack.recommendedMaxFileBytes)} safety margin.`,
  });
}

function checkFilename(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (!pack.filenameMaxChars && !pack.filenameCharset) {
    return buildCheck(pack, "filename", {
      status: "pass",
      detail: "This jurisdiction pack has no filename length or character-set limit.",
    });
  }

  if (!document.filename) {
    return buildCheck(pack, "filename", {
      status: "unknown",
      detail: "No filename fact was provided.",
    });
  }

  const issues = findFilenameIssues(document.filename, pack);

  return buildCheck(pack, "filename", {
    status: issues.length === 0 ? "pass" : "warn",
    detail: issues.length === 0
      ? `The filename "${document.filename}" matches the configured portal filename limits.`
      : issues.join(" "),
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

/**
 * Whether Prepare for Filing should convert output parts to PDF/A for this pack.
 *
 * Conversion depends on both axes in the schema: the court/portal stance must
 * document a benefit, and Raio's prep-default axis must explicitly enable the
 * step for this pack.
 */
export function shouldConvertToPdfA(pack: JurisdictionPack): boolean {
  return pack.pdfa.prepDefault === "on" &&
    (pack.pdfa.stance === "required" || pack.pdfa.stance === "preferred");
}

function checkPdfA(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  const { stance, flavor } = pack.pdfa;

  if (stance === "prohibited") {
    if (document.pdfaCompliant === true) {
      return buildCheck(pack, "pdfa", {
        status: "warn",
        detail: "This portal rejects PDF/A files. Re-export the document as a standard PDF before filing.",
      });
    }

    if (document.pdfaCompliant === undefined) {
      return buildCheck(pack, "pdfa", {
        status: "unknown",
        detail: "This portal rejects PDF/A files and no compliance facts were provided.",
      });
    }

    return buildCheck(pack, "pdfa", {
      status: "pass",
      detail: "This portal rejects PDF/A files; the filing copy is left as a standard PDF.",
    });
  }

  if (stance === "unknown") {
    return buildCheck(pack, "pdfa", {
      status: "unknown",
      detail: "This jurisdiction's PDF/A stance is unverified; no conversion is performed.",
    });
  }

  if (stance === "accepted") {
    return buildCheck(pack, "pdfa", {
      status: "pass",
      detail: "PDF/A is accepted but carries no benefit here; the filing copy is left as a standard PDF.",
    });
  }

  if (document.pdfaCompliant === true) {
    return buildCheck(pack, "pdfa", {
      status: "pass",
      detail: `The document is reported PDF/A compliant for ${stance} flavor ${flavor}.`,
    });
  }

  if (document.pdfaCompliant === undefined) {
    return buildCheck(pack, "pdfa", {
      status: "unknown",
      detail: `PDF/A ${flavor} compliance facts were not provided.`,
    });
  }

  return buildCheck(pack, "pdfa", {
    status: "warn",
    detail: stance === "required"
      ? `PDF/A ${flavor} is required and the document is reported non-compliant.`
      : `PDF/A ${flavor} is preferred by the portal and the document is reported non-compliant.`,
  });
}

function checkSelection(selection: SelectionFacts, pack: JurisdictionPack): readonly PreflightCheck[] {
  return [
    checkEnvelopeSize(selection, pack),
    checkSelectionFilenames(selection, pack),
    checkFilenameCollisions(selection, pack),
  ];
}

function buildUnknownSelectionChecks(pack: JurisdictionPack): readonly PreflightCheck[] {
  return [
    buildCheck(pack, "envelope-size", {
      status: "unknown",
      detail: "This selection check is unknown because the jurisdiction pack failed integrity verification.",
    }),
    buildCheck(pack, "selection-filenames", {
      status: "unknown",
      detail: "This selection check is unknown because the jurisdiction pack failed integrity verification.",
    }),
    buildCheck(pack, "filename-collisions", {
      status: "unknown",
      detail: "This selection check is unknown because the jurisdiction pack failed integrity verification.",
    }),
  ];
}

function checkEnvelopeSize(selection: SelectionFacts, pack: JurisdictionPack): PreflightCheck {
  if (!pack.maxEnvelopeBytes) {
    return buildCheck(pack, "envelope-size", {
      status: "pass",
      detail: "This jurisdiction pack has no configured envelope-size cap.",
    });
  }

  const filesWithoutSizes = selection.files.filter((file) => file.fileBytes === undefined);

  if (filesWithoutSizes.length > 0) {
    return buildCheck(pack, "envelope-size", {
      status: "unknown",
      detail: `No file-size facts were provided for ${filesWithoutSizes.length} selected file(s).`,
    });
  }

  const envelopeBytes = selection.files.reduce((sum, file) => sum + (file.fileBytes ?? 0), 0);

  return buildCheck(pack, "envelope-size", {
    status: envelopeBytes > pack.maxEnvelopeBytes ? "warn" : "pass",
    detail: envelopeBytes > pack.maxEnvelopeBytes
      ? `The selected files total ${formatBytes(envelopeBytes)}, exceeding the ${formatBytes(pack.maxEnvelopeBytes)} envelope cap.`
      : `The selected files total ${formatBytes(envelopeBytes)}, within the ${formatBytes(pack.maxEnvelopeBytes)} envelope cap.`,
  });
}

function checkSelectionFilenames(selection: SelectionFacts, pack: JurisdictionPack): PreflightCheck {
  if (!pack.filenameMaxChars && !pack.filenameCharset) {
    return buildCheck(pack, "selection-filenames", {
      status: "pass",
      detail: "This jurisdiction pack has no filename length or character-set limit.",
    });
  }

  const fileIssues = selection.files
    .map((file) => {
      const issues = findFilenameIssues(file.filename, pack);
      return issues.length === 0 ? null : `${file.filename}: ${issues.join(" ")}`;
    })
    .filter((issue): issue is string => issue !== null);

  return buildCheck(pack, "selection-filenames", {
    status: fileIssues.length === 0 ? "pass" : "warn",
    detail: fileIssues.length === 0
      ? `All ${selection.files.length} selected filename(s) match the configured portal filename limits.`
      : fileIssues.join(" "),
  });
}

function checkFilenameCollisions(selection: SelectionFacts, pack: JurisdictionPack): PreflightCheck {
  const seen = new Map<string, string[]>();

  for (const file of selection.files) {
    const normalized = file.filename.toLocaleLowerCase();
    const filenames = seen.get(normalized) ?? [];
    filenames.push(file.filename);
    seen.set(normalized, filenames);
  }

  const collisions = [...seen.values()].filter((filenames) => filenames.length > 1);

  return buildCheck(pack, "filename-collisions", {
    status: collisions.length === 0 ? "pass" : "warn",
    detail: collisions.length === 0
      ? `No filename collisions were found across ${selection.files.length} selected file(s).`
      : `Duplicate filenames in the selected set: ${collisions.map((files) => files.join(", ")).join("; ")}.`,
  });
}

function findFilenameIssues(filename: string, pack: JurisdictionPack): string[] {
  const issues: string[] = [];
  const portalFilename = filename.replace(/\.pdf$/i, "");

  if (pack.filenameMaxChars && [...portalFilename].length > pack.filenameMaxChars) {
    issues.push(`The portal filename is ${[...portalFilename].length} characters, exceeding the ${pack.filenameMaxChars}-character portal limit.`);
  }

  if (pack.filenameCharset) {
    let charset: RegExp;

    try {
      charset = new RegExp(pack.filenameCharset, "u");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`The configured filename character rule is invalid: ${message}.`);
      return issues;
    }

    if (!charset.test(portalFilename)) {
      issues.push("The filename contains characters outside the configured portal character set.");
    }
  }

  return issues;
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
  result: { status: PreflightStatus; detail: string; kind?: ConstraintKind },
): PreflightCheck {
  const constraint = findConstraint(pack, checkId, result.kind);

  return {
    checkId,
    label: constraint.label,
    authority: constraint.authority,
    detail: result.detail,
    kind: constraint.kind,
    status: result.status,
  };
}

function findConstraint(
  pack: JurisdictionPack,
  checkId: string,
  fallbackKind: ConstraintKind = "rule",
): ConstraintEntry {
  const constraint = pack.constraints.find((entry) => entry.id === checkId);

  if (constraint) {
    return constraint;
  }

  return {
    id: checkId,
    label: checkId,
    kind: fallbackKind,
    authority: "Unspecified",
    lastVerified: "1970-01-01",
    applicability: { scope: "statewide" },
  };
}

function formatPageNumbers(pages: readonly PageFacts[]): string {
  return pages.map((page) => page.pageIndex + 1).join(", ");
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
