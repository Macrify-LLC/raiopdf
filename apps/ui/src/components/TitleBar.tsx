import { BoltIcon } from "../icons";
import "./TitleBar.css";

export interface DocumentTabInfo {
  id: string;
  fileName: string;
  active?: boolean;
  dirty?: boolean;
}

export interface TitleBarProps {
  tabs?: DocumentTabInfo[];
}

const DEMO_TABS: DocumentTabInfo[] = [
  { id: "demo-doc", fileName: "Roe v. Acme Citrus — MSJ.pdf", active: true },
];

export function TitleBar({ tabs = DEMO_TABS }: TitleBarProps) {
  return (
    <header className="title-bar">
      <div className="title-bar__brand">
        <span className="title-bar__mark">
          <BoltIcon size={13} className="title-bar__mark-icon" />
        </span>
        <span className="title-bar__wordmark">
          Raio<span className="title-bar__wordmark-accent">PDF</span>
        </span>
      </div>

      <div className="title-bar__tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="title-bar__tab"
            aria-current={tab.active ? "page" : undefined}
          >
            {tab.dirty ? (
              <span
                className="title-bar__tab-dot"
                aria-label="Unsaved changes"
                title="Unsaved changes"
              />
            ) : null}
            {tab.fileName}
          </div>
        ))}
      </div>

      <div className="title-bar__meta">
        <span className="title-bar__byline">Built by Macrify</span>
      </div>
    </header>
  );
}
