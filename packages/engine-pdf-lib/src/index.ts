import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
} from "pdf-lib";
import type {
  PdfOutlineItem,
  PdfOutlineItemStyle,
  PdfOutlineOpenMode,
  PdfOutlineState,
  PdfOutlineTarget,
} from "@raiopdf/engine-api";

/**
 * The PDF/A conformance claim carried in a document's XMP metadata (e.g. part "2",
 * conformance "B" for PDF/A-2b).
 *
 * Florida's ePortal runs an informational PDF/A conformity check that fails when a
 * file's identification metadata has been scrubbed (its own FAQ: the "pdfcreator"
 * tag "is required to pass the CONFORMITY test"). More fundamentally, PDF/A
 * conformance itself requires an XMP packet with a pdfaid identification — deleting
 * every metadata stream un-PDF/As the file. So the metadata scrub preserves this
 * identification (and nothing else) by default when the input document claims it.
 */
export type PdfAIdentification = {
  part: string;
  conformance: string | null;
};

export type ScrubPdfMetadataOptions = {
  /**
   * Keep a minimal PDF/A identification (pdfaid part/conformance + a RaioPDF
   * creator-tool tag) so the scrub does not silently un-PDF/A the file. All
   * descriptive metadata (author, title, history, custom fields) is still removed.
   *
   * - true (default): capture the identification from the document being scrubbed.
   * - a PdfAIdentification: restore this identification (captured earlier, e.g. from
   *   input bytes before an engine pass that strips XMP) in the same load/save cycle.
   * - false: maximal scrub that also drops the conformance claim — e.g. after an
   *   edit that invalidates conformance anyway.
   */
  preservePdfAIdentification?: boolean | PdfAIdentification;
};

type RawOutlineTarget = {
  dest?: PDFObject | undefined;
  action?: PDFObject | undefined;
  namedDestination?: PDFObject | undefined;
  sameDocument?: boolean | undefined;
};

type OutlineReadContext = {
  pageIndexesByRef: ReadonlyMap<string, number>;
  namedDestinations: ReadonlyMap<string, PDFObject>;
  rawTargetsById: Map<string, RawOutlineTarget>;
};

export type PdfOutlinePageMapper = (pageIndex: number) => number | null;

export type PdfOutlineMapResult = {
  items: readonly PdfOutlineItem[];
  removedTargets: number;
};

export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  return pdf.getPageCount();
}

export function readPdfAIdentification(pdf: PDFDocument): PdfAIdentification | null {
  const xmp = readCatalogXmp(pdf);

  if (!xmp) {
    return null;
  }

  const part = matchXmpValue(xmp, "part", /\d+/);

  if (!part) {
    return null;
  }

  return {
    part,
    conformance: matchXmpValue(xmp, "conformance", /[A-Za-z]/),
  };
}

export function readPdfOutline(pdf: PDFDocument): PdfOutlineState {
  const rawTargetsById = new Map<string, RawOutlineTarget>();
  const context: OutlineReadContext = {
    pageIndexesByRef: buildPageIndexesByRef(pdf),
    namedDestinations: readNamedDestinations(pdf),
    rawTargetsById,
  };
  const root = pdf.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  const openMode = readOutlineOpenMode(pdf);
  const items = root ? readOutlineSiblings(pdf, root.get(PDFName.of("First")), [], context) : [];

  return {
    items,
    openMode,
    revision: outlineRevision(items, openMode),
  };
}

export function writePdfOutlineInPlace(
  pdf: PDFDocument,
  outline: PdfOutlineState,
  options: {
    preserveSource?: PDFDocument | undefined;
    preserveSources?: readonly { pdf: PDFDocument; idPrefix?: string | undefined }[] | undefined;
  } = {},
): void {
  const preserveSources = options.preserveSources
    ?? [{ pdf: options.preserveSource ?? pdf, idPrefix: "" }];
  const rawTargetsById = new Map<string, RawOutlineTarget>();
  for (const source of preserveSources) {
    for (const [id, target] of collectRawOutlineTargets(source.pdf)) {
      rawTargetsById.set(`${source.idPrefix ?? ""}${id}`, {
        ...target,
        sameDocument: source.pdf === pdf,
      });
    }
  }
  const normalizedItems = normalizeWritableOutlineItems(outline.items);

  pdf.catalog.delete(PDFName.of("Outlines"));
  if (normalizedItems.length === 0) {
    if (readOutlineOpenMode(pdf) === "outlines") {
      pdf.catalog.delete(PDFName.of("PageMode"));
    }
    return;
  }

  writeNamedDestinationsInPlace(
    pdf,
    collectNamedDestinationEntries(pdf, normalizedItems, rawTargetsById),
  );

  const context = pdf.context;
  const rootRef = context.nextRef();
  const itemRefs = new Map<string, PDFRef>();
  collectOutlineItems(normalizedItems).forEach((item) => {
    itemRefs.set(item.id, context.nextRef());
  });

  assignOutlineSiblings({
    pdf,
    parentRef: rootRef,
    items: normalizedItems,
    itemRefs,
    rawTargetsById,
  });

  context.assign(
    rootRef,
    context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRefs.get(normalizedItems[0]!.id)!,
      Last: itemRefs.get(normalizedItems[normalizedItems.length - 1]!.id)!,
      Count: visibleOutlineCount(normalizedItems),
    }),
  );

  pdf.catalog.set(PDFName.of("Outlines"), rootRef);
  if (outline.openMode === "outlines") {
    pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  } else if (readOutlineOpenMode(pdf) === "outlines") {
    pdf.catalog.delete(PDFName.of("PageMode"));
  }
}

