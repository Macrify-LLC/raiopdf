import type { SignatureInvalidationNotice } from "../hooks/useDocument";
import { DismissButton } from "./DismissButton";
import "./DocumentBanner.css";

export function DocumentBanner({
  notice,
  onDismiss,
}: {
  notice: SignatureInvalidationNotice | null;
  onDismiss: () => void;
}) {
  if (!notice) {
    return null;
  }

  const count = notice.sourceFileNames.length;
  const unchangedCopy = count === 1 && notice.sourceFileNames[0]
    ? `The original file on disk is unchanged: ${notice.sourceFileNames[0]}.`
    : count > 1
      ? `The ${count} original source files on disk are unchanged.`
      : "The original file on disk is unchanged.";

  return (
    <div className="document-banner" role="status">
      <div>
        <p className="document-banner__title">Digital signature invalidated in this working copy</p>
        <p className="document-banner__copy">{unchangedCopy}</p>
      </div>
      <DismissButton
        label="Close digital signature warning"
        onClick={onDismiss}
      />
    </div>
  );
}
