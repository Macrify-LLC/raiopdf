import { PdfEngineError } from "@raiopdf/engine-api";
import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  countEmbeddedFiles,
  readPdfAIdentificationFromBytes,
  readPdfOutline,
  writePdfAIdentificationInPlace,
  writePdfOutlineInPlace,
} from "@raiopdf/engine-pdf-lib";
import { SidecarPdfEngine } from "../src/index";

type FetchCall = {
  init?: RequestInit;
  url: string;
};

describe("SidecarPdfEngine", () => {
  it("probes the Stirling status endpoint", async () => {
    const { calls, fetchImpl } = createFetch(
      jsonResponse({
        status: "UP",
        version: "2.9.0",
      }),
    );

    const info = await SidecarPdfEngine.probe("http://127.0.0.1:8080/", fetchImpl);

    expect(info).toEqual({
      kind: "stirling-pdf",
      baseUrl: "http://127.0.0.1:8080",
      status: "UP",
      version: "2.9.0",
    });
    expect(calls).toMatchObject([
      {
        url: "http://127.0.0.1:8080/api/v1/info/status",
        init: {
          method: "GET",
        },
      },
    ]);
  });

  it("returns null when probe cannot reach a healthy sidecar", async () => {
    const { fetchImpl } = createFetch(jsonResponse({ status: "DOWN" }, 503));

    await expect(SidecarPdfEngine.probe("http://127.0.0.1:8080", fetchImpl)).resolves.toBeNull();
  });

  it("gets page counts from Stirling basic-info", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1, 2, 3));

    await expect(engine.pageCount(document)).resolves.toBe(3);

    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/api/v1/analysis/basic-info");
    await expectFormFile(calls[0], [1, 2, 3]);
  });

  it("removes encryption through the lossless local qpdf decrypt without opening first", async () => {
    const { calls, fetchImpl } = createFetch(pdfResponse(9, 8, 7));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.removeEncryption(bytes(1, 2, 3), "secret")).resolves.toEqual(bytes(9, 8, 7));

    // Decrypt goes to the engine's local qpdf interceptor, not Stirling's lossy
    // /remove-password: PDF bytes are base64 text in the body, the password is
    // hex-encoded in a loopback query param so qpdf never sees it on a command
    // line.
    expect(pathFromUrl(calls[0]?.url ?? "")).toBe("/local/decrypt");
    expectBase64Body(calls[0], [1, 2, 3]);
    expect(queryValue(calls[0], "body_encoding")).toBe("base64");
    expect(queryValue(calls[0], "password_hex")).toBe("736563726574");
  });

  it("tries an empty local decrypt password for owner-restricted PDFs", async () => {
    const { calls, fetchImpl } = createFetch(pdfResponse(9, 8, 7));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.removeEncryption(bytes(1, 2, 3), "")).resolves.toEqual(bytes(9, 8, 7));

    expect(pathFromUrl(calls[0]?.url ?? "")).toBe("/local/decrypt");
    expectBase64Body(calls[0], [1, 2, 3]);
    expect(queryValue(calls[0], "body_encoding")).toBe("base64");
    expect(queryValue(calls[0], "password_hex")).toBe("");
  });

  it("maps an empty-password local decrypt failure to PASSWORD_REQUIRED", async () => {
    const { fetchImpl } = createFetch(
      textResponse("qpdf --decrypt failed: invalid password", 422),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.removeEncryption(bytes(1), "")).rejects.toMatchObject({
      code: "PASSWORD_REQUIRED",
      message: "A PDF password is required to remove encryption.",
    });
  });

  it("maps a wrong-password local decrypt failure to ENCRYPTED_DOCUMENT", async () => {
    const { fetchImpl } = createFetch(
      textResponse("qpdf --decrypt failed: invalid password", 422),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.removeEncryption(bytes(1), "wrong")).rejects.toMatchObject({
      code: "ENCRYPTED_DOCUMENT",
      message: "The PDF password was not accepted.",
    });
  });

  it("sends the sidecar auth token on every proxied request", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfResponse(9));
    const engine = new SidecarPdfEngine({
      authToken: "test-token",
      baseUrl: "http://127.0.0.1:8080",
      fetch: fetchImpl,
    });
    const document = await engine.open(bytes(1));

    await engine.reorderPages(document, [0, 1, 2]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(headerValue(call, "X-RaioPDF-Auth")).toBe("test-token");
    }
  });

  it("reorders pages through rearrange-pages", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfResponse(9));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const { document: reordered } = await engine.reorderPages(document, [2, 0, 1]);

    expect(await engine.saveToBytes(reordered)).toEqual(bytes(9));
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/general/rearrange-pages");
    expectFormField(calls[1], "pageNumbers", "3,1,2");
    expectFormField(calls[1], "customMode", "CUSTOM");
  });

  it("rotates all selected pages through rotate-pdf", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 2 }), pdfResponse(7));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const rotated = await engine.rotatePages(document, [0, 1], -90);

    expect(await engine.saveToBytes(rotated)).toEqual(bytes(7));
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/general/rotate-pdf");
    expectFormField(calls[1], "angle", "270");
  });

  it("rotates partial page selections by extracting, rotating, and merging pages", async () => {
    const { calls, fetchImpl } = createFetch(
      jsonResponse({ pageCount: 3 }),
      pdfResponse(10),
      pdfResponse(20),
      pdfResponse(21),
      pdfResponse(30),
      pdfResponse(99),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const rotated = await engine.rotatePages(document, [1], 90);

    expect(await engine.saveToBytes(rotated)).toEqual(bytes(99));
    expect(calls.map((call) => pathFromUrl(call.url))).toEqual([
      "/api/v1/analysis/basic-info",
      "/api/v1/general/rearrange-pages",
      "/api/v1/general/rearrange-pages",
      "/api/v1/general/rotate-pdf",
      "/api/v1/general/rearrange-pages",
      "/api/v1/general/merge-pdfs",
    ]);
    expectFormField(calls[1], "pageNumbers", "1");
    expectFormField(calls[2], "pageNumbers", "2");
    expectFormField(calls[3], "angle", "90");
    expectFormField(calls[4], "pageNumbers", "3");
    expectFormField(calls[5], "sortType", "orderProvided");
  });

  it("deletes pages through remove-pages", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfResponse(8));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const { document: deleted } = await engine.deletePages(document, [1]);

    expect(await engine.saveToBytes(deleted)).toEqual(bytes(8));
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/general/remove-pages");
    expectFormField(calls[1], "pageNumbers", "2");
  });

  it("inserts pages by merging and rearranging", async () => {
    const { calls, fetchImpl } = createFetch(
      jsonResponse({ pageCount: 2 }),
      jsonResponse({ pageCount: 1 }),
      pdfResponse(4),
      pdfResponse(5),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const target = await engine.open(bytes(1));
    const inserted = await engine.open(bytes(2));

    const { document: combined } = await engine.insertPages(target, 1, inserted);

    expect(await engine.saveToBytes(combined)).toEqual(bytes(5));
    expect(calls[2]?.url).toBe("http://127.0.0.1:8080/api/v1/general/merge-pdfs");
    expect(calls[3]?.url).toBe("http://127.0.0.1:8080/api/v1/general/rearrange-pages");
    expectFormField(calls[3], "pageNumbers", "1,3,2");
  });

  it("merges documents through merge-pdfs", async () => {
    const { calls, fetchImpl } = createFetch(
      jsonResponse({ pageCount: 2 }),
      jsonResponse({ pageCount: 1 }),
      pdfResponse(6),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const first = await engine.open(bytes(1));
    const second = await engine.open(bytes(2));

    const { document: merged } = await engine.merge([first, second]);

    expect(await engine.saveToBytes(merged)).toEqual(bytes(6));
    expect(calls[2]?.url).toBe("http://127.0.0.1:8080/api/v1/general/merge-pdfs");
    expectFormField(calls[2], "sortType", "orderProvided");
    expectFormField(calls[2], "removeCertSign", "true");
    expectFormField(calls[2], "generateToc", "false");
    expect(getFormData(calls[2]).getAll("fileInput")).toHaveLength(2);
  });

  it("stamps text through add-stamp with required customMargin", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfResponse(77));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const stamped = await engine.stampText(document, {
      text: "Exhibit A",
      pageIndexes: [0, 2],
      placement: { edge: "footer", align: "right" },
      fontSizePt: 12,
      marginIn: 0.75,
    });

    expect(await engine.saveToBytes(stamped)).toEqual(bytes(77));
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/misc/add-stamp");
    expectFormField(calls[1], "pageNumbers", "1,3");
    expectFormField(calls[1], "stampType", "text");
    expectFormField(calls[1], "stampText", "Exhibit A");
    expectFormField(calls[1], "fontSize", "12");
    expectFormField(calls[1], "position", "9");
    expectFormField(calls[1], "customMargin", "large");
  });

  it("maps header-center first-page stamps onto the Stirling position grid", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfResponse(78));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await engine.stampText(document, {
      text: "Filed",
      pageIndexes: "first",
      placement: { edge: "header", align: "center" },
    });

    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/misc/add-stamp");
    expectFormField(calls[1], "pageNumbers", "1");
    expectFormField(calls[1], "fontSize", "11");
    expectFormField(calls[1], "position", "2");
    expectFormField(calls[1], "customMargin", "medium");
  });

  it("redacts text through auto-redact with literal term mapping", async () => {
    const redactedPdf = await createPdfWithMetadata();
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 2 }), pdfBytesResponse(redactedPdf));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const redacted = await engine.redactText(document, {
      terms: ["Alice Smith", "123-45-6789"],
      wholeWord: true,
      rasterize: true,
    });

    await expectNoDocumentMetadata(await engine.saveToBytes(redacted));
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/security/auto-redact");
    expectFormField(calls[1], "listOfText", "Alice Smith\n123-45-6789");
    expectFormField(calls[1], "useRegex", "false");
    expectFormField(calls[1], "wholeWordSearch", "true");
    expectFormField(calls[1], "redactColor", "#000000");
    expectFormField(calls[1], "customPadding", "0");
    expectFormField(calls[1], "convertPDFToImage", "true");
  });

  it("rejects auto-redact text removal unless callers explicitly allow rasterization", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 2 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await expect(
      engine.redactText(document, {
        terms: ["Alice Smith"],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(calls).toHaveLength(1);
  });

  it("replaces text through edit-text with ordered operations and page selection", async () => {
    const sourceBytes = await createBasicPdf();
    const serverBytes = await createBasicPdf();
    const { calls, fetchImpl } = createFetch(pdfBytesResponse(serverBytes));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [
        { find: "Plaintiff", replace: "Petitioner" },
        { find: "Defendant", replace: "Respondent" },
      ],
      wholeWord: true,
      pageIndexes: [0],
    });

    expect(await engine.saveToBytes(result.document)).toBeInstanceOf(Uint8Array);
    expect(result.replacedCounts).toBeNull();
    expect(result.warnings).toEqual([{
      code: "COUNTS_UNAVAILABLE",
      message: expect.stringContaining("does not report replacement counts"),
    }]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/api/v1/general/edit-text");
    expectFormField(calls[0], "edits", JSON.stringify([
      { find: "Plaintiff", replace: "Petitioner" },
      { find: "Defendant", replace: "Respondent" },
    ]));
    expectFormField(calls[0], "wholeWordSearch", "true");
    expectFormField(calls[0], "pageNumbers", "1");
  });

  it("rejects empty replacement operation lists before calling edit-text", async () => {
    const sourceBytes = await createBasicPdf();
    const { calls, fetchImpl } = createFetch();
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    await expect(engine.replaceText(document, { operations: [] })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects empty find strings before calling edit-text", async () => {
    const sourceBytes = await createBasicPdf();
    const { calls, fetchImpl } = createFetch();
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    await expect(
      engine.replaceText(document, {
        operations: [{ find: "", replace: "Petitioner" }],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses permissions-protected PDFs before edit-text because the engine strips encryption", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(new TextEncoder().encode("%PDF-1.7\ntrailer\n<< /Encrypt <<>> >>"));

    await expect(
      engine.replaceText(document, {
        operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      }),
    ).rejects.toMatchObject({
      code: "ENCRYPTED_DOCUMENT",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses signed PDFs unless signature invalidation is explicitly allowed", async () => {
    const sourceBytes = await createPdfWithSignedSignatureField();
    const { calls, fetchImpl } = createFetch();
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    await expect(
      engine.replaceText(document, {
        operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      }),
    ).rejects.toMatchObject({
      code: "SIGNED_DOCUMENT",
    });
    expect(calls).toHaveLength(0);
  });

  it("allows signed PDFs with an invalidation warning when opted in", async () => {
    const sourceBytes = await createPdfWithSignedSignatureField();
    const { fetchImpl } = createFetch(pdfBytesResponse(await createBasicPdf()));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      allowSignatureInvalidation: true,
    });

    expect(result.warnings.map((warning) => warning.code)).toContain("SIGNATURES_INVALIDATED");
  });

  it("refuses PDF/A inputs unless identification removal is explicitly allowed", async () => {
    const sourceBytes = await createPdfWithPdfAIdentification();
    const { calls, fetchImpl } = createFetch();
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    await expect(
      engine.replaceText(document, {
        operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(calls).toHaveLength(0);
  });

  it("strips stale PDF/A identification from edit-text output when opted in", async () => {
    const sourceBytes = await createPdfWithPdfAIdentification();
    const serverBytes = await createPdfWithPdfAIdentification();
    const { fetchImpl } = createFetch(pdfBytesResponse(serverBytes));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
      allowPdfAIdentificationRemoval: true,
    });

    expect(result.warnings.map((warning) => warning.code)).toContain("PDFA_IDENTIFICATION_REMOVED");
    await expect(readPdfAIdentificationFromBytes(await engine.saveToBytes(result.document))).resolves.toBeNull();
  });

  it("restores same-page outlines after edit-text regeneration", async () => {
    const sourceBytes = await createPdfWithOutline();
    const { fetchImpl } = createFetch(pdfBytesResponse(await createBasicPdf()));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
    });
    const outline = readPdfOutline(await PDFDocument.load(await engine.saveToBytes(result.document), {
      updateMetadata: false,
    }));

    expect(outline.items[0]?.title).toBe("First page");
  });

  it("restores embedded files after edit-text regeneration without warning", async () => {
    const sourceBytes = await createPdfWithEmbeddedFile();
    const { fetchImpl } = createFetch(pdfBytesResponse(await createBasicPdf()));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
    });

    expect(result.warnings.map((warning) => warning.code)).not.toContain("ATTACHMENTS_REMOVED");
    await expect(countEmbeddedFiles(await engine.saveToBytes(result.document))).resolves.toBe(1);
  });

  it("warns when tagged-PDF structure will be removed", async () => {
    const sourceBytes = await createTaggedPdf();
    const { fetchImpl } = createFetch(pdfBytesResponse(await createBasicPdf()));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
    });

    expect(result.warnings.map((warning) => warning.code)).toContain("TAGS_REMOVED");
  });

  it("warns heuristically when edit-text output adds Noto fallback fonts", async () => {
    const sourceBytes = await createBasicPdf();
    const serverBytes = await createPdfWithBaseFont("NotoSans-Regular");
    const { fetchImpl } = createFetch(pdfBytesResponse(serverBytes));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(sourceBytes);

    const result = await engine.replaceText(document, {
      operations: [{ find: "Plaintiff", replace: "Petitioner" }],
    });

    expect(result.warnings.map((warning) => warning.code)).toContain("FALLBACK_FONT_POSSIBLE");
    expect(result.warnings.map((warning) => warning.code)).not.toContain("IMAGES_REENCODED");
  });

  it("redacts PDF point areas through the verified local redaction endpoint", async () => {
    const redactedPdf = await createPdfWithMetadata();
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfBytesResponse(redactedPdf));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const redacted = await engine.redactAreas(document, [
      { pageIndex: 0, x: 10, y: 20, w: 30, h: 40 },
      { pageIndex: 2, x: 50, y: 60, w: 70, h: 80 },
    ]);

    await expectNoDocumentMetadata(await engine.saveToBytes(redacted));
    expect(pathFromUrl(calls[1]?.url ?? "")).toBe("/local/redact-areas");
    const request = JSON.parse(calls[1]?.init?.body as string) as {
      pdfBase64: string;
      areas: unknown;
    };
    expect(request.pdfBase64).toBe("AQ==");
    expect(request.areas).toEqual([
      { pageIndex: 0, x: 10, y: 20, w: 30, h: 40 },
      { pageIndex: 2, x: 50, y: 60, w: 70, h: 80 },
    ]);
  });

  it("scrubs metadata through update-metadata deleteAll and local byte post-processing", async () => {
    const serverBytes = await createPdfWithMetadata();
    const { calls, fetchImpl } = createFetch(
      jsonResponse({ pageCount: 1 }),
      pdfBytesResponse(serverBytes),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const scrubbed = await engine.scrubMetadata(document);

    await expectNoDocumentMetadata(await engine.saveToBytes(scrubbed));
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/misc/update-metadata");
    expectFormField(calls[1], "deleteAll", "true");
  });

  it("stamps Bates numbers as sequential add-stamp calls", async () => {
    const { calls, fetchImpl } = createFetch(
      jsonResponse({ pageCount: 3 }),
      pdfResponse(80),
      pdfResponse(81),
      pdfResponse(82),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const stamped = await engine.batesStamp(document, {
      prefix: "ABC",
      start: 98,
      digits: 3,
      placement: { edge: "footer", align: "right" },
    });

    expect(await engine.saveToBytes(stamped)).toEqual(bytes(82));
    expect(calls.slice(1).map((call) => pathFromUrl(call.url))).toEqual([
      "/api/v1/misc/add-stamp",
      "/api/v1/misc/add-stamp",
      "/api/v1/misc/add-stamp",
    ]);
    expectFormField(calls[1], "pageNumbers", "1");
    expectFormField(calls[1], "stampText", "ABC098");
    expectFormField(calls[2], "pageNumbers", "2");
    expectFormField(calls[2], "stampText", "ABC099");
    expectFormField(calls[3], "pageNumbers", "3");
    expectFormField(calls[3], "stampText", "ABC100");
  });

  it("rejects Bates numbers that overflow the configured digit width before stamping", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await expect(
      engine.batesStamp(document, {
        prefix: "ABC",
        start: 98,
        digits: 2,
        placement: { edge: "footer", align: "right" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports sidecar binder creation as unsupported", async () => {
    const { fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await expect(engine.buildBinder(document, [], { slipSheets: false })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("reports sidecar page normalization and byte splitting as unsupported", async () => {
    const { fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await expect(
      engine.normalizePages(document, {
        targetSize: { w: 8.5, h: 11, in: true },
        orientation: "portrait",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(engine.splitByMaxBytes(document, 1024)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("converts to PDF/A through the engine-local Ghostscript interceptor", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 2 }), pdfResponse(91));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const converted = await engine.convertToPdfA(document, {
      flavor: "pdfa-2b",
      strict: true,
    });

    expect(await engine.saveToBytes(converted)).toEqual(bytes(91));
    // PDF/A goes to the local Ghostscript interceptor, not Stirling's
    // LibreOffice-gated (and therefore disabled) /api/v1/convert/pdf/pdfa.
    expect(pathFromUrl(calls[1]?.url ?? "")).toBe("/local/pdfa");
    expectBase64Body(calls[1], [1]);
    expect(queryValue(calls[1], "body_encoding")).toBe("base64");
    expect(queryValue(calls[1], "pdfa_level")).toBe("2");
    expect(queryValue(calls[1], "pdfa_strict")).toBe("true");
  });

  it("maps each PDF/A flavor to its Ghostscript conformance level", async () => {
    const { calls, fetchImpl } = createFetch(
      jsonResponse({ pageCount: 1 }),
      pdfResponse(1),
      pdfResponse(2),
      pdfResponse(3),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    for (const flavor of ["pdfa-1", "pdfa-2b", "pdfa-3b"] as const) {
      await engine.convertToPdfA(document, { flavor });
    }

    expect(queryValue(calls[1], "pdfa_level")).toBe("1");
    expect(queryValue(calls[2], "pdfa_level")).toBe("2");
    expect(queryValue(calls[3], "pdfa_level")).toBe("3");
    expect(queryValue(calls[1], "pdfa_strict")).toBe("false");
  });

  it("compresses through the local qpdf endpoint", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 2 }), pdfResponse(92));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const compressed = await engine.compress(document, {
      quality: 5,
      grayscale: true,
    });

    expect(await engine.saveToBytes(compressed)).toEqual(bytes(92));
    expect(pathFromUrl(calls[1]?.url ?? "")).toBe("/local/compress");
    expectBase64Body(calls[1], [1]);
    expect(queryValue(calls[1], "body_encoding")).toBe("base64");
  });

  it("sanitizes through sanitize-pdf and reports requested removal categories", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }), pdfResponse(93));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const sanitized = await engine.sanitize(document, {
      removeJavaScript: true,
      removeEmbeddedFiles: true,
      removeLinks: true,
    });

    expect(await engine.saveToBytes(sanitized.document)).toEqual(bytes(93));
    expect(sanitized.removed).toEqual(["javascript", "embedded-files", "external-links"]);
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/api/v1/security/sanitize-pdf");
    expectFormField(calls[1], "removeJavaScript", "true");
    expectFormField(calls[1], "removeEmbeddedFiles", "true");
    expectFormField(calls[1], "removeLinks", "true");
    expectFormField(calls[1], "removeMetadata", "false");
    expectFormField(calls[1], "removeXMPMetadata", "false");
    expectFormField(calls[1], "removeFonts", "false");
  });

  it("repairs raw bytes through repair without a prior page-count call", async () => {
    const { calls, fetchImpl } = createFetch(pdfResponse(94));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.repairBytes(bytes(1, 2, 3))).resolves.toEqual(bytes(94));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/api/v1/misc/repair");
    await expectFormFile(calls[0], [1, 2, 3]);
  });

  it("runs OCR through the local OCRmyPDF interceptor", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }), pdfResponse(42));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const searchable = await engine.ocr(document, {
      languages: ["eng", "spa"],
      deskew: true,
    });

    expect(await engine.saveToBytes(searchable)).toEqual(bytes(42));
    expect(pathFromUrl(calls[1]?.url ?? "")).toBe("/local/ocr");
    expectBase64Body(calls[1], [1]);
    expect(queryValue(calls[1], "body_encoding")).toBe("base64");
    expect(queryValue(calls[1], "ocr_type")).toBe("skip-text");
    expect(queryValue(calls[1], "languages")).toBe("eng,spa");
    expect(queryValue(calls[1], "deskew")).toBe("true");
  });

  it("runs raw-byte OCR without probing basic-info when page count is known", async () => {
    const { calls, fetchImpl } = createFetch(pdfResponse(42));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    const searchable = await engine.ocrBytes(bytes(1), {
      languages: ["eng"],
      ocrType: "force-ocr",
      knownPageCount: 6,
    });

    expect(searchable).toEqual({
      bytes: bytes(42),
      pageCount: 6,
    });
    expect(calls).toHaveLength(1);
    expect(pathFromUrl(calls[0]?.url ?? "")).toBe("/local/ocr");
    expectBase64Body(calls[0], [1]);
    expect(queryValue(calls[0], "body_encoding")).toBe("base64");
    expect(queryValue(calls[0], "ocr_type")).toBe("force-ocr");
  });

  it("normalizes legacy Normal OCR mode to skip-text for the local interceptor", async () => {
    const { calls, fetchImpl } = createFetch(pdfResponse(42));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.ocrBytes(bytes(1), {
      ocrType: "Normal",
      knownPageCount: 1,
    })).resolves.toMatchObject({
      bytes: bytes(42),
      pageCount: 1,
    });

    expect(pathFromUrl(calls[0]?.url ?? "")).toBe("/local/ocr");
    expect(queryValue(calls[0], "ocr_type")).toBe("skip-text");
  });

  it("closes document handles and ignores unknown handles", async () => {
    const { fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await expect(engine.close(document)).resolves.toBeUndefined();
    await expect(engine.close("sidecar-pdf:missing" as never)).resolves.toBeUndefined();
    await expect(engine.saveToBytes(document)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("maps local validation failures to PdfEngineError codes", async () => {
    const { fetchImpl } = createFetch();
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.merge([])).rejects.toMatchObject({ code: "EMPTY_INPUT" });
    await expect(engine.saveToBytes("missing" as never)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("maps unsupported rotations before calling Stirling", async () => {
    const { fetchImpl } = createFetch(jsonResponse({ pageCount: 1 }));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    await expect(engine.rotatePages(document, [0], 45)).rejects.toMatchObject({
      code: "UNSUPPORTED_ROTATION",
    });
  });

  it("maps Stirling HTTP errors to typed PdfEngineError codes", async () => {
    const { fetchImpl } = createFetch(
      jsonResponse({ message: "Invalid input parameters or corrupted file" }, 400),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const result = engine.open(bytes(1));

    await expect(result).rejects.toBeInstanceOf(PdfEngineError);
    await expect(result).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("reads Stirling RFC-7807 detail and errorCode fields", async () => {
    const { fetchImpl } = createFetch(
      jsonResponse({
        detail: "PDF is encrypted or password protected",
        status: 400,
        errorCode: "E001",
      }, 400),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const result = engine.open(bytes(1));

    await expect(result).rejects.toMatchObject({ code: "ENCRYPTED_DOCUMENT" });
    await expect(result).rejects.toThrow("PDF is encrypted or password protected (E001)");
  });

  it("maps Stirling disabled endpoint responses to UNSUPPORTED", async () => {
    const { fetchImpl } = createFetch(
      jsonResponse({
        detail: "Endpoint /api/v1/general/remove-pages is disabled",
        status: 403,
        errorCode: "ENDPOINT_DISABLED",
      }, 403),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.open(bytes(1))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("maps Stirling encrypted-document errors to ENCRYPTED_DOCUMENT", async () => {
    const { fetchImpl } = createFetch(
      jsonResponse({ message: "PDF is encrypted or password protected" }, 400),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.open(bytes(1))).rejects.toMatchObject({
      code: "ENCRYPTED_DOCUMENT",
    });
  });

  it("maps unsupported encryption responses to UNSUPPORTED_ENCRYPTION", async () => {
    const { fetchImpl } = createFetch(
      jsonResponse({ message: "Unsupported encryption algorithm" }, 400),
    );
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.open(bytes(1))).rejects.toMatchObject({
      code: "UNSUPPORTED_ENCRYPTION",
    });
  });

  it("maps Stirling page errors to INVALID_PAGE_INDEX", async () => {
    const { fetchImpl } = createFetch(jsonResponse({ message: "Page number is out of range" }, 400));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });

    await expect(engine.open(bytes(1))).rejects.toMatchObject({
      code: "INVALID_PAGE_INDEX",
    });
  });
});

function createFetch(...responses: Response[]): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      ...(init ? { init } : {}),
    });

    const response = responses.shift();

    if (!response) {
      throw new Error("Unexpected fetch call.");
    }

    return response;
  };

  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain",
    },
  });
}

function pdfResponse(...contents: number[]): Response {
  return new Response(arrayBuffer(...contents), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
    },
  });
}

