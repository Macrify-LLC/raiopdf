import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, "data");
const entries = await readdir(dataDir, { withFileTypes: true });
const packs = {};

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "packs.manifest.json") {
    continue;
  }

  const filePath = join(dataDir, entry.name);
  const raw = await readFile(filePath, "utf8");
  const canonical = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  const packId = entry.name.replace(/\.json$/u, "");

  packs[packId] = {
    file: entry.name,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

await writeFile(
  join(dataDir, "packs.manifest.json"),
  `${JSON.stringify({ version: 1, packs }, null, 2)}\n`,
);
