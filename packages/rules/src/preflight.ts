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
        detail: "RaioPDF couldn't verify its rule set for this court, so this check was skipped. Reinstall or update RaioPDF.",
        kind: constraint.kind,
        status: "unknown",
      })),
      ...(selection ? { selectionChecks: buildUnknownSelectionChecks(pack) } : {}),
    };
  }

  return {
    checks: buildDocumentChecks(document, pack),
    ...(selection ? { selectionChecks: checkSelection(selection, pack) } : {}),
  };
}

function buildDocumentChecks(
  document: DocumentFacts,
  pack: JurisdictionPack,
): readonly PreflightCheck[] {
  return [
    hasConstraint(pack, "page-size-orientation") ? checkPageSizeAndOrientation(document, pack) : null,
    hasConstraint(pack, "searchable-text") ? checkSearchableText(document, pack) : null,
    hasConstraint(pack, "file-size") ? checkFileSize(document, pack) : null,
    hasConstraint(pack, "filename") ? checkFilename(document, pack) : null,
    hasConstraint(pack, "clerk-stamp-space") ? checkClerkStampSpace(document, pack) : null,
    hasConstraint(pack, "pdfa") ? checkPdfA(document, pack) : null,
    hasConstraint(pack, "active-content") ? checkActiveContent(document, pack) : null,
    hasConstraint(pack, "encryption") ? checkEncryption(document, pack) : null,
    hasConstraint(pack, "embedded-files") ? checkEmbeddedFiles(document, pack) : null,
    hasConstraint(pack, "metadata-scrub") ? checkMetadataScrub(document, pack) : null,
    hasConstraint(pack, "flatten-forms") ? checkFlattenForms(document, pack) : null,
    ...pack.constraints
      .filter((constraint) => constraint.check?.type === "required-phrase")
      .map((constraint) => checkRequiredPhrase(document, pack, constraint)),
  ].filter((check): check is PreflightCheck => check !== null);
}

function checkRequiredPhrase(
  document: DocumentFacts,
  pack: JurisdictionPack,
  constraint: ConstraintEntry,
): PreflightCheck | null {
  const check = constraint.check;
  if (check?.type !== "required-phrase") {
    return null;
  }

  if (!requiredPhraseApplies(document, check.appliesWhen)) {
    return null;
  }

  if (!hasSearchableTextForPhraseCheck(document)) {
    return buildCheck(pack, constraint.id, {
      status: "unknown",
      detail: check.noTextDetail,
      kind: constraint.kind,
      authority: constraint.authority,
      label: constraint.label,
    });
  }

  const haystack = normalizeSearchText(document.pageTextByPage?.map((page) => page.text).join("\n") ?? "");
  const found = check.phrasesAny.some((phrase) => haystack.includes(normalizeSearchText(phrase)));

  return buildCheck(pack, constraint.id, {
    status: found ? "pass" : "warn",
    detail: found ? check.passDetail ?? "Required phrase found." : check.missingDetail,
    kind: constraint.kind,
    authority: constraint.authority,
    label: constraint.label,
  });
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
      detail: "RaioPDF couldn't read this document's pages, so it couldn't check page size and orientation.",
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
      detail: "RaioPDF doesn't have a confirmed rule for this court on searchable text, so it can't check it. Confirm the court's requirement yourself.",
    });
  }

  if (pack.ocr.stance === "accepted" || pack.ocr.stance === "prohibited") {
    return buildCheck(pack, "searchable-text", {
      status: "pass",
      detail: "Searchable text is not required by this court's rules.",
    });
  }

  if (document.searchableText === undefined) {
    return buildCheck(pack, "searchable-text", {
      status: "unknown",
      detail: "RaioPDF couldn't tell whether this document has searchable text.",
    });
  }

  return buildCheck(pack, "searchable-text", {
    status: document.searchableText ? "pass" : "warn",
    detail: document.searchableText
      ? "The document has searchable text."
      : searchableTextWarningDetail(document),
  });
}