function pdfBytesResponse(contents: Uint8Array): Response {
  return new Response(toArrayBuffer(contents), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
    },
  });
}

async function createPdfWithMetadata(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.setTitle("Confidential Title");
  pdf.setAuthor("Confidential Author");
  pdf.setSubject("Confidential Subject");
  pdf.setKeywords(["confidential", "legal"]);
  pdf.setCreator("RaioPDF Test");
  pdf.setProducer("RaioPDF Producer");

  const metadataStream = pdf.context.stream("<x:xmpmeta>Confidential XMP</x:xmpmeta>", {
    Type: "Metadata",
    Subtype: "XML",
  });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(metadataStream));

  return pdf.save();
}

async function createBasicPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);

  return pdf.save();
}

async function createPdfWithSignedSignatureField(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const signatureValue = pdf.context.register(pdf.context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
  }));
  const signatureField = pdf.context.register(pdf.context.obj({
    FT: "Sig",
    T: "attorney-signature",
    V: signatureValue,
    Rect: [10, 10, 200, 60],
  }));
  const acroForm = pdf.context.obj({
    Fields: [signatureField],
  }) as PDFDict;
  pdf.catalog.set(PDFName.of("AcroForm"), pdf.context.register(acroForm));

  return pdf.save();
}

async function createPdfWithPdfAIdentification(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  writePdfAIdentificationInPlace(pdf, { part: "2", conformance: "B" });

  return pdf.save();
}

