import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type PackageBytes = ArrayBuffer | Uint8Array;

export type PackageProvenance = {
  appVersion: string;
  createdAt: string;
  packId?: string;
  packVersion?: string;
  lastVerified?: Record<string, string>;
  confirmCurrentRequirements?: string;
};

export type UploadFileInfo = {
  pages?: number;
  sourceFilename?: string;
  [key: string]: JsonValue | undefined;
};

export type UploadFileEntry = JsonObject & {
  outputName: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  sourceFilename?: string;
  sourcePath?: string;
  pages?: number;
};

export type RootDocumentEntry = {
  name: string;
  relativePath: string;
  bytes: number;
  sha256: string;
};

export type MachineReportEntry = {
  name: string;
  relativePath: string;
  bytes: number;
  sha256: string;
};

export type ChecksumEntry = {
  relativePath: string;
  sha256: string;
};

export type PackageCheckEntry = JsonObject;
export type PackageOverrideEntry = JsonObject;

export type PackageManifest = {
  manifestVersion: 1;
  provenance: PackageProvenance & {
    confirmCurrentRequirements: string;
  };
  uploadFiles: UploadFileEntry[];
  rootDocuments: RootDocumentEntry[];
  machineReports: MachineReportEntry[];
  overrides: PackageOverrideEntry[];
  checks: PackageCheckEntry[];
  details: Record<string, JsonValue>;
};

export type PackageSession = {
  addUploadFile(
    input: string | PackageBytes,
    outputName: string,
    info?: UploadFileInfo,
  ): Promise<UploadFileEntry>;
  addRootDocument(name: string, bytes: PackageBytes): Promise<RootDocumentEntry>;
  addManifestJson(name: string, value: JsonValue): Promise<MachineReportEntry>;
  recordOverride(entry: PackageOverrideEntry): void;
  recordCheck(entry: PackageCheckEntry): void;
  recordDetail(key: string, value: JsonValue): void;
  finalize(): Promise<PackageManifest>;
  abort(): Promise<void>;
};

const MANIFEST_VERSION = 1;
const MANIFEST_DIR_NAME = "raio-manifest";
const UPLOAD_DIR_NAME = "upload";
const MANIFEST_FILE_NAME = "manifest.json";
const README_FILE_NAME = "README.txt";
const CHECKSUMS_FILE_NAME = "checksums.txt";
const DEFAULT_CONFIRM_REQUIREMENTS_REMINDER =
  "Confirm current filing or production requirements before upload; local packs update only with app releases.";
const MANIFEST_README =
  "This folder contains RaioPDF machine-readable package details, checksums, and workflow reports. These files are for audit and troubleshooting only; they are not filing, service, or production documents and should not be uploaded to a portal.";
const RESERVED_UPLOAD_INFO_KEYS = new Set([
  "outputName",
  "relativePath",
  "sourcePath",
  "bytes",
  "sha256",
]);

class NodePackageSession implements PackageSession {
  private readonly rootDir: string;
  private readonly stageDir: string;
  private readonly lockDir: string;
  private readonly uploadDir: string;
  private readonly manifestDir: string;
  private readonly provenance: PackageManifest["provenance"];
  private readonly uploadFiles: UploadFileEntry[] = [];
  private readonly rootDocuments: RootDocumentEntry[] = [];
  private readonly machineReports: MachineReportEntry[] = [];
  private readonly overrides: PackageOverrideEntry[] = [];
  private readonly checks: PackageCheckEntry[] = [];
  private readonly details: Record<string, JsonValue> = {};
  private readonly writtenRelativePaths = new Set<string>();
  private finalized = false;
  private aborted = false;
  private failed = false;

