import { describe, expect, it } from "vitest";
import {
  editToolStreamedGateMessage,
  STREAMED_FORM_AUTHORING_GATE_MESSAGE,
  STREAMED_SIGNATURE_GATE_MESSAGE,
} from "./editToolGate";

describe("editToolStreamedGateMessage", () => {
  it("gates signatures on streamed documents with the staged-ship message", () => {
    expect(editToolStreamedGateMessage("sign", true)).toBe(STREAMED_SIGNATURE_GATE_MESSAGE);
  });

  it("gates form authoring before edits are staged on streamed documents", () => {
    expect(editToolStreamedGateMessage("formText", true)).toBe(
      STREAMED_FORM_AUTHORING_GATE_MESSAGE,
    );
    expect(editToolStreamedGateMessage("formCheckbox", true)).toBe(
      STREAMED_FORM_AUTHORING_GATE_MESSAGE,
    );
  });

  it("does not gate byte-backed documents or supported streamed edit tools", () => {
    expect(editToolStreamedGateMessage("sign", false)).toBeNull();
    expect(editToolStreamedGateMessage("formText", false)).toBeNull();
    expect(editToolStreamedGateMessage("formCheckbox", false)).toBeNull();
    expect(editToolStreamedGateMessage("highlight", true)).toBeNull();
    expect(editToolStreamedGateMessage("textBox", true)).toBeNull();
    expect(editToolStreamedGateMessage("comment", true)).toBeNull();
  });
});
