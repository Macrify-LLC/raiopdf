import { CanvasWell } from "./CanvasWell";
import { CommandBar } from "./CommandBar";
import { StatusBar } from "./StatusBar";
import { ThumbnailRail } from "./ThumbnailRail";
import { TitleBar } from "./TitleBar";
import { ToolPanel } from "./ToolPanel";
import "./AppShell.css";

export interface AppShellProps {
  /**
   * Fired from every "Open a PDF" entry point (command bar + canvas empty
   * state). No-op by default -- this PR ships static chrome only; the
   * engine-wiring PR supplies real file-opening logic.
   */
  onOpenRequested?: (() => void) | undefined;
}

export function AppShell({ onOpenRequested }: AppShellProps) {
  return (
    <div className="app-shell">
      <div className="app-shell__accent-bar" aria-hidden="true" />
      <TitleBar />
      <CommandBar onOpen={onOpenRequested} />
      <div className="app-shell__body">
        <ThumbnailRail />
        <CanvasWell onOpenRequested={onOpenRequested} />
        <ToolPanel />
      </div>
      <StatusBar />
    </div>
  );
}