  constructor(rootDir: string, meta: PackageProvenance) {
    this.rootDir = resolve(rootDir);
    this.provenance = normalizeProvenance(meta);

    if (existsSync(this.rootDir)) {
      const rootStat = statSync(this.rootDir);
      if (!rootStat.isDirectory()) {
        throw new Error(`Refusing to create a package: target path already exists at ${this.rootDir}.`);
      }

      const entries = readdirSync(this.rootDir);
      if (entries.length > 0) {
        throw new Error(`Refusing to create a package in non-empty directory: ${this.rootDir}`);
      }

      rmdirSync(this.rootDir);
    }

    const parentDir = dirname(this.rootDir);
    const rootName = basename(this.rootDir);
    mkdirSync(parentDir, { recursive: true });
    this.lockDir = join(parentDir, `.${rootName}.lock`);
    try {
      mkdirSync(this.lockDir);
    } catch (error) {
      throw new Error(
        `Refusing to create a package: another package session is already targeting ${this.rootDir}.`,
        { cause: error },
      );
    }

    let stageDir: string | undefined;
    try {
      stageDir = mkdtempSync(join(parentDir, `.${rootName}.tmp-`));
      this.stageDir = stageDir;
      this.uploadDir = join(stageDir, UPLOAD_DIR_NAME);
      this.manifestDir = join(stageDir, MANIFEST_DIR_NAME);
      mkdirSync(this.uploadDir, { recursive: true });
      mkdirSync(this.manifestDir, { recursive: true });
    } catch (error) {
      if (stageDir !== undefined) {
        rmSync(stageDir, { recursive: true, force: true });
      }
      rmSync(this.lockDir, { recursive: true, force: true });
      throw new Error(
        `Failed to initialize package staging for ${this.rootDir}.`,
        { cause: error },
      );
    }
  }

  async addUploadFile(
    input: string | PackageBytes,
    outputName: string,
    info: UploadFileInfo = {},
  ): Promise<UploadFileEntry> {
    this.assertOpen();

    const normalizedName = normalizeUploadName(outputName);
    const relativePath = toPackageRelativePath(UPLOAD_DIR_NAME, normalizedName);
    this.reservePath(relativePath);
    const targetPath = join(this.uploadDir, ...normalizedName.split("/"));
    await mkdir(dirname(targetPath), { recursive: true });

    const sourcePath = typeof input === "string" ? resolve(input) : undefined;
    const hashResult =
      typeof input === "string"
        ? await copyFileWithHash(input, targetPath)
        : await writeBytesWithHash(input, targetPath);

    const metadata = sanitizeUploadInfo(info);
    const sourceFilename =
      info.sourceFilename ?? (sourcePath === undefined ? undefined : basename(sourcePath));
    const entry: UploadFileEntry = {
      ...metadata,
      outputName: normalizedName,
      relativePath,
      bytes: hashResult.bytes,
      sha256: hashResult.sha256,
      ...(sourceFilename === undefined ? {} : { sourceFilename }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
    };

    this.uploadFiles.push(entry);

    return entry;
  }

  async addRootDocument(name: string, bytes: PackageBytes): Promise<RootDocumentEntry> {
    this.assertOpen();

    const normalizedName = normalizeRootDocumentName(name);
    const relativePath = normalizedName;
    this.reservePath(relativePath);
    const targetPath = join(this.stageDir, normalizedName);
    const hashResult = await writeBytesWithHash(bytes, targetPath);
    const entry: RootDocumentEntry = {
      name: normalizedName,
      relativePath,
      bytes: hashResult.bytes,
      sha256: hashResult.sha256,
    };

    this.rootDocuments.push(entry);

    return entry;
  }

  async addManifestJson(name: string, value: JsonValue): Promise<MachineReportEntry> {
    this.assertOpen();

    const normalizedName = normalizeManifestJsonName(name);
    assertNoAbsolutePaths(value, normalizedName);
    const relativePath = toPackageRelativePath(MANIFEST_DIR_NAME, normalizedName);
    this.reservePath(relativePath);
    const targetPath = join(this.manifestDir, normalizedName);
    const hashResult = await writeBytesWithHash(
      new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
      targetPath,
    );
    const entry: MachineReportEntry = {
      name: normalizedName,
      relativePath,
      bytes: hashResult.bytes,
      sha256: hashResult.sha256,
    };

    this.machineReports.push(entry);

    return entry;
  }

  recordOverride(entry: PackageOverrideEntry): void {
    this.assertOpen();
    this.overrides.push(entry);
  }

  recordCheck(entry: PackageCheckEntry): void {
    this.assertOpen();
    this.checks.push(entry);
  }

  recordDetail(key: string, value: JsonValue): void {
    this.assertOpen();
    assertDetailKey(key);
    this.details[key] = value;
  }

  async finalize(): Promise<PackageManifest> {
    this.assertOpen();

    const manifest: PackageManifest = {
      manifestVersion: MANIFEST_VERSION,
      provenance: this.provenance,
      uploadFiles: this.uploadFiles,
      rootDocuments: this.rootDocuments,
      machineReports: this.machineReports,
      overrides: this.overrides,
      checks: this.checks,
      details: this.details,
    };

    try {
      const manifestPath = join(this.manifestDir, MANIFEST_FILE_NAME);
      const readmePath = join(this.manifestDir, README_FILE_NAME);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await writeFile(readmePath, `${MANIFEST_README}\n`, { flag: "wx" });

      const checksumEntries = await this.collectChecksumEntries();
      const checksumLines = checksumEntries
        .map((entry) => `${entry.sha256}  ${entry.relativePath}`)
        .join("\n");
      await writeFile(
        join(this.manifestDir, CHECKSUMS_FILE_NAME),
        `${checksumLines}${checksumLines.length === 0 ? "" : "\n"}`,
        { flag: "wx" },
      );

      // Keep publication portable: Node rename is atomic within one directory, but replacing
      // an existing directory is not safe across Windows/open-handle cases.
      if (existsSync(this.rootDir)) {
        throw new Error(
          `Refusing to publish package: target path already exists at ${this.rootDir}. ` +
            "Atomic package finalization does not replace existing directories or open handles.",
        );
      }

      await rename(this.stageDir, this.rootDir);
      await this.removeLockDir();
      this.finalized = true;
      return manifest;
    } catch (error) {
      this.failed = true;
      await this.cleanupSessionPaths();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.finalized || this.aborted) {
      return;
    }

    this.aborted = true;
    await this.cleanupSessionPaths();
  }

  private reservePath(relativePath: string): void {
    if (this.writtenRelativePaths.has(relativePath)) {
      throw new Error(`Duplicate package output path: ${relativePath}`);
    }

    this.writtenRelativePaths.add(relativePath);
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new Error("Package session has already been finalized.");
    }
    if (this.aborted) {
      throw new Error("Package session has been aborted.");
    }
    if (this.failed) {
      throw new Error("Package session has failed and its staging directory was removed.");
    }
  }