async function createPdfWithOutline(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  writePdfOutlineInPlace(pdf, {
    openMode: "outlines",
    revision: "test",
    items: [{
      id: "first",
      title: "First page",
      target: { kind: "page", pageIndex: 0 },
    }],
  });

  return pdf.save();
}

async function createPdfWithEmbeddedFile(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  addEmbeddedFile(pdf, "native-exhibit.txt", new Uint8Array([1, 2, 3]));

  return pdf.save();
}

async function createTaggedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.catalog.set(PDFName.of("MarkInfo"), pdf.context.obj({
    Marked: PDFBool.True,
  }));
  pdf.catalog.set(PDFName.of("StructTreeRoot"), pdf.context.register(pdf.context.obj({
    Type: "StructTreeRoot",
  })));

  return pdf.save();
}

async function createPdfWithBaseFont(baseFont: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 300]);
  const fontRef = pdf.context.register(pdf.context.obj({
    Type: "Font",
    Subtype: "Type1",
    BaseFont: PDFName.of(baseFont),
  }));
  const resources = page.node.lookupMaybe(PDFName.of("Resources"), PDFDict)
    ?? pdf.context.obj({}) as PDFDict;
  resources.set(PDFName.of("Font"), pdf.context.obj({
    F1: fontRef,
  }));
  page.node.set(PDFName.of("Resources"), resources);

  return pdf.save();
}