function searchableTextWarningDetail(document: DocumentFacts): string {
  const garbledPages = document.textLayerCoverage?.garbledPages.length ?? 0;
  const trivialTextImagePages = document.textLayerCoverage?.trivialTextImagePages?.length ?? 0;
  const totalPages = document.textLayerCoverage
    ? document.textLayerCoverage.imageOnlyPages.length +
      document.textLayerCoverage.mixedPages.length +
      document.textLayerCoverage.textPages.length
    : document.pages.length;

  if (garbledPages > 0) {
    const totalText = totalPages > 0 ? ` on ${garbledPages} of ${totalPages} pages` : "";
    return `The document's hidden searchable text looks garbled${totalText}; running Make Searchable again is recommended.`;
  }

  if (trivialTextImagePages > 0) {
    const totalText = totalPages > 0 ? ` on ${trivialTextImagePages} of ${totalPages} pages` : "";
    return `The document has only a thin layer of searchable text over scanned page images${totalText}; running Make Searchable again is recommended.`;
  }

  return "No searchable text was found in this document.";
}

function checkFileSize(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  const maxFileBytes = pack.maxFileBytes;
  const recommendedMaxFileBytes = pack.recommendedMaxFileBytes;

  if (document.fileBytes === undefined) {
    return buildCheck(pack, "file-size", {
      status: "unknown",
      detail: "RaioPDF couldn't read this document's file size.",
    });
  }

  if (pack.maxFileBytes === undefined && pack.userConfigurable?.maxFileBytes === true) {
    return buildCheck(pack, "file-size", {
      status: "unknown",
      detail: `The document is ${formatBytes(document.fileBytes)}. Set this court's file-size cap before RaioPDF can evaluate this check.`,
    });
  }

  if (maxFileBytes !== undefined && document.fileBytes > maxFileBytes) {
    return buildCheck(pack, "file-size", {
      status: "warn",
      detail: `The document is ${formatBytes(document.fileBytes)}, exceeding the ${formatBytes(maxFileBytes)} portal cap.`,
    });
  }

  if (recommendedMaxFileBytes !== undefined && document.fileBytes > recommendedMaxFileBytes) {
    const authority = findConstraint(pack, "file-size").authority;

    return buildCheck(pack, "file-size", {
      status: "warn",
      detail: maxFileBytes === undefined
        ? `The document is ${formatBytes(document.fileBytes)}, above the ${authority} recommended limit of ${formatBytes(recommendedMaxFileBytes)}.`
        : `The document is ${formatBytes(document.fileBytes)}, under the portal cap but above the ${formatBytes(recommendedMaxFileBytes)} recommended limit.`,
    });
  }

  if (recommendedMaxFileBytes === undefined && maxFileBytes === undefined) {
    return buildCheck(pack, "file-size", {
      status: "unknown",
      detail: "RaioPDF has no file-size rule on record for this court.",
    });
  }

  if (recommendedMaxFileBytes === undefined) {
    const hardMaxFileBytes = maxFileBytes;

    if (hardMaxFileBytes === undefined) {
      return buildCheck(pack, "file-size", {
        status: "unknown",
        detail: "RaioPDF has no file-size rule on record for this court.",
      });
    }

    return buildCheck(pack, "file-size", {
      status: "pass",
      detail: `The document is ${formatBytes(document.fileBytes)}, within the ${formatBytes(hardMaxFileBytes)} portal cap.`,
    });
  }

  return buildCheck(pack, "file-size", {
    status: "pass",
    detail: `The document is ${formatBytes(document.fileBytes)}, within the ${formatBytes(recommendedMaxFileBytes)} recommended limit.`,
  });
}

