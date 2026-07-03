import { useState } from "react";
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
}

export function CrashReportDialog({
  payload,
  onOpenGitHubIssue,
  onNotNow,
  onNeverAsk,
}: CrashReportDialogProps) {
  const [showPayload, setShowPayload] = useState(false);

  if (!payload) {
    return null;
  }

  return (
    <FloatingDialog
      title="RaioPDF closed unexpectedly"
      eyebrow="Crash report"
      width="md"
      draggable={false}
      onClose={onNotNow}
    >
      <div className="crash-report-dialog">
        <p className="crash-report-dialog__copy">
          RaioPDF noticed the last session did not exit cleanly. Nothing has
          been sent. If you want to report it, RaioPDF can open a pre-filled
          GitHub issue that you review before submitting.
        </p>
        <p className="crash-report-dialog__copy">
          The report includes the app version, operating system, crash details
          if we captured them, and a scrubbed tail of the local app log.
        </p>

        {showPayload ? (
          <pre
            className="crash-report-dialog__payload"
            aria-label="Crash report payload"
          >
            {formatCrashReportPreview(payload)}
          </pre>
        ) : null}

        <div className="crash-report-dialog__actions">
          <button
            type="button"
            className="crash-report-dialog__secondary-button"
            onClick={() => setShowPayload((current) => !current)}
          >
            View exactly what will be sent
          </button>
          <button
            type="button"
            className="crash-report-dialog__primary-button"
            onClick={onOpenGitHubIssue}
          >
            Open GitHub issue
          </button>
          <button
            type="button"
            className="crash-report-dialog__secondary-button"
            onClick={onNotNow}
          >
            Not now
          </button>
          <button
            type="button"
            className="crash-report-dialog__secondary-button"
            onClick={onNeverAsk}
          >
            Never ask
          </button>
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
