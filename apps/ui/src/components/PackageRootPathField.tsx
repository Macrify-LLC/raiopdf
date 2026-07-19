import { browseForOutputDirPath, isTauriRuntime } from "../lib/filePort";
import "./PackageRootPathField.css";

/**
 * Package-root folder input + Browse… picker, shared by the three package
 * workflows (Production Set, Batch Cleanup, Filing Packet).
 *
 * The text input stays the source of truth: Browse fills it with the picked
 * folder's real path, and typing a path by hand keeps working. Browse is
 * desktop-only (the browser runtime has no directory picker — it renders
 * disabled with the reason). While the owning workflow runs, BOTH the input
 * and Browse lock — editing the destination mid-build would only desync the
 * field from the build already writing to the old path.
 */
export function PackageRootPathField({
  value,
  onChange,
  disabled = false,
  browseButtonClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  /** True while the owning workflow runs — locks the input and Browse. */
  disabled?: boolean;
  /** The owning dialog's secondary-button class, so Browse matches its chrome. */
  browseButtonClassName: string;
}) {
  const browseAvailable = isTauriRuntime();

  async function browse() {
    const path = await browseForOutputDirPath();
    if (path !== null) {
      onChange(path);
    }
  }

  return (
    <span className="package-root-path-field">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Choose an empty folder..."
        disabled={disabled}
      />
      <button
        type="button"
        className={browseButtonClassName}
        disabled={!browseAvailable || disabled}
        title={browseAvailable
          ? "Choose the package root folder."
          : "Browsing for a folder only works in the installed RaioPDF app."}
        onClick={() => void browse()}
      >
        Browse…
      </button>
    </span>
  );
}