function checkFilename(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (!pack.filenameMaxChars && !pack.filenameCharset) {
    return buildCheck(pack, "filename", {
      status: "pass",
      detail: "RaioPDF has no filename rule on record for this court.",
    });
  }

  if (!document.filename) {
    return buildCheck(pack, "filename", {
      status: "unknown",
      detail: "RaioPDF couldn't read this document's filename.",
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
        ? "The clerk's stamp area on the first page is clear."
        : "The clerk's stamp area on the first page has content in it. Clear that corner before filing.",
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
      detail: "RaioPDF couldn't check whether the clerk's stamp area on the first page is clear.",
    });
  }

  const requiredSpace = pack.clerkStampSpace.firstPage;
  const overlaps = firstPage.occupiedRegions.some((region) => intersects(region, requiredSpace));

  return buildCheck(pack, "clerk-stamp-space", {
    status: overlaps ? "warn" : "pass",
    detail: overlaps
      ? "Content on the first page reaches into the top-right 3x3-inch area the clerk reserves for its stamp. Clear that corner before filing."
      : "The top-right 3x3-inch area the clerk reserves for its stamp is clear on the first page.",
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
  const pdfaClaimed = document.pdfaClaimed ?? false;
  const pdfaValidated = document.pdfaCompliant;

  if (stance === "prohibited") {
    if (pdfaValidated === true) {
      return buildCheck(pack, "pdfa", {
        status: "warn",
        detail: "This portal rejects validated PDF/A files. Re-export the document as a standard PDF before filing.",
      });
    }

    if (pdfaClaimed) {
      return buildCheck(pack, "pdfa", {
        status: "warn",
        detail: "This portal rejects PDF/A files and the document claims PDF/A in its metadata. Re-export the document as a standard PDF before filing.",
      });
    }

    if (document.pdfaClaimed !== false) {
      return buildCheck(pack, "pdfa", {
        status: "unknown",
        detail: "This portal rejects PDF/A files and no PDF/A claim or validation facts were provided.",
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
      detail: "RaioPDF doesn't have a confirmed PDF/A rule for this court, so it can't check it and performs no conversion. Confirm the court's requirement yourself.",
    });
  }

  if (stance === "accepted") {
    return buildCheck(pack, "pdfa", {
      status: "pass",
      detail: pdfaValidated === true
        ? "PDF/A is accepted but carries no benefit here; the validated PDF/A filing copy is left unchanged."
        : pdfaClaimed
          ? "PDF/A is accepted but carries no benefit here; the PDF/A-claimed filing copy is left unchanged."
          : "PDF/A is accepted but carries no benefit here; the filing copy is left as a standard PDF.",
    });
  }

  if (pdfaValidated === true) {
    return buildCheck(pack, "pdfa", {
      status: "pass",
      detail: `The document has been validated as PDF/A compliant for the ${stance} archival format (${flavor}).`,
    });
  }

  if (pdfaValidated === undefined) {
    if (pdfaClaimed) {
      return buildCheck(pack, "pdfa", {
        status: "unknown",
        detail: `The document claims PDF/A in its metadata, but PDF/A archival format (${flavor}) compliance has not been independently validated.`,
      });
    }

    return buildCheck(pack, "pdfa", {
      status: "unknown",
      detail: `PDF/A archival format (${flavor}) compliance facts were not provided.`,
    });
  }

  return buildCheck(pack, "pdfa", {
    status: "warn",
    detail: stance === "required"
      ? `PDF/A archival format (${flavor}) is required and the document failed PDF/A validation.`
      : `PDF/A archival format (${flavor}) is preferred by the portal and the document failed PDF/A validation.`,
  });
}

function checkActiveContent(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (pack.activeContent.stance === "unknown") {
    return buildCheck(pack, "active-content", {
      status: "unknown",
      detail: "RaioPDF doesn't have a confirmed rule for this court on active content, so it can't check it. Confirm the court's requirement yourself.",
      authority: pack.activeContent.authority,
      label: "Active content",
      kind: "portal",
    });
  }

  if (hasFactError(document, "activeContentSignals") || !document.activeContentSignals) {
    return buildCheck(pack, "active-content", {
      status: "unknown",
      detail: "RaioPDF couldn't check this document for active content. Review it before filing.",
      authority: pack.activeContent.authority,
      label: "Active content",
      kind: "portal",
    });
  }

  const signals = document.activeContentSignals.signals.join(", ");
  const prohibited = pack.activeContent.stance === "prohibited";
  return buildCheck(pack, "active-content", {
    status: prohibited && document.activeContentSignals.possiblyPresent ? "warn" : "pass",
    detail: document.activeContentSignals.possiblyPresent
      ? `This document contains active content (such as scripts or embedded actions): ${signals}. Many portals reject it — remove it before filing.`
      : "No active content (scripts or embedded actions) was found.",
    authority: pack.activeContent.authority,
    label: "Active content",
    kind: "portal",
  });
}

function checkEncryption(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (pack.encryption.stance === "unknown") {
    return buildCheck(pack, "encryption", {
      status: "unknown",
      detail: "RaioPDF doesn't have a confirmed rule for this court on password protection or access restrictions, so it can't check it. Confirm the court's requirement yourself.",
      authority: pack.encryption.authority,
      label: "Encryption and restrictions",
      kind: "portal",
    });
  }

  if (document.encryptionState === undefined || document.encryptionState === "detector_failed") {
    return buildCheck(pack, "encryption", {
      status: "unknown",
      detail: "RaioPDF couldn't check whether this document is password-protected. Review it before filing.",
      authority: pack.encryption.authority,
      label: "Encryption and restrictions",
      kind: "portal",
    });
  }

  const hasRestriction = document.encryptionState === "encrypted" ||
    document.encryptionState === "usage_restricted";
  return buildCheck(pack, "encryption", {
    status: pack.encryption.stance === "prohibited" && hasRestriction ? "warn" : "pass",
    detail: hasRestriction
      ? document.encryptionState === "encrypted"
        ? "This document is password-protected."
        : "This document restricts copying or editing."
      : "This document is not password-protected or access-restricted.",
    authority: pack.encryption.authority,
    label: "Encryption and restrictions",
    kind: "portal",
  });
}

function checkEmbeddedFiles(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (pack.embeddedFiles.stance === "unknown") {
    return buildCheck(pack, "embedded-files", {
      status: "unknown",
      detail: "RaioPDF doesn't have a confirmed rule for this court on attached or embedded files, so it can't check it. Confirm the court's requirement yourself.",
      authority: pack.embeddedFiles.authority,
      label: "Embedded files",
      kind: "portal",
    });
  }

  if (hasFactError(document, "embeddedFileCount") || document.embeddedFileCount === undefined) {
    return buildCheck(pack, "embedded-files", {
      status: "unknown",
      detail: "RaioPDF couldn't check this document for attached or embedded files. Review it before filing.",
      authority: pack.embeddedFiles.authority,
      label: "Embedded files",
      kind: "portal",
    });
  }

  return buildCheck(pack, "embedded-files", {
    status: pack.embeddedFiles.stance === "prohibited" && document.embeddedFileCount > 0 ? "warn" : "pass",
    detail: document.embeddedFileCount > 0
      ? `This document has ${document.embeddedFileCount} attached or embedded file(s).`
      : "No attached or embedded files were found in this document.",
    authority: pack.embeddedFiles.authority,
    label: "Embedded files",
    kind: "portal",
  });
}

function checkMetadataScrub(_document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  return buildCheck(pack, "metadata-scrub", {
    status: "unknown",
    detail: pack.metadataScrub.stance === "unknown"
      ? "RaioPDF doesn't have a confirmed rule for this court on metadata scrubbing, so it can't check it. Confirm the court's requirement yourself."
      : "RaioPDF can't confirm whether hidden metadata was fully removed. Check it manually before filing.",
    authority: pack.metadataScrub.authority,
    label: "Metadata scrub",
    kind: "portal",
  });
}

function checkFlattenForms(document: DocumentFacts, pack: JurisdictionPack): PreflightCheck {
  if (pack.flattenForms.stance === "unknown") {
    return buildCheck(pack, "flatten-forms", {
      status: "unknown",
      detail: "RaioPDF doesn't have a confirmed rule for this court on locking form fields, so it can't check it. Confirm the court's requirement yourself.",
      authority: pack.flattenForms.authority,
      label: "Lock fillable form fields",
      kind: "portal",
    });
  }

  if (hasFactError(document, "formFields") || !document.formFields) {
    return buildCheck(pack, "flatten-forms", {
      status: "unknown",
      detail: "RaioPDF couldn't check this document for fillable form fields. Review it before filing.",
      authority: pack.flattenForms.authority,
      label: "Lock fillable form fields",
      kind: "portal",
    });
  }

  const hasFields = document.formFields.count > 0;
  return buildCheck(pack, "flatten-forms", {
    status: pack.flattenForms.stance === "prohibited" && hasFields ? "warn" : "pass",
    detail: hasFields
      ? `This document has ${document.formFields.count} fillable form field(s)${document.formFields.anyFilled ? ", some already filled in" : ""}.`
      : "No fillable form fields were found in this document.",
    authority: pack.flattenForms.authority,
    label: "Lock fillable form fields",
    kind: "portal",
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
      detail: "RaioPDF couldn't verify its rule set for this court, so this check was skipped. Reinstall or update RaioPDF.",
    }),
    buildCheck(pack, "selection-filenames", {
      status: "unknown",
      detail: "RaioPDF couldn't verify its rule set for this court, so this check was skipped. Reinstall or update RaioPDF.",
    }),
    buildCheck(pack, "filename-collisions", {
      status: "unknown",
      detail: "RaioPDF couldn't verify its rule set for this court, so this check was skipped. Reinstall or update RaioPDF.",
    }),
  ];
}

function checkEnvelopeSize(selection: SelectionFacts, pack: JurisdictionPack): PreflightCheck {
  if (!pack.maxEnvelopeBytes) {
    return buildCheck(pack, "envelope-size", {
      status: "pass",
      detail: "RaioPDF has no combined upload-size limit on record for this court.",
    });
  }

  const filesWithoutSizes = selection.envelopeBytes === undefined
    ? selection.files.filter((file) => file.fileBytes === undefined)
    : [];

  if (filesWithoutSizes.length > 0) {
    return buildCheck(pack, "envelope-size", {
      status: "unknown",
      detail: `RaioPDF couldn't read the file size of ${filesWithoutSizes.length} selected file(s).`,
    });
  }

  const envelopeBytes = selection.envelopeBytes ??
    selection.files.reduce((sum, file) => sum + (file.fileBytes ?? 0), 0);

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
      detail: "RaioPDF has no filename rule on record for this court.",
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

  if (pack.filenameMaxChars && [...filename].length > pack.filenameMaxChars) {
    issues.push(`The portal filename is ${[...filename].length} characters, exceeding the ${pack.filenameMaxChars}-character portal limit.`);
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

    if (!charset.test(filename)) {
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
  result: {
    status: PreflightStatus;
    detail: string;
    kind?: ConstraintKind;
    authority?: string | undefined;
    label?: string | undefined;
  },
): PreflightCheck {
  const constraint = findConstraint(pack, checkId, result.kind);

  return {
    checkId,
    label: result.label ?? constraint.label,
    authority: result.authority ?? constraint.authority,
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

function hasConstraint(pack: JurisdictionPack, checkId: string): boolean {
  return pack.constraints.some((entry) => entry.id === checkId);
}

function requiredPhraseApplies(
  document: DocumentFacts,
  appliesWhen: NonNullable<ConstraintEntry["check"]>["appliesWhen"],
): boolean {
  const filename = normalizeSearchText(document.filename ?? "");
  if (appliesWhen.filenameIncludesAny?.some((needle) => filename.includes(normalizeSearchText(needle)))) {
    return true;
  }

  const firstPageText = document.pageTextByPage?.find((page) => page.pageIndex === 0)?.text ?? "";
  const headingLines = firstPageText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(isHeadingLine)
    .slice(0, 12);

  return headingLines.some((line) => {
    const normalized = normalizeSearchText(line);
    return appliesWhen.firstPageHeadingIncludesAny?.some((needle) =>
      normalized.includes(normalizeSearchText(needle))
    ) ?? false;
  });
}

function hasSearchableTextForPhraseCheck(document: DocumentFacts): boolean {
  if (
    (document.textLayerCoverage?.garbledPages.length ?? 0) > 0 ||
    (document.textLayerCoverage?.trivialTextImagePages?.length ?? 0) > 0
  ) {
    return false;
  }

  if (document.searchableText === false && document.textLayerCoverage?.garbledPages.length) {
    return false;
  }

  const hasExtractedText = document.pageTextByPage?.some((page) => page.text.trim().length > 0) ?? false;
  if (!hasExtractedText) {
    return false;
  }

  const effectivelyImageOnlyPages =
    (document.textLayerCoverage?.imageOnlyPages.length ?? 0) +
    (document.textLayerCoverage?.trivialTextImagePages?.length ?? 0);
  if (effectivelyImageOnlyPages === document.pages.length && document.pages.length > 0) {
    return false;
  }

  return true;
}

function isHeadingLine(line: string): boolean {
  if (line.length > 120) {
    return false;
  }

  const letters = line.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) {
    return false;
  }

  const upperLetters = letters.filter((letter) => letter === letter.toLocaleUpperCase()).length;
  if (upperLetters / letters.length >= 0.7) {
    return true;
  }

  const words = line.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) {
    return false;
  }

  const titleCaseWords = words.filter((word) => {
    const firstLetter = word.match(/\p{L}/u)?.[0];
    return firstLetter !== undefined && firstLetter === firstLetter.toLocaleUpperCase();
  });

  return titleCaseWords.length / words.length >= 0.6;
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function formatPageNumbers(pages: readonly PageFacts[]): string {
  return pages.map((page) => page.pageIndex + 1).join(", ");
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function hasFactError(document: DocumentFacts, fact: NonNullable<DocumentFacts["errors"]>[number]["fact"]): boolean {
  return document.errors?.some((error) => error.fact === fact) ?? false;
}
