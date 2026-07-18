import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedactionConfirmationDialog } from "./RedactionConfirmationDialog";

describe("RedactionConfirmationDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("presents destructive confirmation over the document with cancel first", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <RedactionConfirmationDialog
          areaCount={2}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onHelp={vi.fn()}
        />,
      );
    });

    expect(document.querySelector("[role='dialog']")?.textContent).toContain(
      "Permanently remove content under 2 marked areas?",
    );
    const buttons = Array.from(document.querySelectorAll(".redaction-confirmation__actions button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "Apply Redactions"]);

    buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onConfirm).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
});
// @vitest-environment jsdom