function addEmbeddedFile(pdf: PDFDocument, fileName: string, contents: Uint8Array): void {
  const embeddedStreamRef = pdf.context.register(pdf.context.stream(contents, {
    Type: "EmbeddedFile",
    Subtype: "text/plain",
  }));
  const fileSpecRef = pdf.context.register(pdf.context.obj({
    Type: "Filespec",
    F: PDFString.of(fileName),
    UF: PDFHexString.fromText(fileName),
    EF: pdf.context.obj({
      F: embeddedStreamRef,
      UF: embeddedStreamRef,
    }),
  }));
  const namesRoot = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)
    ?? pdf.context.obj({}) as PDFDict;
  namesRoot.set(PDFName.of("EmbeddedFiles"), pdf.context.obj({
    Names: [PDFString.of(fileName), fileSpecRef],
  }));
  pdf.catalog.set(PDFName.of("Names"), namesRoot);
}

async function expectNoDocumentMetadata(contents: Uint8Array): Promise<void> {
  const pdf = await PDFDocument.load(contents, { updateMetadata: false });

  expect(pdf.context.trailerInfo.Info).toBeUndefined();
  expect(pdf.catalog.has(PDFName.of("Metadata"))).toBe(false);

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      expect(object.has(PDFName.of("Metadata"))).toBe(false);
    }
  }
}

