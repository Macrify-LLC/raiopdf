import { useState, type MouseEvent, type ReactNode } from "react";
import { MacrifyWordmarkIcon, RaioWordmarkIcon } from "../icons";
import { ContextMenu } from "./ContextMenu";
import { MenuBar } from "./MenuBar";
import "./TitleBar.css";

export interface DocumentTabInfo {
  id: string;
  fileName: string;
  active?: boolean;
  dirty?: boolean;
  canMoveToNewWindow?: boolean;
}

export interface TitleBarProps {
  tabs?: DocumentTabInfo[];
  onTabSelected?: (tabId: string) => void;
  onTabCloseRequested?: (tabId: string) => void;
  onTabMoveToNewWindowRequested?: (tabId: string) => void;
  onOpenAbout?: () => void;
  /** Gates every File-menu action that operates on the open document. */
  hasDocument?: boolean;
  /** Gates Edit > Undo in the menu bar. */
  canUndo?: boolean;
  /** Whether Microsoft Word was detected -- gates the Word-dependent menu items. */
  wordAvailable?: boolean;
  /**
   * Shared dispatch for the menu bar -- the same function App wires to the
   * native `raiopdf-menu` Tauri event, so both entry points funnel through
   * one switch statement.
   */
  onMenuCommand?: (command: string) => void;
  /** Optional update indicator (the UpdatePill), rendered in the right-side meta area. */
  updateSlot?: ReactNode;
}

export function TitleBar({
  tabs = [],
  onTabSelected,
  onTabCloseRequested,
  onTabMoveToNewWindowRequested,
  onOpenAbout,
  hasDocument = false,
  canUndo = false,
  wordAvailable = true,
  onMenuCommand,
  updateSlot,
}: TitleBarProps) {
  const showWindowControls = isTauriRuntime();
  const hasTabs = tabs.length > 0;
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const contextTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null;

  function handleDragRegionDoubleClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    void toggleMaximizeWindow();
  }

  function handleTabContextMenu(event: MouseEvent<HTMLElement>, tabId: string) {
    if (!showWindowControls) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setTabMenu({ tabId, x: event.clientX, y: event.clientY });
  }

  return (
    <header
      className="title-bar"
      data-tauri-drag-region
      onDoubleClick={handleDragRegionDoubleClick}
    >
      <div className="title-bar__brand" data-tauri-drag-region>
        <RaioWordmarkIcon height={24} className="title-bar__wordmark-mark" />
      </div>

      <MenuBar
        hasDocument={hasDocument}
        canUndo={canUndo}
        wordAvailable={wordAvailable}
        onCommand={(command) => onMenuCommand?.(command)}
        onExit={() => void closeWindow()}
      />

      {hasTabs ? (
        <div
          className="title-bar__tabs"
          role="tablist"
          aria-label="Open documents"
          data-tauri-drag-region
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="title-bar__tab"
              data-active={tab.active ? "true" : undefined}
              onContextMenu={(event) => handleTabContextMenu(event, tab.id)}
            >
              <button
                type="button"
                className="title-bar__tab-button"
                role="tab"
                aria-selected={tab.active ? "true" : "false"}
                tabIndex={tab.active ? 0 : -1}
                title={tab.fileName}
                onClick={() => onTabSelected?.(tab.id)}
              >
                {tab.dirty ? (
                  <span
                    className="title-bar__tab-dot"
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                  />
                ) : null}
                <span className="title-bar__tab-name">{tab.fileName}</span>
              </button>
              <button
                type="button"
                className="title-bar__tab-close"
                aria-label={`Close ${tab.fileName}`}
                title={`Close ${tab.fileName}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onTabCloseRequested?.(tab.id);
                }}
              >
                <span aria-hidden="true">x</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="title-bar__hint" data-tauri-drag-region>
          Open a PDF to work locally
        </p>
      )}

      <div className="title-bar__meta" data-tauri-drag-region>
        {updateSlot}
        <button
          type="button"
          className="title-bar__byline"
          onClick={onOpenAbout}
          title="About Macrify"
          aria-label="Built by Macrify"
        >
          <span className="title-bar__byline-text">Built by</span>
          <MacrifyWordmarkIcon height={16} decorative className="title-bar__byline-mark" />
        </button>
        {showWindowControls ? <WindowControls /> : null}
      </div>
      {showWindowControls && tabMenu && contextTab ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={[
            {
              label: "Move to New Window",
              disabled: !contextTab.canMoveToNewWindow,
              onSelect: () => onTabMoveToNewWindowRequested?.(contextTab.id),
            },
          ]}
          onClose={() => setTabMenu(null)}
        />
      ) : null}
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
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
