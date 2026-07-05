import { useState } from "react";
import { MacrifyMarkIcon } from "../icons";
import { useSectionFocus } from "../hooks/useSectionFocus";
import "./SettingsSectionCard.css";
import "./AboutMacrifySection.css";

const CONNECT_URL = "https://macrify.me/connect";

export interface AboutMacrifySectionProps {
  /**
   * True for the render right after Preferences was opened via the "About
   * Macrify..." menu item or the title bar byline, as opposed to general
   * Preferences. See `useSectionFocus` for the scroll/highlight behavior.
   */
  focused?: boolean | undefined;
  onFocusHandled?: (() => void) | undefined;
}

export function AboutMacrifySection({ focused = false, onFocusHandled }: AboutMacrifySectionProps) {
  const { sectionRef, showFocusRing } = useSectionFocus(focused, onFocusHandled);
  const [licenseStatus, setLicenseStatus] = useState<string | null>(null);

  function handleOpenSourceLicenses() {
    setLicenseStatus(null);

    void (async () => {
      try {
        if (!isTauriRuntime()) {
          setLicenseStatus("Open source notices are bundled with installed RaioPDF builds.");
          return;
        }
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_source_licenses");
      } catch {
        setLicenseStatus("Open source notices could not be opened.");
      }
    })();
  }

  return (
    <section
      ref={sectionRef}
      id="about-macrify"
      className="settings-section about-macrify"
      aria-labelledby="about-macrify-heading"
      data-focused={showFocusRing ? "true" : undefined}
    >
      <header className="settings-section__header">
        <span className="settings-section__icon" aria-hidden="true">
          <MacrifyMarkIcon size={28} />
        </span>
        <div className="settings-section__heading-group">
          <p className="settings-section__eyebrow">Built by</p>
          <h3 id="about-macrify-heading">Macrify</h3>
        </div>
      </header>

      <p className="settings-section__lede">
        Raio is one thing an attorney-run automation shop builds for law firms &mdash; free,
        because it didn&rsquo;t need to be sold. If deadline tracking, document workflows, or a
        firm-wide AI layer is something your practice is chewing on, that&rsquo;s what Macrify
        does for a living.
      </p>

      <div className="about-macrify__actions">
        <a className="about-macrify__cta" href={CONNECT_URL} target="_blank" rel="noreferrer">
          See what Macrify builds
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M4 12 12 4M6 4h6v6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
        <button type="button" className="about-macrify__cta" onClick={handleOpenSourceLicenses}>
          Open source licenses
        </button>
      </div>

      {licenseStatus ? (
        <small className="about-macrify__status" role="status">
          {licenseStatus}
        </small>
      ) : null}
    </section>
  );
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
