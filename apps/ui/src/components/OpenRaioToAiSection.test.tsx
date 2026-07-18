// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRaioToAiSection, buildSetupPrompt } from "./OpenRaioToAiSection";

describe("buildSetupPrompt", () => {
  it("includes the resolved path, both registration snippets, and the docs link", () => {
    const command = "/Applications/RaioPDF.app/Contents/MacOS/raiopdf-mcp";
    const prompt = buildSetupPrompt(command);

    expect(prompt).toContain(command);
    expect(prompt).toContain("claude mcp add raiopdf");
    expect(prompt).toContain('"mcpServers"');
    expect(prompt).toContain('"raiopdf"');
    expect(prompt).toContain("docs/MCP.md");
  });

  it("falls back to the placeholder path when Raio hasn't resolved its install path yet", () => {
    const prompt = buildSetupPrompt("<RAIOPDF_MCP_PATH>");

    expect(prompt).toContain("<RAIOPDF_MCP_PATH>");
  });
});

describe("OpenRaioToAiSection guided prompt fallback", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  it("keeps the selectable prompt on screen after a copy failure, past the label timeout", () => {
    vi.useFakeTimers();
    // Force copy() down its synchronous clipboard-unavailable branch.
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <OpenRaioToAiSection enabled onToggle={() => {}} mcpPath="/opt/raiopdf/raiopdf-mcp" />,
      );
    });

    // The prompt text is not rendered anywhere until a copy attempt fails.
    expect(container!.textContent).not.toContain("Please set it up for me");

    const button = container!.querySelector<HTMLButtonElement>(".open-raio-to-ai__guided-button");
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Failure reveals the selectable prompt.
    expect(container!.textContent).toContain("Please set it up for me");

    // The transient "Could not copy" label clears after its timeout, but the
    // selectable fallback must survive so the user can still hand-copy it.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(container!.textContent).toContain("Please set it up for me");

    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    }
  });
});
