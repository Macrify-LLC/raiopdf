import type { PdfEditPoint, PdfEditRect } from "@raiopdf/engine-api";
import {
  concatTransformationMatrix,
  closePath,
  degrees as pdfDegrees,
  drawEllipse as drawEllipseOperators,
  drawLine as drawLineOperators,
  drawObject,
  drawRectangle as drawRectangleOperators,
  drawSvgPath as drawSvgPathOperators,
  drawText as drawTextOperators,
  fill,
  LineCapStyle,
  lineTo,
  moveTo,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  type Color,
  type PDFContext,
  type PDFDocument,
  type PDFFont,
  type PDFOperator,
  type PDFPage,
} from "pdf-lib";

export type DrawColor = ReturnType<typeof rgb>;

export type DrawRectangleOptions = {
  rect: PdfEditRect;
  fillColor?: DrawColor | undefined;
  strokeColor?: DrawColor | undefined;
  strokeWidthPt?: number | undefined;
  fillAlpha?: number | undefined;
  strokeAlpha?: number | undefined;
};

export type DrawEllipseOptions = {
  rect: PdfEditRect;
  fillColor?: DrawColor | undefined;
  strokeColor?: DrawColor | undefined;
  strokeWidthPt?: number | undefined;
  fillAlpha?: number | undefined;
  strokeAlpha?: number | undefined;
};

export type DrawLineOptions = {
  from: PdfEditPoint;
  to: PdfEditPoint;
  strokeColor: DrawColor;
  strokeWidthPt: number;
  strokeAlpha?: number | undefined;
  lineCap?: LineCapStyle | undefined;
};

export type DrawTextOptions = {
  text: string;
  at: PdfEditPoint;
  font: PDFFont;
  fontSizePt: number;
  color: DrawColor;
  fillAlpha?: number | undefined;
  rotateDegrees?: number | undefined;
};

export type DrawSvgPathOptions = {
  path: string;
  fillColor?: DrawColor | undefined;
  strokeColor?: DrawColor | undefined;
  strokeWidthPt?: number | undefined;
  fillAlpha?: number | undefined;
  strokeAlpha?: number | undefined;
};

export type DrawFilledPolygonOptions = {
  points: readonly PdfEditPoint[];
  fillColor: DrawColor;
};

export interface DrawTarget {
  mapPoint(point: PdfEditPoint): PdfEditPoint;
  drawRectangle(options: DrawRectangleOptions): void;
  drawEllipse(options: DrawEllipseOptions): void;
  drawLine(options: DrawLineOptions): void;
  drawPolyline(points: readonly PdfEditPoint[], options: Omit<DrawLineOptions, "from" | "to">): void;
  drawFilledPolygon(options: DrawFilledPolygonOptions): void;
  drawText(options: DrawTextOptions): void;
  drawSvgPath(options: DrawSvgPathOptions): void;
}

export type AnnotationAppearanceTarget = DrawTarget & {
  readonly annotationRect: PdfEditRect;
  readonly bbox: PdfEditRect;
  readonly matrix: readonly [number, number, number, number, number, number];
  fontResourceName(font: PDFFont): PDFName;
  finish(): PDFRef;
};

export type AnnotationAppearanceOptions = {
  marginPt?: number | undefined;
};

export function createPageDrawTarget(page: PDFPage): DrawTarget {
  return new PageDrawTarget(page);
}

export function createAnnotationAppearanceTarget(
  pdf: PDFDocument,
  rect: PdfEditRect,
  _pageRotation: 0 | 90 | 180 | 270 = 0,
  options: AnnotationAppearanceOptions = {},
): AnnotationAppearanceTarget {
  return new AppearanceDrawTarget(pdf, rect, options);
}

