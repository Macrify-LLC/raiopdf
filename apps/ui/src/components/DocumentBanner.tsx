import type { SignatureInvalidationNotice } from "../hooks/useDocument";
import "./DocumentBanner.css";

export function DocumentBanner({
  notice,
}: {
  notice: SignatureInvalidationNotice | null;
}) {
  if (!notice) {
    return null;
  }

  const count = notice.sourceFileNames.length;
  const fileLabel = count === 1
    ? notice.sourceFileNames[0]
    : `${count} source files`;

  return (
    <div className="document-banner" role="status">
      <div>
        <p className="document-banner__title">Digital signature invalidated in this unlocked copy</p>
        <p className="document-banner__copy">
          Original file on disk unchanged{fileLabel ? `: ${fileLabel}` : "."}
        </p>
      </div>
    </div>
  );
}
