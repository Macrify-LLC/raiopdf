import { describe, expect, it } from "vitest";
import {
  buildCaseReporterCitationPattern,
  federalConstitutionalPattern,
  federalRulePattern,
  federalStatutePattern,
  floridaRulePattern,
  floridaStatutePattern,
  georgiaStatutePattern,
  indianaStatutePattern,
  reporterTable,
  stateConstitutionalPattern,
  stateRulePattern,
} from "../src/index";

describe("citation patterns", () => {
  it("matches case reporter citations using known reporter variants", () => {
    const pattern = buildCaseReporterCitationPattern(reporterTable);
    const text = "See Roe, 410 U.S. 113, and Smith, 123 So.3d 456.";

    const matches = [...text.matchAll(pattern.regex)];

    expect(matches.map((match) => match[0])).toEqual(["410 U.S. 113", "123 So.3d 456"]);
    expect(matches[1]?.groups?.reporter).toBe("So.3d");
  });

  it("matches statute citations with section-marker variants", () => {
    expect("42 U.S.C. § 1983".match(federalStatutePattern.regex)?.[0]).toBe("42 U.S.C. § 1983");
    expect("Florida Statutes section 90.702".match(floridaStatutePattern.regex)?.[0]).toBe(
      "Florida Statutes section 90.702",
    );
    expect("O.C.G.A. sec. 9-11-56".match(georgiaStatutePattern.regex)?.[0]).toBe(
      "O.C.G.A. sec. 9-11-56",
    );
    expect("Ind. Code § 34-13-3-5".match(indianaStatutePattern.regex)?.[0]).toBe(
      "Ind. Code § 34-13-3-5",
    );
  });

  it("captures comma-separated section lists after plural section markers", () => {
    const [federal] = [..."28 U.S.C. §§ 1331, 1332".matchAll(federalStatutePattern.regex)];
    expect(federal?.[0]).toBe("28 U.S.C. §§ 1331, 1332");
    expect(federal?.groups?.["sectionList"]).toBe("1331, 1332");

    const [florida] = [..."Fla. Stat. §§ 768.28(1), (5)".matchAll(floridaStatutePattern.regex)];
    expect(florida?.[0]).toBe("Fla. Stat. §§ 768.28(1), (5)");
    expect(florida?.groups?.["sectionList"]).toBe("768.28(1), (5)");
  });

  it("does not over-capture prose or adjacent citations after a section list", () => {
    const prose = "28 U.S.C. §§ 1331, and the court held".match(federalStatutePattern.regex);
    expect(prose?.[0]).toBe("28 U.S.C. §§ 1331");

    // A singular marker never captures a list, so a following citation's
    // volume number is left alone.
    const adjacent = [..."28 U.S.C. § 1331, 28 U.S.C. § 1332".matchAll(federalStatutePattern.regex)];
    expect(adjacent.map((match) => match[0])).toEqual(["28 U.S.C. § 1331", "28 U.S.C. § 1332"]);
  });

  it("matches federal and state rule citations", () => {
    expect("Fed. R. Civ. P. 56".match(federalRulePattern.regex)?.[0]).toBe(
      "Fed. R. Civ. P. 56",
    );
    expect("Fed. R. Evid. 702".match(federalRulePattern.regex)?.[0]).toBe(
      "Fed. R. Evid. 702",
    );
    expect("Federal Rule of Evidence 702".match(federalRulePattern.regex)?.[0]).toBe(
      "Federal Rule of Evidence 702",
    );
    expect("Federal Rules of Civil Procedure 56".match(federalRulePattern.regex)?.[0]).toBe(
      "Federal Rules of Civil Procedure 56",
    );
    expect("Fla. R. Civ. P. 1.510".match(floridaRulePattern.regex)?.[0]).toBe(
      "Fla. R. Civ. P. 1.510",
    );
    expect("Florida Rule of Appellate Procedure 9.130".match(floridaRulePattern.regex)?.[0]).toBe(
      "Florida Rule of Appellate Procedure 9.130",
    );
    expect("Fla. R. Gen. Prac. & Jud. Admin. 2.425".match(floridaRulePattern.regex)?.[0]).toBe(
      "Fla. R. Gen. Prac. & Jud. Admin. 2.425",
    );
    expect("Ind. Trial Rule 56".match(stateRulePattern.regex)?.[0]).toBe(
      "Ind. Trial Rule 56",
    );
  });

  it("matches federal and state constitutional citations", () => {
    expect("U.S. Const. amend. XIV".match(federalConstitutionalPattern.regex)?.[0]).toBe(
      "U.S. Const. amend. XIV",
    );
    expect("Fla. Const. art. V, § 3".match(stateConstitutionalPattern.regex)?.[0]).toBe(
      "Fla. Const. art. V, § 3",
    );
  });

  it("does not match ordinary numbers, dates, or dollar amounts as authorities", () => {
    const pattern = buildCaseReporterCitationPattern(reporterTable);
    const text = "The filing is dated 01/02/2024 and requests $410.00 on page 113.";

    expect([...text.matchAll(pattern.regex)]).toEqual([]);
    expect(text.match(federalStatutePattern.regex)).toBeNull();
    expect(text.match(federalRulePattern.regex)).toBeNull();
  });
});
