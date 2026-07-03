import {
  createElement,
  type ReactElement,
  type SVGProps,
} from "react";
import spriteMarkup from "./kit/icons.svg?raw";
import "./kit/icons.css";
import type { IconProps } from "./types";

type RpIconName =
  | "arrow-down"
  | "arrow-up"
  | "bates"
  | "bolt-filled"
  | "bolt-outline"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "combine-exhibits"
  | "comment"
  | "comment-marker"
  | "crop"
  | "delete"
  | "drag-handle"
  | "edit"
  | "extract"
  | "highlight"
  | "insert"
  | "minus"
  | "ocr-search"
  | "open"
  | "organize"
  | "plus"
  | "print"
  | "redact"
  | "rotate"
  | "save"
  | "scale"
  | "scrub-metadata"
  | "search"
  | "select-text"
  | "shield-check"
  | "shield-check-bare"
  | "slip-sheet"
  | "split"
  | "undo";

const symbolChildrenById = parseSprite(spriteMarkup);

export interface RpIconProps extends IconProps {
  name: RpIconName;
}

export function RpIcon({
  name,
  size = 20,
  className,
  ...props
}: RpIconProps) {
  const symbolId = `rp-icon-${name}`;
  const children = symbolChildrenById[symbolId] ?? [];
  const classes = [
    "rp-icon",
    name === "bolt-filled" ? "rp-icon--bolt-filled" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={classes}
      {...props}
    >
      <g className="rp-glyph-main">{children}</g>
      <g className="rp-echo rp-echo-1">{children}</g>
      <g className="rp-echo rp-echo-2">{children}</g>
      <g className="rp-echo rp-echo-3">{children}</g>
    </svg>
  );
}

export function RpIconSprite() {
  return (
    <span
      className="rp-icon-sprite"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: spriteMarkup }}
    />
  );
}

function parseSprite(markup: string): Record<string, ReactElement[]> {
  if (typeof DOMParser === "undefined") {
    return {};
  }

  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  const symbols = Array.from(document.querySelectorAll("symbol"));
  const parsed: Record<string, ReactElement[]> = {};

  for (const symbol of symbols) {
    parsed[symbol.id] = Array.from(symbol.children)
      .map((child, index) => domNodeToReactElement(child, `${symbol.id}-${index}`))
      .filter((child): child is ReactElement => child !== null);
  }

  return parsed;
}

function domNodeToReactElement(element: Element, key: string): ReactElement | null {
  const children = Array.from(element.children)
    .map((child, index) => domNodeToReactElement(child, `${key}-${index}`))
    .filter((child): child is ReactElement => child !== null);
  const props: Record<string, string | Record<string, string>> & { key: string } = { key };

  for (const attribute of Array.from(element.attributes)) {
    const name = toReactAttributeName(attribute.name);
    props[name] = name === "style" ? parseStyleAttribute(attribute.value) : attribute.value;
  }

  const tagName = element.tagName.toLowerCase();

  if (!isSvgTagName(tagName)) {
    return null;
  }

  return createElement(tagName, props as SVGProps<SVGElement> & { key: string }, children);
}

function parseStyleAttribute(value: string): Record<string, string> {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((style, declaration) => {
      const [rawProperty, ...rawValue] = declaration.split(":");
      const property = rawProperty?.trim();

      if (!property) {
        return style;
      }

      style[toReactStyleName(property)] = rawValue.join(":").trim();
      return style;
    }, {});
}

function toReactStyleName(property: string): string {
  if (property.startsWith("--")) {
    return property;
  }

  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function toReactAttributeName(name: string): string {
  if (name === "class") {
    return "className";
  }

  if (name === "stroke-width") {
    return "strokeWidth";
  }

  if (name === "stroke-linecap") {
    return "strokeLinecap";
  }

  if (name === "stroke-linejoin") {
    return "strokeLinejoin";
  }

  if (name === "fill-rule") {
    return "fillRule";
  }

  if (name === "clip-rule") {
    return "clipRule";
  }

  return name;
}

function isSvgTagName(tagName: string): tagName is keyof SVGElementTagNameMap {
  return [
    "circle",
    "ellipse",
    "g",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
  ].includes(tagName);
}

export function createKitIcon(name: RpIconName) {
  return function KitIcon({ size = 20, ...props }: IconProps) {
    return <RpIcon {...props} name={name} size={size} />;
  };
}
