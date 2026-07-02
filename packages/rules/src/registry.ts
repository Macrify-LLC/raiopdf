import { floridaPack } from "./florida";
import type { JurisdictionPack, JurisdictionPackId } from "./types";

export const DEFAULT_PACK_ID = "florida";

const packs = new Map<JurisdictionPackId, JurisdictionPack>([
  [floridaPack.id, floridaPack],
]);

export function getPack(id: JurisdictionPackId = DEFAULT_PACK_ID): JurisdictionPack {
  const pack = packs.get(id);

  if (!pack) {
    throw new Error(`Unknown jurisdiction pack: ${id}`);
  }

  return pack;
}

export function listPacks(): readonly JurisdictionPack[] {
  return [...packs.values()];
}
