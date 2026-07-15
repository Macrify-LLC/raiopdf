import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FileGrant } from "../lib/filePort";
import { LoadingSun } from "./LoadingSun";
import "./PdfSecurityPanel.css";

export type PdfSecurityPermission = "allowed" | "blocked" | "unknown";
export type PdfSecuritySignatureState = "none" | "present" | "unknown";
export type PdfSecurityProgress =
  | "idle"
  | "choosing-output"
  | "preparing"
  | "encrypting"
  | "verifying";

const PROGRESS_COPY: Record<Exclude<PdfSecurityProgress, "idle">, string> = {
  "choosing-output": "Choose where to save the protected copy…",
  preparing: "Preparing current edits…",
  encrypting: "Creating protected copy…",
  verifying: "Verifying AES-256 protection…",
};

export type PdfSecurityDocumentState =
  | {
      kind: "unprotected";
      signature: PdfSecuritySignatureState;
      pdfA: boolean;
    }
  | {
      kind: "protected-unlocked" | "owner-restricted";
      encryptionLabel: string | null;
      printing: PdfSecurityPermission;
      copying: PdfSecurityPermission;
      signature: PdfSecuritySignatureState;
      pdfA: boolean;
    };

export interface CreateProtectedCopyRequest {
  password: string;
  allowPrinting: boolean;
  allowCopying: boolean;
}

