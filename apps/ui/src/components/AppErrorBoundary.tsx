import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorActions } from "./ErrorActions";
import { describeErrorChain, recordDiagnosticEvent } from "../lib/diagnostics";
import "./AppErrorBoundary.css";

/**
 * How many reloads to offer before concluding the failure survives one.
 *
 * A render error that reproduces on load turns "Reload" into a loop the user
 * can't escape, so after this many attempts the button goes away and the copy
 * says so instead of inviting a third try.
 */
const MAX_RELOAD_ATTEMPTS = 2;
const RELOAD_ATTEMPTS_KEY = "raiopdf.errorBoundary.reloadAttempts";

interface AppErrorBoundaryProps {
  children: ReactNode;
  /** Injectable for tests; defaults to a real page reload. */
  onReload?: (() => void) | undefined;
}

interface AppErrorBoundaryState {
  /**
   * Set by `getDerivedStateFromError`, which runs BEFORE `componentDidCatch`.
   *
   * Both are needed: without a flag here, render would return the children again,
   * the child would throw again, and React would give up and rethrow — leaving the
   * blank window this component exists to prevent. The correlation id arrives a
   * moment later from `componentDidCatch`, which is the only hook given the
   * component stack.
   */
  hasError: boolean;
  diagnosticId: string | null;
  reloadAttempts: number;
}

/**
 * Catches a render failure and gives the user something to do about it.
 *
 * Without this, a throw during render leaves a blank window: the window-level
 * `error` / `unhandledrejection` handlers in `main.tsx` write the failure to the
 * log, but nothing appears on screen and there is nothing to click. That is
 * simultaneously the moment a user most needs to report a problem and the moment
 * they have the least means to.
 *
 * What this does NOT cover, so nobody mistakes it for complete:
 *
 * - Event-handler exceptions and async rejections. React boundaries only see
 *   errors thrown during render, lifecycle, or constructors. Those paths are
 *   still covered by the window-level handlers, which log but do not render.
 * - Failures before the first render, or a failure inside this component itself.
 * - The Rust side. A panic in the shell is caught by the panic hook and surfaced
 *   as a crash report on the NEXT launch (`crash_report_take_pending`). A React
 *   error caught here does not produce one of those, and vice versa — the two
 *   mechanisms cover different halves and neither replaces the other.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    diagnosticId: null,
    reloadAttempts: readReloadAttempts(),
  };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    // Show the fallback on this commit; componentDidCatch records with the stack.
    return { hasError: true };
  }

  componentDidMount(): void {
    // A clean mount means whatever the counter was tracking is behind us. Clearing
    // it matters because it only ever incremented: after one recovered failure, a
    // later unrelated one inherited a spent budget — no Reload button, and copy
    // asserting a reload had been tried when it hadn't.
    //
    // In a lifecycle hook rather than render(): render must stay side-effect free,
    // and clearing there wiped the count before the fallback could read it.
    if (!this.state.hasError) {
      clearReloadAttempts();
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the whole reason to record here rather than rely on
    // the window handler: it names the subtree that failed, which a bare message
    // never does.
    const diagnosticId = recordDiagnosticEvent("ui.render-failed", describeErrorChain(error), [
      info.componentStack ? `componentStack=${info.componentStack}` : null,
      error.stack ?? null,
    ]);
    this.setState({ diagnosticId });
  }

  private handleReload = (): void => {
    writeReloadAttempts(this.state.reloadAttempts + 1);
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render(): ReactNode {
    const { hasError, diagnosticId, reloadAttempts } = this.state;

    if (!hasError) {
      return this.props.children;
    }

    const reloadWorthTrying = reloadAttempts < MAX_RELOAD_ATTEMPTS;

    // No role="alert" on the container: it implies aria-atomic, so ErrorActions'
    // nested status region would re-announce this whole panel on every copy — and
    // focus is moved here anyway, which announces it once. The alert is scoped to
    // the explanation paragraph instead.
    return (
      <div className="app-error-boundary">
        <div className="app-error-boundary__panel">
          {/* Focused on mount so a keyboard or screen-reader user lands on the
              explanation rather than wherever focus happened to be when the
              subtree disappeared. */}
          <h1 className="app-error-boundary__heading" tabIndex={-1} ref={focusOnMount}>
            Something went wrong
          </h1>
          <p className="app-error-boundary__body" role="alert">
            RaioPDF hit an unexpected error and had to stop drawing this window. Your files
            on disk are untouched — nothing was written.
          </p>
          {reloadWorthTrying ? (
            <p className="app-error-boundary__body">
              Reloading usually clears it. If it comes back, the problem is worth reporting.
            </p>
          ) : (
            <p className="app-error-boundary__body">
              Reloading didn’t clear it, so it’s not a transient glitch — please report it,
              and reopen RaioPDF to carry on.
            </p>
          )}

          <div className="app-error-boundary__actions">
            {reloadWorthTrying ? (
              <button
                type="button"
                className="app-error-boundary__reload"
                onClick={this.handleReload}
              >
                Reload RaioPDF
              </button>
            ) : null}
            <ErrorActions diagnosticId={diagnosticId} />
          </div>
        </div>
      </div>
    );
  }
}

function focusOnMount(node: HTMLHeadingElement | null): void {
  node?.focus();
}

/**
 * The reload counter lives in `sessionStorage` on purpose: it has to survive the
 * reload it is counting, but must not persist into a fresh launch — a failure
 * that has been fixed since should get its Reload button back.
 */
function readReloadAttempts(): number {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_ATTEMPTS_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // Storage can be unavailable; a missing counter just means "offer reload".
    return 0;
  }
}

function writeReloadAttempts(next: number): void {
  try {
    window.sessionStorage.setItem(RELOAD_ATTEMPTS_KEY, String(next));
  } catch {
    // Losing the counter only costs an extra reload offer.
  }
}

function clearReloadAttempts(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_ATTEMPTS_KEY);
  } catch {
    // Nothing to recover from; the counter is a nicety.
  }
}
