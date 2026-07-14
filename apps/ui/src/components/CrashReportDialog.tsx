import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, ShieldCheckIcon } from "../icons";
import { FloatingDialog } from "./FloatingDialog";
import "./CrashReportDialog.css";

const SUPPORT_EMAIL = "crash-reports@macrify.me";
const COPIED_LABEL_MS = 1600;
const COPY_FAILED_LABEL_MS = 2400;

export interface CrashReportPayload {
  title: string;
  body: string;
  signature: string;
  panicLocation: string | null;
  backtrace: string;
  logTail: string;
}

export interface CrashReportDialogProps {
  payload: CrashReportPayload | null;
  onSaveReport: () => Promise<string | null>;
  onOpenGitHubIssue: () => void;
  onNotNow: () => void;
  onNeverAsk: () => void;
  isOpening?: boolean | undefined;
  openStatus?: string | null | undefined;
}

export function CrashReportDialog({
  payload,
  onSaveReport,
  onOpenGitHubIssue,
  onNotNow,
  onNeverAsk,
  isOpening = false,
  openStatus,
}: CrashReportDialogProps) {
  const [showPayload, setShowPayload] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const payloadId = useId();
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (savedPath) {
      copyButtonRef.current?.focus();
    }
  }, [savedPath]);

  useEffect(() => {
    if (!copiedEmail) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopiedEmail(false), COPIED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copiedEmail]);

  useEffect(() => {
    if (!copyFailed) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopyFailed(false), COPY_FAILED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copyFailed]);

  const handleSaveReport = useCallback(() => {
    if (isSaving) {
      return;
    }

    void (async () => {
      setSaveError(null);
      setIsSaving(true);
      try {
        const path = await onSaveReport();
        if (path) {
          setSavedPath(path);
        }
      } catch {
        setSaveError("Couldn't save the report — try again.");
      } finally {
        setIsSaving(false);
      }
    })();
  }, [isSaving, onSaveReport]);

  const copySupportEmail = useCallback(() => {
    setCopyFailed(false);

    try {
      if (!navigator.clipboard?.writeText) {
        setCopiedEmail(false);
        setCopyFailed(true);
        return;
      }

      void navigator.clipboard
        .writeText(SUPPORT_EMAIL)
        .then(() => {
          setCopiedEmail(true);
        })
        .catch(() => {
          setCopiedEmail(false);
          setCopyFailed(true);
        });
    } catch {
      setCopiedEmail(false);
      setCopyFailed(true);
    }
  }, []);

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
          The easiest way: save a report and email it to us — no GitHub account
          needed. You can also open it as a GitHub issue you submit yourself.
        </p>
        <div className="crash-report-dialog__included" aria-label="Report includes">
          <span>App version</span>
          <span>OS</span>
          <span>Crash details</span>
          <span>Recent activity log (personal details removed)</span>
        </div>

        <button
          type="button"
          className="crash-report-dialog__disclosure"
          aria-expanded={showPayload}
          aria-controls={payloadId}
          onClick={() => setShowPayload((current) => !current)}
        >
          {showPayload ? "Hide details" : "View exactly what will be sent"}
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
            aria-label="Crash report details"
            tabIndex={0}
          >
            {formatCrashReportPreview(payload)}
          </pre>
        ) : null}

        {savedPath ? (
          <div className="crash-report-dialog__success-panel">
            <p>
              Saved to <code>{savedPath}</code>.
            </p>
            <p>
              Email it to{" "}
              <strong className="crash-report-dialog__email">{SUPPORT_EMAIL}</strong>{" "}
              and we&rsquo;ll take a look.
            </p>
            {copyFailed ? (
              <p className="crash-report-dialog__status-line" role="status">
                Clipboard access was blocked. Select the email address and copy it manually.
              </p>
            ) : null}
            {copiedEmail ? (
              <p className="visually-hidden" role="status" aria-live="polite">
                Email address copied to clipboard.
              </p>
            ) : null}
            <div className="crash-report-dialog__success-actions">
              <button
                type="button"
                ref={copyButtonRef}
                className="crash-report-dialog__primary-button crash-report-dialog__copy-email-button"
                data-copy-state={copiedEmail ? "copied" : copyFailed ? "failed" : undefined}
                onClick={copySupportEmail}
              >
                {copiedEmail ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                {copiedEmail ? "Copied" : copyFailed ? "Could not copy" : "Copy email address"}
              </button>
              <button
                type="button"
                className="crash-report-dialog__secondary-button"
                onClick={onNotNow}
              >
                Done
              </button>
            </div>
          </div>
        ) : openStatus || saveError ? (
          <p className="crash-report-dialog__status-line" role="status">
            {saveError ?? openStatus}
          </p>
        ) : null}

        {savedPath ? null : (
          <div className="crash-report-dialog__actions">
            <div className="crash-report-dialog__exit-row">
              <button
                type="button"
                className="crash-report-dialog__tertiary-button"
                onClick={onNeverAsk}
              >
                Never ask
              </button>
              <button
                type="button"
                className="crash-report-dialog__secondary-button"
                onClick={onNotNow}
              >
                Not now
              </button>
            </div>
            <div className="crash-report-dialog__send-row">
              <button
                type="button"
                className="crash-report-dialog__secondary-button"
                onClick={onOpenGitHubIssue}
                disabled={isOpening}
              >
                {isOpening ? "Opening..." : "Open GitHub issue"}
              </button>
              <button
                type="button"
                className="crash-report-dialog__primary-button"
                onClick={handleSaveReport}
                disabled={isSaving}
              >
                {isSaving ? "Saving..." : "Save report to email"}
              </button>
            </div>
          </div>
        )}
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
