// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmWithUser } from "./nativeConfirm";

describe("confirmWithUser", () => {
  const originalConfirm = window.confirm;

  afterEach(() => {
    window.confirm = originalConfirm;
    vi.restoreAllMocks();
  });

  it("passes through a synchronous browser confirm", async () => {
    window.confirm = vi.fn(() => true);
    await expect(confirmWithUser("Sure?")).resolves.toBe(true);

    window.confirm = vi.fn(() => false);
    await expect(confirmWithUser("Sure?")).resolves.toBe(false);
  });

  it("awaits the Tauri dialog plugin's async confirm instead of treating the pending Promise as truthy", async () => {
    window.confirm = vi.fn(() => Promise.resolve(false) as unknown as boolean);
    await expect(confirmWithUser("Sure?")).resolves.toBe(false);

    window.confirm = vi.fn(() => Promise.resolve(true) as unknown as boolean);
    await expect(confirmWithUser("Sure?")).resolves.toBe(true);
  });

  it("treats a denied native dialog as cancelled instead of rejecting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.confirm = vi.fn(
      () => Promise.reject(new Error("Command plugin:dialog|confirm not allowed by ACL")) as unknown as boolean,
    );

    await expect(confirmWithUser("Sure?")).resolves.toBe(false);
  });
});