export function drawAnnotationAppearanceOnPage(
  page: PDFPage,
  annotation: PDFDict,
): boolean {
  const rect = readAnnotationRect(annotation);
  const appearanceRef = readNormalAppearanceRef(annotation, page.doc.context);

  if (!rect || !appearanceRef) {
    return false;
  }

  const appearance = page.doc.context.lookupMaybe(appearanceRef, PDFStream);
  if (!appearance) {
    return false;
  }

  const bbox = appearance?.dict.lookupMaybe(PDFName.of("BBox"), PDFArray)?.asRectangle();
  const width = bbox?.width && bbox.width !== 0 ? bbox.width : rect.w;
  const height = bbox?.height && bbox.height !== 0 ? bbox.height : rect.h;
  const offsetX = bbox ? bbox.x : 0;
  const offsetY = bbox ? bbox.y : 0;
  const xScale = rect.w / width;
  const yScale = rect.h / height;
  const xObjectKey = page.node.newXObject("RaioPDFAnnot", appearanceRef);

  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(
      xScale,
      0,
      0,
      yScale,
      rect.x - offsetX * xScale,
      rect.y - offsetY * yScale,
    ),
    drawObject(xObjectKey),
    popGraphicsState(),
  );

  return true;
}

class PageDrawTarget implements DrawTarget {
  constructor(private readonly page: PDFPage) {}

  mapPoint(point: PdfEditPoint): PdfEditPoint {
    return point;
  }

  drawRectangle(options: DrawRectangleOptions): void {
    this.page.drawRectangle({
      x: options.rect.x,
      y: options.rect.y,
      width: options.rect.w,
      height: options.rect.h,
      ...(options.fillColor ? { color: options.fillColor } : {}),
      ...(options.strokeColor
        ? { borderColor: options.strokeColor, borderWidth: options.strokeWidthPt ?? 0 }
        : {}),
      ...(options.fillAlpha !== undefined ? { opacity: options.fillAlpha } : {}),
      ...(options.strokeAlpha !== undefined ? { borderOpacity: options.strokeAlpha } : {}),
    });
  }

  drawEllipse(options: DrawEllipseOptions): void {
    this.page.drawEllipse({
      x: options.rect.x + options.rect.w / 2,
      y: options.rect.y + options.rect.h / 2,
      xScale: options.rect.w / 2,
      yScale: options.rect.h / 2,
      ...(options.fillColor ? { color: options.fillColor } : {}),
      ...(options.strokeColor
        ? { borderColor: options.strokeColor, borderWidth: options.strokeWidthPt ?? 0 }
        : {}),
      ...(options.fillAlpha !== undefined ? { opacity: options.fillAlpha } : {}),
      ...(options.strokeAlpha !== undefined ? { borderOpacity: options.strokeAlpha } : {}),
    });
  }

  drawLine(options: DrawLineOptions): void {
    this.page.drawLine({
      start: options.from,
      end: options.to,
      thickness: options.strokeWidthPt,
      color: options.strokeColor,
      ...(options.lineCap !== undefined ? { lineCap: options.lineCap } : {}),
      ...(options.strokeAlpha !== undefined ? { opacity: options.strokeAlpha } : {}),
    });
  }

  drawPolyline(points: readonly PdfEditPoint[], options: Omit<DrawLineOptions, "from" | "to">): void {
    for (let pointIndex = 0; pointIndex + 1 < points.length; pointIndex += 1) {
      this.drawLine({
        ...options,
        from: points[pointIndex]!,
        to: points[pointIndex + 1]!,
      });
    }
  }

  drawFilledPolygon(options: DrawFilledPolygonOptions): void {
    this.page.pushOperators(...drawFilledPolygonOperators(options.points, options.fillColor));
  }

  drawText(options: DrawTextOptions): void {
    this.page.drawText(options.text, {
      x: options.at.x,
      y: options.at.y,
      size: options.fontSizePt,
      font: options.font,
      color: options.color,
      rotate: pdfDegrees(options.rotateDegrees ?? 0),
      ...(options.fillAlpha !== undefined ? { opacity: options.fillAlpha } : {}),
    });
  }

  drawSvgPath(options: DrawSvgPathOptions): void {
    this.page.drawSvgPath(options.path, {
      ...(options.fillColor ? { color: options.fillColor } : {}),
      ...(options.strokeColor ? { borderColor: options.strokeColor } : {}),
      ...(options.strokeWidthPt !== undefined ? { borderWidth: options.strokeWidthPt } : {}),
      ...(options.fillAlpha !== undefined ? { opacity: options.fillAlpha } : {}),
      ...(options.strokeAlpha !== undefined ? { borderOpacity: options.strokeAlpha } : {}),
    });
  }
}

