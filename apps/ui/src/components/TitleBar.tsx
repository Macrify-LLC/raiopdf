import type { MouseEvent } from "react";
import { SunMarkIcon } from "../icons";
import "./TitleBar.css";

export interface DocumentTabInfo {
  id: string;
  fileName: string;
  active?: boolean;
  dirty?: boolean;
}

export interface TitleBarProps {
  tabs?: DocumentTabInfo[];
}

export function TitleBar({ tabs = [] }: TitleBarProps) {
  const showWindowControls = isTauriRuntime();
  const hasTabs = tabs.length > 0;

  function handleDragRegionDoubleClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    void toggleMaximizeWindow();
  }

  return (
    <header
      className="title-bar"
      data-tauri-drag-region
      onDoubleClick={handleDragRegionDoubleClick}
    >
      <div className="title-bar__brand" data-tauri-drag-region>
        <span className="title-bar__mark">
          <SunMarkIcon size={22} className="title-bar__mark-icon" />
        </span>
        <span className="title-bar__wordmark">
          Raio<span className="title-bar__wordmark-accent">PDF</span>
        </span>
      </div>

      {hasTabs ? (
        <div className="title-bar__tabs" data-tauri-drag-region>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="title-bar__tab"
              aria-current={tab.active ? "page" : undefined}
            >
              {tab.dirty ? (
                <span
                  className="title-bar__tab-dot"
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                />
              ) : null}
              {tab.fileName}
            </div>
          ))}
        </div>
      ) : (
        <p className="title-bar__hint" data-tauri-drag-region>
          Open a PDF to work locally
        </p>
      )}

      <div className="title-bar__meta" data-tauri-drag-region>
        <span className="title-bar__byline">Built by Macrify</span>
        {showWindowControls ? <WindowControls /> : null}
      </div>
    </header>
  );
}

function WindowControls() {
  return (
    <div className="title-bar__window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="title-bar__window-button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void minimizeWindow()}
      >
        <span className="title-bar__window-glyph title-bar__window-glyph--minimize" />
      </button>
      <button
        type="button"
        className="title-bar__window-button"
        aria-label="Maximize"
        title="Maximize"
        onClick={() => void toggleMaximizeWindow()}
      >
        <span className="title-bar__window-glyph title-bar__window-glyph--maximize" />
      </button>
      <button
        type="button"
        className="title-bar__window-button title-bar__window-button--close"
        aria-label="Close"
        title="Close"
        onClick={() => void closeWindow()}
      >
        <span className="title-bar__window-glyph title-bar__window-glyph--close" />
      </button>
    </div>
  );
}

async function minimizeWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

async function toggleMaximizeWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

async function closeWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
