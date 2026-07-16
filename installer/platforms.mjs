import path from "node:path";

/**
 * @typedef {"windows-x64" | "macos-arm64"} PlatformId
 *
 * @typedef {Readonly<{
 *   payloadId: PlatformId,
 *   enginePlatform: "windows-x64" | "darwin-arm64",
 *   rustTarget: "x86_64-pc-windows-msvc" | "aarch64-apple-darwin",
 *   updaterPlatform: "windows-x86_64" | "darwin-aarch64",
 *   artifactPlatform: PlatformId,
 *   nodePlatform: "win32-x64" | "darwin-arm64",
 *   assembler: string,
 *   pinsFile: string,
 *   artifact: Readonly<{
 *     installerSuffix: string,
 *     updaterSuffix: string,
 *     installerPattern: RegExp,
 *     rawInstallerPattern: RegExp,
 *     updaterPattern: RegExp,
 *   }>,
 *   foreignFileMarkers: readonly RegExp[],
 *   nativeBinaryExceptions: readonly Readonly<{
 *     path: string,
 *     format: "pe" | "mach-o" | "elf",
 *     architecture: string,
 *   }>[],
 *   paths: Readonly<{
 *     payloadOutputDir: string,
 *     payloadCacheDir: string,
 *     releaseStageDir: string,
 *   }>,
 * }>} PlatformDescriptor
 */

export const PLATFORM_IDS = /** @type {const} */ (["windows-x64", "macos-arm64"]);

const windowsVersion = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?";

/** @type {Readonly<Record<PlatformId, PlatformDescriptor>>} */
export const PLATFORMS = Object.freeze({
  "windows-x64": Object.freeze({
    payloadId: "windows-x64",
    enginePlatform: "windows-x64",
    rustTarget: "x86_64-pc-windows-msvc",
    updaterPlatform: "windows-x86_64",
    artifactPlatform: "windows-x64",
    nodePlatform: "win32-x64",
    assembler: "assemble-windows-x64.sh",
    pinsFile: "installer/PINS.windows-x64.env",
    artifact: Object.freeze({
      installerSuffix: "windows-x64-setup.exe",
      updaterSuffix: "windows-x64-setup.exe",
      installerPattern: new RegExp(`^RaioPDF-${windowsVersion}-windows-x64-setup\\.exe$`),
      rawInstallerPattern: new RegExp(`^RaioPDF_${windowsVersion}_x64-setup\\.exe$`),
      updaterPattern: new RegExp(`^RaioPDF-${windowsVersion}-windows-x64-setup\\.exe$`),
    }),
    foreignFileMarkers: Object.freeze([
      /(?:^|\/)(?:macos-arm64|darwin-arm64)(?:\/|$)/i,
      /\.(?:app|dmg|dylib|icns)(?:\/|$)/i,
      /\.app\.tar\.gz$/i,
    ]),
    // Microsoft's x64 VC++ redistributable uses an x86 bootstrap executable
    // to install its x64 payload. Keep this exception exact and descriptor-owned.
    nativeBinaryExceptions: Object.freeze([
      Object.freeze({
        path: "ocr/gs/vcredist_x64.exe",
        format: "pe",
        architecture: "x86",
      }),
    ]),
    paths: Object.freeze({
      payloadOutputDir: "apps/shell/src-tauri/payload/windows-x64",
      payloadCacheDir: "installer/.payload-cache/windows-x64",
      releaseStageDir: "release-assets/signed/windows-x64",
    }),
  }),
  "macos-arm64": Object.freeze({
    payloadId: "macos-arm64",
    enginePlatform: "darwin-arm64",
    rustTarget: "aarch64-apple-darwin",
    updaterPlatform: "darwin-aarch64",
    artifactPlatform: "macos-arm64",
    nodePlatform: "darwin-arm64",
    assembler: "assemble-macos-arm64.sh",
    pinsFile: "installer/PINS.macos-arm64.env",
    artifact: Object.freeze({
      installerSuffix: "macos-arm64.dmg",
      updaterSuffix: "macos-arm64.app.tar.gz",
      installerPattern: new RegExp(`^RaioPDF-${windowsVersion}-macos-arm64\\.dmg$`),
      rawInstallerPattern: new RegExp(`^RaioPDF_${windowsVersion}_aarch64\\.dmg$`),
      updaterPattern: new RegExp(`^RaioPDF-${windowsVersion}-macos-arm64\\.app\\.tar\\.gz$`),
    }),
    foreignFileMarkers: Object.freeze([
      /(?:^|\/)(?:windows-x64|win32-x64)(?:\/|$)/i,
      /\.(?:exe|dll|msi|cmd|bat|ps1|ico)(?:\/|$)/i,
      /\.nsis\.zip$/i,
    ]),
    nativeBinaryExceptions: Object.freeze([]),
    paths: Object.freeze({
      payloadOutputDir: "apps/shell/src-tauri/payload/macos-arm64",
      payloadCacheDir: "installer/.payload-cache/macos-arm64",
      releaseStageDir: "release-assets/signed/macos-arm64",
    }),
  }),
});

/** @param {string} platformId @returns {PlatformDescriptor} */
export function getPlatform(platformId) {
  if (!Object.hasOwn(PLATFORMS, platformId)) {
    throw new Error(
      `Unsupported RaioPDF platform ${JSON.stringify(platformId)}. Expected one of: ${PLATFORM_IDS.join(
        ", ",
      )}.`,
    );
  }
  return PLATFORMS[/** @type {PlatformId} */ (platformId)];
}

/** @returns {PlatformId} */
export function getHostPlatformId({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  throw new Error(`Unsupported build host ${platform}-${arch}; RaioPDF ships Windows x64 and macOS arm64.`);
}

/**
 * Resolve a descriptor-owned repository-relative path without allowing a caller
 * to accidentally select a different platform's directory.
 *
 * @param {string} repoRoot
 * @param {PlatformId} platformId
 * @param {keyof PlatformDescriptor["paths"]} pathName
 */
export function platformPath(repoRoot, platformId, pathName) {
  return path.resolve(repoRoot, getPlatform(platformId).paths[pathName]);
}

/**
 * External build roots are allowed, but an override for one platform must
 * never point into another platform's descriptor-owned namespace.
 *
 * @param {string} repoRoot
 * @param {PlatformId} platformId
 * @param {keyof PlatformDescriptor["paths"] | "pinsFile"} pathName
 * @param {string} candidate
 */
export function assertOutsideForeignPlatformRoots(repoRoot, platformId, pathName, candidate) {
  const resolved = path.resolve(candidate);
  for (const otherId of PLATFORM_IDS) {
    if (otherId === platformId) continue;
    const other = getPlatform(otherId);
    const foreignRoot = pathName === "pinsFile"
      ? path.resolve(repoRoot, other.pinsFile)
      : platformPath(repoRoot, otherId, pathName);
    const relative = path.relative(foreignRoot, resolved);
    const crossesBoundary = pathName === "pinsFile"
      ? relative === ""
      : relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (crossesBoundary) {
      throw new Error(
        `${platformId} ${pathName} override enters the ${otherId} namespace: ${resolved}`,
      );
    }
  }
  return resolved;
}

/** @param {PlatformId} platformId @param {string} version */
export function canonicalArtifactNames(platformId, version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid RaioPDF release version ${JSON.stringify(version)}.`);
  }
  const { artifact } = getPlatform(platformId);
  return Object.freeze({
    installer: `RaioPDF-${version}-${artifact.installerSuffix}`,
    updater: `RaioPDF-${version}-${artifact.updaterSuffix}`,
  });
}
