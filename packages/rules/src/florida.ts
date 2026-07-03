import floridaJson from "../data/florida.json" with { type: "json" };
import { validateJurisdictionPack } from "./packLoader.js";

export const floridaPack = validateJurisdictionPack(
  floridaJson,
  "florida jurisdiction pack",
);
