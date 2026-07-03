import georgiaEfilegaJson from "../data/georgia-efilega.json" with { type: "json" };
import { validateJurisdictionPack } from "./packLoader.js";

export const georgiaEfilegaPack = validateJurisdictionPack(
  georgiaEfilegaJson,
  "Georgia eFileGA jurisdiction pack",
);