class AppearanceDrawTarget implements AnnotationAppearanceTarget {
  readonly annotationRect: PdfEditRect;
  readonly bbox: PdfEditRect;
  readonly matrix = [1, 0, 0, 1, 0, 0] as const;
  private readonly operators: PDFOperator[] = [];
  private readonly fontResources: PDFDict;
  private readonly extGStateResources: PDFDict;
  private readonly fontNames = new Map<PDFRef, PDFName>();
  private graphicsStateCount = 0;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly pageRect: PdfEditRect,
    options: AnnotationAppearanceOptions,
  ) {
    const margin = Math.max(0, options.marginPt ?? 0);
    this.annotationRect = padRect(pageRect, margin);
    this.bbox = { x: -margin, y: -margin, w: pageRect.w + margin * 2, h: pageRect.h + margin * 2 };
    this.fontResources = pdf.context.obj({}) as PDFDict;
    this.extGStateResources = pdf.context.obj({}) as PDFDict;
  }

  mapPoint(point: PdfEditPoint): PdfEditPoint {
    return {
      x: point.x - this.pageRect.x,
      y: point.y - this.pageRect.y,
    };
  }

  drawRectangle(options: DrawRectangleOptions): void {
    const rect = this.mapRect(options.rect);

    const graphicsState = this.graphicsStateName(options.fillAlpha, options.strokeAlpha);

    this.operators.push(
      ...drawRectangleOperators({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        borderWidth: options.strokeColor ? (options.strokeWidthPt ?? 0) : 0,
        color: options.fillColor as Color | undefined,
        borderColor: options.strokeColor as Color | undefined,
        rotate: pdfDegrees(0),
        xSkew: pdfDegrees(0),
        ySkew: pdfDegrees(0),
        ...(graphicsState ? { graphicsState } : {}),
      }),
    );
  }

  drawEllipse(options: DrawEllipseOptions): void {
    const rect = this.mapRect(options.rect);

    const graphicsState = this.graphicsStateName(options.fillAlpha, options.strokeAlpha);

    this.operators.push(
      ...drawEllipseOperators({
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        xScale: rect.w / 2,
        yScale: rect.h / 2,
        borderWidth: options.strokeColor ? (options.strokeWidthPt ?? 0) : 0,
        color: options.fillColor as Color | undefined,
        borderColor: options.strokeColor as Color | undefined,
        rotate: pdfDegrees(0),
        ...(graphicsState ? { graphicsState } : {}),
      }),
    );
  }

  drawLine(options: DrawLineOptions): void {
    const graphicsState = this.graphicsStateName(undefined, options.strokeAlpha);

    this.operators.push(
      ...drawLineOperators({
        start: this.mapPoint(options.from),
        end: this.mapPoint(options.to),
        thickness: options.strokeWidthPt,
        color: options.strokeColor,
        ...(options.lineCap !== undefined ? { lineCap: options.lineCap } : {}),
        ...(graphicsState ? { graphicsState } : {}),
      }),
    );
  }

  drawPolyline(points: readonly PdfEditPoint[], options: Omit<DrawLineOptions, "from" | "to">): void {
    for (let pointIndex = 0; pointIndex + 1 < points.length; pointIndex += 1) {
      this.drawLine({
        ...options,
        from: points[pointIndex]!,
        to: points[pointIndex + 1]!,
      });
    }
  }

  drawFilledPolygon(options: DrawFilledPolygonOptions): void {
    this.operators.push(
      ...drawFilledPolygonOperators(
        options.points.map((point) => this.mapPoint(point)),
        options.fillColor,
      ),
    );
  }

  drawText(options: DrawTextOptions): void {
    const at = this.mapPoint(options.at);

    const graphicsState = this.graphicsStateName(options.fillAlpha, undefined);

    this.operators.push(
      ...drawTextOperators(options.font.encodeText(options.text), {
        color: options.color,
        font: this.fontResourceName(options.font),
        size: options.fontSizePt,
        rotate: pdfDegrees(options.rotateDegrees ?? 0),
        xSkew: pdfDegrees(0),
        ySkew: pdfDegrees(0),
        x: at.x,
        y: at.y,
        ...(graphicsState ? { graphicsState } : {}),
      }),
    );
  }

  drawSvgPath(options: DrawSvgPathOptions): void {
    const graphicsState = this.graphicsStateName(options.fillAlpha, options.strokeAlpha);

    this.operators.push(
      ...drawSvgPathOperators(options.path, {
        x: 0,
        y: 0,
        scale: undefined,
        color: options.fillColor as Color | undefined,
        borderColor: options.strokeColor as Color | undefined,
        borderWidth: options.strokeWidthPt ?? 0,
        ...(graphicsState ? { graphicsState } : {}),
      }),
    );
  }

  finish(): PDFRef {
    const stream = this.pdf.context.formXObject(this.operators, {
      BBox: this.pdf.context.obj([
        this.bbox.x,
        this.bbox.y,
        this.bbox.x + this.bbox.w,
        this.bbox.y + this.bbox.h,
      ]),
      Matrix: this.pdf.context.obj(this.matrix),
      Resources: this.pdf.context.obj({
        Font: this.fontResources,
        ExtGState: this.extGStateResources,
      }),
    });

    return this.pdf.context.register(stream);
  }

  fontResourceName(font: PDFFont): PDFName {
    return this.fontName(font);
  }

  private mapRect(rect: PdfEditRect): PdfEditRect {
    const point = this.mapPoint(rect);

    return { ...point, w: rect.w, h: rect.h };
  }

  private fontName(font: PDFFont): PDFName {
    const existing = this.fontNames.get(font.ref);

    if (existing) {
      return existing;
    }

    const name = PDFName.of(`F${this.fontNames.size}`);
    this.fontResources.set(name, font.ref);
    this.fontNames.set(font.ref, name);

    return name;
  }

  private graphicsStateName(
    fillAlpha: number | undefined,
    strokeAlpha: number | undefined,
  ): PDFName | undefined {
    if (fillAlpha === undefined && strokeAlpha === undefined) {
      return undefined;
    }

    const name = PDFName.of(`GS${this.graphicsStateCount}`);
    this.graphicsStateCount += 1;
    this.extGStateResources.set(
      name,
      this.pdf.context.obj({
        Type: "ExtGState",
        ...(fillAlpha !== undefined ? { ca: fillAlpha } : {}),
        ...(strokeAlpha !== undefined ? { CA: strokeAlpha } : {}),
      }),
    );

    return name;
  }
}