export type PrepareProtectedCopyResult =
  | { status: "ready"; displayName: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export type PdfPasswordValidation =
  | { valid: true; error: null }
  | { valid: false; error: string };

export function validatePdfOpenPassword(
  password: string,
  confirmation: string,
): PdfPasswordValidation {
  if (password.includes("\0")) {
    return { valid: false, error: "Passwords cannot contain NUL characters." };
  }

  if (/[\r\n]/u.test(password)) {
    return { valid: false, error: "Passwords cannot contain line breaks." };
  }

  if (new TextEncoder().encode(password).byteLength > 127) {
    return { valid: false, error: "Use no more than 127 UTF-8 bytes." };
  }

  if ([...password].length < 8) {
    return { valid: false, error: "Use at least 8 characters." };
  }

  if (password !== confirmation) {
    return { valid: false, error: "Passwords do not match exactly." };
  }

  return { valid: true, error: null };
}

/** A renderer-safe output identity. Only the shell may resolve its grant. */
export interface PdfSecurityOutputReference {
  grant: FileGrant;
  displayName: string;
  /** Optional presentation copy. Never use this string as operation authority. */
  displayLocation?: string | null | undefined;
}

export type CreateProtectedCopyResult =
  | {
      status: "success";
      output: PdfSecurityOutputReference;
      allowPrinting: boolean;
      allowCopying: boolean;
    }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface PdfSecurityPanelProps {
  documentKey: string | null;
  fileName: string | null;
  documentState: PdfSecurityDocumentState | null;
  desktopAvailable: boolean;
  progress?: PdfSecurityProgress | undefined;
  onPrepareProtectedCopy: () => Promise<PrepareProtectedCopyResult>;
  onDiscardPreparedCopy: () => void | Promise<void>;
  onCreateProtectedCopy: (
    request: CreateProtectedCopyRequest,
  ) => CreateProtectedCopyResult | Promise<CreateProtectedCopyResult>;
  onSaveUnlockedCopy: () => void | Promise<void>;
  onOpenProtectedCopy: (output: PdfSecurityOutputReference) => void | Promise<void>;
  onShowProtectedCopyInFolder: (output: PdfSecurityOutputReference) => void | Promise<void>;
}

export function PdfSecurityPanel({
  documentKey,
  fileName,
  documentState,
  desktopAvailable,
  progress = "idle",
  onPrepareProtectedCopy,
  onDiscardPreparedCopy,
  onCreateProtectedCopy,
  onSaveUnlockedCopy,
  onOpenProtectedCopy,
  onShowProtectedCopyInFolder,
}: PdfSecurityPanelProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordsVisible, setPasswordsVisible] = useState(false);
  const [allowPrinting, setAllowPrinting] = useState(true);
  const [allowCopying, setAllowCopying] = useState(true);
  const [preparedOutputName, setPreparedOutputName] = useState<string | null>(null);
  const [preparingOutput, setPreparingOutput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [success, setSuccess] = useState<Extract<CreateProtectedCopyResult, { status: "success" }> | null>(null);
  const successTitleRef = useRef<HTMLHeadingElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const currentDocumentKeyRef = useRef(documentKey);
  const operationRunIdRef = useRef(0);

  useEffect(() => {
    operationRunIdRef.current += 1;
    currentDocumentKeyRef.current = documentKey;
    setPassword("");
    setConfirmation("");
    setPasswordsVisible(false);
    setAllowPrinting(true);
    setAllowCopying(true);
    setPreparedOutputName(null);
    setPreparingOutput(false);
    setSubmitting(false);
    setOperationError(null);
    setSuccess(null);
  }, [documentKey]);

  useEffect(() => {
    function clearSecretsWhenHidden() {
      if (document.visibilityState !== "hidden") {
        return;
      }

      setPassword("");
      setConfirmation("");
      setPasswordsVisible(false);
      setPreparedOutputName(null);
      setPreparingOutput(false);
      setSubmitting(false);
      setOperationError(null);
      operationRunIdRef.current += 1;
    }

    document.addEventListener("visibilitychange", clearSecretsWhenHidden);
    return () => document.removeEventListener("visibilitychange", clearSecretsWhenHidden);
  }, []);

  useEffect(() => {
    if (success) {
      successTitleRef.current?.focus();
    }
  }, [success]);

  if (!documentState) {
    return (
      <div className="pdf-security-panel__empty-state">
        <SecuritySeal state="unprotected" />
        <p>Open a PDF to review or change its security.</p>
      </div>
    );
  }

  const isUnlockedProtected = documentState?.kind === "protected-unlocked";
  const isOwnerRestricted = documentState?.kind === "owner-restricted";
  const isProtected = isUnlockedProtected || isOwnerRestricted;
  const currentStatusTitle = isUnlockedProtected
    ? "Protected and unlocked for this session"
    : isOwnerRestricted
      ? "Owner-restricted"
      : "Not protected";
  const passwordCharacterCount = [...password].length;
  const passwordByteCount = new TextEncoder().encode(password).byteLength;
  const passwordTooLong = passwordByteCount > 127;
  const passwordTooShort = password.length > 0 && passwordCharacterCount < 8;
  const confirmationMismatch = confirmation.length > 0 && password !== confirmation;
  const hasNul = password.includes("\0");
  const hasLineBreak = /[\r\n]/u.test(password);
  const hasBoundaryWhitespace = password.length > 0 && (/^\s/u.test(password) || /\s$/u.test(password));
  const validation = validatePdfOpenPassword(password, confirmation);
  const canSubmit = preparedOutputName !== null && validation.valid && !submitting;

  async function handlePrepareProtectedCopy() {
    if (preparingOutput || submitting) {
      return;
    }

    setPreparingOutput(true);
    setOperationError(null);
    const runDocumentKey = documentKey;
    const runId = operationRunIdRef.current + 1;
    operationRunIdRef.current = runId;

    try {
      const result = await onPrepareProtectedCopy();

      if (
        runDocumentKey !== currentDocumentKeyRef.current
        || runId !== operationRunIdRef.current
      ) {
        return;
      }

      if (result.status === "ready") {
        setPreparedOutputName(result.displayName);
      } else if (result.status === "error") {
        setPreparedOutputName(null);
        setOperationError(result.message);
      } else {
        setPreparedOutputName(null);
      }
    } catch {
      if (
        runDocumentKey === currentDocumentKeyRef.current
        && runId === operationRunIdRef.current
      ) {
        setPreparedOutputName(null);
        setOperationError("RaioPDF could not choose an output location.");
      }
    } finally {
      if (runId === operationRunIdRef.current) {
        setPreparingOutput(false);
      }
    }
  }

  function resetPreparedCopy() {
    void onDiscardPreparedCopy();
    operationRunIdRef.current += 1;
    setPreparedOutputName(null);
    setPassword("");
    setConfirmation("");
    setPasswordsVisible(false);
    setOperationError(null);
    setPreparingOutput(false);
    setSubmitting(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (preparedOutputName === null) {
      return;
    }

    if (!validation.valid) {
      if (validation.error === "Passwords do not match exactly.") {
        confirmationInputRef.current?.focus();
      } else {
        passwordInputRef.current?.focus();
      }
      return;
    }

    if (submitting) {
      return;
    }

    setSubmitting(true);
    setOperationError(null);
    const runDocumentKey = documentKey;
    const runId = operationRunIdRef.current + 1;
    operationRunIdRef.current = runId;

    try {
      const result = await onCreateProtectedCopy({ password, allowPrinting, allowCopying });

      if (
        runDocumentKey !== currentDocumentKeyRef.current
        || runId !== operationRunIdRef.current
      ) {
        return;
      }

      if (result.status === "success") {
        setPassword("");
        setConfirmation("");
        setPasswordsVisible(false);
        setPreparedOutputName(null);
        setSuccess(result);
      } else if (result.status === "cancelled") {
        setPassword("");
        setConfirmation("");
        setPasswordsVisible(false);
        setPreparedOutputName(null);
      } else {
        setOperationError(result.message);
        setPassword("");
        setConfirmation("");
        setPasswordsVisible(false);
        setPreparedOutputName(null);
      }
    } catch {
      if (
        runDocumentKey === currentDocumentKeyRef.current
        && runId === operationRunIdRef.current
      ) {
        setPassword("");
        setConfirmation("");
        setPasswordsVisible(false);
        setPreparedOutputName(null);
        setOperationError("RaioPDF could not create the protected copy.");
      }
    } finally {
      if (runId === operationRunIdRef.current) {
        setSubmitting(false);
      }
    }
  }

  return (
    <div className="pdf-security-panel">
      <section
        className="pdf-security-panel__status-card"
        data-state={isProtected ? "protected" : "unprotected"}
        aria-labelledby="pdf-security-current-status"
      >
        <SecuritySeal state={isProtected ? "protected" : "unprotected"} />
        <div className="pdf-security-panel__status-copy">
          <div className="pdf-security-panel__status-kicker-row">
            <p className="pdf-security-panel__eyebrow">This PDF</p>
            {fileName ? (
              <p className="pdf-security-panel__file-name" title={fileName}>{fileName}</p>
            ) : null}
          </div>
          <h3 id="pdf-security-current-status">{currentStatusTitle}</h3>
          {isProtected ? (
            <>
              <p className="pdf-security-panel__status-detail">
                {documentState.encryptionLabel
                  ? `${documentState.encryptionLabel} protected`
                  : "Protected — encryption details unavailable"}
              </p>
              <ul className="pdf-security-panel__fact-list" aria-label="Current permissions">
                <li>Printing {documentState.printing}</li>
                <li>Copying {documentState.copying}</li>
              </ul>
            </>
          ) : (
            <p className="pdf-security-panel__status-detail">No open password is required</p>
          )}
        </div>
      </section>
      {!desktopAvailable ? (
        <p className="pdf-security-panel__message">
          Creating protected copies is available in the installed RaioPDF app.
        </p>
      ) : documentState.signature === "present" ? (
        <div className="pdf-security-panel__message" data-tone="danger" role="alert">
          <strong>This PDF contains a digital signature.</strong>{" "}
          Protect the PDF before signing it.
        </div>
      ) : documentState.signature === "unknown" ? (
        <div className="pdf-security-panel__message" data-tone="caution" role="alert">
          <strong>
            RaioPDF could not verify whether this PDF contains a digital signature.
          </strong>{" "}
          Protection is unavailable for this document.
        </div>
      ) : (
        <>
          {progress !== "idle" ? (
            <div className="pdf-security-panel__progress">
              <LoadingSun size={30} label={PROGRESS_COPY[progress]} />
              <p role="status" aria-live="polite">{PROGRESS_COPY[progress]}</p>
            </div>
          ) : success ? (
            <section
              className="pdf-security-panel__success"
              data-verified-success="true"
              aria-labelledby="pdf-security-success-title"
            >
              <SecuritySeal state="verified" />
              <div className="pdf-security-panel__success-copy">
                <p className="pdf-security-panel__eyebrow">Verified output</p>
                <h3 ref={successTitleRef} id="pdf-security-success-title" tabIndex={-1}>
                  Protected copy created
                </h3>
                <p className="pdf-security-panel__sr-only" aria-live="polite">
                  Protected copy created and verified with AES-256.
                </p>
                <p className="pdf-security-panel__output-name" title={success.output.displayName}>
                  {success.output.displayName}
                </p>
                {success.output.displayLocation ? (
                  <p className="pdf-security-panel__output-location">
                    {success.output.displayLocation}
                  </p>
                ) : null}
                <ul className="pdf-security-panel__fact-list" aria-label="Protected copy facts">
                  <li>AES-256</li>
                  <li>Printing {success.allowPrinting ? "allowed" : "blocked"}</li>
                  <li>Copying {success.allowCopying ? "allowed" : "blocked"}</li>
                </ul>
                <p className="pdf-security-panel__success-note">
                  This PDF is still open and unchanged by protection.
                </p>
                <p className="pdf-security-panel__success-note">
                  When practical, send the PDF and its password through different channels.
                </p>
              </div>
              <div className="pdf-security-panel__actions pdf-security-panel__actions--success">
                <button
                  type="button"
                  className="pdf-security-panel__primary-button"
                  onClick={() => void onOpenProtectedCopy(success.output)}
                >
                  Open Protected Copy
                </button>
                <button
                  type="button"
                  className="pdf-security-panel__secondary-button"
                  onClick={() => void onShowProtectedCopyInFolder(success.output)}
                >
                  Show in folder
                </button>
              </div>
            </section>
          ) : (
            <div className="pdf-security-panel__form-shell">
              <div className="pdf-security-panel__section-heading">
                <h3>{isProtected ? "Create a newly protected copy" : "Create a protected copy"}</h3>
                <p>The original stays open and is never changed.</p>
              </div>
              {preparedOutputName === null ? (
                <div className="pdf-security-panel__prepare">
                  <div className="pdf-security-panel__prepare-visual" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <path d="M12 3v12" />
                      <path d="m8 11 4 4 4-4" />
                      <path d="M5 19h14" />
                    </svg>
                  </div>
                  <div className="pdf-security-panel__prepare-copy">
                    <p className="pdf-security-panel__eyebrow">First, choose the new file</p>
                    <p>No password is requested until the save location is ready.</p>
                  </div>
                  {operationError ? (
                    <p className="pdf-security-panel__operation-error" role="alert">
                      {operationError}
                    </p>
                  ) : null}
                  <div className="pdf-security-panel__actions">
                    <button
                      type="button"
                      className="pdf-security-panel__primary-button"
                      disabled={preparingOutput}
                      onClick={() => void handlePrepareProtectedCopy()}
                    >
                      {preparingOutput ? "Choosing output…" : "Choose Protected Copy…"}
                    </button>
                  </div>
                </div>
              ) : (
              <form className="pdf-security-panel__form" onSubmit={handleSubmit}>
                <div className="pdf-security-panel__prepared-output">
                  <div>
                    <p className="pdf-security-panel__eyebrow">Protected copy</p>
                    <p className="pdf-security-panel__prepared-name" title={preparedOutputName}>
                      {preparedOutputName}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="pdf-security-panel__reveal-button"
                    onClick={resetPreparedCopy}
                  >
                    Choose another
                  </button>
                </div>
                <div className="pdf-security-panel__password-heading">
                  <p>Password</p>
                  <button
                    type="button"
                    className="pdf-security-panel__reveal-button"
                    aria-pressed={passwordsVisible}
                    onClick={() => setPasswordsVisible((visible) => !visible)}
                  >
                    {passwordsVisible ? "Hide passwords" : "Show passwords"}
                  </button>
                </div>
                <label className="pdf-security-panel__field">
                  <span>Open password</span>
                  <input
                    ref={passwordInputRef}
                    type={passwordsVisible ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    aria-invalid={passwordTooShort || passwordTooLong || hasNul || hasLineBreak ? "true" : undefined}
                    aria-describedby="pdf-security-password-guidance"
                  />
                </label>
                <label className="pdf-security-panel__field">
                  <span>Confirm password</span>
                  <input
                    ref={confirmationInputRef}
                    type={passwordsVisible ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.currentTarget.value)}
                    aria-invalid={confirmationMismatch ? "true" : undefined}
                    aria-describedby="pdf-security-password-guidance"
                  />
                </label>
                <div id="pdf-security-password-guidance" className="pdf-security-panel__guidance">
                  {hasNul ? (
                    <p data-tone="danger" role="alert">Passwords cannot contain NUL characters.</p>
                  ) : hasLineBreak ? (
                    <p data-tone="danger" role="alert">Passwords cannot contain line breaks.</p>
                  ) : passwordTooLong ? (
                    <p data-tone="danger" role="alert">Use no more than 127 UTF-8 bytes.</p>
                  ) : passwordTooShort ? (
                    <p data-tone="danger" role="alert">Use at least 8 characters.</p>
                  ) : confirmationMismatch ? (
                    <p data-tone="danger" role="alert">Passwords do not match exactly.</p>
                  ) : passwordCharacterCount >= 8 && passwordCharacterCount < 12 ? (
                    <p role="status">Accepted. A longer passphrase is recommended.</p>
                  ) : passwordCharacterCount >= 12 ? (
                    <p role="status">Good length.</p>
                  ) : (
                    <p>Use at least 8 characters; 12 or more is recommended.</p>
                  )}
                  {hasBoundaryWhitespace && !hasLineBreak ? (
                    <p data-tone="caution" role="status">
                      This password starts or ends with whitespace. Those characters will be kept.
                    </p>
                  ) : null}
                </div>
                {operationError ? (
                  <p className="pdf-security-panel__operation-error" role="alert">
                    {operationError}
                  </p>
                ) : null}
                <fieldset className="pdf-security-panel__permissions">
                  <legend>Permissions</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowPrinting}
                      onChange={(event) => setAllowPrinting(event.currentTarget.checked)}
                    />
                    <span>Allow printing</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowCopying}
                      onChange={(event) => setAllowCopying(event.currentTarget.checked)}
                    />
                    <span>Allow copying</span>
                  </label>
                </fieldset>
                {!allowCopying ? (
                  <p className="pdf-security-panel__accessibility-note">
                    Accessibility access remains allowed.
                  </p>
                ) : null}
                <p className="pdf-security-panel__retention-note">
                  Raio does not store this password. Keep it somewhere safe.
                </p>
                <div className="pdf-security-panel__actions">
                  <button
                    type="submit"
                    className="pdf-security-panel__primary-button"
                    disabled={!canSubmit}
                  >
                    {submitting ? "Creating protected copy…" : "Create Protected Copy"}
                  </button>
                </div>
              </form>
              )}
            </div>
          )}
        </>
      )}
      {desktopAvailable && isProtected && progress === "idle" && !success && preparedOutputName === null ? (
        <div className="pdf-security-panel__unlocked-copy">
          <p>Need a copy without protection?</p>
          <button
            type="button"
            className="pdf-security-panel__secondary-button"
            onClick={() => void onSaveUnlockedCopy()}
          >
            Save Unlocked Copy
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SecuritySeal({ state }: { state: "unprotected" | "protected" | "verified" }) {
  const checked = state !== "unprotected";

  return (
    <span className="pdf-security-panel__seal" data-state={state} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        {state === "verified" ? (
          <g className="pdf-security-panel__seal-rays">
            <path d="M12 1V3" />
            <path d="m18.4 3.6-1.5 1.5" />
            <path d="M21 10h-2" />
            <path d="m5.1 5.1-1.5-1.5" />
            <path d="M5 10H3" />
          </g>
        ) : null}
        <path className="pdf-security-panel__seal-outline" d="M12 3 5.5 5.7v5.5c0 4.3 2.9 7 6.5 8.1 3.6-1.1 6.5-3.8 6.5-8.1V5.7L12 3Z" />
        <circle className="pdf-security-panel__seal-ring" cx="12" cy="11" r="3.2" />
        {checked ? (
          <path className="pdf-security-panel__seal-check" d="m10.2 11 1.2 1.2 2.5-2.6" />
        ) : (
          <path className="pdf-security-panel__seal-dash" d="M10.3 11h3.4" />
        )}
      </svg>
    </span>
  );
}
