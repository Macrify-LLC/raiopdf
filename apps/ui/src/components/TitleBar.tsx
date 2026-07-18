import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { MacrifyMarkIcon, MacrifyWordmarkIcon, RaioWordmarkIcon } from "../icons";
import { runtimePlatform, type RuntimePlatform } from "../lib/runtimePlatform";
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
  /** Deterministic override for component tests; runtime callers use platform detection. */
  platform?: RuntimePlatform;
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
  platform = runtimePlatform(),
}: TitleBarProps) {
  const desktopRuntime = platform !== "web";
  const macOS = platform === "macos";
  const showWindowControls = platform === "windows";
  const hasTabs = tabs.length > 0;
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  const contextTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null;

  useEffect(() => {
    if (!desktopRuntime || platform !== runtimePlatform()) {
      setWindowFocused(true);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) {
          return;
        }
        const window = getCurrentWindow();
        setWindowFocused(await window.isFocused());
        unlisten = await window.onFocusChanged(({ payload }) => setWindowFocused(payload));
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopRuntime, platform]);

  function handleDragRegionDoubleClick(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    void toggleMaximizeWindow();
  }

  function handleTabContextMenu(event: MouseEvent<HTMLElement>, tabId: string) {
    if (!desktopRuntime) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setTabMenu({ tabId, x: event.clientX, y: event.clientY });
  }

  return (
    <header
      className={`title-bar title-bar--${platform}`}
      data-window-focused={windowFocused ? "true" : "false"}
      data-tauri-drag-region
      onDoubleClick={showWindowControls ? handleDragRegionDoubleClick : undefined}
    >
      {macOS ? (
        <span className="title-bar__traffic-light-space" data-tauri-drag-region aria-hidden="true" />
      ) : null}
      <div className="title-bar__brand" data-tauri-drag-region>
        <RaioWordmarkIcon height={24} className="title-bar__wordmark-mark" />
      </div>

      {!macOS ? (
        <MenuBar
          hasDocument={hasDocument}
          canUndo={canUndo}
          wordAvailable={wordAvailable}
          onCommand={(command) => onMenuCommand?.(command)}
          onExit={() => void closeWindow()}
        />
      ) : null}

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
      ) : !macOS ? (
        <p className="title-bar__hint" data-tauri-drag-region>
          Open a PDF to work locally
        </p>
      ) : <span className="title-bar__empty-drag-region" data-tauri-drag-region />}

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
          {macOS ? (
            <MacrifyMarkIcon size={16} className="title-bar__byline-compact-mark" />
          ) : null}
        </button>
        {showWindowControls ? <WindowControls /> : null}
      </div>
      {desktopRuntime && tabMenu && contextTab ? (
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
