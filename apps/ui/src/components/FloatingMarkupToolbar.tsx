import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { EditingState } from "../hooks/useEditing";
import type { EditToolId } from "../lib/edits";
import { COMMAND_BAR_EDIT_TOOLS } from "../lib/toolRegistry";
import {
  ArrowLineIcon,
  CalloutIcon,
  CommentIcon,
  DrawIcon,
  EllipseIcon,
  HighlightIcon,
  ImageIcon,
  LineIcon,
  RectangleIcon,
  SelectTextIcon,
  SignIcon,
  StrikethroughIcon,
  TextBoxIcon,
  UnderlineIcon,
} from "../icons";
import "./FloatingMarkupToolbar.css";

const EDIT_TOOL_ICONS: Record<EditToolId, (size: number) => ReactNode> = {
  select: (size) => <SelectTextIcon size={size} />,
  highlight: (size) => <HighlightIcon size={size} />,
  underline: (size) => <UnderlineIcon size={size} />,
  strikethrough: (size) => <StrikethroughIcon size={size} />,
  textBox: (size) => <TextBoxIcon size={size} />,
  callout: (size) => <CalloutIcon size={size} />,
  image: (size) => <ImageIcon size={size} />,
  comment: (size) => <CommentIcon size={size} />,
  draw: (size) => <DrawIcon size={size} />,
  shapeRect: (size) => <RectangleIcon size={size} />,
  shapeEllipse: (size) => <EllipseIcon size={size} />,
  shapeLine: (size) => <LineIcon size={size} />,
  shapeArrow: (size) => <ArrowLineIcon size={size} />,
  sign: (size) => <SignIcon size={size} />,
};

const GROUP_ENDS = new Set<EditToolId>([
  "select",
  "strikethrough",
  "image",
  "comment",
  "shapeArrow",
]);

export interface FloatingMarkupToolbarProps {
  editing: EditingState;
}

export function FloatingMarkupToolbar({ editing }: FloatingMarkupToolbarProps) {
  const activeIndex = Math.max(
    0,
    COMMAND_BAR_EDIT_TOOLS.findIndex((tool) => tool.id === editing.tool),
  );
  const [tabStopIndex, setTabStopIndex] = useState(activeIndex);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setTabStopIndex(activeIndex);
  }, [activeIndex]);

  function focusButton(index: number) {
    setTabStopIndex(index);
    buttonRefs.current[index]?.focus();
  }

  function moveFocus(delta: number) {
    const nextIndex =
      (tabStopIndex + delta + COMMAND_BAR_EDIT_TOOLS.length) % COMMAND_BAR_EDIT_TOOLS.length;
    focusButton(nextIndex);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        focusButton(0);
        break;
      case "End":
        event.preventDefault();
        focusButton(COMMAND_BAR_EDIT_TOOLS.length - 1);
        break;
      default:
        break;
    }
  }

  function toggleTool(toolId: EditToolId) {
    editing.setTool(editing.tool === toolId && toolId !== "select" ? "select" : toolId);
  }

  return (
    <div
      className="floating-markup-toolbar"
      role="toolbar"
      aria-label="Markup tools"
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
    >
      {COMMAND_BAR_EDIT_TOOLS.map((tool, index) => {
        const active = editing.tool === tool.id;

        return (
          <span className="floating-markup-toolbar__item" key={tool.id}>
            <button
              ref={(button) => {
                buttonRefs.current[index] = button;
              }}
              type="button"
              className="floating-markup-toolbar__button"
              data-active={active ? "true" : undefined}
              aria-label={tool.label}
              aria-pressed={active}
              title={tool.tooltip}
              tabIndex={index === tabStopIndex ? 0 : -1}
              onFocus={() => setTabStopIndex(index)}
              onClick={() => toggleTool(tool.id)}
            >
              <span className="floating-markup-toolbar__icon" aria-hidden="true">
                {EDIT_TOOL_ICONS[tool.id](17)}
              </span>
              {/* The name rides in the DOM for every button but is collapsed to
                  zero width by CSS; it expands on hover and for the active tool
                  so the top strip stays compact but still shows tool names. */}
              <span className="floating-markup-toolbar__label">{tool.label}</span>
            </button>
            {GROUP_ENDS.has(tool.id) && index < COMMAND_BAR_EDIT_TOOLS.length - 1 ? (
              <span className="floating-markup-toolbar__divider" aria-hidden="true" />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
