import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const publicPdfjsRoot = new URL("../public/pdfjs/", import.meta.url);

const assetDirs = ["cmaps", "standard_fonts", "wasm"];

await rm(publicPdfjsRoot, { recursive: true, force: true });
await mkdir(publicPdfjsRoot, { recursive: true });

await Promise.all(
  assetDirs.map((assetDir) =>
    cp(join(pdfjsRoot, assetDir), new URL(`${assetDir}/`, publicPdfjsRoot), {
      recursive: true,
    }),
  ),
);
