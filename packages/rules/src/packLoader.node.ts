import { readFileSync } from "node:fs";

import manifestJson from "../data/packs.manifest.json" with { type: "json" };
import type { PackManifest } from "./packIntegrity.js";
import { verifyBundledPackIntegrity } from "./packIntegrity.js";
import type { JurisdictionPack, JurisdictionPackId } from "./types.js";
import {
  loadJurisdictionPackFromJson,
  type PackJsonSource,
} from "./packLoader.js";

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

  const pack = loadJurisdictionPackFromJson(json, `${packId} jurisdiction pack`);

  if (source === bundledPackSource) {
    const issue = verifyBundledPackIntegrity(manifestJson as PackManifest, packId, pack);

    if (issue) {
      throw new Error(`${packId} jurisdiction pack failed integrity verification: ${issue.reason}`);
    }
  }

  return pack;
}
