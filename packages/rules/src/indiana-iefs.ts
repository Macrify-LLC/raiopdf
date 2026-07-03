import indianaIefsJson from "../data/indiana-iefs.json" with { type: "json" };
import { validateJurisdictionPack } from "./packLoader.js";

export const indianaIefsPack = validateJurisdictionPack(
  indianaIefsJson,
  "Indiana IEFS jurisdiction pack",
);