export function mapPdfOutlineItems(
  items: readonly PdfOutlineItem[],
  mapPageIndex: PdfOutlinePageMapper,
): PdfOutlineMapResult {
  let removedTargets = 0;

  function mapItem(item: PdfOutlineItem): readonly PdfOutlineItem[] {
    const childResult = mapPdfOutlineItems(item.children ?? [], mapPageIndex);
    removedTargets += childResult.removedTargets;
    const mappedTarget = mapOutlineTarget(item.target, mapPageIndex);

    if (!mappedTarget) {
      removedTargets += 1;
      return childResult.items;
    }

    return [{
      ...item,
      target: mappedTarget,
      ...(childResult.items.length > 0 ? { children: childResult.items } : { children: undefined }),
    }];
  }

  return {
    items: items.flatMap((item) => [...mapItem(item)]),
    removedTargets,
  };
}

export function offsetPdfOutlineItems(
  items: readonly PdfOutlineItem[],
  offset: number,
): PdfOutlineMapResult {
  return mapPdfOutlineItems(items, (pageIndex) => pageIndex + offset);
}

export function createPdfOutlinePageItem(options: {
  id: string;
  title: string;
  pageIndex: number;
  expanded?: boolean | undefined;
  children?: readonly PdfOutlineItem[] | undefined;
}): PdfOutlineItem {
  return {
    id: options.id,
    title: options.title,
    target: { kind: "page", pageIndex: options.pageIndex },
    expanded: options.expanded,
    ...(options.children && options.children.length > 0 ? { children: options.children } : {}),
  };
}

export function prefixPdfOutlineItemIds(
  items: readonly PdfOutlineItem[],
  prefix: string,
): readonly PdfOutlineItem[] {
  return items.map((item) => ({
    ...item,
    id: `${prefix}${item.id}`,
    target: prefixOutlineTarget(item.target, prefix),
    ...(item.children ? { children: prefixPdfOutlineItemIds(item.children, prefix) } : {}),
  }));
}

export async function readPdfAIdentificationFromBytes(
  bytes: Uint8Array,
): Promise<PdfAIdentification | null> {
  // Cheap pre-filter before a full parse: PDF/A requires the XMP metadata stream to
  // be uncompressed, so a conformant file necessarily contains the literal "pdfaid"
  // namespace prefix. Most documents are not PDF/A and skip the parse entirely.
  if (!bytesContainAscii(bytes, "pdfaid")) {
    return null;
  }

  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  return readPdfAIdentification(pdf);
}

export function writePdfAIdentificationInPlace(
  pdf: PDFDocument,
  identification: PdfAIdentification,
): void {
  const xmp = buildMinimalPdfAXmp(identification);
  // PDF/A requires the metadata stream to be uncompressed; context.stream creates a
  // raw (unfiltered) stream.
  const stream = pdf.context.stream(xmp, {
    Type: "Metadata",
    Subtype: "XML",
  });

  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
}

export async function writePdfAIdentificationToBytes(
  bytes: Uint8Array,
  identification: PdfAIdentification,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  writePdfAIdentificationInPlace(pdf, identification);

  return new Uint8Array(await pdf.save());
}

export function scrubPdfMetadataInPlace(
  pdf: PDFDocument,
  options: ScrubPdfMetadataOptions = {},
): void {
  const preserve = options.preservePdfAIdentification ?? true;
  const identification = preserve === false
    ? null
    : preserve === true
      ? readPdfAIdentification(pdf)
      : preserve;

  const infoRef = pdf.context.trailerInfo.Info;
  if (isPdfRef(infoRef)) {
    pdf.context.delete(infoRef);
  }
  delete pdf.context.trailerInfo.Info;

  const metadataName = PDFName.of("Metadata");
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }

    const metadataRef = object.get(metadataName);
    if (isPdfRef(metadataRef)) {
      pdf.context.delete(metadataRef);
    }

    if (object.has(metadataName)) {
      object.delete(metadataName);
      pdf.context.assign(ref, object);
    }
  }

  if (identification) {
    writePdfAIdentificationInPlace(pdf, identification);
  }
}

