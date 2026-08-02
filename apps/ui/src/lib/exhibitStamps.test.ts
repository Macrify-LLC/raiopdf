// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocateIdentifier,
  defaultExhibitStampTemplates,
  deleteExhibitStampTemplate,
  listExhibitStampTemplates,
  readExhibitStampStore,
  resetCounter,
  resetExhibitStampCacheForTests,
  rollbackIdentifier,
  saveExhibitStampTemplate,
  setNextIdentifier,
  type ExhibitStampStoreV1,
} from "./exhibitStamps";

const STORAGE_KEY = "raiopdf.exhibit-stamps.v1";
const PLAINTIFF = "plaintiffs-exhibit";
// jsdom's localStorage is a proxy that turns instance property writes into
// stored items, so a write spy has to go on the prototype.
const realSetItem = Storage.prototype.setItem;

function writeDirect(key: string, value: string): void {
  realSetItem.call(window.localStorage, key, value);
}

function failWrites(): void {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetExhibitStampCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("store loading", () => {
  it("seeds three starter templates on first load", () => {
    const store = readExhibitStampStore();

    expect(store.templates.map((template) => template.name)).toEqual([
      "Plaintiff's Exhibit",
      "Defendant's Exhibit",
      "Exhibit",
    ]);
    expect(store.templates.map((template) => template.identifierStyle)).toEqual([
      "numbers",
      "letters",
      "letters",
    ]);
    expect(store.revision).toBe(0);
    // The seed is written back so the counters have somewhere to live.
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("falls back to the seed without throwing when the stored value is corrupt", () => {
    for (const corrupt of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ version: 2, revision: 0, templates: [] }),
      JSON.stringify({ version: 1, revision: -1, templates: [] }),
      JSON.stringify({ version: 1, revision: 1.5, templates: [] }),
      JSON.stringify({ version: 1, revision: 0, templates: [{ id: "x" }] }),
      JSON.stringify({
        version: 1,
        revision: 0,
        templates: [{ ...defaultExhibitStampTemplates()[0], identifierStyle: "roman" }],
      }),
      JSON.stringify({
        version: 1,
        revision: 0,
        templates: [{ ...defaultExhibitStampTemplates()[0], nextIndex: -2 }],
      }),
    ]) {
      window.localStorage.setItem(STORAGE_KEY, corrupt);
      resetExhibitStampCacheForTests();

      expect(() => readExhibitStampStore()).not.toThrow();
      expect(listExhibitStampTemplates()).toHaveLength(3);
    }
  });

  it("keeps a valid stored store instead of reseeding", async () => {
    await setNextIdentifier(PLAINTIFF, "12");
    resetExhibitStampCacheForTests();

    expect(templateNextIndex(PLAINTIFF)).toBe(11);
  });

  it("drops the read cache when another window writes the key", () => {
    readExhibitStampStore();

    const store = parseStored();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...store,
      revision: store.revision + 1,
      templates: store.templates.map((template) =>
        template.id === PLAINTIFF ? { ...template, nextIndex: 40 } : template,
      ),
    }));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));

    expect(templateNextIndex(PLAINTIFF)).toBe(40);
  });
});

describe("allocateIdentifier", () => {
  it("hands out the label, lines, and sequence for the next exhibit", async () => {
    const result = await allocateIdentifier(PLAINTIFF);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value.label).toBe("Plaintiff's Exhibit 1");
    expect(result.value.lines).toEqual(["Plaintiff's Exhibit", "1"]);
    expect(result.value.sequence).toEqual({
      schemaVersion: 1,
      identifierStyle: "numbers",
      prefix: "Plaintiff's Exhibit",
      layout: "stacked",
      index: 0,
    });
    expect(result.value.templateId).toBe(PLAINTIFF);
    expect(result.value.templateRevision).toBe(1);
  });

  it("advances the counter on disk before returning", async () => {
    await allocateIdentifier(PLAINTIFF);
    resetExhibitStampCacheForTests();

    expect(templateNextIndex(PLAINTIFF)).toBe(1);
  });

  it("gives concurrent callers unique consecutive indices", async () => {
    const results = await Promise.all([
      allocateIdentifier(PLAINTIFF),
      allocateIdentifier(PLAINTIFF),
      allocateIdentifier(PLAINTIFF),
    ]);

    expect(results.map(indexOf)).toEqual([0, 1, 2]);
    expect(templateNextIndex(PLAINTIFF)).toBe(3);
  });

  it("gives rapid sequential callers unique consecutive indices", async () => {
    const indices: (number | null)[] = [];

    for (let call = 0; call < 4; call += 1) {
      indices.push(indexOf(await allocateIdentifier(PLAINTIFF)));
    }

    expect(indices).toEqual([0, 1, 2, 3]);
    expect(templateNextIndex(PLAINTIFF)).toBe(4);
  });

  it("blocks the allocation when the counter cannot be written", async () => {
    readExhibitStampStore();
    failWrites();

    const result = await allocateIdentifier(PLAINTIFF);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("nothing was stamped");

    vi.restoreAllMocks();
    resetExhibitStampCacheForTests();
    // Nothing was consumed, so the next placement still gets exhibit 1.
    expect(templateNextIndex(PLAINTIFF)).toBe(0);
  });

  it("retries once against the winning store when another window writes first", async () => {
    readExhibitStampStore();

    const competing = withNextIndex(parseStored(), PLAINTIFF, 5, 7);
    let intercepted = false;

    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      writeDirect(key, value);

      if (!intercepted) {
        intercepted = true;
        // Another window commits on top of ours between write and verify.
        writeDirect(STORAGE_KEY, JSON.stringify(competing));
      }
    });

    const result = await allocateIdentifier(PLAINTIFF);

    expect(intercepted).toBe(true);
    // The retry picked up the other window's counter rather than reissuing ours.
    expect(indexOf(result)).toBe(5);
    expect(templateNextIndex(PLAINTIFF)).toBe(6);
  });

  it("gives up after one retry when the conflict keeps repeating", async () => {
    readExhibitStampStore();

    let conflicts = 0;

    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      writeDirect(key, value);
      conflicts += 1;
      writeDirect(
        STORAGE_KEY,
        JSON.stringify(withNextIndex(parseStored(), PLAINTIFF, 9, 30 + conflicts)),
      );
    });

    const result = await allocateIdentifier(PLAINTIFF);

    expect(result.ok).toBe(false);
    expect(conflicts).toBe(2);
  });

  it("reports a template that no longer exists", async () => {
    const result = await allocateIdentifier("not-a-template");

    expect(result.ok).toBe(false);
  });
});

