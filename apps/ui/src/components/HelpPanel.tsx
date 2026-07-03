import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { helpArticles, type HelpArticle } from "@raiopdf/help-content";
import { SearchIcon } from "../icons";
import { FloatingDialog } from "./FloatingDialog";
import "./HelpPanel.css";

const HELP_GROUPS = [
  { id: "getting-started", label: "Getting Started" },
  { id: "edit", label: "Edit" },
  { id: "comment-ocr", label: "Comment & OCR" },
  { id: "organize", label: "Organize" },
  { id: "legal", label: "Legal" },
  { id: "preferences", label: "Preferences" },
] as const;

const articleById = new Map<string, HelpArticle>(helpArticles.map((article) => [article.id, article]));
const defaultArticleId = articleById.has("getting-started")
  ? "getting-started"
  : helpArticles[0]?.id ?? "";

export interface HelpPanelProps {
  onClose: () => void;
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const [selectedArticleId, setSelectedArticleId] = useState<string>(defaultArticleId);
  const [query, setQuery] = useState("");
  const [externalLinkNote, setExternalLinkNote] = useState<string | null>(null);
  const articleRegionId = useId();
  const resultCountId = useId();
  const article = articleById.get(selectedArticleId) ?? helpArticles[0] ?? null;
  const filteredGroups = useMemo(() => groupArticles(query), [query]);
  const visibleArticles = filteredGroups.flatMap((group) => group.articles);
  const indexButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  function selectArticle(articleId: string) {
    setSelectedArticleId(articleId);
    setExternalLinkNote(null);
  }

  function handleArticleClick(event: MouseEvent<HTMLElement>) {
    const anchor = (event.target as HTMLElement).closest("a");

    if (!anchor) {
      return;
    }

    const href = anchor.getAttribute("href") ?? "";

    if (href.startsWith("tool:")) {
      event.preventDefault();
      const targetArticleId = href.slice("tool:".length);

      if (articleById.has(targetArticleId)) {
        selectArticle(targetArticleId);
      }

      return;
    }

    if (href.startsWith("https:")) {
      event.preventDefault();
      setExternalLinkNote("External links open in Phase 2.");
    }
  }

  function handleIndexKeyDown(event: KeyboardEvent<HTMLButtonElement>, articleId: string) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    const currentIndex = visibleArticles.findIndex((candidate) => candidate.id === articleId);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextArticle = visibleArticles[currentIndex + direction];

    if (nextArticle) {
      selectArticle(nextArticle.id);
      indexButtonRefs.current.get(nextArticle.id)?.focus();
    }
  }

  return (
    <FloatingDialog
      title="Help"
      eyebrow="RaioPDF"
      width="lg"
      draggable={false}
      onClose={onClose}
    >
      <div className="help-panel">
        <aside className="help-panel__index" aria-label="Help articles">
          <label className="help-panel__search">
            <SearchIcon size={13} />
            <input
              type="search"
              value={query}
              aria-describedby={resultCountId}
              placeholder="Search help"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <p id={resultCountId} className="help-panel__count" aria-live="polite">
            {formatResultCount(visibleArticles.length)}
          </p>
          <div className="help-panel__groups">
            {filteredGroups.map((group) => (
              <section key={group.id} className="help-panel__group">
                <h3>{group.label}</h3>
                {group.articles.length ? (
                  <ul>
                    {group.articles.map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          ref={(button) => {
                            if (button) {
                              indexButtonRefs.current.set(candidate.id, button);
                            } else {
                              indexButtonRefs.current.delete(candidate.id);
                            }
                          }}
                          type="button"
                          className="help-panel__article-button"
                          data-selected={candidate.id === article?.id ? "true" : undefined}
                          aria-current={candidate.id === article?.id ? "page" : undefined}
                          onClick={() => selectArticle(candidate.id)}
                          onKeyDown={(event) => handleIndexKeyDown(event, candidate.id)}
                        >
                          <span>{candidate.title}</span>
                          <small>{candidate.summary}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="help-panel__empty-group">No Phase 1 articles.</p>
                )}
              </section>
            ))}
          </div>
        </aside>
        <article
          className="help-panel__article"
          aria-labelledby={articleRegionId}
          onClick={handleArticleClick}
        >
          {article ? (
            <>
              <h3 id={articleRegionId} className="help-panel__region-label">Article</h3>
              <div
                className="help-panel__article-body"
                dangerouslySetInnerHTML={{ __html: article.html }}
              />
              {externalLinkNote ? (
                <p className="help-panel__external-note" role="status">
                  {externalLinkNote}
                </p>
              ) : null}
            </>
          ) : (
            <p className="help-panel__empty-group">No help articles are available.</p>
          )}
        </article>
      </div>
    </FloatingDialog>
  );
}

function groupArticles(query: string) {
  const normalizedQuery = normalize(query);
  const ranked = helpArticles
    .map((article) => ({
      article,
      rank: getSearchRank(article, normalizedQuery),
    }))
    .filter(({ rank }) => rank > 0)
    .sort((left, right) => (
      left.rank - right.rank ||
      left.article.order - right.article.order ||
      left.article.title.localeCompare(right.article.title)
    ))
    .map(({ article }) => article);

  const source = normalizedQuery ? ranked : [...helpArticles].sort(compareArticles);

  return HELP_GROUPS.map((group) => ({
    ...group,
    articles: source
      .filter((article) => article.group === group.id)
      .sort((left, right) => (
        normalizedQuery ? 0 : compareArticles(left, right)
      )),
  }));
}

function getSearchRank(article: typeof helpArticles[number], query: string) {
  if (!query) {
    return 1;
  }

  if (normalize(article.title).includes(query)) {
    return 1;
  }

  if (normalize(article.summary).includes(query)) {
    return 2;
  }

  if (normalize(article.plainText).includes(query)) {
    return 3;
  }

  return 0;
}

function compareArticles(left: typeof helpArticles[number], right: typeof helpArticles[number]) {
  return left.order - right.order || left.title.localeCompare(right.title);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatResultCount(count: number) {
  if (count === 1) {
    return "1 article";
  }

  return `${count} articles`;
}