export async function scrubPdfMetadataBytes(
  bytes: Uint8Array,
  options: ScrubPdfMetadataOptions = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  scrubPdfMetadataInPlace(pdf, options);

  return new Uint8Array(await pdf.save());
}

/**
 * What a PDF/A conversion would destroy in a document.
 *
 * PDF/A prohibits interactive form fields, most annotations, and encryption, so the
 * converter strips them to reach conformance — silently, because from its point of
 * view removing a prohibited feature IS success. Each count here is a feature the
 * user may be relying on that the conversion would remove or invalidate:
 *
 * - pendingRedactionAnnotations — Acrobat-style "marked for redaction" /Redact
 *   annotations that have NOT been applied. Stripping these silently discards the
 *   user's redaction to-do list and files the content un-redacted.
 * - overlayAnnotations — visible markup (squares, highlights, ink, free text...). A
 *   black box drawn over text is a common bad redaction; dropping it visibly reveals
 *   the text underneath.
 * - formFields — interactive AcroForm fields; conversion flattens or removes them.
 * - signedSignatureFields — digital signatures; any rewrite of the bytes invalidates
 *   them even if the field survives.
 */
export interface PdfAConversionImpact {
  pendingRedactionAnnotations: number;
  overlayAnnotations: number;
  formFields: number;
  signedSignatureFields: number;
}

export function hasPdfAConversionImpact(impact: PdfAConversionImpact): boolean {
  return Object.values(impact).some((count) => count > 0);
}

/** Annotation subtypes that neither carry user content nor survive-or-die visibly. */
const IGNORED_ANNOTATION_SUBTYPES = new Set(["Link", "Popup", "Widget"]);

export function assessPdfAConversionImpact(pdf: PDFDocument): PdfAConversionImpact {
  let pendingRedactionAnnotations = 0;
  let overlayAnnotations = 0;

  for (const page of pdf.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);

    if (!annotations) {
      continue;
    }

    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      const subtype = annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();

      if (!subtype || IGNORED_ANNOTATION_SUBTYPES.has(subtype)) {
        continue;
      }

      if (subtype === "Redact") {
        pendingRedactionAnnotations += 1;
      } else {
        overlayAnnotations += 1;
      }
    }
  }

  let formFields = 0;
  let signedSignatureFields = 0;

  try {
    for (const field of pdf.getForm().getFields()) {
      formFields += 1;

      if (field instanceof PDFSignature && field.acroField.dict.has(PDFName.of("V"))) {
        signedSignatureFields += 1;
      }
    }
  } catch {
    // A malformed AcroForm fails the form count, not the whole assessment.
  }

  return {
    pendingRedactionAnnotations,
    overlayAnnotations,
    formFields,
    signedSignatureFields,
  };
}

export async function assessPdfAConversionImpactFromBytes(
  bytes: Uint8Array,
): Promise<PdfAConversionImpact> {
  const pdf = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });

  return assessPdfAConversionImpact(pdf);
}

function readOutlineOpenMode(pdf: PDFDocument): PdfOutlineOpenMode {
  const pageMode = pdf.catalog.lookupMaybe(PDFName.of("PageMode"), PDFName)?.decodeText();

  return pageMode === "UseOutlines" ? "outlines" : "default";
}

function buildPageIndexesByRef(pdf: PDFDocument): ReadonlyMap<string, number> {
  const map = new Map<string, number>();

  pdf.getPages().forEach((page, index) => {
    map.set(refKey(page.ref), index);
  });

  return map;
}

function readOutlineSiblings(
  pdf: PDFDocument,
  first: PDFObject | undefined,
  path: readonly number[],
  context: OutlineReadContext,
): PdfOutlineItem[] {
  const items: PdfOutlineItem[] = [];
  const seen = new Set<string>();
  let current = first;
  let siblingIndex = 0;

  while (current) {
    const resolved = resolvePdfObject(pdf, current);
    const dict = resolved.object instanceof PDFDict ? resolved.object : undefined;
    if (!dict) {
      break;
    }

    const identity = resolved.ref ? refKey(resolved.ref) : `path:${[...path, siblingIndex].join(".")}`;
    if (seen.has(identity)) {
      break;
    }
    seen.add(identity);

    const itemPath = [...path, siblingIndex];
    const id = resolved.ref
      ? `ref:${resolved.ref.objectNumber}:${resolved.ref.generationNumber}`
      : `path:${itemPath.join(".")}`;
    const title = readPdfText(dict.get(PDFName.of("Title"))) ?? "Untitled bookmark";
    const target = readOutlineTarget(pdf, dict, id, context);
    const children = readOutlineSiblings(pdf, dict.get(PDFName.of("First")), itemPath, context);
    const count = dict.lookupMaybe(PDFName.of("Count"), PDFNumber)?.asNumber();
    const style = readOutlineStyle(dict);
    const item: PdfOutlineItem = {
      id,
      title,
      target,
      ...(children.length > 0 ? { children } : {}),
      ...(count !== undefined ? { expanded: count >= 0 } : {}),
      ...(style ? { style } : {}),
    };

    items.push(item);
    current = dict.get(PDFName.of("Next"));
    siblingIndex += 1;
  }

  return items;
}