  private async collectChecksumEntries(): Promise<ChecksumEntry[]> {
    const entries: ChecksumEntry[] = [
      ...this.uploadFiles.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
      ...this.rootDocuments.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
      ...this.machineReports.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
      {
        relativePath: toPackageRelativePath(MANIFEST_DIR_NAME, MANIFEST_FILE_NAME),
        sha256: await hashFile(join(this.manifestDir, MANIFEST_FILE_NAME)),
      },
      {
        relativePath: toPackageRelativePath(MANIFEST_DIR_NAME, README_FILE_NAME),
        sha256: await hashFile(join(this.manifestDir, README_FILE_NAME)),
      },
    ];

    return entries.sort((a, b) => compareRelativePath(a.relativePath, b.relativePath));
  }

  private async removeStageDir(): Promise<void> {
    await rm(this.stageDir, { recursive: true, force: true });
  }

  private async removeLockDir(): Promise<void> {
    await rm(this.lockDir, { recursive: true, force: true });
  }

  private async cleanupSessionPaths(): Promise<void> {
    const results = await Promise.allSettled([this.removeStageDir(), this.removeLockDir()]);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejection) {
      throw rejection.reason;
    }
  }
}

export function createPackage(rootDir: string, meta: PackageProvenance): PackageSession {
  return new NodePackageSession(rootDir, meta);
}

