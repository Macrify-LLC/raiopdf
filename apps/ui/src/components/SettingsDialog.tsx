import { useEffect, useState } from "react";
import { AboutMacrifySection } from "./AboutMacrifySection";
import { OpenRaioToAiSection } from "./OpenRaioToAiSection";
import { Switch } from "./Switch";
import type { AppUpdateStatus } from "../lib/appUpdates";
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
  mcpStatus?: string | null | undefined;
  diagnosticsStatus?: string | null | undefined;
  onExportDiagnostics: () => void;
  updateStatus: AppUpdateStatus;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onRelaunchForUpdate: () => void;
}

export function SettingsDialog({
  onClose,
  mcpEnabled,
  onToggleMcpEnabled,
  mcpPath,
  focusSection,
  onFocusSectionHandled,
  mcpStatus,
  diagnosticsStatus,
  onExportDiagnostics,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
  onRelaunchForUpdate,
}: SettingsDialogProps) {
  const [offerCrashReports, setOfferCrashReports] = useState(true);
  const [crashReportsLoading, setCrashReportsLoading] = useState(isTauriRuntime());
  const [crashReportsStatus, setCrashReportsStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const optedOut = await invoke<boolean>("crash_report_is_opted_out");
        if (!disposed) {
          setOfferCrashReports(!optedOut);
          setCrashReportsStatus(null);
        }
      } catch {
        if (!disposed) {
          setCrashReportsStatus("Crash report preference could not be loaded.");
        }
      } finally {
        if (!disposed) {
          setCrashReportsLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  function handleToggleCrashReports(next: boolean) {
    if (!isTauriRuntime()) {
      setOfferCrashReports(next);
      return;
    }

    const previous = offerCrashReports;
    setOfferCrashReports(next);
    setCrashReportsStatus(null);
    setCrashReportsLoading(true);

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("crash_report_set_opted_out", { value: !next });
        setCrashReportsStatus(null);
      } catch {
        setOfferCrashReports(previous);
        setCrashReportsStatus("Crash report preference could not be saved.");
      } finally {
        setCrashReportsLoading(false);
      }
    })();
  }

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
          <section className="settings-dialog__section" aria-labelledby="update-checks-heading">
            <span>
              <strong id="update-checks-heading">Update checks</strong>
              <small>Checks GitHub for signed Windows releases automatically</small>
            </span>
            <div className="settings-dialog__actions">
              <button
                type="button"
                className="settings-dialog__button"
                onClick={onCheckForUpdates}
                disabled={updateStatus.phase === "checking" || updateStatus.phase === "downloading"}
              >
                Check now
              </button>
              {updateStatus.phase === "available" || updateStatus.phase === "downloading" ? (
                <button
                  type="button"
                  className="settings-dialog__button settings-dialog__button--primary"
                  onClick={onInstallUpdate}
                  disabled={updateStatus.phase === "downloading"}
                >
                  Install update
                </button>
              ) : null}
              {updateStatus.phase === "installed" ? (
                <button
                  type="button"
                  className="settings-dialog__button settings-dialog__button--primary"
                  onClick={onRelaunchForUpdate}
                >
                  Restart
                </button>
              ) : null}
            </div>
            <small className="settings-dialog__status" role="status">
              {formatUpdateStatus(updateStatus)}
            </small>
          </section>
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
          <div className="settings-dialog__row">
            <span>
              <strong id="crash-reports-toggle-label">Offer to report crashes</strong>
              <small id="crash-reports-toggle-hint">
                Off means RaioPDF does not ask. When on, RaioPDF asks after an unclean exit;
                you always review before anything is sent.
              </small>
            </span>
            <Switch
              checked={offerCrashReports}
              onChange={handleToggleCrashReports}
              disabled={crashReportsLoading}
              aria-labelledby="crash-reports-toggle-label"
              aria-describedby="crash-reports-toggle-hint"
            />
            {crashReportsStatus ? (
              <small className="settings-dialog__status" role="status">
                {crashReportsStatus}
              </small>
            ) : null}
          </div>

          <OpenRaioToAiSection
            enabled={mcpEnabled}
            onToggle={onToggleMcpEnabled}
            mcpPath={mcpPath}
            status={mcpStatus}
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

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function formatUpdateStatus(status: AppUpdateStatus): string {
  return status.message;
}
