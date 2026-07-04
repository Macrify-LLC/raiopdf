import wordmarkMarkup from "../assets/raiopdf-wordmark-full.svg?raw";
import "./BrandWordmarks.css";

export interface RaioWordmarkIconProps {
  /** Rendered height in px; width follows the source aspect ratio. */
  height?: number;
  className?: string;
}

/**
 * The real RaioPDF wordmark -- sun mark + "RaioPDF" lockup as one file --
 * inlined via a Vite `?raw` import so its `var(--identity-amber)` /
 * `var(--identity-amber-bright)` / `var(--identity-navy)` fills resolve
 * against the app's live tokens. An `<img src="...">` would load the SVG in
 * its own document, where those custom properties don't exist.
 */
export function RaioWordmarkIcon({ height = 24, className }: RaioWordmarkIconProps) {
  return (
    <span
      role="img"
      aria-label="RaioPDF"
      className={["inline-brand-wordmark", "raio-wordmark-icon", className]
        .filter(Boolean)
        .join(" ")}
      style={{ height: `${height}px` }}
      dangerouslySetInnerHTML={{ __html: wordmarkMarkup }}
    />
  );
}
