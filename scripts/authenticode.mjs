import { execFileSync } from "node:child_process";

function psLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function authenticodeTool() {
  // Prefer PowerShell 7+ (pwsh) everywhere. On Windows, powershell.exe (Windows
  // PowerShell 5.1) can fail to autoload Get-AuthenticodeSignature from
  // Microsoft.PowerShell.Security in some sessions, which breaks release-asset
  // signature validation; pwsh loads it reliably.
  return "pwsh";
}

function normalizeThumbprint(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, "").toUpperCase();
}

export function expectedSignerIdentity({
  expectedSubject = process.env.RAIOPDF_SIGN_EXPECTED_SUBJECT,
  expectedThumbprint = process.env.RAIOPDF_SIGN_EXPECTED_THUMBPRINT || process.env.RAIOPDF_SIGN_THUMBPRINT,
} = {}) {
  const subject = typeof expectedSubject === "string" ? expectedSubject.trim() : "";
  const thumbprint = normalizeThumbprint(expectedThumbprint);
  if (!subject && !thumbprint) {
    throw new Error(
      "Authenticode verification requires RAIOPDF_SIGN_EXPECTED_THUMBPRINT, RAIOPDF_SIGN_THUMBPRINT, or RAIOPDF_SIGN_EXPECTED_SUBJECT.",
    );
  }
  return { subject, thumbprint };
}

export function verifyAuthenticodeSignature(
  filePath,
  { expectedSubject, expectedThumbprint, label = "installer" } = {},
) {
  const identity = expectedSignerIdentity({ expectedSubject, expectedThumbprint });
  const script = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath ${psLiteral(filePath)}
[pscustomobject]@{
  Status = [string]$sig.Status
  StatusMessage = [string]$sig.StatusMessage
  SignerSubject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null }
  SignerThumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { $null }
  TimeStamperSubject = if ($sig.TimeStamperCertificate) { [string]$sig.TimeStamperCertificate.Subject } else { $null }
} | ConvertTo-Json -Compress
`;
  let raw;
  try {
    raw = execFileSync(
      authenticodeTool(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new Error(
      `Authenticode verification failed for ${label}: ${stderr || error.message || String(error)}`,
    );
  }

  const signature = JSON.parse(raw);
  if (signature.Status !== "Valid") {
    throw new Error(
      `Authenticode verification failed for ${label}: status ${signature.Status || "(none)"} ${signature.StatusMessage || ""}`.trim(),
    );
  }
  if (!signature.SignerSubject) {
    throw new Error(`Authenticode verification failed for ${label}: missing signer certificate.`);
  }
  if (!signature.SignerThumbprint) {
    throw new Error(`Authenticode verification failed for ${label}: missing signer certificate thumbprint.`);
  }
  if (!signature.TimeStamperSubject) {
    throw new Error(`Authenticode verification failed for ${label}: missing timestamp certificate.`);
  }
  if (identity.thumbprint && normalizeThumbprint(signature.SignerThumbprint) !== identity.thumbprint) {
    throw new Error(
      `Authenticode verification failed for ${label}: signer thumbprint ${JSON.stringify(
        signature.SignerThumbprint,
      )} does not match expected thumbprint ${JSON.stringify(identity.thumbprint)}.`,
    );
  }
  if (identity.subject && signature.SignerSubject !== identity.subject) {
    throw new Error(
      `Authenticode verification failed for ${label}: signer ${JSON.stringify(
        signature.SignerSubject,
      )} does not exactly match expected subject ${JSON.stringify(identity.subject)}.`,
    );
  }
  return signature;
}
