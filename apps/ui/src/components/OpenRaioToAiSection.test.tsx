import { describe, expect, it } from "vitest";
import { buildSetupPrompt } from "./OpenRaioToAiSection";

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
