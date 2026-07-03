import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENABLE_FLAG_RELATIVE_PATH = path.join("me.macrify.raiopdf", "mcp-enabled");

/**
 * User-scoped file that enables local MCP access when it contains a truthy marker.
 */
export const ENABLE_FLAG_PATH_DESCRIPTION =
  "($XDG_CONFIG_HOME || $APPDATA || ~/.config)/me.macrify.raiopdf/mcp-enabled";

export const ENABLE_ACTION = "Enable 'Open Raio to AI' in RaioPDF → Preferences.";

const ENABLED_MARKERS = new Set(["1", "true", "enabled", "enable", "on", "yes"]);

export function enableFlagPath(): string {
  return path.join(configRoot(), ENABLE_FLAG_RELATIVE_PATH);
}

export async function isEnabled(flagPath = enableFlagPath()): Promise<boolean> {
  let contents: string;

  try {
    contents = await fs.readFile(flagPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  return ENABLED_MARKERS.has(contents.trim().toLowerCase());
}

function configRoot(): string {
  return process.env.XDG_CONFIG_HOME
    ?? process.env.APPDATA
    ?? path.join(os.homedir(), ".config");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
