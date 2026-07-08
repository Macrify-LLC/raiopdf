import { LoadingSun } from "./LoadingSun";
import type { LongProcessProgress, LongProcessStep } from "./LongProcessLoader";
import "./DockedProcessLoader.css";

export interface DockedProcessLoaderProps {
  phaseLabel?: string;
  message: string;
  detail?: string | undefined;
  steps?: readonly LongProcessStep[];
  progress?: LongProcessProgress | null;
  cancelLabel?: string | undefined;
  cancelMessage?: string | undefined;
  cancelRequested?: boolean | undefined;
  onCancel?: (() => void) | undefined;
}

export function DockedProcessLoader({
  phaseLabel,
  message,
  detail,
  steps = [],
  progress = null,
  cancelLabel = "Cancel",
  cancelMessage,
  cancelRequested = false,
  onCancel,
}: DockedProcessLoaderProps) {
  const progressValue = normalizedProgress(progress);
  const showCancel = Boolean(onCancel);

  return (
    <div className="docked-process-loader" role="status" aria-live="polite">
      <span className="docked-process-loader__sun" aria-hidden="true">
        <LoadingSun size={36} label={phaseLabel ?? message} />
      </span>
      <div className="docked-process-loader__copy">
        {phaseLabel ? <p className="docked-process-loader__phase">{phaseLabel}</p> : null}
        <p className="docked-process-loader__message">{message}</p>
        {steps.length > 0 ? (
          <ol className="docked-process-loader__steps" aria-label="Progress steps">
            {steps.map((step) => (
              <li
                key={step.id}
                className="docked-process-loader__step"
                data-state={step.state}
              >
                <span className="docked-process-loader__step-dot" aria-hidden="true" />
                <span>{step.reason ? `${step.label} (${step.reason})` : step.label}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <div className="docked-process-loader__progress-area">
        {progressValue ? (
          <>
            <progress
              className="docked-process-loader__progress-bar"
              value={progressValue.current}
              max={progressValue.total}
              aria-label={formatProgress(progressValue)}
            />
            <p className="docked-process-loader__progress-text">{formatProgress(progressValue)}</p>
          </>
        ) : (
          <>
            <span className="docked-process-loader__meter" aria-hidden="true">
              <span />
            </span>
            {detail ? <p className="docked-process-loader__progress-text">{detail}</p> : null}
          </>
        )}
        {showCancel ? (
          <div className="docked-process-loader__cancel">
            {cancelMessage ? <p>{cancelMessage}</p> : null}
            <button
              type="button"
              className="docked-process-loader__cancel-button"
              onClick={onCancel}
              disabled={cancelRequested}
            >
              {cancelRequested ? "Cancelling..." : cancelLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function normalizedProgress(progress: LongProcessProgress | null): LongProcessProgress | null {
  if (
    !progress ||
    !Number.isFinite(progress.current) ||
    !Number.isFinite(progress.total) ||
    progress.total <= 0
  ) {
    return null;
  }

  return {
    current: Math.min(Math.max(Math.floor(progress.current), 0), Math.ceil(progress.total)),
    total: Math.ceil(progress.total),
    unit: progress.unit,
  };
}

function formatProgress(progress: LongProcessProgress): string {
  if (progress.unit === "%") {
    return `${progress.current}%`;
  }

  const unit = progress.unit.trim() || "step";
  return `${progress.current} of ${progress.total} ${pluralizeUnit(unit, progress.total)}`;
}

function pluralizeUnit(unit: string, total: number): string {
  if (total === 1 || unit.endsWith("s")) {
    return unit;
  }

  return `${unit}s`;
}
