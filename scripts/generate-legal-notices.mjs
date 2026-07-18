#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getPlatform, platformPath } from "../installer/platforms.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const args = parseArgs(process.argv.slice(2));
const platform = getPlatform(
  args.platform ?? process.env.RAIOPDF_PLATFORM ?? process.env.PAYLOAD_PLATFORM ?? "windows-x64",
);
const pinsPath = resolve(
  args.pinsPath ?? process.env.RAIOPDF_PINS_FILE ?? join(REPO_ROOT, platform.pinsFile),
);
const payloadDir = resolve(
  args.payloadDir ??
    process.env.RAIOPDF_PAYLOAD_DIR ??
    platformPath(REPO_ROOT, platform.payloadId, "payloadOutputDir"),
);
const legalDir = join(payloadDir, "legal");
const checkOnly = args.check;
const isMacPlatform = platform.payloadId === "macos-arm64";
const SUPPORTED_LEGAL_PLATFORMS = new Set(["windows-x64", "macos-arm64"]);

const pins = parsePins(pinsPath);
assertSupportedProvenance();
const version = releaseVersion();

if (checkOnly) {
  checkLegalPayload();
} else {
  generateLegalPayload();
  checkLegalPayload();
}

function parseArgs(argv) {
  const parsed = { check: false, payloadDir: undefined, platform: undefined, pinsPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg.startsWith("--payload-dir=")) {
      parsed.payloadDir = arg.slice("--payload-dir=".length);
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
    if (arg.startsWith("--platform=")) {
      parsed.platform = arg.slice("--platform=".length);
      continue;
    }
    if (arg === "--platform") {
      const value = argv[index + 1];
      if (!value) usage("Missing value for --platform");
      parsed.platform = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--pins=")) {
      parsed.pinsPath = arg.slice("--pins=".length);
      continue;
    }
    if (arg === "--pins") {
      const value = argv[index + 1];
      if (!value) usage("Missing value for --pins");
      parsed.pinsPath = value;
      index += 1;
      continue;
    }
    usage(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(message) {
  console.error(message);
  console.error(
    "Usage: node scripts/generate-legal-notices.mjs [--platform ID] [--pins PATH] [--payload-dir PATH] [--check]",
  );
  process.exit(2);
}

function parsePins(path) {
  if (!existsSync(path)) {
    throw new Error(`Legal provenance pins do not exist for ${platform.payloadId}: ${path}`);
  }
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

function assertSupportedProvenance() {
  if (!SUPPORTED_LEGAL_PLATFORMS.has(platform.payloadId)) {
    throw new Error(
      `${platform.payloadId} legal generation is not enabled until its native component paths, ` +
        "license inventory, and source-correspondence templates are verified. Refusing to emit " +
        "unverified platform claims.",
    );
  }

  const commonRequired = [
    "TEMURIN_JRE_VERSION",
    "TEMURIN_JRE_URL",
    "TEMURIN_JRE_SHA256",
    "NODE_RUNTIME_VERSION",
    "NODE_RUNTIME_URL",
    "NODE_RUNTIME_SHA256",
    "OCRMYPDF_VERSION",
    "OCRMYPDF_REQUIREMENTS",
    "OCRMYPDF_REQUIREMENTS_SHA256",
    "TESSERACT_VERSION",
    "TESSDATA_FAST_VERSION",
    "TESSDATA_ENG_URL",
    "TESSDATA_ENG_SHA256",
    "GHOSTSCRIPT_VERSION",
    "GHOSTSCRIPT_SOURCE_URL",
    "GHOSTSCRIPT_SOURCE_SHA256",
    "QPDF_VERSION",
  ];
  // Windows ships prebuilt binaries for Python/Tesseract/qpdf; macOS builds
  // them (and their static image-IO dependencies) from pinned source instead.
  const platformRequired = isMacPlatform
    ? [
        "PYTHON_STANDALONE_VERSION",
        "PYTHON_STANDALONE_URL",
        "PYTHON_STANDALONE_SHA256",
        "TESSERACT_SOURCE_URL",
        "TESSERACT_SOURCE_SHA256",
        "QPDF_SOURCE_URL",
        "QPDF_SOURCE_SHA256",
        "LEPTONICA_VERSION",
        "LEPTONICA_SOURCE_URL",
        "LEPTONICA_SOURCE_SHA256",
        "LIBPNG_VERSION",
        "LIBPNG_SOURCE_URL",
        "LIBPNG_SOURCE_SHA256",
        "LIBTIFF_VERSION",
        "LIBTIFF_SOURCE_URL",
        "LIBTIFF_SOURCE_SHA256",
        "LIBJPEG_TURBO_VERSION",
        "LIBJPEG_TURBO_SOURCE_URL",
        "LIBJPEG_TURBO_SOURCE_SHA256",
      ]
    : [
        "PYTHON_EMBED_VERSION",
        "PYTHON_EMBED_URL",
        "PYTHON_EMBED_SHA256",
        "TESSERACT_URL",
        "TESSERACT_SHA256",
        "GHOSTSCRIPT_URL",
        "GHOSTSCRIPT_SHA256",
        "QPDF_URL",
        "QPDF_SHA256",
      ];
  const missing = [...commonRequired, ...platformRequired].filter((name) => !pins[name]);
  if (missing.length > 0) {
    throw new Error(
      `${platform.payloadId} legal provenance is incomplete in ${relative(REPO_ROOT, pinsPath)}; ` +
        `missing: ${missing.join(", ")}.`,
    );
  }
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
    ghostscriptComponent(),
    component("Stirling-PDF core flavor", readPinnedTag("engine/PINNED_TAG"), "MIT", "https://github.com/Stirling-Tools/Stirling-PDF", {
      role: "PDF engine",
      payloadPaths: ["engine/stirling.jar"],
      correspondingSource: "See engine/PINNED_TAG, engine/vendor.sh, and engine/build.sh in the RaioPDF source tree.",
    }),
    component("Eclipse Temurin JRE", pins.TEMURIN_JRE_VERSION, "GPL-2.0-only WITH Classpath-exception-2.0", "https://adoptium.net/", {
      role: "bundled Java runtime",
      binary: { url: pins.TEMURIN_JRE_URL, sha256: pins.TEMURIN_JRE_SHA256 },
    }),
    nodeComponent(),
    pythonComponent(),
    ocrmypdfComponent(),
    tesseractComponent(),
    tessdataComponent(),
    qpdfComponent(),
    component("pdfjs-dist", npmVersion("pdfjs-dist"), "Apache-2.0", "https://github.com/mozilla/pdf.js", {
      role: "PDF rendering assets and worker",
      payloadPaths: ["mcp/pdfjs/cmaps", "mcp/pdfjs/standard_fonts", "mcp/pdfjs/wasm"],
    }),
    component("pdf-lib", npmVersion("pdf-lib"), "MIT", "https://github.com/Hopding/pdf-lib", {
      role: "PDF manipulation library",
    }),
    canvasComponent(),
    component("React", npmVersion("react"), "MIT", "https://react.dev/", { role: "desktop UI" }),
    component("React DOM", npmVersion("react-dom"), "MIT", "https://react.dev/", { role: "desktop UI" }),
    component("Tauri", cargoVersion("tauri"), "Apache-2.0 OR MIT", "https://tauri.app/", {
      role: "desktop application shell",
    }),
    // macOS builds its native OCR toolchain (Ghostscript/Tesseract/qpdf) from
    // source instead of shipping prebuilt binaries, which pulls in these
    // statically-linked source dependencies. Windows has no equivalent.
    ...(isMacPlatform ? macSourceBuiltImageDependencies() : []),
  ];

  return {
    schemaVersion: 1,
    product: "RaioPDF",
    releaseVersion: version,
    generatedBy: "scripts/generate-legal-notices.mjs",
    provenancePins: relative(REPO_ROOT, pinsPath).replaceAll("\\", "/"),
    sourceRepository: "https://github.com/Macrify-LLC/raiopdf",
    platforms: [
      {
        id: platform.payloadId,
        enginePlatform: platform.enginePlatform,
        artifactPlatform: platform.artifactPlatform,
        status: "shipping",
        note: `Release payload assembled by installer/${platform.assembler}.`,
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

// Platform-conditional component builders. Windows branches are the
// pre-existing, byte-for-byte-unchanged behavior; macOS branches describe the
// source-built toolchain per installer/PINS.macos-arm64.env.

function ghostscriptComponent() {
  if (isMacPlatform) {
    return component("Ghostscript", pins.GHOSTSCRIPT_VERSION, "AGPL-3.0-only", "https://www.ghostscript.com/", {
      role: "OCR/PDF interpreter",
      payloadPaths: ["ocr/gs/bin/gs"],
      source: {
        url: pins.GHOSTSCRIPT_SOURCE_URL,
        sha256: pins.GHOSTSCRIPT_SOURCE_SHA256,
      },
      modificationStatus:
        "Built from the pinned upstream AGPL-3.0 source archive on the build host. RaioPDF's build " +
        "configuration (configure flags) produces a self-contained arm64 binary; RaioPDF makes no " +
        "functional modifications to the Ghostscript source.",
    });
  }
  return component("Ghostscript", pins.GHOSTSCRIPT_VERSION, "AGPL-3.0-only", "https://www.ghostscript.com/", {
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
  });
}

function nodeComponent() {
  const payloadPaths = isMacPlatform
    ? ["mcp/node/bin/node", "mcp/node/LICENSE"]
    : ["mcp/node/node.exe", "mcp/node/LICENSE"];
  return component("Node.js runtime", pins.NODE_RUNTIME_VERSION, "MIT", "https://nodejs.org/", {
    role: "bundled MCP runtime",
    binary: { url: pins.NODE_RUNTIME_URL, sha256: pins.NODE_RUNTIME_SHA256 },
    payloadPaths,
  });
}

function pythonComponent() {
  if (isMacPlatform) {
    return component(
      "Python (python-build-standalone)",
      pins.PYTHON_STANDALONE_VERSION,
      "Python-2.0",
      "https://github.com/astral-sh/python-build-standalone",
      {
        role: "bundled OCR runtime",
        binary: { url: pins.PYTHON_STANDALONE_URL, sha256: pins.PYTHON_STANDALONE_SHA256 },
        payloadPaths: ["ocr/python/bin/python3"],
      },
    );
  }
  return component("Python embeddable package", pins.PYTHON_EMBED_VERSION, "Python-2.0", "https://www.python.org/", {
    role: "bundled OCR runtime",
    binary: { url: pins.PYTHON_EMBED_URL, sha256: pins.PYTHON_EMBED_SHA256 },
    payloadPaths: ["ocr/python/python.exe"],
  });
}

function ocrmypdfComponent() {
  const payloadPaths = isMacPlatform
    ? ["ocr/ocrmypdf", "ocr/THIRD-PARTY-PYTHON.md"]
    : ["ocr/ocrmypdf.cmd", "ocr/THIRD-PARTY-PYTHON.md"];
  return component("OCRmyPDF", pins.OCRMYPDF_VERSION, "MPL-2.0", "https://ocrmypdf.readthedocs.io/", {
    role: "OCR pipeline",
    payloadPaths,
  });
}

function tesseractComponent() {
  if (isMacPlatform) {
    return component("Tesseract OCR", pins.TESSERACT_VERSION, "Apache-2.0", "https://github.com/tesseract-ocr/tesseract", {
      role: "OCR engine",
      payloadPaths: ["ocr/tesseract/bin/tesseract"],
      source: { url: pins.TESSERACT_SOURCE_URL, sha256: pins.TESSERACT_SOURCE_SHA256 },
      modificationStatus:
        "Built from the pinned upstream source archive on the build host, statically linked against " +
        "Leptonica, libpng, libtiff, and libjpeg-turbo; no functional source modifications.",
    });
  }
  return component("Tesseract OCR", pins.TESSERACT_VERSION, "Apache-2.0", "https://github.com/tesseract-ocr/tesseract", {
    role: "OCR engine",
    binary: { url: pins.TESSERACT_URL, sha256: pins.TESSERACT_SHA256 },
    payloadPaths: ["ocr/tesseract/tesseract.exe"],
  });
}

function tessdataComponent() {
  const payloadPaths = isMacPlatform
    ? ["ocr/tesseract/share/tessdata/eng.traineddata"]
    : ["ocr/tesseract/tessdata/eng.traineddata"];
  return component("tessdata_fast English traineddata", pins.TESSDATA_FAST_VERSION, "Apache-2.0", "https://github.com/tesseract-ocr/tessdata_fast", {
    role: "OCR language data",
    binary: { url: pins.TESSDATA_ENG_URL, sha256: pins.TESSDATA_ENG_SHA256 },
    payloadPaths,
  });
}

function qpdfComponent() {
  if (isMacPlatform) {
    return component("qpdf", pins.QPDF_VERSION, "Apache-2.0", "https://github.com/qpdf/qpdf", {
      role: "PDF repair/linearization helper",
      payloadPaths: ["ocr/qpdf/bin/qpdf"],
      source: { url: pins.QPDF_SOURCE_URL, sha256: pins.QPDF_SOURCE_SHA256 },
      modificationStatus:
        "Built from the pinned upstream source archive on the build host (fully static, native crypto, " +
        "no OpenSSL); no functional source modifications.",
    });
  }
  return component("qpdf", pins.QPDF_VERSION, "Apache-2.0", "https://github.com/qpdf/qpdf", {
    role: "PDF repair/linearization helper",
    binary: { url: pins.QPDF_URL, sha256: pins.QPDF_SHA256 },
    payloadPaths: ["ocr/qpdf/bin/qpdf.exe", "ocr/qpdf/LICENSE.txt"],
  });
}

function canvasComponent() {
  const payloadPaths = isMacPlatform
    ? [
        "mcp/node_modules/@napi-rs/canvas/package.json",
        "mcp/node_modules/@napi-rs/canvas-darwin-arm64/package.json",
      ]
    : [
        "mcp/node_modules/@napi-rs/canvas/package.json",
        "mcp/node_modules/@napi-rs/canvas-win32-x64-msvc/package.json",
      ];
  return component("@napi-rs/canvas", npmVersion("@napi-rs/canvas"), "MIT", "https://github.com/Brooooooklyn/canvas", {
    role: "MCP image/canvas rendering dependency",
    payloadPaths,
  });
}

// Static image-IO dependencies pulled in only because macOS builds
// Ghostscript/Tesseract/qpdf from source instead of shipping prebuilt
// binaries. All are statically linked into those binaries; none ship as
// standalone payload files.
//
// SPDX expressions below were verified against the license files shipped in
// the exact pinned source tarballs (SHA256-checked against the pins file):
// - Leptonica 1.84.1: leptonica-license.txt (the 2-clause Leptonica license;
//   SPDX id "Leptonica").
// - libpng 1.6.43: LICENSE ("PNG Reference Library License version 2", used
//   by libpng since 1.6.36; SPDX id "libpng-2.0").
// - libtiff 4.6.0: LICENSE.md (the Leffler/SGI libtiff license; SPDX id
//   "libtiff").
// - libjpeg-turbo 3.0.4: LICENSE.md + README.ijg. Only the libjpeg API
//   library (libjpeg.a) is linked: IJG-licensed core plus zlib-licensed Arm
//   NEON SIMD objects. The BSD-3-Clause portions cover the TurboJPEG API
//   library and build system, neither of which is linked or shipped, so the
//   expression for the shipped binaries is "IJG AND Zlib".
function macSourceBuiltImageDependencies() {
  return [
    component("Leptonica", pins.LEPTONICA_VERSION, "Leptonica", "http://leptonica.org/", {
      role: "Tesseract image I/O dependency (statically linked)",
      source: { url: pins.LEPTONICA_SOURCE_URL, sha256: pins.LEPTONICA_SOURCE_SHA256 },
      modificationStatus: "Built from the pinned upstream source archive on the build host; no functional source modifications.",
    }),
    component("libpng", pins.LIBPNG_VERSION, "libpng-2.0", "http://www.libpng.org/pub/png/libpng.html", {
      role: "PNG image support for Leptonica (statically linked)",
      source: { url: pins.LIBPNG_SOURCE_URL, sha256: pins.LIBPNG_SOURCE_SHA256 },
      modificationStatus: "Built from the pinned upstream source archive on the build host; no functional source modifications.",
    }),
    component("libtiff", pins.LIBTIFF_VERSION, "libtiff", "https://libtiff.gitlab.io/libtiff/", {
      role: "TIFF image support for Leptonica (statically linked)",
      source: { url: pins.LIBTIFF_SOURCE_URL, sha256: pins.LIBTIFF_SOURCE_SHA256 },
      modificationStatus: "Built from the pinned upstream source archive on the build host; no functional source modifications.",
    }),
    component("libjpeg-turbo", pins.LIBJPEG_TURBO_VERSION, "IJG AND Zlib", "https://libjpeg-turbo.org/", {
      role: "JPEG support for Leptonica, Tesseract, and qpdf (statically linked)",
      source: { url: pins.LIBJPEG_TURBO_SOURCE_URL, sha256: pins.LIBJPEG_TURBO_SOURCE_SHA256 },
      modificationStatus: "Built from the pinned upstream source archive on the build host; no functional source modifications.",
    }),
  ];
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
${isMacPlatform ? `${macImageLibraryAttribution()}\n` : ""}
Bundled npm Dependency Inventory
--------------------------------

The bundled UI and MCP JavaScript artifacts include the following npm
dependencies according to \`pnpm licenses list --json --filter @raiopdf/mcp
--filter @raiopdf/ui\` when that inventory is available:

${npmRows || "- npm dependency inventory unavailable; see COMPONENT-MANIFEST.json."}

Ghostscript Source
------------------

${ghostscriptProvenanceNote()}

See legal/source-offers/GHOSTSCRIPT-SOURCE-OFFER.txt and
legal/RELEASE-SOURCE-CORRESPONDENCE.md for source-correspondence details.

Platform Scope
--------------

These notices apply only to the ${platform.payloadId} payload. Every other
platform has a separate pins file, component inventory, and release gate.

License Texts
-------------

- legal/licenses/GPL-3.0.txt
- legal/licenses/AGPL-3.0.txt
- legal/licenses/MPL-2.0.txt
`;
}

// macOS-only THIRD-PARTY-NOTICES section. The IJG license requires binary
// distributions to state "This software is based in part on the work of the
// Independent JPEG Group." in the product documentation; the statically
// linked image libraries otherwise appear only as component rows. Windows
// output must remain byte-identical, so the caller emits "" there.
function macImageLibraryAttribution() {
  return `
Statically Linked Image Libraries
---------------------------------

This software is based in part on the work of the Independent JPEG Group.

The macOS Tesseract and qpdf binaries statically link their image-format
dependencies (Leptonica, libpng, libtiff, and libjpeg-turbo's IJG-licensed
libjpeg API library, including its zlib-licensed Arm NEON SIMD portions);
none ships as a standalone payload file. Each library's license identifier,
pinned source URL, and SHA256 are recorded in COMPONENT-MANIFEST.json.`;
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

${ghostscriptSourceCorrespondenceNote()}

## Other Bundled Runtime Components

Pinned URLs and checksums for JRE, Node.js, Python, Tesseract, tessdata_fast,
Ghostscript, and qpdf${isMacPlatform ? " (plus the source-built Leptonica/libpng/libtiff/libjpeg-turbo dependencies)" : ", and 7-Zip helper"}
downloads live in \`${relative(REPO_ROOT, pinsPath).replaceAll("\\", "/")}\`.
The release payload manifest hashes every file copied under the bundled
\`payload/\` resource directory.

## Other Platform Payloads

These notices do not describe another platform's binaries. Before another
platform ships, its native pins, payload inventory, and source correspondence
must pass that platform's legal generator and release gate.
`;
}

function ghostscriptSourceOffer() {
  return `Ghostscript Source Offer for RaioPDF
========================================

${ghostscriptSourceOfferNote()}
`;
}

// The three narrative helpers below describe the same underlying facts
// (Ghostscript license, pinned binary/source, modification status) at three
// call sites (THIRD-PARTY-NOTICES, RELEASE-SOURCE-CORRESPONDENCE, and the
// GHOSTSCRIPT-SOURCE-OFFER). Each stays platform-conditional here rather than
// duplicating the branch at every call site.

function ghostscriptProvenanceNote() {
  if (isMacPlatform) {
    return `RaioPDF treats the bundled Ghostscript component as AGPL-3.0-only.
Ghostscript is built from the pinned upstream AGPL-3.0 source archive on the
build host; RaioPDF ships no prebuilt Ghostscript binary for macOS. RaioPDF's
build configuration (configure flags) produces a self-contained arm64 binary
with no functional source modifications.

Pinned Ghostscript source:
${pins.GHOSTSCRIPT_SOURCE_URL}
SHA256: ${pins.GHOSTSCRIPT_SOURCE_SHA256}`;
  }
  return `RaioPDF treats the bundled Ghostscript Windows x64 component as AGPL-3.0-only.
The Ghostscript binary is not modified. The payload copies the upstream
gswin64c.exe to gs.exe as a byte-identical convenience alias.

Pinned Ghostscript binary:
${pins.GHOSTSCRIPT_URL}
SHA256: ${pins.GHOSTSCRIPT_SHA256}

Pinned Ghostscript source:
${pins.GHOSTSCRIPT_SOURCE_URL}
SHA256: ${pins.GHOSTSCRIPT_SOURCE_SHA256}`;
}

function ghostscriptSourceCorrespondenceNote() {
  if (isMacPlatform) {
    return `RaioPDF builds Ghostscript from the pinned upstream AGPL-3.0 source archive
on the build host; no prebuilt Ghostscript binary ships for macOS:

- ${pins.GHOSTSCRIPT_SOURCE_URL}
- SHA256: \`${pins.GHOSTSCRIPT_SOURCE_SHA256}\`

RaioPDF's build configuration (configure flags) produces a self-contained
arm64 \`gs\` binary that links only system libraries. RaioPDF makes no
functional modifications to the Ghostscript source.`;
  }
  return `The bundled Ghostscript Windows x64 binary is taken from:

- ${pins.GHOSTSCRIPT_URL}
- SHA256: \`${pins.GHOSTSCRIPT_SHA256}\`

The corresponding pinned Ghostscript source archive is:

- ${pins.GHOSTSCRIPT_SOURCE_URL}
- SHA256: \`${pins.GHOSTSCRIPT_SOURCE_SHA256}\`

RaioPDF does not patch or rebuild Ghostscript. The installer payload copies
\`ocr/gs/bin/gswin64c.exe\` to \`ocr/gs/bin/gs.exe\`; the release gate verifies
those files are byte-identical when both are present.`;
}

function ghostscriptSourceOfferNote() {
  if (isMacPlatform) {
    return `RaioPDF bundles Ghostscript ${pins.GHOSTSCRIPT_VERSION}, built for macOS arm64
from the pinned upstream AGPL-3.0 source archive on the build host.

Source archive:
${pins.GHOSTSCRIPT_SOURCE_URL}
SHA256: ${pins.GHOSTSCRIPT_SOURCE_SHA256}

The RaioPDF release process attaches this source archive to release artifacts
as ghostscript-${pins.GHOSTSCRIPT_VERSION}-source.tar.xz and records it in
SHA256SUMS.txt. The archive can also be downloaded from the pinned upstream URL
above.

RaioPDF's build configuration (configure flags) produces a self-contained
arm64 binary; RaioPDF makes no functional modifications to the Ghostscript
source.`;
  }
  return `RaioPDF bundles Ghostscript ${pins.GHOSTSCRIPT_VERSION} for Windows x64 under
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
to gs.exe as a byte-identical convenience alias for command-line invocation.`;
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
    errors.push(
      `GHOSTSCRIPT_SOURCE_URL and GHOSTSCRIPT_SOURCE_SHA256 must be pinned in ${relative(REPO_ROOT, pinsPath)}`,
    );
  }

  const manifestPath = join(legalDir, "COMPONENT-MANIFEST.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.product !== "RaioPDF") {
      errors.push(`COMPONENT-MANIFEST.json product must be RaioPDF, got ${manifest.product}`);
    }
    if (manifest.releaseVersion !== version) {
      errors.push(
        `COMPONENT-MANIFEST.json releaseVersion must be ${version}, got ${manifest.releaseVersion}`,
      );
    }
    if (manifest.provenancePins !== relative(REPO_ROOT, pinsPath).replaceAll("\\", "/")) {
      errors.push("COMPONENT-MANIFEST.json provenancePins does not match the selected pins file");
    }
    const selectedPlatform = manifest.platforms?.find(
      (entry) => entry.id === platform.payloadId && entry.status === "shipping",
    );
    if (!selectedPlatform || manifest.platforms?.length !== 1) {
      errors.push(
        `COMPONENT-MANIFEST.json must describe only the selected ${platform.payloadId} shipping payload`,
      );
    }
    const raio = manifest.components?.find((entry) => entry.name === "RaioPDF");
    if (!raio) {
      errors.push("COMPONENT-MANIFEST.json is missing RaioPDF");
    } else if (raio.version !== version) {
      errors.push(`RaioPDF component version must be ${version}, got ${raio.version}`);
    }
    const ghostscript = manifest.components?.find((entry) => entry.name === "Ghostscript");
    if (!ghostscript) {
      errors.push("COMPONENT-MANIFEST.json is missing Ghostscript");
    } else {
      if (ghostscript.version !== pins.GHOSTSCRIPT_VERSION) {
        errors.push(`Ghostscript version must be ${pins.GHOSTSCRIPT_VERSION}, got ${ghostscript.version}`);
      }
      if (ghostscript.license !== "AGPL-3.0-only") {
        errors.push(`Ghostscript license must be AGPL-3.0-only, got ${ghostscript.license}`);
      }
      if (ghostscript.source?.url !== pins.GHOSTSCRIPT_SOURCE_URL) {
        errors.push("Ghostscript source URL in manifest does not match the selected pins file");
      }
      if (ghostscript.source?.sha256 !== pins.GHOSTSCRIPT_SOURCE_SHA256) {
        errors.push("Ghostscript source SHA256 in manifest does not match the selected pins file");
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

  // Windows-only byte-identity check. macOS ships ocr/gs/bin/gs (no .exe
  // extension, no gswin64c.exe alias), so both existsSync calls are false
  // there and this block is a no-op rather than an error.
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
  // Windows' embeddable package uses a flat Lib/site-packages; macOS's
  // python-build-standalone layout is versioned (lib/python<X.Y>/site-packages).
  const sitePackages = isMacPlatform
    ? join(payloadDir, "ocr", "python", "lib", `python${pins.PYTHON_VERSION}`, "site-packages")
    : join(payloadDir, "ocr", "python", "Lib", "site-packages");
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
