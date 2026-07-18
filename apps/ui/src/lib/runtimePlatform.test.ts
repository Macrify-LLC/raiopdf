import { describe, expect, it } from "vitest";
import { detectRuntimePlatform } from "./runtimePlatform";

describe("detectRuntimePlatform", () => {
  it("keeps ordinary browsers on the web composition", () => {
    expect(detectRuntimePlatform({ tauri: false, userAgent: "Macintosh" })).toBe("web");
  });

  it("detects the packaged macOS WKWebView", () => {
    expect(detectRuntimePlatform({
      tauri: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    })).toBe("macos");
  });

  it("uses the custom desktop composition for non-Mac Tauri windows", () => {
    expect(detectRuntimePlatform({
      tauri: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    })).toBe("windows");
  });
});
