import type { SVGProps } from "react";

/**
 * Shared prop contract for every RaioPDF icon.
 *
 * All icons share one 20px viewBox grid and a 1.5px stroke by default, per
 * the design spec's iconography rules. `size` controls the rendered
 * width/height while the viewBox stays fixed, so stroke weight stays
 * proportionally consistent at every call site.
 */
export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

export const ICON_VIEWBOX = "0 0 20 20";
export const ICON_STROKE_WIDTH = 1.5;