function readOutlineTarget(
  pdf: PDFDocument,
  dict: PDFDict,
  id: string,
  context: OutlineReadContext,
): PdfOutlineTarget {
  const dest = dict.get(PDFName.of("Dest"));
  if (dest) {
    context.rawTargetsById.set(id, { dest: resolvePdfObject(pdf, dest).object ?? dest });
    return readDestinationTarget(pdf, dest, id, context);
  }

  const action = dict.get(PDFName.of("A"));
  const actionDict = resolvePdfObject(pdf, action).object;
  if (action) {
    context.rawTargetsById.set(id, { action: actionDict ?? action });
  }
  if (actionDict instanceof PDFDict) {
    const actionKind = actionDict.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();

    if (actionKind === "GoTo") {
      const actionDest = actionDict.get(PDFName.of("D"));
      if (actionDest) {
        return readDestinationTarget(pdf, actionDest, id, context);
      }
    }

    if (actionKind === "URI") {
      const uri = readPdfText(actionDict.get(PDFName.of("URI")));
      return uri ? { kind: "uri", uri, preserveId: id } : {
        kind: "unsupported",
        reason: "URI action without a readable URI.",
        preserveId: id,
      };
    }

    if (actionKind === "GoToR" || actionKind === "Launch") {
      return { kind: "remote", preserveId: id };
    }

    return {
      kind: "unsupported",
      reason: actionKind ? `Unsupported outline action: ${actionKind}.` : "Unsupported outline action.",
      preserveId: id,
    };
  }

  if (!action) {
    context.rawTargetsById.set(id, {});
  }
  return {
    kind: "unsupported",
    reason: "Bookmark has no internal page destination.",
    preserveId: id,
  };
}

function readDestinationTarget(
  pdf: PDFDocument,
  dest: PDFObject,
  id: string,
  context: OutlineReadContext,
): PdfOutlineTarget {
  const resolved = resolvePdfObject(pdf, dest).object;
  const name = readDestinationName(resolved);
  if (name) {
    const namedDestination = context.namedDestinations.get(name);
    const resolvedPageIndex = namedDestination
      ? resolveDestinationPageIndex(pdf, resolvePdfObject(pdf, namedDestination).object, context)
      : null;
    if (namedDestination) {
      context.rawTargetsById.set(id, {
        ...(context.rawTargetsById.get(id) ?? {}),
        namedDestination: resolvePdfObject(pdf, namedDestination).object ?? namedDestination,
      });
    }

    return {
      kind: "named",
      name,
      ...(resolvedPageIndex !== null ? { resolvedPageIndex } : {}),
      preserveId: id,
    };
  }

  const pageIndex = resolveDestinationPageIndex(pdf, resolved, context);

  if (pageIndex !== null) {
    return { kind: "page", pageIndex, preserveId: id };
  }

  return {
    kind: "unsupported",
    reason: "Bookmark destination could not be resolved to a page.",
    preserveId: id,
  };
}

function resolveDestinationPageIndex(
  pdf: PDFDocument,
  dest: PDFObject | undefined,
  context: OutlineReadContext,
): number | null {
  if (!dest) {
    return null;
  }

  if (dest instanceof PDFArray) {
    const page = dest.get(0);
    const pageRef = page instanceof PDFRef ? page : undefined;
    if (pageRef) {
      return context.pageIndexesByRef.get(refKey(pageRef)) ?? null;
    }

    const pageDict = resolvePdfObject(pdf, page).object;
    const ref = pageDict ? pdf.context.getObjectRef(pageDict) : undefined;
    return ref ? context.pageIndexesByRef.get(refKey(ref)) ?? null : null;
  }

  const name = readDestinationName(dest);
  if (name) {
    const namedDestination = context.namedDestinations.get(name);
    return namedDestination
      ? resolveDestinationPageIndex(pdf, resolvePdfObject(pdf, namedDestination).object, context)
      : null;
  }

  if (dest instanceof PDFDict) {
    return resolveDestinationPageIndex(pdf, dest.get(PDFName.of("D")), context);
  }

  return null;
}

