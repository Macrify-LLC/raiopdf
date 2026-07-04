import macrifyWordmarkMarkup from "../assets/macrify-wordmark.svg?raw";
import "./BrandWordmarks.css";

export interface MacrifyWordmarkIconProps {
  /** Rendered height in px; width follows the source aspect ratio. */
  height?: number;
  className?: string;
  /**
   * Set when the mark sits next to its own text label (e.g. the "Built by"
   * byline button) so the surrounding text already carries the accessible
   * name -- the mark itself becomes decorative rather than double-announced.
   */
  decorative?: boolean;
}

/**
 * The Macrify wordmark -- cropped to its ink, per `logo-system.md`'s "Built
 * by" placement -- inlined via a Vite `?raw` import so its
 * `var(--brand-macrify-navy)` fill resolves against the app's live tokens.
 * An `<img src="...">` would load the SVG in its own document, where that
 * custom property doesn't exist.
 */
export function MacrifyWordmarkIcon({
  height = 16,
  className,
  decorative = false,
}: MacrifyWordmarkIconProps) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Macrify"}
      aria-hidden={decorative ? "true" : undefined}
      className={["inline-brand-wordmark", "macrify-wordmark-icon", className]
        .filter(Boolean)
        .join(" ")}
      style={{ height: `${height}px` }}
      dangerouslySetInnerHTML={{ __html: macrifyWordmarkMarkup }}
    />
  );
}
