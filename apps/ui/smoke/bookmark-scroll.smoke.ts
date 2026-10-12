import { expect, test, type Page } from "@playwright/test";
import { createPdfOutlinePageItem, writePdfOutlineInPlace } from "@raiopdf/engine-pdf-lib";
import { PDFDocument } from "pdf-lib";

test("bookmark wheel scrolling stays inside navigation across document and panel changes", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.goto("/");
  await openPdf(page, "long-bookmarks.pdf", await createLongBookmarkedPdf());
  await page.getByRole("tab", { name: "Bookmarks", exact: true }).click();

  const rail = page.locator(".bookmarks-rail");
  await expect(rail.getByText("Chapter 1", { exact: true })).toBeVisible();
  await expect(rail.locator(".bookmarks-rail__children")).toHaveCount(1);
  await expect.poll(async () => rail.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);

  // Expand/collapse changes the outline's content height without changing its
  // scroll owner. The real wheel below must still move the bookmark rail.
  await rail.getByRole("button", { name: "Collapse bookmark" }).first().click();
  await expect(rail.locator(".bookmarks-rail__children")).toHaveCount(0);
  await rail.getByRole("button", { name: "Expand bookmark" }).first().click();
  await expect(rail.locator(".bookmarks-rail__children")).toHaveCount(1);

  const viewer = page.locator(".page-list");
  await expect(viewer).toBeVisible();
  let stationary = await capturePageState(page);
  await wheelRail(page, 480);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStationaryChromeAndViewer(page, stationary);

  // Use physical wheel input at each edge and verify that the gesture does not
  // escape into the document root or the continuously scrolling PDF viewer.
  await wheelRail(page, 20_000);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop + element.clientHeight))
    .toBeGreaterThanOrEqual(await rail.evaluate((element) => element.scrollHeight));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    stationary = await capturePageState(page);
    await wheelRail(page, 700);
    await expectStationaryChromeAndViewer(page, stationary);
  }

  await wheelRail(page, -20_000);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBe(0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    stationary = await capturePageState(page);
    await wheelRail(page, -700);
    await expectStationaryChromeAndViewer(page, stationary);
  }

  // Confirm the rail remains a real scroll container after switching views,
  // resizing the app, and hiding/reopening navigation.
  await page.getByRole("tab", { name: "Pages", exact: true }).click();
  await page.getByRole("tab", { name: "Bookmarks", exact: true }).click();
  await expect.poll(() => rail.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await page.setViewportSize({ width: 900, height: 610 });
  await expect.poll(() => rail.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  stationary = await capturePageState(page);
  await wheelRail(page, 480);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStationaryChromeAndViewer(page, stationary);

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.getByRole("button", { name: "Show bookmarks" }).click();
  await expect(rail).toBeVisible();
  stationary = await capturePageState(page);
  await wheelRail(page, 480);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStationaryChromeAndViewer(page, stationary);

  // Adding a bookmark keeps the same rail bounded and scrollable.
  await rail.evaluate((element) => { element.scrollTop = 0; });
  await rail.getByRole("button", { name: "Add bookmark" }).click();
  await expect(rail.locator(":scope > .bookmarks-rail__tree > .bookmarks-rail__node"))
    .toHaveCount(101);
  await expect(page.locator(".page-list")).toBeVisible();
  await expect(page.locator('[data-testid="pdf-page-canvas"]').first()).toBeVisible();
  await expect.poll(() => rail.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);

  stationary = await capturePageState(page);
  await wheelRail(page, 480);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStationaryChromeAndViewer(page, stationary);

  // Switch to a different PDF tab, then back to the document with the imported
  // outline. Its rail must remain independently scrollable after restoration.
  await openPdf(page, "other-document.pdf", await createPdf(3));
  const otherDocumentTab = page.getByRole("tab", { name: "other-document.pdf", exact: true });
  await expect(otherDocumentTab).toHaveAttribute("aria-selected", "true");
  const longDocumentTab = page.getByRole("tab", { name: /long-bookmarks\.pdf$/ });
  await longDocumentTab.click();
  await expect(longDocumentTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".page-list")).toBeVisible();
  await expect(page.locator('[data-testid="pdf-page-canvas"]').first()).toBeVisible();
  await page.getByRole("tab", { name: "Bookmarks", exact: true }).click();
  await expect(rail.getByText("Chapter 1", { exact: true })).toBeVisible();
  await rail.evaluate((element) => { element.scrollTop = 0; });
  stationary = await capturePageState(page);
  await wheelRail(page, 480);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStationaryChromeAndViewer(page, stationary);
});

