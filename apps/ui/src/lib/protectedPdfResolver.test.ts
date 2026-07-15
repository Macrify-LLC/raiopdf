import { describe, expect, it, vi } from "vitest";
import { PdfEngineError, type PdfProtectionFacts } from "@raiopdf/engine-api";
import { resolveProtectedPdfBytes } from "./protectedPdfResolver";

describe("resolveProtectedPdfBytes protection provenance", () => {
  it("keeps the password prompt open after a typed invalid-password inspection", async () => {
    const result = await resolveProtectedPdfBytes(new Uint8Array([1, 2, 3]), {
      password: "wrong",
      inspectProtection: vi.fn(async () => {
        throw new PdfEngineError("PASSWORD_INVALID", "not accepted");
      }),
      removeEncryption: vi.fn(),
    });

    expect(result).toEqual({ status: "password_required" });
  });

  it("inspects the still-encrypted source before decrypting and retains the facts", async () => {
    const facts: PdfProtectionFacts = {
      kind: "open-password",
      encryption: "AES-256",
      permissions: {
        printing: "full",
        copying: "blocked",
        accessibilityExtraction: "allowed",
      },
    };
    const order: string[] = [];
    const inspectProtection = vi.fn(async () => {
      order.push("inspect");
      return facts;
    });
    const removeEncryption = vi.fn(async () => {
      order.push("decrypt");
      return new Uint8Array([37, 80, 68, 70]);
    });

    const result = await resolveProtectedPdfBytes(new Uint8Array([1, 2, 3]), {
      password: "open secret",
      inspectProtection,
      removeEncryption,
    });

    expect(order).toEqual(["inspect", "decrypt"]);
    expect(result).toMatchObject({
      status: "unlocked",
      provenance: { protection: facts },
    });
  });
});
