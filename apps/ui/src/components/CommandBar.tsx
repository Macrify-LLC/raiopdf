import { useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  HighlightIcon,
  MinusIcon,
  OpenIcon,
  PlusIcon,
  PrintIcon,
  SaveIcon,
  SearchIcon,
  SelectTextIcon,
  UndoIcon,
} from "../icons";
import { IconButton } from "./IconButton";
import "./CommandBar.css";

type EditTool = "select-text" | "highlight";

export interface CommandBarProps {
  onOpen?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  onPrint?: (() => void) | undefined;
}

export function CommandBar({ onOpen, onSave, onPrint }: CommandBarProps) {
  const [activeTool, setActiveTool] = useState<EditTool>("select-text");

  return (
    <div className="command-bar">
      <div className="command-bar__group">
        <IconButton icon={<OpenIcon size={17} />} label="Open" onClick={onOpen} />
        <IconButton icon={<SaveIcon size={17} />} label="Save" onClick={onSave} />
        <IconButton icon={<PrintIcon size={17} />} label="Print" onClick={onPrint} />
      </div>

      <span className="command-bar__divider" aria-hidden="true" />

      <div className="command-bar__group">
        <IconButton icon={<UndoIcon size={17} />} label="Undo" disabled />
        <IconButton
          icon={<SelectTextIcon size={17} />}
          label="Select text"
          active={activeTool === "select-text"}
          onClick={() => setActiveTool("select-text")}
        />
        <IconButton
          icon={<HighlightIcon size={17} />}
          label="Highlight"
          active={activeTool === "highlight"}
          onClick={() => setActiveTool("highlight")}
        />
      </div>

      <div className="command-bar__center">
        <div className="command-bar__page-nav">
          <IconButton icon={<ChevronLeftIcon size={15} />} label="Previous page" />
          <span className="command-bar__page-label">
            Page <b>2</b> / 14
          </span>
          <IconButton icon={<ChevronRightIcon size={15} />} label="Next page" />
        </div>

        <span className="command-bar__divider" aria-hidden="true" />

        <div className="command-bar__zoom">
          <IconButton icon={<MinusIcon size={15} />} label="Zoom out" />
          <span className="command-bar__zoom-label">100%</span>
          <IconButton icon={<PlusIcon size={15} />} label="Zoom in" />
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
