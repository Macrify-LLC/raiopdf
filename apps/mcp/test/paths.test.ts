import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathPolicyError, prepareOutput, resolveInput } from "../src/paths.js";

let dir: string;

beforeEach(async () => {
  // realpath so the temp root itself has no symlink components (macOS /tmp, etc.)
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-paths-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("resolveInput", () => {
  it("rejects relative input paths", async () => {
    await expect(resolveInput("relative/file.pdf")).rejects.toBeInstanceOf(PathPolicyError);
  });

  it("rejects a non-existent input path", async () => {
    await expect(resolveInput(path.join(dir, "missing.pdf"))).rejects.toBeInstanceOf(PathPolicyError);
  });

  it("rejects a directory", async () => {
    await expect(resolveInput(dir)).rejects.toBeInstanceOf(PathPolicyError);
  });

  it("rejects an input path that escapes through a symlink component", async () => {
    const target = path.join(dir, "target.pdf");
    await fs.writeFile(target, "%PDF-1.4\n");
    const linkDir = path.join(dir, "link");
    await fs.symlink(dir, linkDir);
    // link/target.pdf resolves to an existing file, but the "link" component is a symlink.
    await expect(resolveInput(path.join(linkDir, "target.pdf"))).rejects.toBeInstanceOf(
      PathPolicyError,
    );
  });

  it("accepts a regular file and returns its real path", async () => {
    const file = path.join(dir, "real.pdf");
    await fs.writeFile(file, "%PDF-1.4\n");
    const resolved = await resolveInput(file);
    expect(resolved.realPath).toBe(await fs.realpath(file));
  });
});

describe("prepareOutput", () => {
  it("refuses to clobber a pre-existing output", async () => {
    const out = path.join(dir, "exists.pdf");
    await fs.writeFile(out, "original");
    await expect(prepareOutput(out)).rejects.toBeInstanceOf(PathPolicyError);
    expect(await fs.readFile(out, "utf8")).toBe("original");
  });

  it("writes through a temp file then atomically renames on commit", async () => {
    const out = path.join(dir, "new.pdf");
    const handle = await prepareOutput(out);
    await handle.write(new TextEncoder().encode("%PDF-1.4\n"));

    // Content lives in the temp file until commit; the reserved output is still empty.
    expect(await fs.readFile(handle.tempPath, "utf8")).toBe("%PDF-1.4\n");

    await handle.commit();

    expect(await fs.readFile(out, "utf8")).toBe("%PDF-1.4\n");
    await expect(fs.access(handle.tempPath)).rejects.toBeTruthy();
  });

  it("removes the temp file and reserved output on abort", async () => {
    const out = path.join(dir, "aborted.pdf");
    const handle = await prepareOutput(out);
    await handle.write(new TextEncoder().encode("partial"));
    await handle.abort();

    await expect(fs.access(handle.tempPath)).rejects.toBeTruthy();
    await expect(fs.access(out)).rejects.toBeTruthy();
  });
});
