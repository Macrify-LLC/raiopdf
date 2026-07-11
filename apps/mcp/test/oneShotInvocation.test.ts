import { describe, expect, it } from "vitest";
import { parseOneShotInvocation } from "../src/oneShotInvocation.js";

describe("parseOneShotInvocation", () => {
  it("dispatches one-shot when --one-shot is the first script argument", () => {
    expect(
      parseOneShotInvocation(["node", "index.mjs", "--one-shot", "build_binder"]),
    ).toEqual({ oneShot: true, toolName: "build_binder" });
  });

  it("dispatches one-shot when flags precede the marker (v0.1.0–v0.1.2 regression)", () => {
    // The shell used to prepend --disallow-code-generation-from-strings as a
    // positional argument, shifting --one-shot out of argv[2]; the fixed-index
    // check then booted the stdio server and every one-shot tool broke.
    expect(
      parseOneShotInvocation([
        "node",
        "index.mjs",
        "--disallow-code-generation-from-strings",
        "--one-shot",
        "build_production_set",
      ]),
    ).toEqual({ oneShot: true, toolName: "build_production_set" });
  });

  it("boots the stdio server when --one-shot is absent", () => {
    expect(parseOneShotInvocation(["node", "index.mjs"])).toEqual({
      oneShot: false,
      toolName: undefined,
    });
  });

  it("does not treat the node binary or entrypoint slots as the marker", () => {
    expect(
      parseOneShotInvocation(["--one-shot", "--one-shot"]),
    ).toEqual({ oneShot: false, toolName: undefined });
  });

  it("reports a missing tool name as undefined", () => {
    expect(parseOneShotInvocation(["node", "index.mjs", "--one-shot"])).toEqual({
      oneShot: true,
      toolName: undefined,
    });
  });
});
