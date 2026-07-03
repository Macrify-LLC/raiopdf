import georgiaPeachcourtJson from "../data/georgia-peachcourt.json" with { type: "json" };
import { validateJurisdictionPack } from "./packLoader.js";

export const georgiaPeachcourtPack = validateJurisdictionPack(
  georgiaPeachcourtJson,
  "Georgia PeachCourt jurisdiction pack",
);
