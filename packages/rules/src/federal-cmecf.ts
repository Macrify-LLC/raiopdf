import federalCmecfJson from "../data/federal-cmecf.json" with { type: "json" };
import { validateJurisdictionPack } from "./packLoader.js";

export const federalCmecfPack = validateJurisdictionPack(
  federalCmecfJson,
  "federal CM/ECF jurisdiction pack",
);
