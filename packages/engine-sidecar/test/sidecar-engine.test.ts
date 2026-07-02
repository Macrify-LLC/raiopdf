import { PdfEngineError } from "@raiopdf/engine-api";
import { describe, expect, it } from "vitest";
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

  it("reorders pages through rearrange-pages", async () => {
    const { calls, fetchImpl } = createFetch(jsonResponse({ pageCount: 3 }), pdfResponse(9));
    const engine = new SidecarPdfEngine({ baseUrl: "http://127.0.0.1:8080", fetch: fetchImpl });
    const document = await engine.open(bytes(1));

    const reordered = await engine.reorderPages(document, [2, 0, 1]);

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

    const deleted = await engine.deletePages(document, [1]);

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

    const combined = await engine.insertPages(target, 1, inserted);

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

    const merged = await engine.merge([first, second]);

    expect(await engine.saveToBytes(merged)).toEqual(bytes(6));
    expect(calls[2]?.url).toBe("http://127.0.0.1:8080/api/v1/general/merge-pdfs");
    expectFormField(calls[2], "sortType", "orderProvided");
    expectFormField(calls[2], "removeCertSign", "true");
    expectFormField(calls[2], "generateToc", "false");
    expect(getFormData(calls[2]).getAll("fileInput")).toHaveLength(2);
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

function pdfResponse(...contents: number[]): Response {
  return new Response(arrayBuffer(...contents), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
    },
  });
}

function bytes(...contents: number[]): Uint8Array {
  return new Uint8Array(contents);
}

function arrayBuffer(...contents: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(contents.length);
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

function pathFromUrl(url: string): string {
  return new URL(url).pathname;
}
