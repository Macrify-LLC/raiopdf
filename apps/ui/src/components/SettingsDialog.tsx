import "./SettingsDialog.css";

export interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  return (
    <div className="settings-dialog" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <h2 id="settings-dialog-title">Preferences</h2>
          <button
            type="button"
            className="settings-dialog__close"
            aria-label="Close preferences"
            onClick={onClose}
          >
            {"\u00d7"}
          </button>
        </header>
        <div className="settings-dialog__body">
          <label className="settings-dialog__row">
            <span>
              <strong>Update checks</strong>
              <small>Check for signed Windows releases automatically</small>
            </span>
            <input type="checkbox" checked readOnly disabled />
          </label>
          <label className="settings-dialog__row">
            <span>
              <strong>Default jurisdiction</strong>
              <small>Used for filing-preflight defaults</small>
            </span>
            <select value="florida" disabled>
              <option value="florida">Florida</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
