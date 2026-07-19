import { useEffect, useState } from "react";
import type { PdfCoverStyle } from "@raiopdf/engine-api";
import type { JurisdictionPack, JurisdictionPackId } from "@raiopdf/rules";
import { AboutMacrifySection } from "./AboutMacrifySection";
import { CoverStylePicker } from "./CoverStylePicker";
import { OpenRaioToAiSection } from "./OpenRaioToAiSection";
import { Switch } from "./Switch";
import type { AppUpdateStatus } from "../lib/appUpdates";
import { getWordCapability, type WordCapability } from "../lib/wordCapability";
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
  /** The registry pack list, threaded from App like the other pack pickers. */
  filingPacks: readonly JurisdictionPack[];
  defaultFilingPackId: JurisdictionPackId;
  onDefaultFilingPackChange: (packId: JurisdictionPackId) => void;
  defaultCoverStyle: PdfCoverStyle;
  onDefaultCoverStyleChange: (style: PdfCoverStyle) => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
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
  filingPacks,
  defaultFilingPackId,
  onDefaultFilingPackChange,
  defaultCoverStyle,
  onDefaultCoverStyleChange,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onRelaunchForUpdate,
}: SettingsDialogProps) {
  // The update section shows at most one primary button; which one (and its
  // label/disabled state) is a pure function of the phase.
  const primaryUpdate = primaryUpdateButton(updateStatus, {
    onDownloadUpdate,
    onInstallUpdate,
    onRelaunchForUpdate,
  });
  const [offerCrashReports, setOfferCrashReports] = useState(true);
  const [crashReportsLoading, setCrashReportsLoading] = useState(isTauriRuntime());
  const [crashReportsStatus, setCrashReportsStatus] = useState<string | null>(null);
  const [wordCapability, setWordCapability] = useState<WordCapability>(() =>
    isTauriRuntime() ? { state: "notDetected", reason: null } : { state: "notApplicable", reason: null },
  );
  const [wordCapabilityLoading, setWordCapabilityLoading] = useState(isTauriRuntime());
  const [wordCapabilityStatus, setWordCapabilityStatus] = useState<string | null>(null);

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

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;

    void (async () => {
      try {
        const capability = await getWordCapability(false);
        if (!disposed) {
          setWordCapability(capability);
          setWordCapabilityStatus(null);
        }
      } catch {
        if (!disposed) {
          setWordCapabilityStatus("Word integration could not be checked.");
        }
      } finally {
        if (!disposed) {
          setWordCapabilityLoading(false);
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

  function handleTestWordCapability() {
    if (!isTauriRuntime()) {
      return;
    }

    setWordCapabilityLoading(true);
    setWordCapabilityStatus(null);

    void (async () => {
      try {
        const capability = await getWordCapability(true);
        setWordCapability(capability);
        setWordCapabilityStatus(null);
      } catch {
        setWordCapabilityStatus("Word integration test could not run.");
      } finally {
        setWordCapabilityLoading(false);
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
          <h2 id="settings-dialog-title">Settings</h2>
          <button
            type="button"
            className="settings-dialog__close"
            aria-label="Close settings"
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
                disabled={isUpdateInFlight(updateStatus.phase)}
              >
                Check now
              </button>
              {primaryUpdate ? (
                <button
                  type="button"
                  className="settings-dialog__button settings-dialog__button--primary"
                  onClick={primaryUpdate.onClick}
                  disabled={primaryUpdate.disabled}
                >
                  {primaryUpdate.label}
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
            <select
              value={defaultFilingPackId}
              onChange={(event) => onDefaultFilingPackChange(event.target.value as JurisdictionPackId)}
            >
              {filingPacks.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.jurisdiction} - {pack.portal}
                </option>
              ))}
            </select>
            <small className="settings-dialog__status">
              Applies the next time RaioPDF opens; this window keeps its current
              jurisdiction. Switching jurisdiction inside Prepare for Filing also
              updates this default.
            </small>
          </label>
          <div className="settings-dialog__row settings-dialog__row--stacked">
            <span>
              <strong>Default exhibit cover style</strong>
              <small>Used for slip sheets in Combine with Exhibits and Organize Pages</small>
            </span>
            <CoverStylePicker
              value={defaultCoverStyle}
              onChange={onDefaultCoverStyleChange}
              size="sm"
            />
          </div>
          <section className="settings-dialog__section" aria-labelledby="word-integration-heading">
            <span>
              <strong id="word-integration-heading">Word integration</strong>
              <small>{formatWordCapabilityDetail(wordCapability)}</small>
            </span>
            <div className="settings-dialog__actions">
              <button
                type="button"
                className="settings-dialog__button"
                onClick={handleTestWordCapability}
                disabled={
                  wordCapabilityLoading ||
                  !isTauriRuntime() ||
                  wordCapability.state === "notApplicable"
                }
              >
                Test
              </button>
            </div>
            <small className="settings-dialog__status" role="status">
              {wordCapabilityLoading ? "Checking..." : formatWordCapabilityLabel(wordCapability)}
              {wordCapabilityStatus ? ` ${wordCapabilityStatus}` : ""}
            </small>
          </section>
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

function formatWordCapabilityLabel(capability: WordCapability): string {
  switch (capability.state) {
    case "available":
      return "Available";
    case "detected":
      return "Detected";
    case "unavailable":
      return "Unavailable";
    case "notDetected":
      return "Not detected";
    case "notApplicable":
      return "Not applicable";
  }
}

function formatWordCapabilityDetail(capability: WordCapability): string {
  switch (capability.state) {
    case "available":
      return "Microsoft Word started successfully.";
    case "detected":
      return "Microsoft Word is registered. Test to confirm it can start.";
    case "unavailable":
      return capability.reason ?? "Microsoft Word is registered but could not start.";
    case "notDetected":
      return "Microsoft Word was not found.";
    case "notApplicable":
      return "Word integration is only available on Windows.";
  }
}

/**
 * Phases where a re-check would be destructive (it discards the staged download
 * handle) or redundant (already checking) — "Check now" is disabled for these.
 */
function isUpdateInFlight(phase: AppUpdateStatus["phase"]): boolean {
  return (
    phase === "checking" ||
    phase === "downloading" ||
    phase === "downloaded" ||
    phase === "installing" ||
    phase === "installed"
  );
}

/**
 * The single primary action offered in the update section for the current
 * phase (or null when only "Check now" applies). Download → Install now →
 * Restart, with the in-progress phases shown as a disabled button.
 */
function primaryUpdateButton(
  status: AppUpdateStatus,
  handlers: {
    onDownloadUpdate: () => void;
    onInstallUpdate: () => void;
    onRelaunchForUpdate: () => void;
  },
): { onClick: () => void; disabled: boolean; label: string } | null {
  switch (status.phase) {
    case "available":
    case "downloading":
      return {
        onClick: handlers.onDownloadUpdate,
        disabled: status.phase === "downloading",
        label: status.phase === "downloading" ? "Downloading…" : "Download update",
      };
    case "downloaded":
    case "installing":
      return {
        onClick: handlers.onInstallUpdate,
        disabled: status.phase === "installing",
        label: status.phase === "installing" ? "Installing…" : "Install now",
      };
    case "installed":
      return { onClick: handlers.onRelaunchForUpdate, disabled: false, label: "Restart" };
    default:
      return null;
  }
}
