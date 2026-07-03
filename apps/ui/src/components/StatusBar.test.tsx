import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TextLayerStatus } from "../lib/textLayerStatus";
import { StatusBar } from "./StatusBar";

describe("StatusBar searchability chip", () => {
  it("renders the clean verified state", () => {
    const html = renderToStaticMarkup(
      <StatusBar textLayerStatus={cleanStatus} />,
    );

    expect(html).toContain('data-status="clean"');
    expect(html).toContain("Searchable — verified");
  });

  it("renders the garbled amber state with page counts", () => {
    const html = renderToStaticMarkup(
      <StatusBar textLayerStatus={garbledStatus} />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('data-status="garbled"');
    expect(html).toContain("Text layer looks garbled on 2 of 5 pages — re-OCR recommended");
  });

  it("renders the image-only neutral state", () => {
    const html = renderToStaticMarkup(
      <StatusBar textLayerStatus={imageOnlyStatus} />,
    );

    expect(html).toContain('data-status="image_only"');
    expect(html).toContain("No searchable text — run Make Searchable");
  });

  it("renders the unknown muted state", () => {
    const html = renderToStaticMarkup(
      <StatusBar textLayerStatus={unknownStatus} />,
    );

    expect(html).toContain('data-status="unknown"');
    expect(html).toContain("Searchability not checked");
  });
});

const cleanStatus: TextLayerStatus = {
  state: "clean",
  quality: {
    cleanPages: 3,
    garbledPages: 0,
    imageOnlyPages: 0,
    totalPages: 3,
    verdict: "clean",
  },
  garbledPages: [],
};

const garbledStatus: TextLayerStatus = {
  state: "garbled",
  quality: {
    cleanPages: 3,
    garbledPages: 2,
    imageOnlyPages: 0,
    totalPages: 5,
    verdict: "mixed",
  },
  garbledPages: [
    {
      pageIndex: 1,
      confidence: 0.92,
      reason: "low_alpha_entropy",
      puaRatio: 0,
      replacementRatio: 0,
      alphaRatio: 0.01,
    },
    {
      pageIndex: 4,
      confidence: 0.88,
      reason: "combined",
      puaRatio: 0.2,
      replacementRatio: 0.1,
      alphaRatio: 0.02,
    },
  ],
};

const imageOnlyStatus: TextLayerStatus = {
  state: "image_only",
  quality: {
    cleanPages: 0,
    garbledPages: 0,
    imageOnlyPages: 2,
    totalPages: 2,
    verdict: "image_only",
  },
  garbledPages: [],
};

const unknownStatus: TextLayerStatus = {
  state: "unknown",
  quality: null,
  garbledPages: [],
};
