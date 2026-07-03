import { AboutMacrifySection } from "./AboutMacrifySection";
import { OpenRaioToAiSection } from "./OpenRaioToAiSection";
import "./SettingsDialog.css";

export type SettingsFocusSection = "open-raio-to-ai" | "about-macrify";

export interface SettingsDialogProps {
  onClose: () => void;
  /** "Open Raio to AI" access gate. Off by default; the shell owns persistence. */
  mcpEnabled: boolean;
  onToggleMcpEnabled: (next: boolean) => void;
  /** Resolved absolute path to raiopdf-mcp, once the shell has it. */
  mcpPath?: string | null | undefined;
  /** Set when Preferences was opened via "Open Raio to AI..." specifically. */
  focusSection?: SettingsFocusSection | null | undefined;
  onFocusSectionHandled?: (() => void) | undefined;
  diagnosticsStatus?: string | null | undefined;
  onExportDiagnostics: () => void;
}

export function SettingsDialog({
  onClose,
  mcpEnabled,
  onToggleMcpEnabled,
  mcpPath,
  focusSection,
  onFocusSectionHandled,
  diagnosticsStatus,
  onExportDiagnostics,
}: SettingsDialogProps) {
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
            {"×"}
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
          <section className="settings-dialog__section" aria-labelledby="diagnostics-heading">
            <span>
              <strong id="diagnostics-heading">Diagnostics</strong>
              <small>Save a scrubbed local report for troubleshooting</small>
            </span>
            <button
              type="button"
              className="settings-dialog__button"
              onClick={onExportDiagnostics}
            >
              Export diagnostics...
            </button>
            {diagnosticsStatus ? (
              <small className="settings-dialog__status" role="status">
                {diagnosticsStatus}
              </small>
            ) : null}
          </section>

          <OpenRaioToAiSection
            enabled={mcpEnabled}
            onToggle={onToggleMcpEnabled}
            mcpPath={mcpPath}
            focused={focusSection === "open-raio-to-ai"}
            onFocusHandled={onFocusSectionHandled}
          />

          <AboutMacrifySection
            focused={focusSection === "about-macrify"}
            onFocusHandled={onFocusSectionHandled}
          />
        </div>
      </section>
    </div>
  );
}
