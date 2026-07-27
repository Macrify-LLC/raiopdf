import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, ShieldCheckIcon } from "../icons";
import { FloatingDialog } from "./FloatingDialog";
import { buildDiagnosePrompt } from "../lib/diagnosePrompt";
import type { DiagnosticEntry } from "../lib/diagnostics";
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

  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [promptCopyFailed, setPromptCopyFailed] = useState(false);

  useEffect(() => {
    if (!copiedPrompt) {
      return;
    }
    const timeoutId = window.setTimeout(() => setCopiedPrompt(false), COPIED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copiedPrompt]);

  useEffect(() => {
    if (!promptCopyFailed) {
      return;
    }
    const timeoutId = window.setTimeout(() => setPromptCopyFailed(false), COPY_FAILED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [promptCopyFailed]);

  /**
   * Put a diagnose prompt for THIS crash on the clipboard.
   *
   * Built from the crash payload rather than the in-memory diagnostics ring: the
   * payload is richer (panic signature, location, backtrace, log tail) and was
   * already scrubbed on the Rust side, and the crash happened in a previous
   * process so the ring is empty anyway.
   */
  const copyDiagnosePrompt = useCallback(() => {
    if (!payload) {
      return;
    }
    setPromptCopyFailed(false);

    void (async () => {
      try {
        const text = await buildDiagnosePrompt({
          diagnostic: crashPayloadAsDiagnostic(payload),
          // The version that CRASHED, read from the payload — not the version
          // running now, which may differ if the app updated in between, and not
          // "unknown", which loses the main fact tying a crash to a release.
          appVersion: crashedAppVersion(payload),
          userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        });
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(text);
        setCopiedPrompt(true);
      } catch {
        setPromptCopyFailed(true);
      }
    })();
  }, [payload]);

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
          needed. You can also open it as a GitHub issue you submit yourself, or
          hand the details to your own AI assistant to diagnose.
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
            {/* Conditionally rendered, matching every other live region in this app —
                an always-present empty one shows up in queries for [role="status"]. */}
            {promptCopyFailed || copiedPrompt ? (
              <p
                className="crash-report-dialog__prompt-status"
                role="status"
                aria-live="polite"
                data-tone={promptCopyFailed ? "danger" : undefined}
              >
                {promptCopyFailed
                  ? "Couldn’t reach the clipboard — use “Save report to email” instead."
                  : "Prompt copied. Paste it into your own AI assistant."}
              </p>
            ) : null}
            <div className="crash-report-dialog__send-row">
              <button
                type="button"
                className="crash-report-dialog__secondary-button"
                onClick={copyDiagnosePrompt}
                data-copy-state={copiedPrompt ? "copied" : promptCopyFailed ? "failed" : undefined}
                aria-label="Help diagnose this"
              >
                <span aria-hidden="true">
                  {copiedPrompt ? "Copied — paste into your AI" : "Help diagnose this"}
                </span>
              </button>
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

/**
 * Present a crash payload as a diagnostic entry so it can reuse the diagnose
 * prompt builder. `id` is the envelope marker rather than a ring correlation id —
 * the crash happened in a previous process, so there is no ring entry to point at,
 * and the assistant is told to work from the pasted text.
 */
function crashPayloadAsDiagnostic(payload: CrashReportPayload): DiagnosticEntry {
  return {
    id: "previous-session-crash",
    kind: "shell.crash",
    message: payload.signature,
    details: [
      payload.panicLocation ? `panicLocation=${payload.panicLocation}` : null,
      payload.backtrace,
      payload.logTail,
    ]
      .filter(Boolean)
      .join("\n"),
    at: Date.now(),
  };
}

/**
 * The app version recorded in the crash payload.
 *
 * `build_crash_report_payload` writes it into the body as `App version: x.y.z`;
 * there is no structured field for it. Parsing the body is the cheap read — the
 * alternative is widening the IPC payload type for one string.
 */
function crashedAppVersion(payload: CrashReportPayload): string | null {
  return /^App version:\s*(.+)$/mu.exec(payload.body)?.[1]?.trim() ?? null;
}
