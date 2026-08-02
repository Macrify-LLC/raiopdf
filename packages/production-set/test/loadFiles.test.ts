import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatProductionDat, type ProductionDatRow } from "../src/loadFiles";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "production-golden.dat");

const DAT_FIELD_DELIMITER = String.fromCharCode(0x14);
const DAT_TEXT_QUALIFIER = "þ";
const DAT_NEWLINE_SUBSTITUTE = "®";

const DAT_HEADER_FIELDS = [
  "BEGBATES",
  "ENDBATES",
  "BEGATTACH",
  "ENDATTACH",
  "PAGECOUNT",
  "CONFIDENTIALITY",
  "CUSTODIAN",
  "FILENAME",
  "LINK",
  "SHA256",
];

const GOLDEN_ROWS: ProductionDatRow[] = [
  {
    begBates: "SMITH000001",
    endBates: "SMITH000003",
    pageCount: 3,
    confidentiality: "Confidential",
    custodian: "J. Smith",
    filename: "contract.pdf",
    link: "upload/SMITH000001 - SMITH000003 - contract.pdf",
    sha256: "a".repeat(64),
  },
  {
    // Embedded newline exercises the ® substitution inside the committed
    // golden fixture itself, not just in the dedicated sanitization test.
    begBates: "SMITH000004",
    endBates: "SMITH000004",
    pageCount: 1,
    confidentiality: "",
    custodian: "",
    filename: "notes\r\nfollowup.pdf",
    link: "upload/VOL002/SMITH000004 - SMITH000004 - notes.pdf",
    sha256: "b".repeat(64),
  },
];