function readDestinationName(dest: PDFObject | undefined): string | null {
  if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) {
    return dest.decodeText();
  }

  return null;
}

function readNamedDestinations(pdf: PDFDocument): ReadonlyMap<string, PDFObject> {
  const destinations = new Map<string, PDFObject>();
  const namesRoot = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const destsRoot = namesRoot?.lookupMaybe(PDFName.of("Dests"), PDFDict);
  collectNameTreeDestinations(pdf, destsRoot, destinations);

  const legacyDests = pdf.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (legacyDests) {
    for (const [key, value] of legacyDests.entries()) {
      const name = key.decodeText();
      const resolved = resolvePdfObject(pdf, value).object;
      if (resolved) {
        destinations.set(name, resolved);
      }
    }
  }

  return destinations;
}

function collectNameTreeDestinations(
  pdf: PDFDocument,
  node: PDFDict | undefined,
  output: Map<string, PDFObject>,
): void {
  if (!node) {
    return;
  }

  const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) {
    for (let index = 0; index + 1 < names.size(); index += 2) {
      const name = readPdfText(names.get(index));
      const destination = names.get(index + 1);
      if (name && destination) {
        output.set(name, resolvePdfObject(pdf, destination).object ?? destination);
      }
    }
  }

  const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
  if (kids) {
    for (let index = 0; index < kids.size(); index += 1) {
      const kid = resolvePdfObject(pdf, kids.get(index)).object;
      if (kid instanceof PDFDict) {
        collectNameTreeDestinations(pdf, kid, output);
      }
    }
  }
}

function readPdfText(value: PDFObject | undefined): string | null {
  const resolved = value instanceof PDFRef ? undefined : value;
  if (resolved instanceof PDFString || resolved instanceof PDFHexString || resolved instanceof PDFName) {
    return resolved.decodeText();
  }

  return null;
}

function readOutlineStyle(dict: PDFDict): PdfOutlineItemStyle | null {
  const flags = dict.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber();
  if (flags === undefined) {
    return null;
  }

  return {
    ...(flags & 1 ? { italic: true } : {}),
    ...(flags & 2 ? { bold: true } : {}),
  };
}

function collectRawOutlineTargets(pdf: PDFDocument): ReadonlyMap<string, RawOutlineTarget> {
  const context: OutlineReadContext = {
    pageIndexesByRef: buildPageIndexesByRef(pdf),
    namedDestinations: readNamedDestinations(pdf),
    rawTargetsById: new Map<string, RawOutlineTarget>(),
  };
  const root = pdf.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  if (root) {
    readOutlineSiblings(pdf, root.get(PDFName.of("First")), [], context);
  }

  return context.rawTargetsById;
}

