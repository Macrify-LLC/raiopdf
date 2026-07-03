import { describe, expect, it } from "vitest";
import {
  looksLikeAbsolutePath,
  resolveDesktopFileGrantPaths,
  type TauriInvoke,
} from "./localPaths";

describe("localPaths", () => {
  it("recognizes Unix and Windows absolute paths", () => {
    expect(looksLikeAbsolutePath("/Users/jake/motion.pdf")).toBe(true);
    expect(looksLikeAbsolutePath("C:\\Users\\jake\\motion.pdf")).toBe(true);
    expect(looksLikeAbsolutePath("4d3e0d7a-4a2c-49ee-8db1-c0c98eac91f8")).toBe(false);
    expect(looksLikeAbsolutePath(null)).toBe(false);
  });

  it("resolves Tauri file grants before backend path validation", async () => {
    const invokeCalls: { command: string; args: Record<string, unknown> | undefined }[] = [];
    const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ command, args });
      return ["/Users/jake/motion.pdf"] as T;
    };

    const paths = await resolveDesktopFileGrantPaths(
      ["4d3e0d7a-4a2c-49ee-8db1-c0c98eac91f8"],
      {
        invoke,
        isTauriRuntime: () => true,
      },
    );

    expect(paths).toEqual(["/Users/jake/motion.pdf"]);
    expect(invokeCalls).toEqual([
      {
        command: "resolve_file_grants",
        args: {
          grants: ["4d3e0d7a-4a2c-49ee-8db1-c0c98eac91f8"],
        },
      },
    ]);
  });

  it("passes through web and dev paths without calling Tauri", async () => {
    let invokeCalls = 0;
    const invoke: TauriInvoke = async <T>() => {
      invokeCalls += 1;
      return [] as T;
    };

    await expect(resolveDesktopFileGrantPaths(
      ["/tmp/motion.pdf", null],
      {
        invoke,
        isTauriRuntime: () => false,
      },
    )).resolves.toEqual(["/tmp/motion.pdf", null]);
    expect(invokeCalls).toBe(0);
  });
});
