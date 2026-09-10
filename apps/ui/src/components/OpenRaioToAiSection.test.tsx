// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenRaioToAiSection,
  buildCodexTomlSnippet,
  buildSetupPrompt,
  tomlString,
} from "./OpenRaioToAiSection";

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

  it("steers the assistant to Claude Desktop's own Edit Config and to merge, not replace", () => {
    // A pasted prompt once led an assistant to guess %APPDATA%\Claude (wrong for a
    // Microsoft Store install) and then to select-all-and-replace the file it found,
    // which held the app's own settings. The prompt has to head both off.
    const prompt = buildSetupPrompt("C:\\Users\\me\\AppData\\Local\\RaioPDF\\raiopdf-mcp.exe");

    expect(prompt).toContain("Settings → Developer → Edit Config");
    expect(prompt).toMatch(/merging it into whatever the file already contains/i);
    expect(prompt).toMatch(/never replace the file/i);
    expect(prompt).toContain("backup");
    expect(prompt).toContain("Cowork");
    expect(prompt).toMatch(/fully quit/i);
  });

  it("covers the ChatGPT desktop app / Codex and rules out browser ChatGPT", () => {
    const prompt = buildSetupPrompt("C:\\Users\\me\\AppData\\Local\\RaioPDF\\raiopdf-mcp.exe");

    expect(prompt).toContain('codex mcp add raiopdf -- "C:\\Users\\me\\AppData\\Local\\RaioPDF\\raiopdf-mcp.exe"');
    expect(prompt).toContain("[mcp_servers.raiopdf]");
    expect(prompt).toContain("command = 'C:\\Users\\me\\AppData\\Local\\RaioPDF\\raiopdf-mcp.exe'");
    expect(prompt).toContain("~/.codex/config.toml");
    expect(prompt).toMatch(/web browser only connects to remote HTTPS servers/);
    expect(prompt).toMatch(/don't try to expose the connector to the internet/);
  });
});

describe("Codex config.toml snippet", () => {
  it("keeps Windows backslashes verbatim in a TOML literal string", () => {
    // A basic (double-quoted) TOML string treats \U in C:\Users as an escape and the
    // Codex / ChatGPT desktop app then refuses the whole config file on startup.
    expect(buildCodexTomlSnippet("C:\\Users\\me\\RaioPDF\\raiopdf-mcp.exe")).toBe(
      "[mcp_servers.raiopdf]\ncommand = 'C:\\Users\\me\\RaioPDF\\raiopdf-mcp.exe'",
    );
  });

  it("uses a POSIX path as-is", () => {
    expect(buildCodexTomlSnippet("/Applications/RaioPDF.app/Contents/MacOS/raiopdf-mcp")).toBe(
      "[mcp_servers.raiopdf]\ncommand = '/Applications/RaioPDF.app/Contents/MacOS/raiopdf-mcp'",
    );
  });

  it("falls back to an escaped basic string when the path contains a single quote", () => {
    expect(tomlString("C:\\Users\\O'Brien\\raiopdf-mcp.exe")).toBe(
      '"C:\\\\Users\\\\O\'Brien\\\\raiopdf-mcp.exe"',
    );
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
