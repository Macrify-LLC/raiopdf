import type {
  ConstraintEntry,
  ConstraintStance,
  DocumentFacts,
  JurisdictionPack,
  PolicyConstraint,
  PrepPlanStance,
  PrepPlanStep,
} from "./types.js";

type PolicyBackedStep = {
  id: PrepPlanStep["id"];
  label: string;
  policy: PolicyConstraint;
  destructive?: boolean;
  disabledWhenProhibited?: boolean;
  impact: (facts: DocumentFacts) => string;
};

const UNKNOWN_LAST_VERIFIED = "1970-01-01";

export function resolvePrepPlan(
  pack: JurisdictionPack,
  facts: DocumentFacts,
): readonly PrepPlanStep[] {
  return [
    policyStep({
      id: "remove-encryption",
      label: "Remove encryption",
      policy: pack.encryption,
      impact: encryptionImpact,
    }, facts),
    normalizeStep(pack),
    sanitizeStep(pack, facts),
    policyStep({
      id: "scrub-metadata",
      label: "Scrub metadata",
      policy: pack.metadataScrub,
      impact: () => "Document metadata will be removed where Raio can safely remove it.",
    }, facts),
    policyStep({
      id: "make-searchable",
      label: "Make searchable",
      policy: pack.ocr,
      impact: searchableImpact,
    }, facts),
    policyStep({
      id: "flatten-forms",
      label: "Flatten forms",
      policy: pack.flattenForms,
      destructive: true,
      disabledWhenProhibited: true,
      impact: formImpact,
    }, facts),
    policyStep({
      id: "convert-pdfa",
      label: `Convert to ${pack.pdfa.flavor.toUpperCase()}`,
      policy: pack.pdfa,
      destructive: true,
      disabledWhenProhibited: true,
      impact: conversionImpact,
    }, facts),
    splitStep(pack),
  ];
}

function policyStep(input: PolicyBackedStep, facts: DocumentFacts): PrepPlanStep {
  const disabledReason = input.disabledWhenProhibited && input.policy.stance === "prohibited"
    ? "This pack marks this output property as prohibited."
    : undefined;

  return {
    id: input.id,
    label: input.label,
    stance: input.policy.stance,
    ...(input.policy.condition ? { condition: input.policy.condition } : {}),
    authority: input.policy.authority ?? "Unspecified",
    lastVerified: input.policy.lastVerified ?? UNKNOWN_LAST_VERIFIED,
    ...(input.policy.note ? { note: input.policy.note } : {}),
    prepDefault: input.policy.prepDefault,
    defaultChecked: input.policy.prepDefault === "on" && !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
    destructive: input.destructive === true,
    impact: input.impact(facts),
  };
}

function normalizeStep(pack: JurisdictionPack): PrepPlanStep {
  const constraint = findConstraint(pack, "page-size-orientation");

  return {
    id: "normalize-pages",
    label: "Normalize pages",
    stance: "standard",
    condition: `${pack.pageSize.w} x ${pack.pageSize.h} in ${pack.orientation}`,
    authority: constraint.authority,
    lastVerified: constraint.lastVerified,
    prepDefault: "on",
    defaultChecked: true,
    destructive: false,
    impact: "Pages will be rendered onto the pack's filing page size and orientation.",
  };
}

function sanitizeStep(pack: JurisdictionPack, facts: DocumentFacts): PrepPlanStep {
  const policies = [pack.activeContent, pack.embeddedFiles];
  const stance = strongestStance(policies.map((policy) => policy.stance));
  const defaultOn = policies.some((policy) => policy.prepDefault === "on");
  const authority = joinUnique(policies.map((policy) => policy.authority).filter(isString));
  const lastVerified = policies
    .map((policy) => policy.lastVerified)
    .filter(isString)
    .sort()[0] ?? UNKNOWN_LAST_VERIFIED;
  const conditions = joinUnique(policies.map((policy) => policy.condition).filter(isString));
  const notes = joinUnique(policies.map((policy) => policy.note).filter(isString));

  return {
    id: "sanitize-content",
    label: "Sanitize active and embedded content",
    stance,
    ...(conditions ? { condition: conditions } : {}),
    authority: authority || "Unspecified",
    lastVerified,
    ...(notes ? { note: notes } : {}),
    prepDefault: defaultOn ? "on" : "off",
    defaultChecked: defaultOn,
    destructive: false,
    impact: sanitizeImpact(facts),
  };
}