describe("formatProductionDat", () => {
  it("writes a UTF-8-BOM, 0x14-delimited, þ-qualified, CRLF DAT with the fixed field order", () => {
    const bytes = formatProductionDat(GOLDEN_ROWS, { includeFilenameInIndex: true });

    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text.endsWith("\r\n")).toBe(true);
    // Every line ends CRLF and nothing but CRLF -- splitting on it with the
    // trailing empty segment removed should perfectly partition the file.
    const rawLines = text.split("\r\n");
    expect(rawLines[rawLines.length - 1]).toBe("");
    const lines = rawLines.slice(0, -1);
    expect(lines).toHaveLength(1 + GOLDEN_ROWS.length);

    const headerFields = lines[0]!.split(DAT_FIELD_DELIMITER);
    expect(headerFields).toEqual(DAT_HEADER_FIELDS.map((name) => qualify(name)));

    const firstRowFields = lines[1]!.split(DAT_FIELD_DELIMITER);
    expect(firstRowFields).toEqual([
      "SMITH000001",
      "SMITH000003",
      "",
      "",
      "3",
      "Confidential",
      "J. Smith",
      "contract.pdf",
      "upload\\SMITH000001 - SMITH000003 - contract.pdf",
      "a".repeat(64),
    ].map((value) => qualify(value)));

    const secondRowFields = lines[2]!.split(DAT_FIELD_DELIMITER);
    // The embedded CRLF became a single ® -- confirming the substitution
    // survives inside the committed byte-exact fixture, not just a unit
    // assertion in isolation.
    expect(secondRowFields[7]).toBe(qualify(`notes${DAT_NEWLINE_SUBSTITUTE}followup.pdf`));
    expect(secondRowFields[8]).toBe(qualify("upload\\VOL002\\SMITH000004 - SMITH000004 - notes.pdf"));
  });

  it("matches the committed golden DAT fixture byte-for-byte", async () => {
    const bytes = formatProductionDat(GOLDEN_ROWS, { includeFilenameInIndex: true });

    if (!existsSync(FIXTURE_PATH)) {
      await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
      await fs.writeFile(FIXTURE_PATH, bytes);
    }

    const fixture = await fs.readFile(FIXTURE_PATH);
    expect(Buffer.compare(Buffer.from(bytes), fixture)).toBe(0);
  });

  it("sanitizes a value with a comma, thorn, pre-existing ®, delimiter, and CRLF into exactly 10 clean fields", () => {
    const dirty = `comma, thorn ${DAT_TEXT_QUALIFIER} and ${DAT_NEWLINE_SUBSTITUTE} test${DAT_FIELD_DELIMITER}here\r\nline.pdf`;
    const rows: ProductionDatRow[] = [{
      begBates: "A000001",
      endBates: "A000001",
      pageCount: 1,
      confidentiality: "",
      custodian: "",
      filename: dirty,
      link: `upload/${dirty}`,
      sha256: "0".repeat(64),
    }];

    const bytes = formatProductionDat(rows, { includeFilenameInIndex: true });
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.split("\r\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);

    const dataLine = lines[1]!;
    // A naive splitter with no knowledge of qualifiers -- exactly what a
    // reviewer's importer does first -- must still land on 10 fields.
    const fields = dataLine.split(DAT_FIELD_DELIMITER);
    expect(fields).toHaveLength(10);
    for (const field of fields) {
      expect(field.startsWith(DAT_TEXT_QUALIFIER)).toBe(true);
      expect(field.endsWith(DAT_TEXT_QUALIFIER)).toBe(true);
    }

    const filenameField = unqualify(fields[7]!);
    const linkField = unqualify(fields[8]!);
    // Neither the delimiter nor a bare qualifier character survives.
    expect(filenameField.includes(DAT_FIELD_DELIMITER)).toBe(false);
    expect(filenameField.includes(DAT_TEXT_QUALIFIER)).toBe(false);
    expect(linkField.includes(DAT_FIELD_DELIMITER)).toBe(false);
    expect(linkField.includes(DAT_TEXT_QUALIFIER)).toBe(false);
    // The comma and the pre-existing ® pass through untouched -- only the
    // delimiter, the qualifier, and the CRLF were sanitized.
    expect(filenameField).toContain("comma,");
    expect(filenameField).toContain(DAT_NEWLINE_SUBSTITUTE);
    // The embedded CRLF became exactly one more ® (in addition to the
    // pre-existing one already in the dirty string).
    expect(filenameField.split(DAT_NEWLINE_SUBSTITUTE)).toHaveLength(3);
  });

  it("blanks FILENAME (header stays, value empty) when includeFilenameInIndex is false", () => {
    // filename and link are deliberately distinct strings here (unlike a
    // real produced file, where the output name -- and so the LINK path --
    // is DERIVED from the source filename): this is a pure-function test of
    // the FILENAME field specifically, not of LINK's independent content.
    const rows: ProductionDatRow[] = [{
      begBates: "B000001",
      endBates: "B000001",
      pageCount: 1,
      confidentiality: "",
      custodian: "",
      filename: "should-not-appear-as-a-field-value.pdf",
      link: "upload/B000001 - B000001 - produced.pdf",
      sha256: "c".repeat(64),
    }];

    const bytes = formatProductionDat(rows, { includeFilenameInIndex: false });
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.split("\r\n").filter((line) => line.length > 0);

    expect(lines[0]!.split(DAT_FIELD_DELIMITER)).toContain(qualify("FILENAME"));
    const fields = lines[1]!.split(DAT_FIELD_DELIMITER);
    expect(fields).toHaveLength(10);
    expect(fields[7]).toBe(qualify(""));
    expect(text).not.toContain("should-not-appear-as-a-field-value.pdf");
  });

  it("writes a blank CUSTODIAN when the row has none, and the custodian text when it does", () => {
    const rows: ProductionDatRow[] = [
      {
        begBates: "D000001",
        endBates: "D000001",
        pageCount: 1,
        confidentiality: "",
        custodian: "",
        filename: "a.pdf",
        link: "upload/a.pdf",
        sha256: "d".repeat(64),
      },
      {
        begBates: "D000002",
        endBates: "D000002",
        pageCount: 1,
        confidentiality: "",
        custodian: "R. Custodian",
        filename: "b.pdf",
        link: "upload/b.pdf",
        sha256: "e".repeat(64),
      },
    ];

    const bytes = formatProductionDat(rows, { includeFilenameInIndex: true });
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.split("\r\n").filter((line) => line.length > 0);

    expect(lines[1]!.split(DAT_FIELD_DELIMITER)[6]).toBe(qualify(""));
    expect(lines[2]!.split(DAT_FIELD_DELIMITER)[6]).toBe(qualify("R. Custodian"));
  });

  it("writes zero data rows (header only) for an empty row set", () => {
    const bytes = formatProductionDat([], { includeFilenameInIndex: true });
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.split("\r\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });
});

function qualify(value: string): string {
  return `${DAT_TEXT_QUALIFIER}${value}${DAT_TEXT_QUALIFIER}`;
}

function unqualify(value: string): string {
  return value.slice(DAT_TEXT_QUALIFIER.length, value.length - DAT_TEXT_QUALIFIER.length);
}
