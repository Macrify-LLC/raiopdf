import { useCallback, useState } from "react";
import { MailIcon } from "../icons";
import { getLastDiagnostic } from "../lib/diagnostics";
import { buildErrorReportMailto, ERROR_REPORT_EMAIL } from "../lib/errorReportMailto";
import "./ErrorReportButton.css";

// How recent a captured diagnostic must be for `requireDiagnostic` to show the
// button. Long enough to cover a user reading an error and deciding to report
// it; short enough that a much-earlier failure doesn't attach to an unrelated
// message shown later on the same shared surface.
const DEFAULT_DIAGNOSTIC_MAX_AGE_MS = 5 * 60 * 1000;

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
   * Only render when a recent diagnostic exists. Use on shared surfaces that
   * also show non-failure messages (e.g. the canvas error chip, which validation
   * nudges reuse) so the report button appears for real failures only -- those
   * are the ones that recorded a diagnostic. Off by default: dedicated failure
   * surfaces (a failure-only dialog) always want the button.
   */
  requireDiagnostic?: boolean;
}

/**
 * A small, self-contained "Email a report" action for the error surfaces. On
 * click it drafts a `mailto:` to the crash-reports alias, prefilled with the
 * most recent captured error plus app version and system info, and opens the
 * user's own mail client. Nothing is sent automatically -- the user reviews and
 * sends the draft themselves, so no data leaves the machine on its own.
 */
export function ErrorReportButton({
  className,
  label = "Email a report",
  showHint = true,
  requireDiagnostic = false,
}: ErrorReportButtonProps) {
  const [failed, setFailed] = useState(false);

  const handleClick = useCallback(() => {
    void (async () => {
      setFailed(false);
      const mailto = buildErrorReportMailto({
        diagnostic: getLastDiagnostic(),
        appVersion: await readAppVersion(),
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      });

      try {
        await openMailDraft(mailto);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  if (requireDiagnostic) {
    const last = getLastDiagnostic();
    if (!last || Date.now() - last.at > DEFAULT_DIAGNOSTIC_MAX_AGE_MS) {
      return null;
    }
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
