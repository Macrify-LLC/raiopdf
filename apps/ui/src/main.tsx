import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RpIconSprite } from "./icons/RpIcon";
import "./styles.css";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("RaioPDF root element was not found.");
}

installLocalErrorLogging();

createRoot(root).render(
  <StrictMode>
    <RpIconSprite />
    <App />
  </StrictMode>,
);

function installLocalErrorLogging(): void {
  if (!isTauriRuntime()) {
    return;
  }

  window.addEventListener("error", (event) => {
    void recordDiagnosticEvent("window.error", event.message || "Uncaught UI error", [
      event.filename ? `file=${event.filename}` : null,
      Number.isFinite(event.lineno) ? `line=${event.lineno}` : null,
      Number.isFinite(event.colno) ? `column=${event.colno}` : null,
      event.error instanceof Error && event.error.stack ? event.error.stack : null,
    ]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    void recordDiagnosticEvent("window.unhandledrejection", reasonMessage(event.reason), [
      reasonStack(event.reason),
    ]);
  });
}

async function recordDiagnosticEvent(
  kind: string,
  message: string,
  details: Array<string | null>,
): Promise<void> {
  try {
    const invoke = await getTauriInvoke();
    await invoke("diagnostics_record_event", {
      event: {
        source: "ui",
        kind,
        message,
        details: details.filter(Boolean).join(" | ") || null,
      },
    });
  } catch {
    // Diagnostics must never create a second user-facing failure.
  }
}

async function getTauriInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");

  return invoke;
}

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }

  return "Unhandled promise rejection";
}

function reasonStack(reason: unknown): string | null {
  return reason instanceof Error && reason.stack ? reason.stack : null;
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
