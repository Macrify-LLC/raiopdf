import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class PathPolicyError extends Error {
  readonly code = "PATH_POLICY";
  readonly action: string;

  constructor(message: string, action: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathPolicyError";
    this.action = action;
  }
}

export type ResolvedInput = {
  originalPath: string;
  realPath: string;
};

export type PreparedOutput = {
  outputPath: string;
  tempPath: string;
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
};

export type PreparedPackageOutputDir = {
  outputPath: string;
};

export async function resolveInput(inputPath: string): Promise<ResolvedInput> {
  assertAbsolutePath(inputPath, "input");
  await assertNoSymlinkComponents(inputPath);

  let realPath: string;
  let stats;

  try {
    realPath = await fs.realpath(inputPath);
    stats = await fs.stat(realPath);
  } catch (error) {
    throw pathError(
      `Input file does not exist or is not accessible: ${inputPath}.`,
      "Choose an existing absolute path to a regular PDF file.",
      error,
    );
  }

  if (!stats.isFile()) {
    throw new PathPolicyError(
      `Input path is not a regular file: ${inputPath}.`,
      "Choose an existing regular PDF file, not a directory, device, or special file.",
    );
  }

  return { originalPath: inputPath, realPath };
}

export async function prepareOutput(outputPath: string): Promise<PreparedOutput> {
  assertAbsolutePath(outputPath, "output");

  const outputDirectory = path.dirname(outputPath);
  await assertNoSymlinkComponents(outputDirectory);
  await assertExistingDirectory(outputDirectory);
  await assertOutputDoesNotExist(outputPath);

  const tempPath = path.join(
    outputDirectory,
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const reservation = await reserveOutput(outputPath);
  const temp = await createExclusiveTemp(tempPath, outputPath);
  let closed = false;
  let finished = false;

  async function closeTemp(): Promise<void> {
    if (!closed) {
      closed = true;
      await temp.close();
    }
  }

  async function cleanup(): Promise<void> {
    await closeTemp();
    await removeIfExists(tempPath);
    await removeIfExists(outputPath);
  }

  return {
    outputPath,
    tempPath,
    async write(bytes) {
      if (finished) {
        throw new PathPolicyError(
          `Output handle is already finished: ${outputPath}.`,
          "Prepare a new output handle before writing again.",
        );
      }

      await temp.writeFile(bytes);
    },
    async commit() {
      if (finished) {
        throw new PathPolicyError(
          `Output handle is already finished: ${outputPath}.`,
          "Prepare a new output handle before committing again.",
        );
      }

      try {
        finished = true;
        await closeTemp();
        await reservation.close();
        await fs.rename(tempPath, outputPath);
      } catch (error) {
        await cleanup();
        throw pathError(
          `Output file could not be committed safely: ${outputPath}.`,
          "Choose a writable destination directory and a new absolute output path.",
          error,
        );
      }
    },
    async abort() {
      if (finished) {
        return;
      }

      finished = true;
      await reservation.close();
      await cleanup();
    },
  };
}

export async function preparePackageOutputDir(outputDir: string): Promise<PreparedPackageOutputDir> {
  assertAbsolutePath(outputDir, "output");
  await assertNoSymlinkComponents(outputDir);

  return { outputPath: path.resolve(outputDir) };
}

async function reserveOutput(outputPath: string): Promise<fs.FileHandle> {
  try {
    return await fs.open(outputPath, "wx");
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new PathPolicyError(
        `Output path already exists: ${outputPath}.`,
        "Choose a new absolute output path; RaioPDF MCP never overwrites existing files.",
        { cause: error },
      );
    }

    throw pathError(
      `Output path cannot be reserved safely: ${outputPath}.`,
      "Choose a writable destination directory and a new absolute output path.",
      error,
    );
  }
}

async function createExclusiveTemp(
  tempPath: string,
  outputPath: string,
): Promise<fs.FileHandle> {
  try {
    return await fs.open(tempPath, "wx");
  } catch (error) {
    await removeIfExists(outputPath);
    throw pathError(
      `Temporary output file could not be created safely: ${tempPath}.`,
      "Choose a writable destination directory and try a new output path.",
      error,
    );
  }
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await fs.lstat(outputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw pathError(
      `Output path is not accessible: ${outputPath}.`,
      "Choose a writable destination directory and a new absolute output path.",
      error,
    );
  }

  throw new PathPolicyError(
    `Output path already exists: ${outputPath}.`,
    "Choose a new absolute output path; RaioPDF MCP never overwrites existing files.",
  );
}

function assertAbsolutePath(filePath: string, label: "input" | "output"): void {
  if (!path.isAbsolute(filePath)) {
    throw new PathPolicyError(
      `${capitalize(label)} path must be absolute: ${filePath}.`,
      `Pass an absolute ${label} path.`,
    );
  }
}

async function assertExistingDirectory(directoryPath: string): Promise<void> {
  let stats;

  try {
    stats = await fs.stat(directoryPath);
  } catch (error) {
    throw pathError(
      `Output parent directory does not exist or is not accessible: ${directoryPath}.`,
      "Choose an output path inside an existing directory.",
      error,
    );
  }

  if (!stats.isDirectory()) {
    throw new PathPolicyError(
      `Output parent is not a directory: ${directoryPath}.`,
      "Choose an output path inside an existing directory.",
    );
  }
}

async function assertNoSymlinkComponents(filePath: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);
  const parts = absolutePath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;

  for (const part of parts) {
    current = path.join(current, part);

    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }

      throw pathError(
        `Path component is not accessible: ${current}.`,
        "Choose an absolute path without symlink components.",
        error,
      );
    }

    if (stats.isSymbolicLink()) {
      throw new PathPolicyError(
        `Path contains a symlink component: ${current}.`,
        "Choose the real absolute path to a regular file; symlink paths are not accepted.",
      );
    }
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function pathError(message: string, action: string, cause: unknown): PathPolicyError {
  return new PathPolicyError(message, action, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