describe("counter maintenance", () => {
  it("rolls back only the most recent allocation", async () => {
    const first = indexOf(await allocateIdentifier(PLAINTIFF));
    const second = indexOf(await allocateIdentifier(PLAINTIFF));

    expect([first, second]).toEqual([0, 1]);

    const stale = await rollbackIdentifier(PLAINTIFF, 0);

    expect(stale.ok).toBe(false);
    expect(templateNextIndex(PLAINTIFF)).toBe(2);

    const latest = await rollbackIdentifier(PLAINTIFF, 1);

    expect(latest.ok).toBe(true);
    expect(templateNextIndex(PLAINTIFF)).toBe(1);
  });

  it("does not roll back when the write fails", async () => {
    await allocateIdentifier(PLAINTIFF);
    failWrites();

    const result = await rollbackIdentifier(PLAINTIFF, 0);

    expect(result.ok).toBe(false);

    vi.restoreAllMocks();
    resetExhibitStampCacheForTests();
    expect(templateNextIndex(PLAINTIFF)).toBe(1);
  });

  it("sets the next identifier from typed text", async () => {
    expect(await setNextIdentifier(PLAINTIFF, "12")).toEqual({ ok: true, value: 11 });
    expect(templateNextIndex(PLAINTIFF)).toBe(11);
    expect(indexOf(await allocateIdentifier(PLAINTIFF))).toBe(11);
  });

  it("rejects typed text that is not an identifier", async () => {
    const result = await setNextIdentifier(PLAINTIFF, "12A");

    expect(result.ok).toBe(false);
    expect(templateNextIndex(PLAINTIFF)).toBe(0);
  });

  it("resets the counter to the first exhibit", async () => {
    await allocateIdentifier(PLAINTIFF);
    await allocateIdentifier(PLAINTIFF);

    expect((await resetCounter(PLAINTIFF)).ok).toBe(true);
    expect(templateNextIndex(PLAINTIFF)).toBe(0);
  });
});

describe("template maintenance", () => {
  it("adds a template and keeps its created timestamp on update", async () => {
    const seed = defaultExhibitStampTemplates()[0];

    if (!seed) {
      throw new Error("expected a starter template");
    }

    const created = await saveExhibitStampTemplate({
      ...seed,
      id: "custom",
      name: "Joint Exhibit",
      prefix: "Joint Exhibit",
      createdAt: 111,
      updatedAt: 111,
    });

    expect(created.ok).toBe(true);
    expect(listExhibitStampTemplates()).toHaveLength(4);

    const updated = await saveExhibitStampTemplate({
      ...seed,
      id: "custom",
      name: "Joint Exhibit",
      prefix: "Joint Ex.",
      createdAt: 999,
      updatedAt: 999,
    });

    expect(updated.ok && updated.value.createdAt).toBe(111);
    expect(updated.ok && updated.value.prefix).toBe("Joint Ex.");
    expect(listExhibitStampTemplates()).toHaveLength(4);
  });

  it("deletes a template and reports one that is already gone", async () => {
    expect((await deleteExhibitStampTemplate(PLAINTIFF)).ok).toBe(true);
    expect(listExhibitStampTemplates().map((template) => template.id)).not.toContain(PLAINTIFF);
    expect((await deleteExhibitStampTemplate(PLAINTIFF)).ok).toBe(false);
  });
});

function indexOf(result: Awaited<ReturnType<typeof allocateIdentifier>>): number | null {
  return result.ok ? result.value.sequence.index : null;
}

function templateNextIndex(templateId: string): number | null {
  resetExhibitStampCacheForTests();

  return listExhibitStampTemplates().find((template) => template.id === templateId)?.nextIndex ??
    null;
}

function parseStored(): ExhibitStampStoreV1 {
  const raw = window.localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    throw new Error("expected a stored exhibit stamp store");
  }

  return JSON.parse(raw) as ExhibitStampStoreV1;
}

function withNextIndex(
  store: ExhibitStampStoreV1,
  templateId: string,
  nextIndex: number,
  revision: number,
): ExhibitStampStoreV1 {
  return {
    ...store,
    revision,
    templates: store.templates.map((template) =>
      template.id === templateId ? { ...template, nextIndex } : template,
    ),
  };
}
