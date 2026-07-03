import { useId, useState } from "react";
import { ChevronDownIcon, ShieldCheckIcon } from "../icons";
import { FloatingDialog } from "./FloatingDialog";
import "./CrashReportDialog.css";

export interface CrashReportPayload {
  title: string;
  body: string;
}

export interface CrashReportDialogProps {
  payload: CrashReportPayload | null;
  onOpenGitHubIssue: () => void;
  onNotNow: () => void;
  onNeverAsk: () => void;
  isOpening?: boolean | undefined;
  openStatus?: string | null | undefined;
}

export function CrashReportDialog({
  payload,
  onOpenGitHubIssue,
  onNotNow,
  onNeverAsk,
  isOpening = false,
  openStatus,
}: CrashReportDialogProps) {
  const [showPayload, setShowPayload] = useState(false);
  const payloadId = useId();

  if (!payload) {
    return null;
  }

  return (
    <FloatingDialog
      title="RaioPDF closed unexpectedly"
      eyebrow="Crash report"
      draggable={false}
      scrim
      onClose={onNotNow}
    >
      <div className="crash-report-dialog">
        <p className="crash-report-dialog__trust-chip">
          <ShieldCheckIcon size={14} />
          <strong>Nothing is sent automatically — you choose what to share.</strong>
        </p>
        <p className="crash-report-dialog__copy">
          RaioPDF noticed the last session did not exit cleanly. It can open a
          pre-filled GitHub issue for you to review before submitting.
        </p>
        <div className="crash-report-dialog__included" aria-label="Report includes">
          <span>App version</span>
          <span>OS</span>
          <span>Crash details</span>
          <span>Scrubbed log tail</span>
        </div>

        <button
          type="button"
          className="crash-report-dialog__disclosure"
          aria-expanded={showPayload}
          aria-controls={payloadId}
          onClick={() => setShowPayload((current) => !current)}
        >
          {showPayload ? "Hide payload" : "View exactly what will be sent"}
          <ChevronDownIcon
            size={16}
            className="crash-report-dialog__chevron"
            data-open={showPayload ? "true" : undefined}
          />
        </button>

        {showPayload ? (
          <pre
            id={payloadId}
            className="crash-report-dialog__payload"
            aria-label="Crash report payload"
            tabIndex={0}
          >
            {formatCrashReportPreview(payload)}
          </pre>
        ) : null}

        {openStatus ? (
          <p className="crash-report-dialog__status-line" role="status">
            {openStatus}
          </p>
        ) : null}

        <div className="crash-report-dialog__actions">
          <button
            type="button"
            className="crash-report-dialog__tertiary-button"
            onClick={onNeverAsk}
          >
            Never ask
          </button>
          <div className="crash-report-dialog__decision-actions">
            <button
              type="button"
              className="crash-report-dialog__secondary-button"
              onClick={onNotNow}
            >
              Not now
            </button>
            <button
              type="button"
              className="crash-report-dialog__primary-button"
              onClick={onOpenGitHubIssue}
              disabled={isOpening}
            >
              Open GitHub issue
            </button>
          </div>
        </div>
      </div>
    </FloatingDialog>
  );
}

export function formatCrashReportPreview(payload: CrashReportPayload): string {
  return [
    "GitHub issue title",
    payload.title,
    "",
    "GitHub labels",
    "crash",
    "",
    "GitHub issue body",
    payload.body,
  ].join("\n");
}
