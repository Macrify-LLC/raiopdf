#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_PAYLOAD_DIR = join(REPO_ROOT, "apps", "shell", "src-tauri", "payload");

const args = parseArgs(process.argv.slice(2));
const payloadDir = resolve(args.payloadDir ?? process.env.RAIOPDF_PAYLOAD_DIR ?? DEFAULT_PAYLOAD_DIR);
const legalDir = join(payloadDir, "legal");
const checkOnly = args.check;

const pins = parsePins(join(REPO_ROOT, "installer", "PINS.env"));
const version = releaseVersion();

if (checkOnly) {
  checkLegalPayload();
} else {
  generateLegalPayload();
  checkLegalPayload();
}

function parseArgs(argv) {
  const parsed = { check: false, payloadDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--payload-dir") {
      const value = argv[index + 1];
      if (!value) {
        usage("Missing value for --payload-dir");
      }
      parsed.payloadDir = value;
      index += 1;
      continue;
    }
    usage(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(message) {
  console.error(message);
  console.error("Usage: node scripts/generate-legal-notices.mjs [--payload-dir PATH] [--check]");
  process.exit(2);
}

function parsePins(path) {
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(trimmed);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

function releaseVersion() {
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME?.startsWith("v")) {
    return process.env.GITHUB_REF_NAME.slice(1);
  }

  const exactTag = exactGitTagVersion();
  if (exactTag) {
    return exactTag;
  }

  const shellVersion = packageVersion(join(REPO_ROOT, "apps", "shell", "package.json"));
  if (shellVersion) {
    return shellVersion;
  }

  return packageVersion(join(REPO_ROOT, "package.json")) ?? "0.1.0";
}

function exactGitTagVersion() {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/^v/u, "");
  } catch {
    return null;
  }
}

