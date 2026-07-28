import { useCallback, useState } from "react";
import { MailIcon } from "../icons";
import { getDiagnosticById } from "../lib/diagnostics";
import { buildErrorReportMailto, ERROR_REPORT_EMAIL } from "../lib/errorReportMailto";
import "./ErrorReportButton.css";

interface ErrorReportButtonProps {
  /** Extra class for context-specific placement (e.g. inside a dialog footer). */
  className?: string;
  /** Button label. Defaults to "Email a report". */
  label?: string;
  /**
   * Show the one-line hint under the button that explains it opens the mail app.
   * Defaults on -- turn off in tight spots where the surrounding copy already
   * makes it clear.
   */
  showHint?: boolean;
  /**
   * Correlation id of the failure being displayed, from the state that owns the
   * message on screen.
   *
   * The button renders only when this resolves to a retained diagnostic, which
   * is what makes the affordance correct on two fronts. A surface showing a gate
   * or a nudge passes null and gets no button. A surface showing a real failure
   * passes its own id and reports *that* failure.
   *
   * This replaced an earlier "use whatever diagnostic was recorded most
   * recently" behaviour, which could attach an unrelated error -- e.g. the OCR
   * dialog's missing-toolchain gate deliberately records nothing, so the report
   * it offered described some earlier, different failure.
   */
  diagnosticId?: string | null | undefined;
}

/**
 * A small "Email a report" action for the error surfaces. On click it drafts a
 * `mailto:` to the crash-reports alias, prefilled with the diagnostic named by
 * `diagnosticId` plus app version and system info, and opens the user's own mail
 * client. Nothing is sent automatically -- the user reviews and sends the draft
 * themselves, so no data leaves the machine on its own.
 *
 * Renders nothing unless `diagnosticId` resolves, so a surface that shows both
 * failures and gates gets the button only for the failures.
 */
export function ErrorReportButton({
  className,
  label = "Email a report",
  showHint = true,
  diagnosticId = null,
}: ErrorReportButtonProps) {
  const [failed, setFailed] = useState(false);
  const diagnostic = diagnosticId ? getDiagnosticById(diagnosticId) : null;

  const handleClick = useCallback(() => {
    void (async () => {
      setFailed(false);
      const mailto = buildErrorReportMailto({
        diagnostic,
        appVersion: await readAppVersion(),
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      });

      try {
        await openMailDraft(mailto);
      } catch {
        setFailed(true);
      }
    })();
  }, [diagnostic]);

  // No resolvable diagnostic means there is nothing to report: either this
  // message is a gate, or the entry has aged out of the ring buffer.
  if (!diagnostic) {
    return null;
  }

  return (
    <div className={`error-report${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="error-report__button"
        onClick={handleClick}
      >
        <MailIcon size={14} />
        {label}
      </button>
      {failed ? (
        <p className="error-report__hint error-report__hint--failed" role="status">
          Couldn&rsquo;t open your email app. Write to <strong>{ERROR_REPORT_EMAIL}</strong>.
        </p>
      ) : showHint ? (
        <p className="error-report__hint">
          Opens your email app with the details filled in — nothing sends until you do.
        </p>
      ) : null}
    </div>
  );
}

async function readAppVersion(): Promise<string | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return null;
  }
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

async function openMailDraft(mailto: string): Promise<void> {
  // In the desktop app, route through the opener plugin (the same path the crash
  // dialog uses for the GitHub link). In a plain browser (dev/tests) fall back to
  // normal navigation, which the OS still hands to the default mail client.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(mailto);
    return;
  }

  if (typeof window !== "undefined") {
    window.location.href = mailto;
  }
}
