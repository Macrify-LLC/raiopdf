import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPackage, readPackageManifest } from "../src/index";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("package writer", () => {
  it("creates the package layout", async () => {
    const rootDir = await packageRoot();

    createPackage(rootDir, meta());

    await expect(readdir(join(rootDir, "upload"))).resolves.toEqual([]);
    await expect(readdir(join(rootDir, "raio-manifest"))).resolves.toEqual([]);
  });

  it("writes upload files with SHA-256 and byte counts", async () => {
    const rootDir = await packageRoot();
    const sourcePath = join(rootDir, "source.pdf");
    await writeFile(sourcePath, "abc");
    const session = createPackage(join(rootDir, "package"), meta());

    const entry = await session.addUploadFile(sourcePath, "VOL001/filing.pdf", {
      pages: 2,
      description: "Complaint",
    });

    expect(entry).toMatchObject({
      outputName: "VOL001/filing.pdf",
      relativePath: "upload/VOL001/filing.pdf",
      bytes: 3,
      sha256: SHA256_ABC,
      sourceFilename: "source.pdf",
      sourcePath: resolve(sourcePath),
      pages: 2,
      description: "Complaint",
    });
    await expect(readFile(join(rootDir, "package", "upload", "VOL001", "filing.pdf"), "utf8"))
      .resolves.toBe("abc");
  });

  it("writes root documents and keeps source paths out of README and checksums", async () => {
    const rootDir = await packageRoot();
    const sourcePath = join(rootDir, "source-with-sensitive-path.pdf");
    await writeFile(sourcePath, "abc");
    const session = createPackage(join(rootDir, "package"), meta());

    await session.addUploadFile(sourcePath, "filing.pdf");
    await session.addRootDocument("Manifest.pdf", new TextEncoder().encode("index"));
    await session.finalize();

    const readme = await readFile(
      join(rootDir, "package", "raio-manifest", "README.txt"),
      "utf8",
    );
    const checksums = await readFile(
      join(rootDir, "package", "raio-manifest", "checksums.txt"),
      "utf8",
    );

    expect(readme).not.toContain(sourcePath);
    expect(checksums).not.toContain(sourcePath);
    expect(checksums).toContain(`${SHA256_ABC}  upload/filing.pdf`);
  });

  it("rejects duplicate and traversal output paths", async () => {
    const rootDir = await packageRoot();
    const session = createPackage(rootDir, meta());

    await session.addUploadFile(bytes("one"), "filing.pdf");
    await expect(session.addUploadFile(bytes("two"), "filing.pdf")).rejects.toThrow(
      /Duplicate package output path/,
    );
    await expect(session.addUploadFile(bytes("bad"), "../escape.pdf")).rejects.toThrow(
      /traversal segments/,
    );
    await expect(session.addRootDocument("../Manifest.pdf", bytes("bad"))).rejects.toThrow(
      /traversal segments/,
    );
    await expect(
      session.addManifestJson("workflow.json", {
        sourcePath: "/sensitive/source/path.pdf",
      }),
    ).rejects.toThrow(/must not contain absolute paths/);
  });

  it("rejects control characters in package output paths", async () => {
    const cases = [
      { name: "line\nbreak.pdf", label: "newline" },
      { name: "carriage\rreturn.pdf", label: "CR" },
      { name: "tab\tname.pdf", label: "tab" },
      { name: "delete\u007fname.pdf", label: "DEL" },
    ];

    for (const testCase of cases) {
      const rootDir = await packageRoot();
      const session = createPackage(rootDir, meta());

      await expect(session.addUploadFile(bytes(testCase.label), testCase.name)).rejects.toThrow(
        /control characters/,
      );
    }
  });

  it("refuses writes and second finalize after finalization", async () => {
    const rootDir = await packageRoot();
    const session = createPackage(rootDir, meta());

    await session.finalize();

    await expect(session.finalize()).rejects.toThrow(/already been finalized/);
    await expect(session.addRootDocument("Manifest.pdf", bytes("late"))).rejects.toThrow(
      /already been finalized/,
    );
  });

  it("round-trips provenance and overrides through readPackageManifest", async () => {
    const rootDir = await packageRoot();
    const session = createPackage(rootDir, {
      appVersion: "1.2.3",
      createdAt: "2026-07-03T12:00:00.000Z",
      packId: "fl",
      packVersion: "2026.07",
      lastVerified: {
        fileSize: "2026-07-01",
      },
    });

    await session.addUploadFile(bytes("abc"), "filing.pdf", { pages: 1 });
    session.recordOverride({
      type: "prep-step",
      message: "user skipped metadata scrub",
    });
    session.recordCheck({
      rule: "fileSize",
      status: "pass",
    });
    session.recordDetail("batch", {
      id: "batch-1",
    });
    await session.finalize();

    const manifest = await readPackageManifest(rootDir);

    expect(manifest.provenance).toMatchObject({
      appVersion: "1.2.3",
      createdAt: "2026-07-03T12:00:00.000Z",
      packId: "fl",
      packVersion: "2026.07",
      lastVerified: {
        fileSize: "2026-07-01",
      },
    });
    expect(manifest.provenance.confirmCurrentRequirements).toContain("Confirm current");
    expect(manifest.overrides).toEqual([
      {
        type: "prep-step",
        message: "user skipped metadata scrub",
      },
    ]);
    expect(manifest.checks).toEqual([
      {
        rule: "fileSize",
        status: "pass",
      },
    ]);
    expect(manifest.details).toEqual({
      batch: {
        id: "batch-1",
      },
    });
  });

  it("rejects truncated manifests", async () => {
    const rootDir = await packageRoot();
    await mkdir(join(rootDir, "raio-manifest"));
    await writeFile(
      join(rootDir, "raio-manifest", "manifest.json"),
      `${JSON.stringify({ manifestVersion: 1 })}\n`,
    );

    await expect(readPackageManifest(rootDir)).rejects.toThrow(/Invalid RaioPDF package manifest/);
  });

  it("checksums every package file except checksums.txt", async () => {
    const rootDir = await packageRoot();
    const session = createPackage(rootDir, meta());

    await session.addUploadFile(bytes("abc"), "filing.pdf");
    await session.addRootDocument("Manifest.pdf", bytes("index"));
    await session.addManifestJson("workflow.json", {
      sourceFilename: "source.pdf",
    });
    await session.finalize();

    const checksums = await readFile(join(rootDir, "raio-manifest", "checksums.txt"), "utf8");
    const lines = checksums.trim().split("\n");
    const byPath = new Map(
      lines.map((line) => {
        const [sha256, relativePath] = line.split("  ");
        if (sha256 === undefined || relativePath === undefined) {
          throw new Error(`Invalid checksum line: ${line}`);
        }

        return [relativePath, sha256];
      }),
    );

    expect([...byPath.keys()].sort()).toEqual([
      "Manifest.pdf",
      "raio-manifest/README.txt",
      "raio-manifest/manifest.json",
      "raio-manifest/workflow.json",
      "upload/filing.pdf",
    ]);
    for (const [relativePath, expectedHash] of byPath) {
      const fileBytes = await readFile(join(rootDir, relativePath));
      expect(expectedHash).toBe(createHash("sha256").update(fileBytes).digest("hex"));
    }
  });

  it("refuses dirty target directories", async () => {
    const rootDir = await packageRoot();
    createPackage(rootDir, meta());

    expect(() => createPackage(rootDir, meta())).toThrow(/non-empty directory/);

    const dirtyRoot = await packageRoot();
    await writeFile(join(dirtyRoot, "leftover.txt"), "dirty");

    expect(() => createPackage(dirtyRoot, meta())).toThrow(/non-empty directory/);
  });
});

async function packageRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "raiopdf-package-writer-"));
}

function meta() {
  return {
    appVersion: "0.0.0-test",
    createdAt: "2026-07-03T12:00:00.000Z",
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
