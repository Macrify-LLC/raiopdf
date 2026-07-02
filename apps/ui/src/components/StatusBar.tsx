import { CheckIcon, ShieldCheckIcon } from "../icons";
import "./StatusBar.css";

export function StatusBar() {
  return (
    <footer className="status-bar">
      <span>Page 2 of 14</span>
      <span>8.5 × 11 in</span>
      <span>3.2 MB</span>
      <span className="status-bar__ok-chip">
        <CheckIcon size={12} />
        Searchable
      </span>
      <span className="status-bar__local">
        <ShieldCheckIcon size={13} checked={false} />
        All processing local — no files leave this computer
      </span>
    </footer>
  );
}
