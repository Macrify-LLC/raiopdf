import { BoltIcon, OpenIcon } from "../icons";
import "./CanvasWell.css";

export interface CanvasWellProps {
  /**
   * Fired when the primary "Open a PDF" action is used. No-op by default --
   * this PR ships static chrome only, the engine-wiring PR supplies real
   * file-opening logic.
   */
  onOpenRequested?: (() => void) | undefined;
}

export function CanvasWell({ onOpenRequested }: CanvasWellProps) {
  return (
    <section className="canvas-well" aria-label="Document canvas">
      <div className="canvas-well__empty">
        <span className="canvas-well__mark">
          <BoltIcon size={24} className="canvas-well__mark-icon" />
        </span>
        <h2 className="canvas-well__heading">Open a PDF to get started</h2>
        <p className="canvas-well__hint">
          Drag a PDF here, or choose one from this computer.
        </p>
        <button
          type="button"
          className="canvas-well__cta"
          onClick={onOpenRequested}
        >
          <OpenIcon size={16} />
          Open a PDF
        </button>
      </div>
    </section>
  );
}