function splitStep(pack: JurisdictionPack): PrepPlanStep {
  const constraint = findConstraint(pack, "file-size");
  const hasConfiguredCap = pack.maxFileBytes !== undefined || pack.recommendedMaxFileBytes !== undefined;
  const needsProfile = pack.userConfigurable?.maxFileBytes === true && pack.maxFileBytes === undefined;

  return {
    id: "split-by-size",
    label: "Split by upload cap",
    stance: hasConfiguredCap ? "standard" : "unknown",
    authority: constraint.authority,
    lastVerified: constraint.lastVerified,
    ...(needsProfile
      ? { condition: "set this court's cap before Raio can evaluate size" }
      : {}),
    prepDefault: hasConfiguredCap ? "on" : "off",
    defaultChecked: hasConfiguredCap,
    destructive: false,
    impact: hasConfiguredCap
      ? `Output parts will use the pack's ${formatBytes(pack.recommendedMaxFileBytes ?? pack.maxFileBytes!)} default cap unless you override it for this run.`
      : "No numeric file-size cap is configured yet.",
  };
}

function encryptionImpact(facts: DocumentFacts): string {
  if (facts.encryptionState === "encrypted" || facts.encryptionState === "usage_restricted") {
    return "Encrypted or access-restricted input detected - Raio will ask for the password before preparing this file.";
  }

  if (facts.encryptionState === "none") {
    return "No encryption detected.";
  }

  if (facts.encryptionState === "detector_failed") {
    return "Raio could not verify encryption state; encrypted input will be reported as a warning if it cannot be opened.";
  }

  return "Raio cannot compute encryption state until the encrypted-file fact extractor lands.";
}

function sanitizeImpact(facts: DocumentFacts): string {
  const lines: string[] = [];

  if (facts.activeContentSignals !== undefined) {
    const signalCount = facts.activeContentSignals.signals.length;
    lines.push(`${signalCount} active-content signal${signalCount === 1 ? "" : "s"}`);
  }

  if (facts.embeddedFileCount !== undefined) {
    lines.push(`${facts.embeddedFileCount} embedded file${facts.embeddedFileCount === 1 ? "" : "s"}`);
  }

  if (lines.length === 0) {
    return "Raio cannot compute active-content or embedded-file impact until richer local fact extractors land.";
  }

  return `${lines.join(", ")} detected - sanitizing removes supported active or embedded content.`;
}

function searchableImpact(facts: DocumentFacts): string {
  if (facts.searchableText === true) {
    return "Searchable text detected.";
  }

  if (facts.searchableText === false) {
    const garbledPages = facts.textLayerCoverage?.garbledPages.length ?? 0;

    if (garbledPages > 0) {
      return "Text layer looks unreliable - re-OCR is recommended.";
    }

    return "No searchable text detected - OCR may add a text layer.";
  }

  return "Raio cannot verify searchable-text coverage for this document yet.";
}

function formImpact(facts: DocumentFacts): string {
  if (facts.formFields) {
    if (facts.formFields.count === 0) {
      return "No interactive form fields detected.";
    }

    const filled = facts.formFields.anyFilled ? " including filled fields" : "";
    return `${facts.formFields.count} form field${facts.formFields.count === 1 ? "" : "s"} detected${filled} - flattening makes them no longer editable.`;
  }

  return "Raio cannot compute form-field impact until richer local fact extractors land.";
}

function conversionImpact(facts: DocumentFacts): string {
  const lines: string[] = [];

  if (facts.annotationCount !== undefined) {
    lines.push(`${facts.annotationCount} annotation${facts.annotationCount === 1 ? "" : "s"}`);
  }

  if (facts.formFields?.count !== undefined) {
    lines.push(`${facts.formFields.count} form field${facts.formFields.count === 1 ? "" : "s"}`);
  }

  if (facts.signatureFieldCount !== undefined) {
    lines.push(`${facts.signatureFieldCount} signature field${facts.signatureFieldCount === 1 ? "" : "s"}`);
  }

  if (facts.possibleUnappliedRedactions !== undefined) {
    const redactionCount =
      facts.possibleUnappliedRedactions.redactAnnotationCount +
      facts.possibleUnappliedRedactions.blackRectangleAnnotationCount;
    lines.push(`${redactionCount} possible unapplied redaction${redactionCount === 1 ? "" : "s"}`);
  }

  if (lines.length === 0) {
    return "Raio cannot compute PDF/A conversion impact until richer local fact extractors land; review annotations, signatures, form fields, and redaction marks before running.";
  }

  return `${lines.join(", ")} detected - conversion may invalidate or remove them.`;
}

function findConstraint(pack: JurisdictionPack, id: string): ConstraintEntry {
  return pack.constraints.find((constraint) => constraint.id === id) ?? {
    id,
    label: id,
    kind: "rule",
    authority: "Unspecified",
    lastVerified: UNKNOWN_LAST_VERIFIED,
    applicability: { scope: "varies" },
  };
}

function strongestStance(stances: readonly ConstraintStance[]): PrepPlanStance {
  const order: ConstraintStance[] = ["required", "preferred", "prohibited", "accepted", "unknown"];

  return order.find((stance) => stances.includes(stance)) ?? "unknown";
}

function joinUnique(values: readonly string[]): string {
  return [...new Set(values)].join("; ");
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
