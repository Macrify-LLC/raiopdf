import { useCallback, useEffect, useState } from "react";
import { MailIcon, PlugIcon } from "../icons";
import { getDiagnosticById, RedactionUnavailableError } from "../lib/diagnostics";
import { buildDiagnosePrompt } from "../lib/diagnosePrompt";
import { buildErrorReportMailto, ERROR_REPORT_EMAIL } from "../lib/errorReportMailto";
import "./ErrorActions.css";

const COPIED_LABEL_MS = 1600;
const COPY_FAILED_LABEL_MS = 2400;

export interface ErrorActionsProps {
  /**
   * Correlation id of the failure being displayed, from the state that owns the
   * message on screen.
   *
   * Renders nothing unless this resolves to a retained diagnostic. That is what
   * keeps the affordance correct on two fronts: a surface showing a gate or a
   * nudge passes null and gets no actions, and a surface showing a real failure
   * reports *that* failure rather than whichever was recorded most recently.
   */
  diagnosticId?: string | null | undefined;
  /** Extra class for context-specific placement (e.g. a dialog footer). */
  className?: string;
  /**
   * Tighten for a dialog, popover or footer: single row, no hint, smaller controls.
   */
  compact?: boolean;
  /**
   * Copy text to the clipboard. Injectable so tests can drive the failure path
   * without fighting `navigator.clipboard`, following the same
   * push-effects-out-to-props seam the crash dialog uses.
   */
  onCopyPrompt?: ((text: string) => Promise<void>) | undefined;
  /** Open the user's mail client. Injectable for the same reason. */
  onOpenMailDraft?: ((mailto: string) => Promise<void>) | undefined;
}

/**
 * The two things a user can do about a failure: hand it to their own AI to
 * diagnose, or email it.
 *
 * "Help diagnose this" puts a prompt on the clipboard — RaioPDF contains no AI and
 * makes no network call for it. Same premise as the MCP connector in Settings: the
 * product speaks to *your* assistant without containing one. The hint copy says so
 * outright, because a primary action mentioning AI in a product whose promise is
 * "no AI, no cloud, no telemetry" has to be unambiguous at the surface the user
 * actually sees.
 */