function packageVersion(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function generateLegalPayload() {
  mkdirSync(join(legalDir, "licenses"), { recursive: true });
  mkdirSync(join(legalDir, "source-offers"), { recursive: true });

  const manifest = buildComponentManifest();
  writeFileSync(
    join(legalDir, "COMPONENT-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(legalDir, "THIRD-PARTY-NOTICES.txt"), thirdPartyNotices(manifest), "utf8");
  writeFileSync(
    join(legalDir, "RELEASE-SOURCE-CORRESPONDENCE.md"),
    sourceCorrespondence(manifest),
    "utf8",
  );
  writeFileSync(
    join(legalDir, "source-offers", "GHOSTSCRIPT-SOURCE-OFFER.txt"),
    ghostscriptSourceOffer(),
    "utf8",
  );

  copyText(
    join(REPO_ROOT, "installer", "RAIOPDF-LICENSE-NOTICES.txt"),
    join(legalDir, "RAIOPDF-LICENSE-NOTICES.txt"),
  );
  copyText(join(REPO_ROOT, "LICENSE"), join(legalDir, "licenses", "GPL-3.0.txt"));
  copyText(join(REPO_ROOT, "licenses", "AGPL-3.0.txt"), join(legalDir, "licenses", "AGPL-3.0.txt"));
  copyText(join(REPO_ROOT, "licenses", "MPL-2.0.txt"), join(legalDir, "licenses", "MPL-2.0.txt"));
}

function buildComponentManifest() {
  const components = [
    component("RaioPDF", version, "GPL-3.0-only", "https://github.com/Macrify-LLC/raiopdf", {
      role: "application",
      source: "https://github.com/Macrify-LLC/raiopdf",
      correspondingSource: "The public GitHub repository contains the preferred source form and build scripts.",
    }),
    component("Ghostscript", pins.GHOSTSCRIPT_VERSION, "AGPL-3.0-only", "https://www.ghostscript.com/", {
      role: "OCR/PDF interpreter",
      binary: {
        url: pins.GHOSTSCRIPT_URL,
        sha256: pins.GHOSTSCRIPT_SHA256,
        payloadPaths: ["ocr/gs/bin/gswin64c.exe", "ocr/gs/bin/gs.exe"],
      },
      source: {
        url: pins.GHOSTSCRIPT_SOURCE_URL,
        sha256: pins.GHOSTSCRIPT_SOURCE_SHA256,
      },
      modificationStatus:
        "Unmodified upstream Windows x64 installer payload. RaioPDF copies gswin64c.exe to gs.exe as a byte-identical convenience alias.",
    }),
    component("Stirling-PDF core flavor", readPinnedTag("engine/PINNED_TAG"), "MIT", "https://github.com/Stirling-Tools/Stirling-PDF", {
      role: "PDF engine",
      payloadPaths: ["engine/stirling.jar"],
      correspondingSource: "See engine/PINNED_TAG, engine/vendor.sh, and engine/build.sh in the RaioPDF source tree.",
    }),
    component("Eclipse Temurin JRE", pins.TEMURIN_JRE_VERSION, "GPL-2.0-only WITH Classpath-exception-2.0", "https://adoptium.net/", {
      role: "bundled Java runtime",
      binary: { url: pins.TEMURIN_JRE_URL, sha256: pins.TEMURIN_JRE_SHA256 },
    }),
    component("Node.js runtime", pins.NODE_RUNTIME_VERSION, "MIT", "https://nodejs.org/", {
      role: "bundled MCP runtime",
      binary: { url: pins.NODE_RUNTIME_URL, sha256: pins.NODE_RUNTIME_SHA256 },
      payloadPaths: ["mcp/node/node.exe", "mcp/node/LICENSE"],
    }),
    component("Python embeddable package", pins.PYTHON_EMBED_VERSION, "Python-2.0", "https://www.python.org/", {
      role: "bundled OCR runtime",
      binary: { url: pins.PYTHON_EMBED_URL, sha256: pins.PYTHON_EMBED_SHA256 },
      payloadPaths: ["ocr/python/python.exe"],
    }),
    component("OCRmyPDF", pins.OCRMYPDF_VERSION, "MPL-2.0", "https://ocrmypdf.readthedocs.io/", {
      role: "OCR pipeline",
      payloadPaths: ["ocr/ocrmypdf.cmd", "ocr/THIRD-PARTY-PYTHON.md"],
    }),
    component("Tesseract OCR", pins.TESSERACT_VERSION, "Apache-2.0", "https://github.com/tesseract-ocr/tesseract", {
      role: "OCR engine",
      binary: { url: pins.TESSERACT_URL, sha256: pins.TESSERACT_SHA256 },
      payloadPaths: ["ocr/tesseract/tesseract.exe"],
    }),
    component("tessdata_fast English traineddata", pins.TESSDATA_FAST_VERSION, "Apache-2.0", "https://github.com/tesseract-ocr/tessdata_fast", {
      role: "OCR language data",
      binary: { url: pins.TESSDATA_ENG_URL, sha256: pins.TESSDATA_ENG_SHA256 },
      payloadPaths: ["ocr/tesseract/tessdata/eng.traineddata"],
    }),
    component("qpdf", pins.QPDF_VERSION, "Apache-2.0", "https://github.com/qpdf/qpdf", {
      role: "PDF repair/linearization helper",
      binary: { url: pins.QPDF_URL, sha256: pins.QPDF_SHA256 },
      payloadPaths: ["ocr/qpdf/bin/qpdf.exe", "ocr/qpdf/LICENSE.txt"],
    }),
    component("pdfjs-dist", npmVersion("pdfjs-dist"), "Apache-2.0", "https://github.com/mozilla/pdf.js", {
      role: "PDF rendering assets and worker",
      payloadPaths: ["mcp/pdfjs/cmaps", "mcp/pdfjs/standard_fonts", "mcp/pdfjs/wasm"],
    }),
    component("pdf-lib", npmVersion("pdf-lib"), "MIT", "https://github.com/Hopding/pdf-lib", {
      role: "PDF manipulation library",
    }),
    component("@napi-rs/canvas", npmVersion("@napi-rs/canvas"), "MIT", "https://github.com/Brooooooklyn/canvas", {
      role: "MCP image/canvas rendering dependency",
      payloadPaths: [
        "mcp/node_modules/@napi-rs/canvas/package.json",
        "mcp/node_modules/@napi-rs/canvas-win32-x64-msvc/package.json",
      ],
    }),
    component("React", npmVersion("react"), "MIT", "https://react.dev/", { role: "desktop UI" }),
    component("React DOM", npmVersion("react-dom"), "MIT", "https://react.dev/", { role: "desktop UI" }),
    component("Tauri", cargoVersion("tauri"), "Apache-2.0 OR MIT", "https://tauri.app/", {
      role: "desktop application shell",
    }),
  ];

  return {
    schemaVersion: 1,
    product: "RaioPDF",
    releaseVersion: version,
    generatedBy: "scripts/generate-legal-notices.mjs",
    sourceRepository: "https://github.com/Macrify-LLC/raiopdf",
    platforms: [
      {
        id: "windows-x64",
        status: "shipping",
        note: "Current release payload assembled by installer/assemble-payload.sh.",
      },
      {
        id: "macos",
        status: "planned",
        note: "Not currently shipped. Re-run this generator when a macOS payload is added.",
      },
      {
        id: "linux",
        status: "planned",
        note: "Not currently shipped. Re-run this generator when a Linux payload is added.",
      },
    ],
    components,
    inventories: {
      bundledNpmDependencies: npmLicenseInventory(),
      bundledPythonDistributions: pythonDistributions(),
      localWorkspacePackages: localWorkspacePackages(),
      bundledJar: bundledJarFacts(),
    },
  };
}

function component(name, version, license, homepage, extra = {}) {
  return {
    name,
    version: version ?? "unknown",
    license,
    homepage,
    ...extra,
  };
}

function thirdPartyNotices(manifest) {
  const rows = manifest.components
    .map((entry) => `- ${entry.name} ${entry.version}: ${entry.license}. ${entry.role ?? ""}`.trim())
    .join("\n");
  const npmRows = manifest.inventories.bundledNpmDependencies
    .map((entry) => `- ${entry.name} ${entry.version}: ${entry.license}`)
    .join("\n");
  return `RaioPDF Open Source and Third-Party Notices
==============================================

RaioPDF is free and open-source software licensed under GPL-3.0-only.
Source code: https://github.com/Macrify-LLC/raiopdf

No Warranty
-----------

RaioPDF and the bundled third-party components are provided without warranty,
to the extent permitted by their respective licenses.

Bundled Components
------------------

${rows}

Bundled npm Dependency Inventory
--------------------------------

The bundled UI and MCP JavaScript artifacts include the following npm
dependencies according to \`pnpm licenses list --json --filter @raiopdf/mcp
--filter @raiopdf/ui\` when that inventory is available:

${npmRows || "- npm dependency inventory unavailable; see COMPONENT-MANIFEST.json."}

Ghostscript Source
------------------

RaioPDF treats the bundled Ghostscript Windows x64 component as AGPL-3.0-only.
The Ghostscript binary is not modified. The payload copies the upstream
gswin64c.exe to gs.exe as a byte-identical convenience alias.

Pinned Ghostscript binary:
${pins.GHOSTSCRIPT_URL}
SHA256: ${pins.GHOSTSCRIPT_SHA256}

Pinned Ghostscript source:
${pins.GHOSTSCRIPT_SOURCE_URL}
SHA256: ${pins.GHOSTSCRIPT_SOURCE_SHA256}

See legal/source-offers/GHOSTSCRIPT-SOURCE-OFFER.txt and
legal/RELEASE-SOURCE-CORRESPONDENCE.md for source-correspondence details.

Platform Scope
--------------

The current shipping payload is windows-x64. macOS and Linux are listed in the
component manifest as planned platforms so future payloads have a notice gate
before release.

License Texts
-------------

- legal/licenses/GPL-3.0.txt
- legal/licenses/AGPL-3.0.txt
- legal/licenses/MPL-2.0.txt
`;
}

function sourceCorrespondence(manifest) {
  return `# RaioPDF Release Source Correspondence

Product: ${manifest.product}
Release version: ${manifest.releaseVersion}
Source repository: ${manifest.sourceRepository}

## RaioPDF

The RaioPDF source repository contains the preferred source form for the
application, build scripts, installer scripts, and payload assembly scripts.

## Ghostscript

The bundled Ghostscript Windows x64 binary is taken from:

- ${pins.GHOSTSCRIPT_URL}
- SHA256: \`${pins.GHOSTSCRIPT_SHA256}\`

The corresponding pinned Ghostscript source archive is:

- ${pins.GHOSTSCRIPT_SOURCE_URL}
- SHA256: \`${pins.GHOSTSCRIPT_SOURCE_SHA256}\`

RaioPDF does not patch or rebuild Ghostscript. The installer payload copies
\`ocr/gs/bin/gswin64c.exe\` to \`ocr/gs/bin/gs.exe\`; the release gate verifies
those files are byte-identical when both are present.

## Other Bundled Runtime Components

Pinned URLs and checksums for JRE, Node.js, Python, Tesseract, tessdata_fast,
Ghostscript, qpdf, and 7-Zip helper downloads live in \`installer/PINS.env\`.
The release payload manifest hashes every file copied under the bundled
\`payload/\` resource directory.

## Planned macOS and Linux Payloads

macOS and Linux are not shipping payloads in this release line. Before either
platform ships, the payload generator must be run on that platform's payload and
the component manifest must be updated to include its platform-specific bundled
components and source correspondence.
`;
}

function ghostscriptSourceOffer() {
  return `Ghostscript Source Offer for RaioPDF
========================================

RaioPDF bundles Ghostscript ${pins.GHOSTSCRIPT_VERSION} for Windows x64 under
AGPL-3.0-only.

Bundled binary:
${pins.GHOSTSCRIPT_URL}
SHA256: ${pins.GHOSTSCRIPT_SHA256}

Corresponding source archive:
${pins.GHOSTSCRIPT_SOURCE_URL}
SHA256: ${pins.GHOSTSCRIPT_SOURCE_SHA256}

The RaioPDF release process attaches this source archive to release artifacts
as ghostscript-${pins.GHOSTSCRIPT_VERSION}-source.tar.xz and records it in
SHA256SUMS.txt. The archive can also be downloaded from the pinned upstream URL
above.

RaioPDF does not modify Ghostscript. It copies the upstream gswin64c.exe binary
to gs.exe as a byte-identical convenience alias for command-line invocation.
`;
}

function checkLegalPayload() {
  const required = [
    "THIRD-PARTY-NOTICES.txt",
    "COMPONENT-MANIFEST.json",
    "RELEASE-SOURCE-CORRESPONDENCE.md",
    "RAIOPDF-LICENSE-NOTICES.txt",
    "source-offers/GHOSTSCRIPT-SOURCE-OFFER.txt",
    "licenses/GPL-3.0.txt",
    "licenses/AGPL-3.0.txt",
    "licenses/MPL-2.0.txt",
  ];
  const errors = [];
  for (const path of required) {
    const absolute = join(legalDir, path);
    if (!existsSync(absolute) || statSync(absolute).size === 0) {
      errors.push(`Missing legal payload file: legal/${path}`);
    }
  }

  if (!pins.GHOSTSCRIPT_SOURCE_URL || !pins.GHOSTSCRIPT_SOURCE_SHA256) {
    errors.push("GHOSTSCRIPT_SOURCE_URL and GHOSTSCRIPT_SOURCE_SHA256 must be pinned in installer/PINS.env");
  }

  const manifestPath = join(legalDir, "COMPONENT-MANIFEST.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const ghostscript = manifest.components?.find((entry) => entry.name === "Ghostscript");
    if (!ghostscript) {
      errors.push("COMPONENT-MANIFEST.json is missing Ghostscript");
    } else {
      if (ghostscript.license !== "AGPL-3.0-only") {
        errors.push(`Ghostscript license must be AGPL-3.0-only, got ${ghostscript.license}`);
      }
      if (ghostscript.source?.sha256 !== pins.GHOSTSCRIPT_SOURCE_SHA256) {
        errors.push("Ghostscript source SHA256 in manifest does not match installer/PINS.env");
      }
    }
    const npmDependencyNames = new Set(
      (manifest.inventories?.bundledNpmDependencies ?? []).map((entry) => entry.name),
    );
    for (const requiredName of ["@modelcontextprotocol/sdk", "zod"]) {
      if (!npmDependencyNames.has(requiredName)) {
        errors.push(`Bundled npm dependency inventory is missing ${requiredName}`);
      }
    }
  }

  const gsExe = join(payloadDir, "ocr", "gs", "bin", "gs.exe");
  const gsWin = join(payloadDir, "ocr", "gs", "bin", "gswin64c.exe");
  if (existsSync(gsExe) || existsSync(gsWin)) {
    if (!existsSync(gsExe) || !existsSync(gsWin)) {
      errors.push("Ghostscript payload must contain both ocr/gs/bin/gs.exe and ocr/gs/bin/gswin64c.exe");
    } else if (sha256(gsExe) !== sha256(gsWin)) {
      errors.push("ocr/gs/bin/gs.exe must be byte-identical to ocr/gs/bin/gswin64c.exe");
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(`Verified legal payload at ${relative(REPO_ROOT, legalDir)}`);
}

function copyText(source, destination) {
  writeFileSync(destination, readFileSync(source, "utf8").replace(/\r\n/gu, "\n"), "utf8");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readPinnedTag(path) {
  const absolute = join(REPO_ROOT, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8").trim() : "unknown";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function npmVersion(packageName) {
  const lockedVersion = pnpmLockVersion(packageName);
  if (lockedVersion) {
    return lockedVersion;
  }

  const candidates = [
    join(REPO_ROOT, "package.json"),
    join(REPO_ROOT, "apps", "ui", "package.json"),
    join(REPO_ROOT, "apps", "mcp", "package.json"),
    join(REPO_ROOT, "apps", "shell", "package.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const pkg = readJson(candidate);
    const version =
      pkg.dependencies?.[packageName] ??
      pkg.devDependencies?.[packageName] ??
      pkg.optionalDependencies?.[packageName];
    if (version) {
      return version;
    }
  }
  return "unknown";
}

function npmLicenseInventory() {
  try {
    const output = execFileSync(
      "pnpm",
      ["licenses", "list", "--json", "--filter", "@raiopdf/mcp", "--filter", "@raiopdf/ui"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const byLicense = JSON.parse(output);
    const packages = [];
    for (const [license, entries] of Object.entries(byLicense)) {
      for (const entry of entries) {
        for (const version of entry.versions ?? ["unknown"]) {
          packages.push({
            name: entry.name,
            version,
            license,
            homepage: entry.homepage ?? null,
          });
        }
      }
    }
    return uniquePackages(packages);
  } catch {
    return directNpmDependencyInventory();
  }
}

function directNpmDependencyInventory() {
  const packagePaths = [
    join(REPO_ROOT, "apps", "mcp", "package.json"),
    join(REPO_ROOT, "apps", "ui", "package.json"),
  ];
  const packages = [];
  for (const packagePath of packagePaths) {
    if (!existsSync(packagePath)) {
      continue;
    }
    const pkg = readJson(packagePath);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith("@raiopdf/")) {
        continue;
      }
      packages.push({
        name,
        version: pnpmLockVersion(name) ?? pkg.dependencies[name],
        license: npmPackageLicense(name) ?? "see package metadata",
        homepage: null,
      });
    }
  }
  return uniquePackages(packages);
}

function uniquePackages(packages) {
  const byKey = new Map();
  for (const pkg of packages) {
    byKey.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function npmPackageLicense(packageName) {
  const packagePath = join(REPO_ROOT, "node_modules", packageName, "package.json");
  if (!existsSync(packagePath)) {
    return null;
  }
  try {
    return readJson(packagePath).license ?? null;
  } catch {
    return null;
  }
}

function pnpmLockVersion(packageName) {
  const lockPath = join(REPO_ROOT, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) {
    return null;
  }
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^'?${escapedName}@([^':]+)'?:`, "u");
  for (const line of readFileSync(lockPath, "utf8").split(/\r?\n/u)) {
    const match = pattern.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

function cargoVersion(crateName) {
  const lockPath = join(REPO_ROOT, "Cargo.lock");
  if (!existsSync(lockPath)) {
    return "workspace";
  }
  let currentName = null;
  for (const line of readFileSync(lockPath, "utf8").split(/\r?\n/u)) {
    const nameMatch = /^name = "(.+)"$/u.exec(line);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    const versionMatch = /^version = "(.+)"$/u.exec(line);
    if (currentName === crateName && versionMatch) {
      return versionMatch[1];
    }
  }
  return "workspace";
}

function pythonDistributions() {
  const sitePackages = join(payloadDir, "ocr", "python", "Lib", "site-packages");
  if (!existsSync(sitePackages)) {
    return [];
  }
  return readdirSync(sitePackages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".dist-info"))
    .map((entry) => {
      const metadataPath = join(sitePackages, entry.name, "METADATA");
      if (!existsSync(metadataPath)) {
        return null;
      }
      const metadata = readFileSync(metadataPath, "utf8");
      return {
        name: firstMetadataValue(metadata, "Name") ?? entry.name.replace(/\.dist-info$/u, ""),
        version: firstMetadataValue(metadata, "Version") ?? "unknown",
        license: firstMetadataValue(metadata, "License-Expression") ?? firstMetadataValue(metadata, "License") ?? "see package metadata",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function firstMetadataValue(metadata, key) {
  const prefix = `${key}:`;
  return metadata
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function localWorkspacePackages() {
  const roots = ["apps", "packages"];
  const packages = [];
  for (const root of roots) {
    const rootPath = join(REPO_ROOT, root);
    if (!existsSync(rootPath)) {
      continue;
    }
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgPath = join(rootPath, entry.name, "package.json");
      if (!existsSync(pkgPath)) {
        continue;
      }
      const pkg = readJson(pkgPath);
      packages.push({
        name: pkg.name ?? `${root}/${entry.name}`,
        version: pkg.version ?? "workspace",
        license: pkg.license ?? "inherits RaioPDF project license",
      });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function bundledJarFacts() {
  const jarPath = join(payloadDir, "engine", "stirling.jar");
  if (!existsSync(jarPath)) {
    return null;
  }
  return {
    path: "engine/stirling.jar",
    size: statSync(jarPath).size,
    sha256: sha256(jarPath),
  };
}
