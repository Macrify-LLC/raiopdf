import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RpIconSprite } from "./icons/RpIcon";
import { recordDiagnosticEvent } from "./lib/diagnostics";
import "./styles.css";

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

void mountApp();

// e2e-webdriver builds (Vite `--mode e2e`) load the WebDriver test bridge so
// @wdio/tauri-service can drive the app. `import.meta.env.MODE` is inlined at
// build time, so this branch — and the `@wdio/tauri-plugin` import with it — is
// stripped from every shipped build by dead-code elimination.
async function mountApp(): Promise<void> {
  if (import.meta.env.MODE === "e2e") {
    await import("@wdio/tauri-plugin");
  }

  createRoot(root!).render(
    <StrictMode>
      <RpIconSprite />
      <App />
    </StrictMode>,
  );
}

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