export function ErrorActions({
  diagnosticId = null,
  className,
  compact = false,
  onCopyPrompt,
  onOpenMailDraft,
}: ErrorActionsProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [redactionFailed, setRedactionFailed] = useState(false);
  const [mailFailed, setMailFailed] = useState(false);
  const [promptFallback, setPromptFallback] = useState<string | null>(null);
  const diagnostic = diagnosticId ? getDiagnosticById(diagnosticId) : null;

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = window.setTimeout(() => setCopied(false), COPIED_LABEL_MS);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    // Don't expire the explanation while the fallback it explains is still on
    // screen: that would leave a bare "Copy it manually (4,504 characters)"
    // disclosure with nothing saying why it appeared.
    if (!copyFailed || promptFallback) {
      return;
    }
    const timeout = window.setTimeout(() => setCopyFailed(false), COPY_FAILED_LABEL_MS);
    return () => window.clearTimeout(timeout);
  }, [copyFailed, promptFallback]);

  useEffect(() => {
    if (!redactionFailed) {
      return;
    }
    const timeout = window.setTimeout(() => setRedactionFailed(false), COPY_FAILED_LABEL_MS);
    return () => window.clearTimeout(timeout);
  }, [redactionFailed]);

  const handleDiagnose = useCallback(() => {
    void (async () => {
      // Clear the other action's outcome: with both set, the precedence below would
      // hide the newer failure behind the older one.
      setCopyFailed(false);
      setRedactionFailed(false);
      setMailFailed(false);
      let text = "";

      // Building is inside the try as well: it awaits the shell's scrubber, and a
      // failure there would otherwise reject unhandled and leave the button
      // looking like it simply did nothing.
      try {
        text = await buildDiagnosePrompt({
          diagnostic,
          appVersion: await readAppVersion(),
          userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        });
        await (onCopyPrompt ?? copyToClipboard)(text);
        setCopied(true);
        setPromptFallback(null);
      } catch (error: unknown) {
        if (error instanceof RedactionUnavailableError) {
          // Nothing was copied, deliberately. Offering unredacted text would break
          // the promise the prompt itself makes about having been scrubbed.
          setRedactionFailed(true);
          setPromptFallback(null);
          return;
        }
        setCopyFailed(true);
        // Keep the text on screen until a later copy succeeds: it is far too long
        // to retype, and the transient "couldn't copy" label clears in seconds.
        // Empty when the build itself failed — the fallback then just doesn't show.
        setPromptFallback(text || null);
      }
    })();
  }, [diagnostic, onCopyPrompt]);

  const handleEmail = useCallback(() => {
    void (async () => {
      // Same reason as the copy path: don't let a stale outcome mask this one.
      setMailFailed(false);
      setCopyFailed(false);
      setRedactionFailed(false);
      const mailto = buildErrorReportMailto({
        diagnostic,
        appVersion: await readAppVersion(),
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      });

      try {
        await (onOpenMailDraft ?? openMailDraft)(mailto);
      } catch {
        setMailFailed(true);
      }
    })();
  }, [diagnostic, onOpenMailDraft]);

  // Nothing to report: this message is a gate, or the entry aged out of the ring.
  if (!diagnostic) {
    return null;
  }


  return (
    <div
      className={`error-actions${compact ? " error-actions--compact" : ""}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label="Report this problem"
    >
      <div className="error-actions__buttons">
        {/* Fixed accessible name via aria-label: the visible label swaps to confirm
            the copy for sighted users, but letting the NAME change would announce the
            outcome twice — once as a name change, once from the live region — and then
            revert. The live region owns the outcome. */}
        <button
          type="button"
          className="error-actions__button error-actions__button--primary"
          data-copy-state={copied ? "copied" : copyFailed ? "failed" : undefined}
          aria-label="Help diagnose this"
          onClick={handleDiagnose}
        >
          <PlugIcon size={14} />
          <span aria-hidden="true">
            {copied ? "Copied — paste into your AI" : "Help diagnose this"}
          </span>
        </button>
        <button type="button" className="error-actions__button" onClick={handleEmail}>
          <MailIcon size={14} />
          Email a report
        </button>
      </div>

      {/* One live region for both actions, so a screen reader hears the outcome
          without the buttons themselves changing accessible name unpredictably. */}
      {copyFailed || redactionFailed || mailFailed || copied ? (
        <p
          className="error-actions__status"
          role="status"
          aria-live="polite"
          data-tone={copyFailed || redactionFailed || mailFailed ? "danger" : undefined}
        >
          {redactionFailed
            ? "RaioPDF couldn’t prepare a safe copy of the details, so nothing was copied. Use “Email a report” instead."
            : copyFailed
              ? "Couldn’t reach the clipboard. The text is below — select and copy it."
              : mailFailed
                ? `Couldn’t open your email app. Write to ${ERROR_REPORT_EMAIL}.`
                : "Prompt copied. Paste it into your own AI assistant."}
        </p>
      ) : null}

      {/* Shown on every surface, including compact ones. This is the disclosure that
          keeps a primary AI-mentioning action honest in a product that promises no AI,
          no cloud, no telemetry — a tighter placement is not a reason to drop it. */}
      <p className="error-actions__hint">
        {compact
          ? "Copies a prompt for your own AI — RaioPDF has no AI and sends nothing."
          : "RaioPDF has no AI of its own — “Help diagnose this” just copies a prompt for whichever assistant you already use. Nothing is sent anywhere until you send it."}
      </p>

      {promptFallback ? (
        // Collapsed behind a disclosure on purpose: dumping several thousand
        // characters inline traps a screen-reader user in it.
        <details className="error-actions__fallback">
          <summary>Copy it manually ({promptFallback.length.toLocaleString()} characters)</summary>
          <pre className="error-actions__fallback-text">
            <code>{promptFallback}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
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
  // In the desktop app route through the opener plugin (the same path the crash
  // dialog uses). In a plain browser fall back to navigation, which the OS still
  // hands to the default mail client.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(mailto);
    return;
  }

  if (typeof window !== "undefined") {
    window.location.href = mailto;
  }
}
