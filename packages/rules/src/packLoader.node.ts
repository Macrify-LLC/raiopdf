import { readFileSync } from "node:fs";

import type { JurisdictionPack, JurisdictionPackId } from "./types";
import {
  loadJurisdictionPackFromJson,
  type PackJsonSource,
} from "./packLoader";

const bundledPackFiles = new Map<JurisdictionPackId, URL>([
  ["florida", new URL("../data/florida.json", import.meta.url)],
]);

/** Node-only pack source reading the JSON bundled with the package. */
export const bundledPackSource: PackJsonSource = {
  readPackJson(packId) {
    const fileUrl = bundledPackFiles.get(packId);

    if (!fileUrl) {
      return undefined;
    }

    return readFileSync(fileUrl, "utf8");
  },
};

/**
 * Runtime-updatable packs should be implemented as another PackJsonSource that
 * checks the app-data directory before falling back to bundledPackSource.
 */
export function loadPackFromSource(
  packId: JurisdictionPackId,
  source: PackJsonSource = bundledPackSource,
): JurisdictionPack {
  const json = source.readPackJson(packId);

  if (json === undefined) {
    throw new Error(`Unknown jurisdiction pack: ${packId}`);
  }

  return loadJurisdictionPackFromJson(json, `${packId} jurisdiction pack`);
}
