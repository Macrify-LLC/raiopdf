import type { ReactNode } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CommentIcon,
  DrawIcon,
  HighlightIcon,
  ImageIcon,
  MinusIcon,
  OpenIcon,
  PlusIcon,
  PrintIcon,
  SaveIcon,
  SearchIcon,
  SelectTextIcon,
  SignIcon,
  TextBoxIcon,
  UndoIcon,
} from "../icons";
import type { EditToolId } from "../lib/edits";
import { IconButton } from "./IconButton";
import "./CommandBar.css";

const EDIT_TOOLS: ReadonlyArray<{
  id: EditToolId;
  label: string;
  icon: (size: number) => ReactNode;
}> = [
  { id: "select", label: "Select", icon: (size) => <SelectTextIcon size={size} /> },
  { id: "highlight", label: "Highlight", icon: (size) => <HighlightIcon size={size} /> },
  { id: "textBox", label: "Text box", icon: (size) => <TextBoxIcon size={size} /> },
  { id: "image", label: "Image", icon: (size) => <ImageIcon size={size} /> },
  { id: "comment", label: "Comment", icon: (size) => <CommentIcon size={size} /> },
  { id: "draw", label: "Draw", icon: (size) => <DrawIcon size={size} /> },
  { id: "sign", label: "Sign", icon: (size) => <SignIcon size={size} /> },
];

export interface CommandBarProps {
  onOpen?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  onPrint?: (() => void) | undefined;
  onPreviousPage?: (() => void) | undefined;
  onNextPage?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onZoomIn?: (() => void) | undefined;
  currentPage?: number;
  pageCount?: number;
  zoom?: number;
  hasDocument?: boolean;
  editTool?: EditToolId;
  onEditToolChange?: ((tool: EditToolId) => void) | undefined;
}

export function CommandBar({
  onOpen,
  onSave,
  onPrint,
  onPreviousPage,
  onNextPage,
  onZoomOut,
  onZoomIn,
  currentPage = 1,
  pageCount = 0,
  zoom = 1,
  hasDocument = false,
  editTool = "select",
  onEditToolChange,
}: CommandBarProps) {
  function toggleTool(toolId: EditToolId) {
    // Tools are mutually exclusive toggles; re-clicking the active tool
    // returns to Select, like every other mode toggle in the app.
    onEditToolChange?.(editTool === toolId && toolId !== "select" ? "select" : toolId);
  }

  return (
    <div className="command-bar">
      <div className="command-bar__group">
        <IconButton icon={<OpenIcon size={17} />} label="Open" onClick={onOpen} />
        <IconButton
          icon={<SaveIcon size={17} />}
          label="Save"
          onClick={onSave}
          disabled={!hasDocument}
        />
        <IconButton icon={<PrintIcon size={17} />} label="Print" onClick={onPrint} />
      </div>

      <span className="command-bar__divider" aria-hidden="true" />

      <div className="command-bar__group">
        <IconButton icon={<UndoIcon size={17} />} label="Undo" disabled />
        {EDIT_TOOLS.map((tool) => (
          <IconButton
            key={tool.id}
            icon={tool.icon(17)}
            label={tool.label}
            active={editTool === tool.id}
            disabled={!hasDocument && tool.id !== "select"}
            onClick={() => toggleTool(tool.id)}
          />
        ))}
      </div>

      <div className="command-bar__center">
        <div className="command-bar__page-nav">
          <IconButton
            icon={<ChevronLeftIcon size={15} />}
            label="Previous page"
            onClick={onPreviousPage}
            disabled={!hasDocument || currentPage <= 1}
          />
          {hasDocument ? (
            <span className="command-bar__page-label">
              Page <b>{currentPage}</b> / {pageCount}
            </span>
          ) : (
            <span className="command-bar__page-label">No document</span>
          )}
          <IconButton
            icon={<ChevronRightIcon size={15} />}
            label="Next page"
            onClick={onNextPage}
            disabled={!hasDocument || currentPage >= pageCount}
          />
        </div>

        <span className="command-bar__divider" aria-hidden="true" />

        <div className="command-bar__zoom">
          <IconButton
            icon={<MinusIcon size={15} />}
            label="Zoom out"
            onClick={onZoomOut}
            disabled={!hasDocument || zoom <= 0.25}
          />
          <span className="command-bar__zoom-label">{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={<PlusIcon size={15} />}
            label="Zoom in"
            onClick={onZoomIn}
            disabled={!hasDocument || zoom >= 4}
          />
        </div>
      </div>

      <label className="command-bar__search">
        <SearchIcon size={13} />
        <input
          type="search"
          placeholder="Search document"
          aria-label="Search document"
        />
      </label>
    </div>
  );
}
