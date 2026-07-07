import { describe, expect, it } from "vitest";
import { describeErrorChain } from "./diagnostics";

describe("describeErrorChain", () => {
  it("serializes a simple error", () => {
    expect(describeErrorChain(new Error("boom"))).toBe("Error: boom");
  });

  it("walks the full cause chain so hidden transport detail survives", () => {
    const inner = new TypeError("Failed to fetch");
    const outer = new Error("Local engine request failed.", { cause: inner });

    expect(describeErrorChain(outer)).toBe(
      "Error: Local engine request failed. <- TypeError: Failed to fetch",
    );
  });

  it("includes a string error code when present", () => {
    const error = Object.assign(new Error("qpdf refused"), { code: "INVALID_DOCUMENT" });

    expect(describeErrorChain(error)).toBe("Error[INVALID_DOCUMENT]: qpdf refused");
  });

  it("passes through a raw string cause", () => {
    const error = new Error("wrap", { cause: "read request body: (os error 10035)" });

    expect(describeErrorChain(error)).toBe(
      "Error: wrap <- read request body: (os error 10035)",
    );
  });

  it("does not loop on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(describeErrorChain(a)).toBe("Error: a <- Error: b");
  });

  it("falls back for nullish input", () => {
    expect(describeErrorChain(null)).toBe("unknown error");
    expect(describeErrorChain(undefined)).toBe("unknown error");
  });
});
