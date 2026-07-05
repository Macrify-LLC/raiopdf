import { LoadingSun } from "./LoadingSun";
import "./LongProcessLoader.css";

export interface LongProcessStep {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "failed" | "skipped";
  reason?: string;
}

export interface LongProcessProgress {
  current: number;
  total: number;
  unit: string;
}

export interface LongProcessLoaderProps {
  phaseLabel?: string;
  message: string;
  detail?: string;
  steps?: readonly LongProcessStep[];
  progress?: LongProcessProgress | null;
  hideProgressText?: boolean;
  cancelMode?: "none" | "cancel";
  cancelLabel?: string;
  cancelMessage?: string;
  onCancel?: () => void;
}

export function LongProcessLoader({
  phaseLabel,
  message,
  detail,
  steps = [],
  progress = null,
  hideProgressText = false,
  cancelMode = "none",
  cancelLabel = "Cancel",
  cancelMessage,
  onCancel,
}: LongProcessLoaderProps) {
  const progressValue = normalizedProgress(progress);
  const showCancel = cancelMode === "cancel" && Boolean(onCancel);

  return (
    <div className="long-process-loader">
      <span aria-hidden="true">
        <LoadingSun size={30} label={phaseLabel ?? message} />
      </span>
      <div className="long-process-loader__copy" role="status" aria-live="polite">
        {phaseLabel ? <p className="long-process-loader__phase">{phaseLabel}</p> : null}
        <p className="long-process-loader__message">{message}</p>
        {detail ? <p className="long-process-loader__detail">{detail}</p> : null}
        {progressValue ? (
          <div className="long-process-loader__progress">
            <progress
              className="long-process-loader__progress-bar"
              value={progressValue.current}
              max={progressValue.total}
              aria-label={formatProgress(progressValue)}
            />
            {hideProgressText ? null : (
              <p className="long-process-loader__progress-text">{formatProgress(progressValue)}</p>
            )}
          </div>
        ) : null}
      </div>
      {steps.length > 0 ? (
        <ol className="long-process-loader__steps" aria-label="Progress steps">
          {steps.map((step) => {
            return (
              <li key={step.id} className="long-process-loader__step" data-state={step.state}>
                <span className="long-process-loader__step-dot" aria-hidden="true" />
                <span>{step.reason ? `${step.label} (${step.reason})` : step.label}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {showCancel ? (
        <div className="long-process-loader__cancel">
          {cancelMessage ? <p>{cancelMessage}</p> : null}
          <button type="button" className="long-process-loader__cancel-button" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      ) : null}
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
