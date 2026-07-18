import { describe, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "./pdfjs";
import { getPdfPageTextContent } from "./pdfTextContent";

describe("getPdfPageTextContent", () => {
  it("reads text streams without requiring ReadableStream async iteration", async () => {
    const releaseLock = vi.fn();
    const chunks = [
      {
        value: {
          items: [{ str: "First" }],
          styles: { body: { fontFamily: "sans-serif" } },
          lang: "en",
        },
        done: false,
      },
      {
        value: {
          items: [{ str: "Second" }],
          styles: { bold: { fontFamily: "sans-serif" } },
          lang: null,
        },
        done: false,
      },
      { value: undefined, done: true },
    ];
    const page = {
      streamTextContent: () => ({
        getReader: () => ({
          read: vi.fn(async () => chunks.shift()),
          releaseLock,
        }),
      }),
    } as unknown as PDFPageProxy;

    const content = await getPdfPageTextContent(page);

    expect(content.items).toEqual([{ str: "First" }, { str: "Second" }]);
    expect(Object.keys(content.styles)).toEqual(["body", "bold"]);
    expect(content.lang).toBe("en");
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
