import type { SignatureUnlockPrompt } from "../hooks/useDocument";
import "./SignatureUnlockModal.css";

export function SignatureUnlockModal({
  prompt,
  onCancel,
  onContinue,
}: {
  prompt: SignatureUnlockPrompt | null;
  onCancel: () => void;
  onContinue: () => void;
}) {
  if (!prompt) {
    return null;
  }

  const fileLabel = prompt.sourceFileNames.length === 1
    ? prompt.sourceFileNames[0]
    : `${prompt.sourceFileNames.length} files`;

  return (
    <div className="signature-unlock-modal" role="presentation">
      <div
        className="signature-unlock-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signature-unlock-modal-title"
      >
        <p className="signature-unlock-modal__eyebrow">Protected PDF</p>
        <h2 id="signature-unlock-modal-title">Digital signature will be invalidated</h2>
        <p>
          Creating this unlocked copy invalidates the digital signature markers detected in {fileLabel}.
          The original file on disk is untouched.
        </p>
        <div className="signature-unlock-modal__actions">
          <button type="button" className="signature-unlock-modal__secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="signature-unlock-modal__primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
