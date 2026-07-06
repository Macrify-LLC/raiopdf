import { describe, expect, it } from "vitest";
import {
  editToolStreamedGateMessage,
  STREAMED_SIGNATURE_GATE_MESSAGE,
} from "./editToolGate";

describe("editToolStreamedGateMessage", () => {
  it("gates signatures on streamed documents with the staged-ship message", () => {
    expect(editToolStreamedGateMessage("sign", true)).toBe(STREAMED_SIGNATURE_GATE_MESSAGE);
  });

  it("does not gate signatures for byte-backed documents or staged streamed edit tools", () => {
    expect(editToolStreamedGateMessage("sign", false)).toBeNull();
    expect(editToolStreamedGateMessage("highlight", true)).toBeNull();
    expect(editToolStreamedGateMessage("textBox", true)).toBeNull();
    expect(editToolStreamedGateMessage("comment", true)).toBeNull();
  });
});
