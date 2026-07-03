import { describe, expect, it } from "vitest";
import { helpArticles } from "@raiopdf/help-content";
import { TOOL_REGISTRY } from "./toolRegistry";

const KNOWN_GROUPS = new Set([
  "getting-started",
  "edit",
  "comment-ocr",
  "organize",
  "legal",
  "preferences",
]);

const KNOWN_HELP_ONLY_ARTICLE_IDS = new Set([
  "getting-started",
  "data-stays-local",
]);

describe("help content completeness", () => {
  it("keeps the runtime tool registry and generated articles in sync", () => {
    const articleIds = new Set<string>();
    const duplicateArticleIds = new Set<string>();

    for (const article of helpArticles) {
      if (articleIds.has(article.id)) {
        duplicateArticleIds.add(article.id);
      }

      articleIds.add(article.id);
      expect(KNOWN_GROUPS.has(article.group), `${article.id} uses a known group`).toBe(true);
    }

    expect([...duplicateArticleIds]).toEqual([]);

    const registryTargets = new Set<string>(TOOL_REGISTRY.map((tool) => tool.helpArticleId));

    for (const tool of TOOL_REGISTRY) {
      const mappedArticleExists = articleIds.has(tool.helpArticleId);

      expect(
        mappedArticleExists,
        `${tool.id} should map to a shipped article`,
      ).toBe(true);
    }

    const orphanArticleIds = helpArticles
      .map((article) => article.id)
      .filter((articleId) => (
        !registryTargets.has(articleId) &&
        !KNOWN_HELP_ONLY_ARTICLE_IDS.has(articleId)
      ));

    expect(orphanArticleIds).toEqual([]);

    const shippedArticleIds = new Set<string>(helpArticles.map((article) => article.id));

    for (const article of helpArticles) {
      const toolLinks = [...article.html.matchAll(/href="tool:([^"]+)"/gu)]
        .map((match) => match[1])
        .filter((target): target is string => Boolean(target));

      for (const target of toolLinks) {
        expect(
          shippedArticleIds.has(target),
          `${article.id} links to shipped help article ${target}`,
        ).toBe(true);
      }
    }
  });
});