test("short empty bookmarks can be added without creating document scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.goto("/");
  await openPdf(page, "no-bookmarks.pdf", await createPdf(1));
  await page.getByRole("tab", { name: "Bookmarks", exact: true }).click();

  const rail = page.locator(".bookmarks-rail");
  await expect(rail.getByText("No bookmarks", { exact: true })).toBeVisible();
  await expect(rail).toHaveCSS("overscroll-behavior-y", "contain");
  await expect.poll(async () => rail.evaluate((element) => element.scrollHeight <= element.clientHeight))
    .toBe(true);

  const beforeWheel = await capturePageState(page);
  await wheelRail(page, 700);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBe(0);
  await expectStationaryChromeAndViewer(page, beforeWheel);

  const before = await capturePageState(page);
  await rail.getByRole("button", { name: "Add bookmark" }).click();
  await expect(rail.getByText("Bookmark 1", { exact: true })).toBeVisible();
  const after = await capturePageState(page);
  expect(after.rootScrollTop).toBe(before.rootScrollTop);
  expect(after.commandBar).toEqual(before.commandBar);
  expect(after.navigation).toEqual(before.navigation);
  expect(after.viewer).toEqual(before.viewer);
  expect(after.currentPage).toBe(before.currentPage);
});

async function openPdf(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.getByLabel("Open PDF file").setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByLabel("Go to page")).toHaveValue("1");
  await expect(page.locator(".page-list")).toBeVisible();
  await expect(page.locator('[data-testid="pdf-page-canvas"]').first()).toBeVisible();
}

async function createPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage([420, 540]);
  }
  return pdf.save();
}

async function createLongBookmarkedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 12; index += 1) {
    pdf.addPage([420, 540]);
  }

  const items = [
    createPdfOutlinePageItem({
      id: "chapter-1",
      title: "Chapter 1",
      pageIndex: 0,
      expanded: true,
      children: Array.from({ length: 8 }, (_, index) => createPdfOutlinePageItem({
        id: `chapter-1-section-${index + 1}`,
        title: `Chapter 1, section ${index + 1}`,
        pageIndex: index % 12,
      })),
    }),
    ...Array.from({ length: 99 }, (_, index) => createPdfOutlinePageItem({
      id: `bookmark-${index + 2}`,
      title: `Imported bookmark ${index + 2}`,
      pageIndex: index % 12,
    })),
  ];
  writePdfOutlineInPlace(pdf, { items, openMode: "default", revision: "bookmark-scroll-smoke" });
  return pdf.save();
}

async function wheelRail(page: Page, deltaY: number): Promise<void> {
  const rail = page.locator(".bookmarks-rail");
  const box = await rail.boundingBox();
  if (!box) throw new Error("Bookmark rail bounds unavailable.");
  const x = box.x + Math.min(30, box.width / 2);
  const y = box.y + Math.min(180, box.height / 2);
  const insideRail = await page.evaluate(([pointX, pointY]) => {
    return Boolean(document.elementFromPoint(pointX ?? 0, pointY ?? 0)?.closest(".bookmarks-rail"));
  }, [x, y]);
  expect(insideRail, "physical wheel input must land inside the bookmark rail").toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, deltaY);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function capturePageState(page: Page): Promise<{
  rootScrollTop: number;
  commandBar: number[];
  navigation: number[];
  viewer: number[];
  viewerScrollTop: number | null;
  currentPage: string | null;
}> {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}.`);
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height];
    };
    const pageList = document.querySelector(".page-list");
    const currentPage = document.querySelector<HTMLInputElement>('[aria-label="Go to page"]');
    return {
      rootScrollTop: document.scrollingElement?.scrollTop ?? 0,
      commandBar: rect(".command-bar"),
      navigation: rect(".document-nav-panel"),
      viewer: rect(".canvas-well"),
      viewerScrollTop: pageList instanceof HTMLElement ? pageList.scrollTop : null,
      currentPage: currentPage?.value ?? null,
    };
  });
}

async function expectStationaryChromeAndViewer(
  page: Page,
  before: Awaited<ReturnType<typeof capturePageState>>,
): Promise<void> {
  await expect.poll(() => capturePageState(page)).toEqual(before);
}
