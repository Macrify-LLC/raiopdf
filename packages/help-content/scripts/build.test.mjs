import { describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  renderMarkdownToSanitizedHtml,
} from "./build.mjs";

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
});
