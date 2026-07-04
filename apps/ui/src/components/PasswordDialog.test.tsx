// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDialogStackForTests } from "./FloatingDialog";
import { PasswordDialog, type PasswordDialogPhase } from "./PasswordDialog";

describe("PasswordDialog", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    resetDialogStackForTests();
  });

  it("submits the typed password on Unlock", () => {
    const onSubmit = vi.fn();
    renderDialog({ phase: "prompt", error: null, onSubmit });

    typePassword("hunter2");
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith("hunter2");
  });

  it("does not submit an empty password", () => {
    const onSubmit = vi.fn();
    renderDialog({ phase: "prompt", error: null, onSubmit });

    submitForm();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(getButton("Unlock").hasAttribute("disabled")).toBe(true);
  });

  it("submits on Enter from the password field", () => {
    const onSubmit = vi.fn();
    renderDialog({ phase: "prompt", error: null, onSubmit });

    typePassword("hunter2");
    getInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    // jsdom does not auto-submit forms on Enter -- exercise the same path a
    // real Enter keypress takes in a browser.
    submitForm();

    expect(onSubmit).toHaveBeenCalledWith("hunter2");
  });

  it("shows the honest default hint when there is no error yet", () => {
    renderDialog({ phase: "prompt", error: null, onSubmit: () => undefined });

    expect(document.body.textContent).toContain(
      "If this PDF uses an unusual encryption scheme, unlocking may not succeed.",
    );
  });

  it("shows the running state with no input while unlocking", () => {
    renderDialog({ phase: "unlocking", error: null, onSubmit: () => undefined });

    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector("[role='status']")?.textContent).toBe(
      "Unlocking the document…",
    );
  });

  it("shows starting-engine status before unlocking begins", () => {
    renderDialog({ phase: "starting-engine", error: null, onSubmit: () => undefined });

    expect(document.querySelector("[role='status']")?.textContent).toBe(
      "Starting the PDF engine…",
    );
  });

  it("on a wrong-password retry, keeps the dialog open, shows the inline error, and selects the input", () => {
    const onCancel = vi.fn();
    renderDialog({ phase: "prompt", error: null, onSubmit: () => undefined, onCancel });

    typePassword("wrong-guess");

    // Simulate the parent flipping back to "prompt" with an error after the
    // unlock attempt failed -- the dialog stays open (no onCancel call) and
    // the same component instance re-renders with the new error prop.
    rerenderDialog({ phase: "prompt", error: "That password wasn't accepted. Try again.", onSubmit: () => undefined, onCancel });

    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toBe(
      "That password wasn't accepted. Try again.",
    );
    expect(getInput().value).toBe("wrong-guess");
    expect(document.activeElement).toBe(getInput());
    expect(getInput().selectionStart).toBe(0);
    expect(getInput().selectionEnd).toBe("wrong-guess".length);
  });

  it("cancels via the secondary button", () => {
    const onCancel = vi.fn();
    renderDialog({ phase: "prompt", error: null, onSubmit: () => undefined, onCancel });

    clickButton("Cancel");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  interface DialogProps {
    phase: PasswordDialogPhase;
    error: string | null;
    onSubmit: (password: string) => void;
    onCancel?: () => void;
  }

  function renderDialog(props: DialogProps) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<Harness {...props} />);
    });
  }

  function rerenderDialog(props: DialogProps) {
    act(() => {
      root?.render(<Harness {...props} />);
    });
  }

  function Harness({ phase, error, onSubmit, onCancel }: DialogProps) {
    return (
      <PasswordDialog
        fileName="sealed-order.pdf"
        phase={phase}
        error={error}
        onSubmit={onSubmit}
        onCancel={onCancel ?? (() => undefined)}
      />
    );
  }

  function typePassword(value: string) {
    const input = getInput();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function submitForm() {
    const form = document.querySelector("form");

    if (!form) {
      throw new Error("Password form not found.");
    }

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function getInput(): HTMLInputElement {
    const input = document.querySelector("input[type='password']");

    if (!input) {
      throw new Error("Password input not found.");
    }

    return input as HTMLInputElement;
  }

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element): element is HTMLButtonElement => element.textContent?.trim() === name,
    );

    if (!button) {
      throw new Error(`Button not found: ${name}`);
    }

    return button;
  }

  function clickButton(name: string) {
    act(() => {
      getButton(name).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
});
