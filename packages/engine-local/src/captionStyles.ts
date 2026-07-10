import type { PdfCaptionStyle } from "@raiopdf/engine-api";

export const CAPTION_STYLES: readonly PdfCaptionStyle[] = [
  {
    id: "classic-boxed",
    label: "Classic boxed",
    partyBlockStyle: "boxed",
    vsSeparator: "v.",
    caseInfoAlign: "right",
    ordering: ["court", "parties", "caseInfo", "title", "signature"],
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    fontFamily: "times",
  },
  {
    id: "underlined-parties",
    label: "Underlined parties",
    partyBlockStyle: "open",
    vsSeparator: "v.",
    caseInfoAlign: "right",
    ordering: ["court", "parties", "caseInfo", "title", "signature"],
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    fontFamily: "times",
  },
  {
    id: "centered-federal",
    label: "Centered federal",
    partyBlockStyle: "centered",
    vsSeparator: "v.",
    caseInfoAlign: "right",
    ordering: ["court", "parties", "caseInfo", "title", "signature"],
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    fontFamily: "times",
  },
  {
    id: "minimal",
    label: "Minimal",
    partyBlockStyle: "open",
    vsSeparator: "v.",
    caseInfoAlign: "left",
    ordering: ["court", "title", "parties", "caseInfo", "signature"],
    margins: { top: 72, right: 90, bottom: 72, left: 90 },
    fontFamily: "times",
  },
];

export function resolveCaptionStyle(styleId: string): PdfCaptionStyle {
  return CAPTION_STYLES.find((style) => style.id === styleId) ?? CAPTION_STYLES[0]!;
}
