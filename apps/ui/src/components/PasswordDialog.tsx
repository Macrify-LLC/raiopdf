import { useEffect, useRef, useState, type FormEvent } from "react";
import { FloatingDialog } from "./FloatingDialog";
import { LoadingSun } from "./LoadingSun";
import "./PasswordDialog.css";

export type PasswordDialogRunningPhase = "starting-engine" | "unlocking";
export type PasswordDialogPhase = "prompt" | PasswordDialogRunningPhase;

export interface PasswordDialogProps {
  fileName: string;
  phase: PasswordDialogPhase;
  /** Inline "wrong password" message. Only ever shown in the "prompt" phase. */
  error: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

const RUNNING_STATUS_LABEL: Record<PasswordDialogRunningPhase, string> = {
  "starting-engine": "Starting the PDF engine…",
  unlocking: "Unlocking the document…",
};

export function PasswordDialog({ fileName, phase, error, onSubmit, onCancel }: PasswordDialogProps) {
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isRunning = phase !== "prompt";

  // Wrong-password retry: keep the value the user already typed, but select
  // it so the next attempt can simply start typing over it -- no extra
  // clicks, no re-reading a password they just typed correctly-but-for-the-
  // wrong-copy-of-the-file.
  useEffect(() => {
    if (!isRunning && error) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [error, isRunning]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!password || isRunning) {
      return;
    }

    onSubmit(password);
  }

  return (
    <FloatingDialog
      title="Unlock PDF"
      eyebrow="Open"
      width="sm"
      scrim
      draggable={false}
      onClose={onCancel}
    >
      <form className="password-dialog" data-phase={phase} onSubmit={handleSubmit}>
        {isRunning ? (
          <div className="password-dialog__progress" key={phase}>
            <LoadingSun size={30} label="Unlocking the document" />
            <p className="password-dialog__status-line" role="status" aria-live="polite">
              {RUNNING_STATUS_LABEL[phase]}
            </p>
          </div>
        ) : (
          <div className="password-dialog__form">
            <p className="password-dialog__copy">
              &ldquo;{fileName}&rdquo; needs its open password. Enter it below and RaioPDF will
              open an unlocked working copy — the original file on disk is never changed.
            </p>
            <label className="password-dialog__field">
              <span>Open password</span>
              <input
                ref={inputRef}
                type="password"
                autoFocus
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "password-dialog-error" : "password-dialog-hint"}
              />
            </label>
            {error ? (
              <p id="password-dialog-error" className="password-dialog__error" role="alert">
                {error}
              </p>
            ) : (
              <p id="password-dialog-hint" className="password-dialog__hint">
                If this PDF uses an unusual encryption scheme, unlocking may not succeed.
              </p>
            )}
            <div className="password-dialog__actions">
              <button type="button" className="password-dialog__secondary-button" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="password-dialog__primary-button" disabled={!password}>
                Unlock
              </button>
            </div>
          </div>
        )}
      </form>
    </FloatingDialog>
  );
}