function bytes(...contents: number[]): Uint8Array {
  return new Uint8Array(contents);
}

function arrayBuffer(...contents: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(contents.length);
  new Uint8Array(buffer).set(contents);

  return buffer;
}

function toArrayBuffer(contents: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(contents.byteLength);
  new Uint8Array(buffer).set(contents);

  return buffer;
}

function getFormData(call: FetchCall | undefined): FormData {
  expect(call?.init?.body).toBeInstanceOf(FormData);

  return call?.init?.body as FormData;
}

function expectFormField(call: FetchCall | undefined, name: string, value: string): void {
  expect(getFormData(call).get(name)).toBe(value);
}

async function expectFormFile(call: FetchCall | undefined, expectedBytes: readonly number[]): Promise<void> {
  const value = getFormData(call).get("fileInput");
  expect(value).toBeInstanceOf(Blob);

  const fileBytes = new Uint8Array(await (value as Blob).arrayBuffer());
  expect([...fileBytes]).toEqual(expectedBytes);
}

function expectBase64Body(call: FetchCall | undefined, expectedBytes: readonly number[]): void {
  const body = call?.init?.body;
  expect(typeof body).toBe("string");
  expect(body).toBe(btoa(String.fromCharCode(...expectedBytes)));
}

function pathFromUrl(url: string): string {
  return new URL(url).pathname;
}

function queryValue(call: FetchCall | undefined, name: string): string | null {
  expect(call?.url).toBeDefined();

  return new URL(call?.url ?? "").searchParams.get(name);
}

function headerValue(call: FetchCall | undefined, name: string): string | null {
  const headers = call?.init?.headers;
  expect(headers).toBeDefined();

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (Array.isArray(headers)) {
    return new Headers(headers).get(name);
  }

  return new Headers(headers).get(name);
}
