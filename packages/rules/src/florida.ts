import floridaJson from "../data/florida.json";
import { validateJurisdictionPack } from "./packLoader";

export const floridaPack = validateJurisdictionPack(
  floridaJson,
  "florida jurisdiction pack",
);