function normalizeWritableOutlineItems(items: readonly PdfOutlineItem[]): readonly PdfOutlineItem[] {
  const seen = new Set<string>();

  function visit(item: PdfOutlineItem): PdfOutlineItem {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate bookmark id "${item.id}".`);
    }
    seen.add(item.id);

    const title = item.title.trim();
    if (!title) {
      throw new Error("Bookmark titles must not be empty.");
    }

    const children = (item.children ?? []).map(visit);
    return {
      ...item,
      title,
      ...(children.length > 0 ? { children } : { children: undefined }),
    };
  }

  return items.map(visit);
}

function assignOutlineSiblings(options: {
  pdf: PDFDocument;
  parentRef: PDFRef;
  items: readonly PdfOutlineItem[];
  itemRefs: ReadonlyMap<string, PDFRef>;
  rawTargetsById: ReadonlyMap<string, RawOutlineTarget>;
}): void {
  const { pdf, parentRef, items, itemRefs, rawTargetsById } = options;

  items.forEach((item, index) => {
    const ref = itemRefs.get(item.id);
    if (!ref) {
      throw new Error(`Missing bookmark ref for "${item.title}".`);
    }

    const children = item.children ?? [];
    if (children.length > 0) {
      assignOutlineSiblings({
        pdf,
        parentRef: ref,
        items: children,
        itemRefs,
        rawTargetsById,
      });
    }

    const dict = pdf.context.obj({
      Title: PDFHexString.fromText(item.title),
      Parent: parentRef,
      ...(index > 0 ? { Prev: itemRefs.get(items[index - 1]!.id)! } : {}),
      ...(index < items.length - 1 ? { Next: itemRefs.get(items[index + 1]!.id)! } : {}),
      ...(children.length > 0 ? { First: itemRefs.get(children[0]!.id)! } : {}),
      ...(children.length > 0 ? { Last: itemRefs.get(children[children.length - 1]!.id)! } : {}),
      ...(children.length > 0 ? { Count: outlineItemCount(item) } : {}),
      ...(styleFlags(item.style) > 0 ? { F: styleFlags(item.style) } : {}),
    });

    writeOutlineTarget(pdf, dict, item, rawTargetsById);
    pdf.context.assign(ref, dict);
  });
}

function writeOutlineTarget(
  pdf: PDFDocument,
  dict: PDFDict,
  item: PdfOutlineItem,
  rawTargetsById: ReadonlyMap<string, RawOutlineTarget>,
): void {
  if (item.target.kind === "page") {
    assertPageIndex(item.target.pageIndex, pdf.getPageCount(), item.title);
    const rawTarget = item.target.preserveId ? rawTargetsById.get(item.target.preserveId) : undefined;
    const preserved = rawTarget ? remapPageOutlineTarget(pdf, rawTarget, item.target.pageIndex) : null;
    if (preserved?.dest) {
      dict.set(PDFName.of("Dest"), preserved.dest);
      return;
    }
    if (preserved?.action) {
      dict.set(PDFName.of("A"), preserved.action);
      return;
    }
    dict.set(PDFName.of("Dest"), pdf.context.obj([pdf.getPage(item.target.pageIndex).ref, PDFName.of("Fit")]));
    return;
  }

  if (item.target.kind === "named") {
    const rawTarget = rawTargetsById.get(item.target.preserveId);
    if (!rawTarget && item.target.resolvedPageIndex === undefined) {
      throw new Error(`Cannot safely preserve bookmark target for "${item.title}".`);
    }
    dict.set(PDFName.of("Dest"), PDFString.of(item.target.name));
    return;
  }

  if (item.target.kind === "uri") {
    dict.set(PDFName.of("A"), pdf.context.obj({
      S: PDFName.of("URI"),
      URI: PDFString.of(item.target.uri),
    }));
    return;
  }

  const rawTarget = rawTargetsById.get(item.target.preserveId);
  if (!rawTarget) {
    throw new Error(`Cannot safely preserve bookmark target for "${item.title}".`);
  }

  if (rawTarget.dest) {
    const dest = cloneRawOutlineObjectForContext(pdf, rawTarget.dest, rawTarget.sameDocument === true);
    if (!dest) {
      throw new Error(`Cannot safely preserve bookmark target for "${item.title}".`);
    }
    dict.set(PDFName.of("Dest"), dest);
    return;
  }

  if (rawTarget.action) {
    const action = cloneRawOutlineObjectForContext(pdf, rawTarget.action, rawTarget.sameDocument === true);
    if (!action) {
      throw new Error(`Cannot safely preserve bookmark target for "${item.title}".`);
    }
    dict.set(PDFName.of("A"), action);
    return;
  }

  return;
}

function remapPageOutlineTarget(
  pdf: PDFDocument,
  rawTarget: RawOutlineTarget,
  pageIndex: number,
): { dest?: PDFObject | undefined; action?: PDFObject | undefined } | null {
  if (rawTarget.dest) {
    const dest = remapPageDestination(pdf, rawTarget.dest, pageIndex, rawTarget.sameDocument === true);
    return dest ? { dest } : null;
  }

  if (rawTarget.action) {
    const action = remapGoToAction(pdf, rawTarget.action, pageIndex, rawTarget.sameDocument === true);
    return action ? { action } : null;
  }

  return null;
}

function remapPageDestination(
  pdf: PDFDocument,
  dest: PDFObject,
  pageIndex: number,
  sameDocument: boolean,
): PDFObject | null {
  const resolved = resolvePdfObject(pdf, dest).object;
  if (resolved instanceof PDFDict) {
    const destination = resolved.get(PDFName.of("D"));
    const remappedDestination = destination
      ? remapPageDestination(pdf, destination, pageIndex, sameDocument)
      : null;
    if (!remappedDestination) {
      return null;
    }

    const destinationName = PDFName.of("D");
    const copy = pdf.context.obj({}) as PDFDict;
    for (const [key, value] of resolved.entries()) {
      if (key === destinationName || key.decodeText() === "D") {
        copy.set(key, remappedDestination);
        continue;
      }

      const cloned = cloneRawOutlineObjectForContext(pdf, value, sameDocument);
      if (!cloned) {
        return null;
      }
      copy.set(key, cloned);
    }
    return copy;
  }

  if (!(resolved instanceof PDFArray)) {
    return null;
  }

  const values: PDFObject[] = [pdf.getPage(pageIndex).ref];
  for (let index = 1; index < resolved.size(); index += 1) {
    const cloned = cloneRawOutlineObjectForContext(pdf, resolved.get(index), sameDocument);
    if (!cloned) {
      return null;
    }
    values.push(cloned);
  }

  return pdf.context.obj(values);
}

function remapGoToAction(
  pdf: PDFDocument,
  action: PDFObject,
  pageIndex: number,
  sameDocument: boolean,
): PDFObject | null {
  const resolved = resolvePdfObject(pdf, action).object;
  if (!(resolved instanceof PDFDict)) {
    return null;
  }

  const actionKind = resolved.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();
  if (actionKind !== "GoTo") {
    return null;
  }

  const destination = resolved.get(PDFName.of("D"));
  if (!destination) {
    return null;
  }

  const remappedDestination = remapPageDestination(pdf, destination, pageIndex, sameDocument);
  if (!remappedDestination) {
    return null;
  }

  const destinationName = PDFName.of("D");
  const copy = pdf.context.obj({}) as PDFDict;
  for (const [key, value] of resolved.entries()) {
    if (key === destinationName || key.decodeText() === "D") {
      copy.set(key, remappedDestination);
      continue;
    }

    const cloned = cloneRawOutlineObjectForContext(pdf, value, sameDocument);
    if (!cloned) {
      return null;
    }
    copy.set(key, cloned);
  }

  return copy;
}

function cloneRawOutlineObjectForContext(
  pdf: PDFDocument,
  object: PDFObject,
  sameDocument: boolean,
): PDFObject | null {
  if (!sameDocument && pdfObjectContainsRef(object)) {
    return null;
  }

  return clonePdfObjectForContext(pdf, object);
}

function clonePdfObjectForContext(pdf: PDFDocument, object: PDFObject): PDFObject {
  return object.clone(pdf.context);
}

function pdfObjectContainsRef(object: PDFObject, seen = new Set<PDFObject>()): boolean {
  if (object instanceof PDFRef) {
    return true;
  }

  if (seen.has(object)) {
    return false;
  }
  seen.add(object);

  if (object instanceof PDFArray) {
    for (let index = 0; index < object.size(); index += 1) {
      if (pdfObjectContainsRef(object.get(index), seen)) {
        return true;
      }
    }
  }

  if (object instanceof PDFDict) {
    for (const [, value] of object.entries()) {
      if (pdfObjectContainsRef(value, seen)) {
        return true;
      }
    }
  }

  return false;
}

function mapOutlineTarget(
  target: PdfOutlineTarget,
  mapPageIndex: PdfOutlinePageMapper,
): PdfOutlineTarget | null {
  if (target.kind === "page") {
    const mappedPageIndex = mapPageIndex(target.pageIndex);
    return mappedPageIndex === null ? null : { ...target, pageIndex: mappedPageIndex };
  }

  if (target.kind === "named" && target.resolvedPageIndex !== undefined) {
    const mappedPageIndex = mapPageIndex(target.resolvedPageIndex);
    return mappedPageIndex === null ? null : { ...target, resolvedPageIndex: mappedPageIndex };
  }

  return target.kind === "uri" ? target : null;
}

function prefixOutlineTarget(target: PdfOutlineTarget, prefix: string): PdfOutlineTarget {
  switch (target.kind) {
    case "page":
      return target.preserveId ? { ...target, preserveId: `${prefix}${target.preserveId}` } : target;
    case "named":
      return { ...target, name: `${prefix}${target.name}`, preserveId: `${prefix}${target.preserveId}` };
    case "uri":
      return { ...target, preserveId: `${prefix}${target.preserveId}` };
    case "remote":
      return { ...target, preserveId: `${prefix}${target.preserveId}` };
    case "unsupported":
      return { ...target, preserveId: `${prefix}${target.preserveId}` };
  }
}

function collectNamedDestinationEntries(
  pdf: PDFDocument,
  items: readonly PdfOutlineItem[],
  rawTargetsById: ReadonlyMap<string, RawOutlineTarget>,
): ReadonlyMap<string, PDFObject> {
  const destinations = new Map<string, PDFObject>();

  for (const item of collectOutlineItems(items)) {
    if (item.target.kind !== "named" || item.target.resolvedPageIndex === undefined) {
      continue;
    }

    assertPageIndex(item.target.resolvedPageIndex, pdf.getPageCount(), item.title);
    const rawTarget = rawTargetsById.get(item.target.preserveId);
    const destination = rawTarget?.namedDestination
      ? remapPageDestination(
          pdf,
          rawTarget.namedDestination,
          item.target.resolvedPageIndex,
          rawTarget.sameDocument === true,
        )
      : pdf.context.obj([pdf.getPage(item.target.resolvedPageIndex).ref, PDFName.of("Fit")]);

    if (destination) {
      destinations.set(item.target.name, destination);
    }
  }

  return destinations;
}

function writeNamedDestinationsInPlace(
  pdf: PDFDocument,
  destinations: ReadonlyMap<string, PDFObject>,
): void {
  if (destinations.size === 0) {
    return;
  }

  const merged = new Map(readNamedDestinations(pdf));
  for (const [name, destination] of destinations) {
    merged.set(name, destination);
  }

  const entries: PDFObject[] = [];
  for (const [name, destination] of [...merged.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    entries.push(PDFHexString.fromText(name), destination);
  }

  const namesRoot = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict) ?? pdf.context.obj({});
  namesRoot.set(PDFName.of("Dests"), pdf.context.obj({
    Names: entries,
  }));
  pdf.catalog.set(PDFName.of("Names"), namesRoot);
}

function collectOutlineItems(items: readonly PdfOutlineItem[]): PdfOutlineItem[] {
  return items.flatMap((item) => [item, ...collectOutlineItems(item.children ?? [])]);
}

function visibleOutlineCount(items: readonly PdfOutlineItem[]): number {
  return items.reduce((count, item) => {
    const children = item.children ?? [];
    return count + 1 + (item.expanded === false ? 0 : visibleOutlineCount(children));
  }, 0);
}

function totalOutlineCount(items: readonly PdfOutlineItem[]): number {
  return items.reduce((count, item) => count + 1 + totalOutlineCount(item.children ?? []), 0);
}

function outlineItemCount(item: PdfOutlineItem): number {
  const children = item.children ?? [];
  const count = visibleOutlineCount(children);

  return item.expanded === false ? -count : count;
}

function styleFlags(style: PdfOutlineItemStyle | undefined): number {
  return (style?.italic ? 1 : 0) | (style?.bold ? 2 : 0);
}

function outlineRevision(items: readonly PdfOutlineItem[], openMode: PdfOutlineOpenMode): string {
  return `${openMode}:${items.length}:${totalOutlineCount(items)}`;
}

function assertPageIndex(pageIndex: number, pageCount: number, title: string): void {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
    throw new Error(`Bookmark "${title}" points outside the document.`);
  }
}

function resolvePdfObject(
  pdf: PDFDocument,
  object: PDFObject | undefined,
): { object: PDFObject | undefined; ref: PDFRef | undefined } {
  if (object instanceof PDFRef) {
    return { object: pdf.context.lookup(object), ref: object };
  }

  return { object, ref: undefined };
}

function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

function bytesContainAscii(bytes: Uint8Array, text: string): boolean {
  const first = text.charCodeAt(0);
  const limit = bytes.length - text.length;

  outer: for (let index = 0; index <= limit; index += 1) {
    if (bytes[index] !== first) {
      continue;
    }

    for (let offset = 1; offset < text.length; offset += 1) {
      if (bytes[index + offset] !== text.charCodeAt(offset)) {
        continue outer;
      }
    }

    return true;
  }

  return false;
}

function readCatalogXmp(pdf: PDFDocument): string | null {
  try {
    const stream = pdf.catalog.lookupMaybe(PDFName.of("Metadata"), PDFStream);

    if (!(stream instanceof PDFRawStream)) {
      return null;
    }

    const contents = stream.dict.has(PDFName.of("Filter"))
      ? decodePDFRawStream(stream).decode()
      : stream.contents;

    return new TextDecoder("utf-8", { fatal: false }).decode(contents);
  } catch {
    return null;
  }
}

function matchXmpValue(xmp: string, tag: string, valuePattern: RegExp): string | null {
  // XMP serializes properties as elements (<pdfaid:part>2</pdfaid:part>) or as
  // attributes (pdfaid:part="2"); accept both.
  const element = new RegExp(`<pdfaid:${tag}[^>]*>\\s*(${valuePattern.source})\\s*<`).exec(xmp);

  if (element?.[1]) {
    return element[1];
  }

  const attribute = new RegExp(`pdfaid:${tag}\\s*=\\s*"(${valuePattern.source})"`).exec(xmp);

  return attribute?.[1] ?? null;
}

function buildMinimalPdfAXmp(identification: PdfAIdentification): string {
  const conformance = identification.conformance
    ? `\n    <pdfaid:conformance>${identification.conformance}</pdfaid:conformance>`
    : "";

  return `<?xpacket begin="${"\uFEFF"}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>${identification.part}</pdfaid:part>${conformance}
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>RaioPDF</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>RaioPDF</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function isPdfRef(value: unknown): value is PDFRef {
  return (
    value instanceof PDFRef ||
    (
      typeof value === "object" &&
      value !== null &&
      "objectNumber" in value &&
      "generationNumber" in value
    )
  );
}