export async function readPackageManifest(rootDir: string): Promise<PackageManifest> {
  const manifestPath = join(resolve(rootDir), MANIFEST_DIR_NAME, MANIFEST_FILE_NAME);
  const contents = await readFile(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(contents);

  if (!isPackageManifest(parsed)) {
    throw new Error(`Invalid RaioPDF package manifest at ${manifestPath}`);
  }

  return parsed;
}

function normalizeProvenance(
  meta: PackageProvenance,
): PackageManifest["provenance"] {
  return {
    ...meta,
    confirmCurrentRequirements:
      meta.confirmCurrentRequirements ?? DEFAULT_CONFIRM_REQUIREMENTS_REMINDER,
  };
}

function sanitizeUploadInfo(info: UploadFileInfo): JsonObject {
  const output: JsonObject = {};

  for (const [key, value] of Object.entries(info)) {
    if (value === undefined || RESERVED_UPLOAD_INFO_KEYS.has(key)) {
      continue;
    }

    output[key] = value;
  }

  return output;
}

function normalizeUploadName(name: string): string {
  const normalized = normalizePackageRelativePath(name);
  if (normalized === UPLOAD_DIR_NAME || normalized.startsWith(`${UPLOAD_DIR_NAME}/`)) {
    throw new Error("Upload output names are relative to upload/ and must not include upload/.");
  }

  return normalized;
}

function normalizeRootDocumentName(name: string): string {
  const normalized = normalizePackageRelativePath(name);
  if (normalized.includes("/")) {
    throw new Error("Root document names must not include subdirectories.");
  }
  if (normalized === UPLOAD_DIR_NAME || normalized === MANIFEST_DIR_NAME) {
    throw new Error(`Root document name conflicts with reserved package directory: ${normalized}`);
  }

  return normalized;
}

function normalizeManifestJsonName(name: string): string {
  const normalized = normalizeRootDocumentName(name);
  if (!normalized.endsWith(".json")) {
    throw new Error("Machine report names must end with .json.");
  }
  if (
    normalized === MANIFEST_FILE_NAME ||
    normalized === CHECKSUMS_FILE_NAME ||
    normalized === README_FILE_NAME
  ) {
    throw new Error(`${normalized} is reserved for package metadata.`);
  }

  return normalized;
}

function normalizePackageRelativePath(name: string): string {
  if (hasControlCharacter(name)) {
    throw new Error(`Package output paths must not contain control characters: ${name}`);
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Package output names must not be empty.");
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`Package output paths must be relative: ${name}`);
  }
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(`Invalid package output path: ${name}`);
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Package output paths must not contain traversal segments: ${name}`);
  }
  if (parts.some((part) => part.length === 0 || part === ".")) {
    throw new Error(`Invalid package output path: ${name}`);
  }

  return parts.join("/");
}

function toPackageRelativePath(...parts: string[]): string {
  return parts.join("/");
}

function compareRelativePath(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function assertDetailKey(key: string): void {
  if (key.trim().length === 0) {
    throw new Error("Package detail keys must not be empty.");
  }
}

function assertNoAbsolutePaths(value: JsonValue, reportName: string): void {
  const seen = new WeakSet<object>();

  const visit = (current: JsonValue, trail: string): void => {
    if (typeof current === "string") {
      if (looksLikeAbsolutePath(current)) {
        throw new Error(
          `Machine report ${reportName} must not contain absolute paths outside manifest.json: ${trail}`,
        );
      }

      return;
    }

    if (current === null || typeof current !== "object") {
      return;
    }

    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${trail}[${index}]`));
      return;
    }

    for (const [key, item] of Object.entries(current)) {
      if (looksLikeAbsolutePath(key)) {
        throw new Error(
          `Machine report ${reportName} must not contain absolute path keys outside manifest.json: ${trail}.${key}`,
        );
      }
      visit(item, `${trail}.${key}`);
    }
  };

  visit(value, "$");
}

function looksLikeAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

type HashResult = {
  bytes: number;
  sha256: string;
};

async function copyFileWithHash(sourcePath: string, targetPath: string): Promise<HashResult> {
  const hash = createHash("sha256");
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      callback(null, chunk);
    },
  });

  await pipeline(
    createReadStream(sourcePath),
    hasher,
    createWriteStream(targetPath, { flags: "wx" }),
  );

  return {
    bytes,
    sha256: hash.digest("hex"),
  };
}

async function writeBytesWithHash(bytes: PackageBytes, targetPath: string): Promise<HashResult> {
  const buffer = toBuffer(bytes);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  await writeFile(targetPath, buffer, { flag: "wx" });

  return {
    bytes: buffer.byteLength,
    sha256,
  };
}

function toBuffer(bytes: PackageBytes): Buffer {
  if (bytes instanceof ArrayBuffer) {
    return Buffer.from(bytes);
  }

  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function isPackageManifest(value: unknown): value is PackageManifest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.manifestVersion === MANIFEST_VERSION &&
    isManifestProvenance(value.provenance) &&
    Array.isArray(value.uploadFiles) &&
    Array.isArray(value.rootDocuments) &&
    Array.isArray(value.machineReports) &&
    Array.isArray(value.overrides) &&
    Array.isArray(value.checks) &&
    isRecord(value.details)
  );
}

function isManifestProvenance(value: unknown): value is PackageManifest["provenance"] {
  return (
    isRecord(value) &&
    typeof value.appVersion === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.confirmCurrentRequirements === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
