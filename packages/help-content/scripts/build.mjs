import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const marked = new Marked({ gfm: true });
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const articlesDir = path.join(packageRoot, "articles");
const outputFile = path.join(packageRoot, "dist", "index.ts");

export const KNOWN_GROUPS = new Set([
  "getting-started",
  "edit",
  "comment-ocr",
  "organize",
  "legal",
  "preferences",
]);

export function parseFrontmatter(markdown, sourceName = "article.md") {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(normalized);

  if (!match) {
    throw new Error(`${sourceName} is missing frontmatter`);
  }

  const frontmatter = {};
  const rawFrontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  for (const line of rawFrontmatter.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const separator = line.indexOf(":");

    if (separator === -1) {
      throw new Error(`${sourceName} has invalid frontmatter line: ${line}`);
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    frontmatter[key] = key === "order" ? Number(rawValue) : unquote(rawValue);
  }

  const required = ["id", "title", "group", "summary", "order"];

  for (const key of required) {
    if (frontmatter[key] === undefined || frontmatter[key] === "") {
      throw new Error(`${sourceName} is missing frontmatter field: ${key}`);
    }
  }

  if (!Number.isFinite(frontmatter.order)) {
    throw new Error(`${sourceName} has invalid order frontmatter`);
  }

  if (!KNOWN_GROUPS.has(frontmatter.group)) {
    throw new Error(`${sourceName} has unknown group: ${frontmatter.group}`);
  }

  return {
    frontmatter,
    body,
  };
}

export function renderMarkdownToSanitizedHtml(markdown) {
  const tokens = marked.lexer(markdown);
  return renderBlockTokens(tokens);
}

export async function buildHelpContent() {
  const entries = [];
  const fileNames = (await readdir(articlesDir))
    .filter((fileName) => fileName.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of fileNames) {
    const filePath = path.join(articlesDir, fileName);
    const markdown = await readFile(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(markdown, fileName);

    entries.push({
      id: frontmatter.id,
      title: frontmatter.title,
      group: frontmatter.group,
      summary: frontmatter.summary,
      order: frontmatter.order,
      html: renderMarkdownToSanitizedHtml(body),
      plainText: body.trim(),
    });
  }

  entries.sort((left, right) => (
    left.group.localeCompare(right.group) ||
    left.order - right.order ||
    left.title.localeCompare(right.title)
  ));

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, formatGeneratedModule(entries), "utf8");
}

function formatGeneratedModule(entries) {
  return [
    "export interface HelpArticle {",
    "  id: string;",
    "  title: string;",
    "  group: string;",
    "  summary: string;",
    "  order: number;",
    "  html: string;",
    "  plainText: string;",
    "}",
    "",
    "export const helpArticles = " + JSON.stringify(entries, null, 2) + " as const satisfies readonly HelpArticle[];",
    "",
  ].join("\n");
}

function renderBlockTokens(tokens) {
  return tokens.map(renderBlockToken).join("");
}

function renderBlockToken(token) {
  switch (token.type) {
    case "heading": {
      const depth = Math.min(Math.max(token.depth, 1), 4);
      return `<h${depth}>${renderInlineTokens(token.tokens ?? [])}</h${depth}>`;
    }
    case "paragraph":
      return `<p>${renderInlineTokens(token.tokens ?? [])}</p>`;
    case "list": {
      const tag = token.ordered ? "ol" : "ul";
      const items = token.items
        .map((item) => `<li>${renderListItem(item)}</li>`)
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "space":
      return "";
    default:
      return "";
  }
}

function renderListItem(item) {
  const inline = item.tokens?.length === 1 && item.tokens[0]?.type === "text"
    ? renderInlineTokens(item.tokens[0].tokens ?? [])
    : "";

  if (inline) {
    return inline;
  }

  return renderBlockTokens(item.tokens ?? []);
}

function renderInlineTokens(tokens) {
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token) {
  switch (token.type) {
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens) : escapeHtml(token.text ?? "");
    case "strong":
      return `<strong>${renderInlineTokens(token.tokens ?? [])}</strong>`;
    case "em":
      return `<em>${renderInlineTokens(token.tokens ?? [])}</em>`;
    case "codespan":
      return `<code>${escapeHtml(token.text ?? "")}</code>`;
    case "link": {
      const label = renderInlineTokens(token.tokens ?? []);
      const href = String(token.href ?? "");

      if (!isAllowedHref(href)) {
        return label;
      }

      return `<a href="${escapeAttribute(href)}">${label}</a>`;
    }
    case "br":
      return " ";
    default:
      return "";
  }
}

function isAllowedHref(href) {
  return href.startsWith("tool:") || href.startsWith("https:");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildHelpContent();
}
