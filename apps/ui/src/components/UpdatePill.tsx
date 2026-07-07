import { useEffect, useRef, useState } from "react";
import type { AppUpdateStatus } from "../lib/appUpdates";
import { ArrowDownIcon, CheckIcon, RotateIcon, ICON_STROKE_WIDTH, ICON_VIEWBOX } from "../icons";
import "./UpdatePill.css";

export interface UpdatePillProps {
  status: AppUpdateStatus;
  /** Begin the background download (nothing installs yet). */
  onDownload: () => void;
  /** Run the installer for the already-downloaded update. */
  onInstall: () => void;
  /** Relaunch after an installed update. */
  onRelaunch: () => void;
}

/** Phases that give the pill something to show. Everything else hides it. */
const VISIBLE_PHASES = new Set<AppUpdateStatus["phase"]>([
  "available",
  "downloading",
  "downloaded",
  "installing",
  "installed",
  "error",
]);

/**
 * Unobtrusive top-bar update indicator. Appears whenever a newer signed release
 * is available and stays until the update is installed (the startup check
 * re-surfaces it every launch). Clicking opens a small popover with the one
 * contextual action for the current phase: Download → Install → Restart. Never
 * downloads or installs on its own — every step is an explicit click.
 */
export function UpdatePill({ status, onDownload, onInstall, onRelaunch }: UpdatePillProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  // Move focus into the popover when it opens (the action button when there
  // is one, otherwise the popover itself), and return it to the trigger on
  // close -- standard disclosure-widget focus handling for a `role="dialog"`.
  useEffect(() => {
    if (!open) {
      return;
    }

    const target = actionRef.current ?? popoverRef.current;
    target?.focus();

    return () => {
      triggerRef.current?.focus();
    };
  }, [open]);

  // If the phase becomes hidden while the popover is open, close it so the
  // open-gated window listeners are torn down — otherwise the component renders
  // null with `open` still true and the listeners leak until unmount.
  useEffect(() => {
    if (!VISIBLE_PHASES.has(status.phase)) {
      setOpen(false);
    }
  }, [status.phase]);

  if (!VISIBLE_PHASES.has(status.phase)) {
    return null;
  }

  const version = status.availableVersion ?? "update";
  const label = pillLabel(status, version);
  const action = popoverAction(status.phase, { onDownload, onInstall, onRelaunch });

  return (
    <div className="update-pill" ref={rootRef} data-phase={status.phase}>
      <button
        type="button"
        ref={triggerRef}
        className="update-pill__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`RaioPDF ${version} — ${status.message}`}
        title={status.message}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="update-pill__glyph" aria-hidden="true">
          {updateGlyph(status.phase, 13)}
        </span>
        <span className="update-pill__label">{label}</span>
      </button>
      {open ? (
        <div
          className="update-pill__popover"
          role="dialog"
          aria-label="Software update"
          ref={popoverRef}
          tabIndex={-1}
        >
          <div className="update-pill__popover-header">
            <span className="update-pill__popover-glyph" aria-hidden="true">
              {updateGlyph(status.phase, 15)}
            </span>
            <p className="update-pill__message">{status.message}</p>
          </div>
          {status.phase === "downloading" ? (
            <div
              className="update-pill__progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                typeof status.progress === "number"
                  ? Math.round(status.progress * 100)
                  : undefined
              }
            >
              <span
                className="update-pill__progress-fill"
                data-indeterminate={status.progress == null ? "true" : undefined}
                style={
                  typeof status.progress === "number"
                    ? { width: `${Math.round(status.progress * 100)}%` }
                    : undefined
                }
              />
            </div>
          ) : null}
          {action ? (
            <button
              type="button"
              ref={actionRef}
              className="update-pill__action"
              onClick={() => {
                action.run();
                if (action.closeOnRun) {
                  setOpen(false);
                }
              }}
            >
              {action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Phase → glyph. Reuses the app's real icon set (download / check / rotate)
 * instead of ad hoc Unicode characters, at whatever `size` the call site
 * needs (the compact trigger vs. the slightly larger popover header). "error"
 * has no dedicated icon in the kit yet, so it stays a small local glyph drawn
 * on the same 20x20 / 1.5px-stroke grid as every other RaioPDF icon.
 */
function updateGlyph(phase: AppUpdateStatus["phase"], size: number) {
  switch (phase) {
    case "downloaded":
      return <CheckIcon size={size} />;
    case "installed":
      return <RotateIcon size={size} />;
    case "installing":
      // Same restart glyph as "installed", spinning while it actually runs.
      return <RotateIcon size={size} className="update-pill__glyph-spin" />;
    case "error":
      return <AlertGlyph size={size} />;
    default:
      // available / downloading both read as "update in flight, coming down".
      return <ArrowDownIcon size={size} />;
  }
}

function AlertGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3.4 17.3 16H2.7Z" />
      <path d="M10 8v3.6" />
      <circle cx="10" cy="14.1" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function pillLabel(status: AppUpdateStatus, version: string): string {
  switch (status.phase) {
    case "downloading":
      return typeof status.progress === "number"
        ? `${Math.round(status.progress * 100)}%`
        : "…";
    case "installing":
      return "Installing";
    case "installed":
      return "Restart";
    case "error":
      return "Update";
    default:
      return version;
  }
}

function popoverAction(
  phase: AppUpdateStatus["phase"],
  handlers: { onDownload: () => void; onInstall: () => void; onRelaunch: () => void },
): { label: string; run: () => void; closeOnRun: boolean } | null {
  switch (phase) {
    case "available":
      return { label: "Download in background", run: handlers.onDownload, closeOnRun: false };
    case "downloaded":
      return { label: "Install now", run: handlers.onInstall, closeOnRun: false };
    case "installed":
      return { label: "Restart RaioPDF", run: handlers.onRelaunch, closeOnRun: true };
    case "error":
      return { label: "Try again", run: handlers.onDownload, closeOnRun: false };
    default:
      // downloading / installing are in-progress; no action button.
      return null;
  }
}