function drawFilledPolygonOperators(
  points: readonly PdfEditPoint[],
  fillColor: DrawColor,
): PDFOperator[] {
  const [firstPoint, ...restPoints] = points;

  if (!firstPoint) {
    return [];
  }

  return [
    pushGraphicsState(),
    setFillingColor(fillColor),
    moveTo(firstPoint.x, firstPoint.y),
    ...restPoints.map((point) => lineTo(point.x, point.y)),
    closePath(),
    fill(),
    popGraphicsState(),
  ];
}

function padRect(rect: PdfEditRect, padding: number): PdfEditRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + padding * 2,
    h: rect.h + padding * 2,
  };
}

function readAnnotationRect(annotation: PDFDict): PdfEditRect | undefined {
  const rect = annotation.lookupMaybe(PDFName.of("Rect"), PDFArray);

  if (!rect || rect.size() !== 4) {
    return undefined;
  }

  const [x1, y1, x2, y2] = rect.asArray().map((value) => Number(value.toString()));

  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }

  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function readNormalAppearanceRef(
  annotation: PDFDict,
  context: PDFContext,
): PDFRef | undefined {
  const appearance = annotation.lookupMaybe(PDFName.of("AP"), PDFDict);
  const normalAppearance = appearance?.get(PDFName.of("N"));

  if (normalAppearance instanceof PDFRef && context.lookupMaybe(normalAppearance, PDFStream)) {
    return normalAppearance;
  }

  // /N may be a sub-dictionary keyed by appearance state (widget annotations,
  // e.g. checkbox On/Off) — resolve the annotation's current /AS entry.
  const stateDictionary = normalAppearance instanceof PDFRef
    ? context.lookupMaybe(normalAppearance, PDFDict)
    : normalAppearance instanceof PDFDict
      ? normalAppearance
      : undefined;
  const state = annotation.get(PDFName.of("AS"));

  if (stateDictionary && state instanceof PDFName) {
    const stateRef = stateDictionary.get(state);

    if (stateRef instanceof PDFRef && context.lookupMaybe(stateRef, PDFStream)) {
      return stateRef;
    }
  }

  return undefined;
}
