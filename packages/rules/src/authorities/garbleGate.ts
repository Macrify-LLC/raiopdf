import type { DocumentFacts } from "../types.js";

export type AuthoritiesGarbleGateResult = {
  blocked: boolean;
  garbledPages: readonly number[];
  guidance?: string;
};

export function authoritiesGarbleGate(
  documentFacts: DocumentFacts,
): AuthoritiesGarbleGateResult {
  const garbledPages = documentFacts.textLayerCoverage?.garbledPages.map(
    (page) => page.pageIndex,
  ) ?? [];

  if (garbledPages.length === 0) {
    return { blocked: false, garbledPages };
  }

  const totalPages = documentFacts.textLayerCoverage
    ? documentFacts.textLayerCoverage.imageOnlyPages.length +
      documentFacts.textLayerCoverage.mixedPages.length +
      documentFacts.textLayerCoverage.textPages.length
    : documentFacts.pages.length;
  const totalText = totalPages > 0 ? ` on ${garbledPages.length} of ${totalPages} pages` : "";

  return {
    blocked: true,
    garbledPages,
    guidance: `The document's hidden searchable text looks garbled${totalText}; running Make Searchable again is recommended.`,
  };
}
