import {
  deriveTextLayerQuality,
  type GarbledPageInfo,
  type TextLayerCoverage,
  type TextLayerQuality,
} from "@raiopdf/rules";

export type TextLayerStatus =
  | {
      state: "clean";
      quality: TextLayerQuality;
      garbledPages: readonly GarbledPageInfo[];
    }
  | {
      state: "garbled";
      quality: TextLayerQuality;
      garbledPages: readonly GarbledPageInfo[];
    }
  | {
      state: "image_only";
      quality: TextLayerQuality;
      garbledPages: readonly GarbledPageInfo[];
    }
  | {
      state: "unknown";
      quality: TextLayerQuality | null;
      garbledPages: readonly GarbledPageInfo[];
    };

export function deriveTextLayerStatus(coverage: TextLayerCoverage | null): TextLayerStatus {
  if (!coverage) {
    return { state: "unknown", quality: null, garbledPages: [] };
  }

  const quality = deriveTextLayerQuality(coverage);

  if (quality.verdict === "clean") {
    return { state: "clean", quality, garbledPages: coverage.garbledPages };
  }

  if (coverage.garbledPages.length > 0) {
    return { state: "garbled", quality, garbledPages: coverage.garbledPages };
  }

  if (quality.verdict === "unknown") {
    return { state: "unknown", quality, garbledPages: coverage.garbledPages };
  }

  return { state: "image_only", quality, garbledPages: coverage.garbledPages };
}

export function describeTextLayerStatus(status: TextLayerStatus): string {
  if (status.state === "clean") {
    return "Verified";
  }

  if (status.state === "garbled") {
    return "Unreliable";
  }

  if (status.state === "image_only") {
    return "No searchable text";
  }

  return "Not checked";
}
