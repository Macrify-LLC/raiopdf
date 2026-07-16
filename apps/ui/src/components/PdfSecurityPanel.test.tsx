// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileGrant } from "../lib/filePort";
import {
  PdfSecurityPanel,
  type CreateProtectedCopyResult,
  type PdfSecurityPanelProps,
  type PrepareProtectedCopyResult,
  validatePdfOpenPassword,
} from "./PdfSecurityPanel";

describe("PdfSecurityPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let currentProps: PdfSecurityPanelProps | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }

    container?.remove();
    root = null;
    container = null;
    currentProps = null;
    vi.restoreAllMocks();
  });

  it("truthfully describes an unprotected document", () => {
    renderPanel();

    const status = document.querySelector("[aria-labelledby='pdf-security-current-status']");

    expect(status?.textContent).toContain("This PDF");
    expect(status?.textContent).toContain("Not protected");
    expect(status?.textContent).toContain("No open password is required");
    expect(status?.textContent).toContain("motion.pdf");
    expect(document.body.textContent).toContain("The original stays open and is never changed.");
  });

  it("reports known protection and permission facts for the current document", () => {
    renderPanel({
      documentState: {
        kind: "protected-unlocked",
        encryptionLabel: "AES-256",
        printing: "allowed",
        copying: "blocked",
        signature: "none",
        pdfA: false,
      },
    });

    const status = document.querySelector("[aria-labelledby='pdf-security-current-status']");

    expect(status?.textContent).toContain("Protected and unlocked for this session");
    expect(status?.textContent).toContain("AES-256 protected");
    expect(status?.textContent).toContain("Printing allowed");
    expect(status?.textContent).toContain("Copying blocked");
    expect(document.body.textContent).toContain("Create a newly protected copy");
    expect(getButton("Save Unlocked Copy")).not.toBeNull();
  });

  it("describes owner restrictions without guessing unknown encryption details", () => {
    renderPanel({
      documentState: {
        kind: "owner-restricted",
        encryptionLabel: null,
        printing: "unknown",
        copying: "allowed",
        signature: "none",
        pdfA: false,
      },
    });

    const status = document.querySelector("[aria-labelledby='pdf-security-current-status']");
    expect(status?.textContent).toContain("Owner-restricted");
    expect(status?.textContent).toContain("Protected — encryption details unavailable");
    expect(status?.textContent).toContain("Printing unknown");
    expect(status?.textContent).toContain("Copying allowed");
  });

  it("shows a quiet empty state when no document is open", () => {
    renderPanel({ documentKey: null, fileName: null, documentState: null });

    expect(document.body.textContent).toContain("Open a PDF to review or change its security.");
    expect(document.querySelector("form")).toBeNull();
  });

  it("keeps status visible but blocks creation outside the installed desktop app", () => {
    renderPanel({ desktopAvailable: false });

    expect(document.body.textContent).toContain("Not protected");
    expect(document.body.textContent).toContain(
      "Creating protected copies is available in the installed RaioPDF app.",
    );
    expect(document.querySelector("form")).toBeNull();
  });

  it("blocks protection when the PDF contains a cryptographic signature", () => {
    renderPanel({
      documentState: {
        kind: "unprotected",
        signature: "present",
        pdfA: false,
      },
    });

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "This PDF contains a digital signature",
    );
    expect(document.body.textContent).toContain("Protect the PDF before signing it.");
    expect(document.querySelector("form")).toBeNull();
  });

  it("still offers the existing unlocked-copy flow for a signed protected source", () => {
    renderPanel({
      documentState: {
        kind: "protected-unlocked",
        encryptionLabel: "AES-256",
        printing: "allowed",
        copying: "allowed",
        signature: "present",
        pdfA: false,
      },
    });

    expect(document.querySelector("form")).toBeNull();
    expect(getButton("Save Unlocked Copy")).not.toBeNull();
  });

  it("fails closed with distinct copy when signature detection is unavailable", () => {
    renderPanel({
      documentState: {
        kind: "unprotected",
        signature: "unknown",
        pdfA: false,
      },
    });

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "RaioPDF could not verify whether this PDF contains a digital signature.",
    );
    expect(document.body.textContent).toContain("Protection is unavailable for this document.");
    expect(document.body.textContent).not.toContain("This PDF contains a digital signature.");
    expect(document.querySelector("form")).toBeNull();
  });

  it("chooses an output before rendering any password controls", async () => {
    const onPrepareProtectedCopy = vi.fn().mockResolvedValue({
      status: "ready",
      displayName: "motion-protected.pdf",
    });
    renderPanel({ onPrepareProtectedCopy });

    expect(document.querySelector("input[type='password']")).toBeNull();
    expect(document.body.textContent).toContain(
      "No password is requested until the save location is ready.",
    );

    await prepareOutput();

    expect(onPrepareProtectedCopy).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("motion-protected.pdf");
    expect(document.querySelectorAll("input[type='password']")).toHaveLength(2);
  });

  it("keeps credentials unmounted while the native output picker is open", async () => {
    const onPrepareProtectedCopy = vi.fn(() => new Promise<never>(() => undefined));
    renderPanel({ onPrepareProtectedCopy });

    await act(async () => {
      getButton("Choose Protected Copy…").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(getButton("Choosing output…").disabled).toBe(true);
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("Open password");
  });

  it("returns gracefully to output selection when preparation is cancelled", async () => {
    renderPanel({
      onPrepareProtectedCopy: vi.fn().mockResolvedValue({ status: "cancelled" }),
    });

    await prepareOutput();

    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("shows preparation errors without ever exposing password controls", async () => {
    renderPanel({
      onPrepareProtectedCopy: vi.fn().mockResolvedValue({
        status: "error",
        message: "That location is not writable.",
      }),
    });

    await prepareOutput();

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "That location is not writable.",
    );
    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
  });

  it("clears secrets before allowing a different output to be selected", async () => {
    const onPrepareProtectedCopy = vi.fn().mockResolvedValue({
      status: "ready",
      displayName: "motion-protected.pdf",
    });
    const onDiscardPreparedCopy = vi.fn();
    renderPanel({ onPrepareProtectedCopy, onDiscardPreparedCopy });
    await prepareOutput();
    expect(document.body.textContent).not.toContain("Save Unlocked Copy");
    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");

    clickButton("Choose another");

    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("private secret");
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
    expect(onPrepareProtectedCopy).toHaveBeenCalledOnce();
    expect(onDiscardPreparedCopy).toHaveBeenCalledOnce();
  });

  it("submits the exact Unicode password with printing and copying allowed by default", async () => {
    const onCreateProtectedCopy = vi.fn().mockResolvedValue({ status: "cancelled" });
    renderPanel({ onCreateProtectedCopy });
    await prepareOutput();

    typeInto("Open password", "Mañana-secreto");
    typeInto("Confirm password", "Mañana-secreto");
    await submitForm();

    expect(onCreateProtectedCopy).toHaveBeenCalledWith({
      password: "Mañana-secreto",
      allowPrinting: true,
      allowCopying: true,
    });
  });

  it("submits disabled print and copy permissions while preserving accessibility access", async () => {
    const onCreateProtectedCopy = vi.fn().mockResolvedValue({ status: "cancelled" });
    renderPanel({ onCreateProtectedCopy });
    await prepareOutput();

    clickCheckbox("Allow printing");
    clickCheckbox("Allow copying");

    expect(document.body.textContent).toContain("Accessibility access remains allowed.");

    typeInto("Open password", "correct horse");
    typeInto("Confirm password", "correct horse");
    await submitForm();

    expect(onCreateProtectedCopy).toHaveBeenCalledWith({
      password: "correct horse",
      allowPrinting: false,
      allowCopying: false,
    });
  });

  it("requires eight characters and recommends twelve without blocking", async () => {
    renderPanel();
    await prepareOutput();

    typeInto("Open password", "1234567");
    typeInto("Confirm password", "1234567");
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Use at least 8 characters.",
    );
    expect(getButton("Create Protected Copy").disabled).toBe(true);

    typeInto("Open password", "12345678");
    typeInto("Confirm password", "12345678");
    expect(document.body.textContent).toContain("Accepted. A longer passphrase is recommended.");
    expect(getButton("Create Protected Copy").disabled).toBe(false);
  });

  it("requires exact confirmation without trimming or Unicode normalization", async () => {
    renderPanel();
    await prepareOutput();

    typeInto("Open password", "Café-secret");
    typeInto("Confirm password", "Cafe\u0301-secret");

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Passwords do not match exactly.",
    );
    expect(getButton("Create Protected Copy").disabled).toBe(true);
  });

  it("focuses the field that prevents keyboard submission", async () => {
    renderPanel();
    await prepareOutput();

    typeInto("Open password", "1234567");
    typeInto("Confirm password", "1234567");
    await submitForm();
    expect(document.activeElement).toBe(getInput("Open password"));

    typeInto("Open password", "correct horse");
    typeInto("Confirm password", "different horse");
    await submitForm();
    expect(document.activeElement).toBe(getInput("Confirm password"));
  });

  it("rejects line breaks because the secure password transport is line based", () => {
    expect(validatePdfOpenPassword("line-one\nline-two", "line-one\nline-two")).toMatchObject({
      valid: false,
      error: "Passwords cannot contain line breaks.",
    });
    expect(validatePdfOpenPassword("line-one\rline-two", "line-one\rline-two")).toMatchObject({
      valid: false,
      error: "Passwords cannot contain line breaks.",
    });
  });

  it("rejects NUL characters before secret transport", () => {
    expect(validatePdfOpenPassword("private\0secret", "private\0secret")).toMatchObject({
      valid: false,
      error: "Passwords cannot contain NUL characters.",
    });
  });

  it("enforces the 127-byte UTF-8 interoperability limit", () => {
    const atLimit = `${"é".repeat(63)}a`;
    const overLimit = "é".repeat(64);

    expect(validatePdfOpenPassword(atLimit, atLimit)).toMatchObject({ valid: true });
    expect(validatePdfOpenPassword(overLimit, overLimit)).toMatchObject({
      valid: false,
      error: "Use no more than 127 UTF-8 bytes.",
    });
  });

  it("warns about boundary whitespace but submits it unchanged", async () => {
    const onCreateProtectedCopy = vi.fn().mockResolvedValue({ status: "cancelled" });
    renderPanel({ onCreateProtectedCopy });
    await prepareOutput();

    typeInto("Open password", " correct horse ");
    typeInto("Confirm password", " correct horse ");

    expect(document.body.textContent).toContain(
      "This password starts or ends with whitespace. Those characters will be kept.",
    );

    await submitForm();
    expect(onCreateProtectedCopy).toHaveBeenCalledWith(
      expect.objectContaining({ password: " correct horse " }),
    );
  });

  it("shows the UTF-8 byte-limit error in the form", async () => {
    renderPanel();
    await prepareOutput();
    const overLimit = "é".repeat(64);

    typeInto("Open password", overLimit);
    typeInto("Confirm password", overLimit);

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Use no more than 127 UTF-8 bytes.",
    );
    expect(getButton("Create Protected Copy").disabled).toBe(true);
  });

  it("reveals and hides both password fields with one accessible control", async () => {
    renderPanel();
    await prepareOutput();

    const showButton = getButton("Show passwords");
    expect(showButton.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll("input[type='password']")).toHaveLength(2);

    clickButton("Show passwords");
    expect(getButton("Hide passwords").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("input[type='text']")).toHaveLength(2);
  });

  it("shows a truthful verified receipt, clears secrets, and uses the opaque output for actions", async () => {
    const output = {
      grant: "protected-output-grant" as FileGrant,
      displayName: "motion-protected.pdf",
      displayLocation: "Documents",
    };
    const onOpenProtectedCopy = vi.fn();
    const onShowProtectedCopyInFolder = vi.fn();
    renderPanel({
      onCreateProtectedCopy: vi.fn().mockResolvedValue({
        status: "success",
        output,
        allowPrinting: true,
        allowCopying: false,
      }),
      onOpenProtectedCopy,
      onShowProtectedCopyInFolder,
    });
    await prepareOutput();

    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");
    await submitForm();

    const receipt = document.querySelector("[data-verified-success='true']");
    expect(receipt?.textContent).toContain("Protected copy created");
    expect(receipt?.textContent).toContain("AES-256");
    expect(receipt?.textContent).toContain("motion-protected.pdf");
    expect(receipt?.textContent).toContain("Documents");
    expect(receipt?.textContent).toContain("This PDF is still open and unchanged");
    expect(receipt?.textContent).toContain(
      "When practical, send the PDF and its password through different channels.",
    );
    expect(document.body.textContent).not.toContain("private secret");
    expect(document.querySelector("input")).toBeNull();
    expect(document.getElementById("pdf-security-current-status")?.textContent).toBe(
      "Not protected",
    );
    expect(document.activeElement).toBe(document.getElementById("pdf-security-success-title"));
    expect(document.querySelector("[aria-live='polite']")?.textContent).toContain(
      "Protected copy created and verified with AES-256.",
    );

    clickButton("Open Protected Copy");
    clickButton("Show in folder");
    expect(onOpenProtectedCopy).toHaveBeenCalledWith(output);
    expect(onShowProtectedCopyInFolder).toHaveBeenCalledWith(output);
  });

  it("consumes the prepared target and clears secrets after every creation error", async () => {
    renderPanel({
      onCreateProtectedCopy: vi.fn().mockResolvedValue({
        status: "error",
        message: "Choose a different output location.",
      }),
    });
    await prepareOutput();

    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");
    await submitForm();

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Choose a different output location.",
    );
    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
    expect(document.body.textContent).not.toContain("private secret");
  });

  it("requires a fresh output selection when creation is cancelled", async () => {
    renderPanel({
      onCreateProtectedCopy: vi.fn().mockResolvedValue({ status: "cancelled" }),
    });
    await prepareOutput();

    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");
    await submitForm();

    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
    expect(document.body.textContent).not.toContain("private secret");
  });

  it("clears secrets after a nonrecoverable protection error", async () => {
    renderPanel({
      onCreateProtectedCopy: vi.fn().mockResolvedValue({
        status: "error",
        message: "Verification failed. No protected copy was kept.",
      }),
    });
    await prepareOutput();

    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");
    await submitForm();

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "Verification failed. No protected copy was kept.",
    );
    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
  });

  it("fails safely and clears secrets when orchestration unexpectedly rejects", async () => {
    renderPanel({
      onCreateProtectedCopy: vi.fn().mockRejectedValue(new Error("secret-bearing internal error")),
    });
    await prepareOutput();

    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");
    await submitForm();

    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "RaioPDF could not create the protected copy.",
    );
    expect(document.body.textContent).not.toContain("secret-bearing internal error");
    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
  });

  it("clears the prepared target and secrets when the open document identity changes", async () => {
    renderPanel();
    await prepareOutput();
    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");

    rerenderPanel({ documentKey: "document-2", fileName: "second.pdf" });

    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("motion-protected.pdf");
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
  });

  it("ignores a stale prepared target after the open document changes", async () => {
    let resolvePreparation!: (result: PrepareProtectedCopyResult) => void;
    const preparation = new Promise<PrepareProtectedCopyResult>((resolve) => {
      resolvePreparation = resolve;
    });
    renderPanel({ onPrepareProtectedCopy: vi.fn(() => preparation) });

    clickButton("Choose Protected Copy…");
    rerenderPanel({ documentKey: "document-2", fileName: "second.pdf" });

    await act(async () => {
      resolvePreparation({ status: "ready", displayName: "wrong-document.pdf" });
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain("wrong-document.pdf");
    expect(document.querySelector("input")).toBeNull();
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
  });

  it("ignores a stale operation completion after a new document starts its own run", async () => {
    let resolveOld!: (result: CreateProtectedCopyResult) => void;
    let resolveNew!: (result: CreateProtectedCopyResult) => void;
    const oldRun = new Promise<CreateProtectedCopyResult>((resolve) => { resolveOld = resolve; });
    const newRun = new Promise<CreateProtectedCopyResult>((resolve) => { resolveNew = resolve; });
    renderPanel({ onCreateProtectedCopy: vi.fn(() => oldRun) });
    await prepareOutput();

    typeInto("Open password", "first secret");
    typeInto("Confirm password", "first secret");
    await submitForm();

    rerenderPanel({
      documentKey: "document-2",
      fileName: "second.pdf",
      onCreateProtectedCopy: vi.fn(() => newRun),
    });
    await prepareOutput();
    typeInto("Open password", "second secret");
    typeInto("Confirm password", "second secret");
    await submitForm();
    expect(getButton("Creating protected copy…")).not.toBeNull();

    await act(async () => {
      resolveOld({ status: "cancelled" });
      await Promise.resolve();
    });

    expect(getButton("Creating protected copy…")).not.toBeNull();

    await act(async () => {
      resolveNew({ status: "cancelled" });
      await Promise.resolve();
    });
  });

  it("clears the prepared target and secrets when the app becomes hidden", async () => {
    renderPanel();
    await prepareOutput();
    typeInto("Open password", "private secret");
    typeInto("Confirm password", "private secret");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("motion-protected.pdf");
    expect(getButton("Choose Protected Copy…")).not.toBeNull();
  });

  it("reports accurate parent-driven operation phases without exposing secrets", async () => {
    renderPanel();
    await prepareOutput();
    typeInto("Open password", "private secret");

    const phases = [
      ["choosing-output", "Choose where to save the protected copy…"],
      ["preparing", "Preparing current edits…"],
      ["encrypting", "Creating protected copy…"],
      ["verifying", "Verifying AES-256 protection…"],
    ] as const;

    for (const [progress, copy] of phases) {
      rerenderPanel({ progress });
      expect(document.querySelector("[aria-live='polite']")?.textContent).toContain(copy);
      expect(document.body.textContent).not.toContain("private secret");
      expect(document.querySelector("input")).toBeNull();
    }
  });

  function renderPanel(overrides: Partial<PdfSecurityPanelProps> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    currentProps = {
      documentKey: "document-1",
      fileName: "motion.pdf",
      documentState: {
        kind: "unprotected",
        signature: "none",
        pdfA: false,
      },
      desktopAvailable: true,
      progress: "idle",
      onPrepareProtectedCopy: vi.fn().mockResolvedValue({
        status: "ready",
        displayName: "motion-protected.pdf",
      }),
      onDiscardPreparedCopy: vi.fn(),
      onCreateProtectedCopy: vi.fn().mockResolvedValue({ status: "cancelled" }),
      onSaveUnlockedCopy: vi.fn(),
      onOpenProtectedCopy: vi.fn(),
      onShowProtectedCopyInFolder: vi.fn(),
      ...overrides,
    };

    act(() => {
      root?.render(<PdfSecurityPanel {...currentProps!} />);
    });
  }

  function rerenderPanel(overrides: Partial<PdfSecurityPanelProps>) {
    if (!currentProps) {
      throw new Error("Panel has not been rendered.");
    }

    currentProps = { ...currentProps, ...overrides };

    act(() => {
      root?.render(<PdfSecurityPanel {...currentProps!} />);
    });
  }

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate): candidate is HTMLButtonElement =>
        candidate.textContent?.trim() === name || candidate.getAttribute("aria-labelledby")
          ?.split(" ")
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .includes(name) === true,
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

  function clickCheckbox(name: string) {
    const label = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes(name),
    );
    const checkbox = label?.querySelector("input[type='checkbox']");

    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error(`Checkbox not found: ${name}`);
    }

    act(() => {
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function getInput(name: string): HTMLInputElement {
    const label = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes(name),
    );
    const input = label?.querySelector("input");

    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Input not found: ${name}`);
    }

    return input;
  }

  function typeInto(name: string, value: string) {
    act(() => {
      const input = getInput(name);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submitForm() {
    const form = document.querySelector("form");

    if (!form) {
      throw new Error("Security form not found.");
    }

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  }

  async function prepareOutput() {
    await act(async () => {
      getButton("Choose Protected Copy…").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
  }
});
