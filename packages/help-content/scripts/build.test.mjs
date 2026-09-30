import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  renderMarkdownToSanitizedHtml,
} from "./build.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("help content build script", () => {
  it("parses frontmatter and preserves the markdown body", () => {
    const parsed = parseFrontmatter(`---
id: redact
title: Redact
group: legal
summary: Remove confidential text.
order: 40
---

# Redact

Body text.
`);

    expect(parsed.frontmatter).toEqual({
      id: "redact",
      title: "Redact",
      group: "legal",
      summary: "Remove confidential text.",
      order: 40,
    });
    expect(parsed.body).toContain("# Redact");
  });

  it("strips raw HTML, event attributes, and unsafe hrefs", () => {
    const html = renderMarkdownToSanitizedHtml(`
# Title

Hello <script>alert(1)</script><span onclick="evil()">bad</span>

[good](tool:redact) [external](https://example.com) [js](javascript:alert(1)) [file](file:///tmp/a)
`);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain('<a href="tool:redact">good</a>');
    expect(html).toContain('<a href="https://example.com">external</a>');
    expect(html).toContain("js");
    expect(html).toContain("file");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file:");
    expect(html).not.toContain("<span");
  });

  it("keeps the local ChatGPT/Codex setup and schema-dialect guidance in the article", async () => {
    const markdown = await readFile(
      path.join(packageRoot, "articles", "data-stays-local.md"),
      "utf8",
    );
    const { body } = parseFrontmatter(markdown, "data-stays-local.md");

    expect(body).toContain("ChatGPT desktop app, Codex CLI, and Codex IDE extension");
    expect(body).toContain("STDIO");
    expect(body).toContain("~/.codex/config.toml");
    expect(body).toContain("%USERPROFILE%\\.codex\\config.toml");
    expect(body).toContain("[mcp_servers.raiopdf]");
    expect(body).toContain("JSON Schema **2020-12**");
    expect(body).toContain("draft-07");

    const html = renderMarkdownToSanitizedHtml(body);
    expect(html).toContain("codex mcp add raiopdf");
    expect(html).toContain("mcp_servers.raiopdf");
    expect(html).toContain("JSON Schema <strong>2020-12</strong>");
  });
});
