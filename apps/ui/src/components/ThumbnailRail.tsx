import { useState } from "react";
import "./ThumbnailRail.css";

type LineWidth = "full" | "wide" | "medium" | "narrow";

interface ThumbnailLine {
  width: LineWidth;
  heading?: boolean;
}

interface ThumbnailPage {
  page: number;
  lines: ThumbnailLine[];
}

// Placeholder page content -- stand-ins for real rendered thumbnails until
// the engine-wiring PR lands. Each pattern is hand-varied so the rail reads
// as a real document rather than four identical boxes.
const DEMO_PAGES: ThumbnailPage[] = [
  {
    page: 1,
    lines: [
      { width: "wide", heading: true },
      { width: "medium", heading: true },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
    ],
  },
  {
    page: 2,
    lines: [
      { width: "medium", heading: true },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "medium" },
    ],
  },
  {
    page: 3,
    lines: [
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
    ],
  },
  {
    page: 4,
    lines: [
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "full" },
      { width: "narrow" },
      { width: "medium" },
    ],
  },
];

export interface ThumbnailRailProps {
  pages?: ThumbnailPage[];
  defaultActivePage?: number;
}

export function ThumbnailRail({
  pages = DEMO_PAGES,
  defaultActivePage = 2,
}: ThumbnailRailProps) {
  const [activePage, setActivePage] = useState(defaultActivePage);

  return (
    <nav className="thumbnail-rail" aria-label="Page thumbnails">
      {pages.map((thumbnail) => {
        const isActive = thumbnail.page === activePage;
        return (
          <button
            key={thumbnail.page}
            type="button"
            className="thumbnail"
            data-active={isActive ? "true" : undefined}
            aria-current={isActive ? "true" : undefined}
            aria-label={`Page ${thumbnail.page}`}
            onClick={() => setActivePage(thumbnail.page)}
          >
            <span className="thumbnail__page">
              {thumbnail.lines.map((line, index) => (
                <span
                  key={index}
                  className="thumbnail__line"
                  data-heading={line.heading ? "true" : undefined}
                  data-width={line.width}
                />
              ))}
            </span>
            <span className="thumbnail__number">{thumbnail.page}</span>
          </button>
        );
      })}
    </nav>
  );
}
