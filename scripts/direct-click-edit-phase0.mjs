import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

export class DirectClickEditError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "DirectClickEditError";
    this.code = code;
    this.detail = detail;
  }
}

export function buildEngineTextMap({ pageIndex, elements }) {
  let text = "";
  const spans = [];

  elements.forEach((element, index) => {
    const start = text.length;
    text += element.text;
    spans.push({
      elementIndex: index,
      start,
      end: text.length,
      text: element.text,
      rect: element.rect,
    });
  });

  return {
    pageIndex,
    text,
    spans,
    fingerprint: fingerprintPage({ pageIndex, elements }),
  };
}

export function createTargetFromEngineRange({ pageIndex, elements, start, end }) {
  const map = buildEngineTextMap({ pageIndex, elements });

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > map.text.length
  ) {
    throw new DirectClickEditError("INVALID_RANGE", "The requested engine text range is invalid.");
  }

  const firstSpan = map.spans.find((span) => start >= span.start && start < span.end);
  const lastSpan = [...map.spans].reverse().find((span) => end > span.start && end <= span.end);

  if (!firstSpan || !lastSpan) {
    throw new DirectClickEditError("INVALID_RANGE", "The requested engine text range does not overlap text.");
  }

  return {
    pageIndex,
    start,
    end,
    expectedText: map.text.slice(start, end),
    sourceFingerprint: map.fingerprint,
    firstElementIndex: firstSpan.elementIndex,
    lastElementIndex: lastSpan.elementIndex,
    firstElementOffset: start - firstSpan.start,
    lastElementOffset: end - lastSpan.start,
  };
}

export function applyTargetedEdit({ pageIndex, elements, target, replacement }) {
  const map = buildEngineTextMap({ pageIndex, elements });

  if (target.pageIndex !== pageIndex) {
    throw new DirectClickEditError("PAGE_MISMATCH", "The target belongs to another page.");
  }

  if (target.sourceFingerprint !== map.fingerprint) {
    throw new DirectClickEditError("TARGET_STALE", "The source text map changed before the edit was applied.");
  }

  if (map.text.slice(target.start, target.end) !== target.expectedText) {
    throw new DirectClickEditError("TEXT_MISMATCH", "The target no longer resolves to the selected text.");
  }

  const edited = elements.map((element) => ({ ...element }));
  const first = edited[target.firstElementIndex];
  const last = edited[target.lastElementIndex];

  if (!first || !last) {
    throw new DirectClickEditError("INVALID_TARGET", "The target references a missing text element.");
  }

  if (target.firstElementIndex === target.lastElementIndex) {
    first.text = [
      first.text.slice(0, target.firstElementOffset),
      replacement,
      first.text.slice(target.lastElementOffset),
    ].join("");
  } else {
    first.text = `${first.text.slice(0, target.firstElementOffset)}${replacement}`;
    for (let index = target.firstElementIndex + 1; index < target.lastElementIndex; index += 1) {
      edited[index].text = "";
    }
    last.text = last.text.slice(target.lastElementOffset);
  }

  return {
    elements: edited,
    text: buildEngineTextMap({ pageIndex, elements: edited }).text,
    changedElementIndexes: range(target.firstElementIndex, target.lastElementIndex),
  };
}

export function resolveDomSelectionToEngineTarget({
  pageIndex,
  elements,
  selectedText,
  selectionRects,
  minOverlapRatio = 0.45,
}) {
  if (!selectedText) {
    throw new DirectClickEditError("EMPTY_SELECTION", "No selectable text was provided.");
  }

  const map = buildEngineTextMap({ pageIndex, elements });
  const candidates = rangesForText(map.text, selectedText);

  if (candidates.length === 0) {
    const compact = selectedText.replace(/\s+/g, "");
    const compactIndex = compact ? map.text.indexOf(compact) : -1;
    if (compactIndex !== -1 && selectedText !== compact) {
      throw new DirectClickEditError(
        "TEXT_MODEL_MISMATCH",
        "The UI selection contains inferred whitespace that the engine text model does not contain.",
      );
    }
    throw new DirectClickEditError("TEXT_NOT_FOUND", "The selected text is not present in the engine text model.");
  }

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: geometryOverlapScore(selectionRects, elementRectsForRange(map, candidate.start, candidate.end)),
    }))
    .filter((candidate) => candidate.score >= minOverlapRatio)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    throw new DirectClickEditError("GEOMETRY_MISMATCH", "The selected text exists but not at the selected location.");
  }

  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.05) {
    throw new DirectClickEditError(
      "TARGET_AMBIGUOUS",
      "The selected text resolves to more than one engine occurrence.",
    );
  }

  return createTargetFromEngineRange({
    pageIndex,
    elements,
    start: scored[0].start,
    end: scored[0].end,
  });
}

export function runPhase0Spike() {
  const cases = [];

  const add = (name, run) => {
    try {
      run();
      cases.push({ name, status: "PASS" });
    } catch (error) {
      cases.push({
        name,
        status: "FAIL",
        error: error instanceof Error ? `${error.name}: ${error.message}` : inspect(error),
      });
    }
  };

  add("targeted duplicate replacement edits only the selected occurrence", () => {
    const elements = [
      element("John Smith", 72, 700, 80, 12),
      element(" v. ", 152, 700, 18, 12),
      element("John Smith", 170, 700, 80, 12),
    ];
    const target = resolveDomSelectionToEngineTarget({
      pageIndex: 0,
      elements,
      selectedText: "John Smith",
      selectionRects: [rect(170, 700, 80, 12)],
    });
    const result = applyTargetedEdit({ pageIndex: 0, elements, target, replacement: "Jane Doe" });

    assertEqual(result.text, "John Smith v. Jane Doe");
    assertDeepEqual(result.changedElementIndexes, [2]);
  });

  add("split-run deletion removes a selected name across multiple elements", () => {
    const elements = [
      element("John", 72, 700, 32, 12),
      element(" ", 104, 700, 4, 12),
      element("Smith", 108, 700, 40, 12),
      element(" filed", 148, 700, 34, 12),
    ];
    const target = createTargetFromEngineRange({ pageIndex: 0, elements, start: 0, end: 10 });
    const result = applyTargetedEdit({ pageIndex: 0, elements, target, replacement: "" });

    assertEqual(result.text, " filed");
    assertDeepEqual(result.elements.map((candidate) => candidate.text), ["", "", "", " filed"]);
  });

  add("same-run middle edit preserves prefix and suffix", () => {
    const elements = [element("Alpha John Smith Omega", 72, 700, 160, 12)];
    const target = createTargetFromEngineRange({ pageIndex: 0, elements, start: 6, end: 16 });
    const result = applyTargetedEdit({ pageIndex: 0, elements, target, replacement: "Jane Doe" });

    assertEqual(result.text, "Alpha Jane Doe Omega");
  });

  add("source fingerprint rejects stale text maps", () => {
    const elements = [element("John Smith", 72, 700, 80, 12)];
    const target = createTargetFromEngineRange({ pageIndex: 0, elements, start: 0, end: 10 });
    const stale = [element("John Q. Smith", 72, 700, 92, 12)];

    assertThrows(
      () => applyTargetedEdit({ pageIndex: 0, elements: stale, target, replacement: "Jane Doe" }),
      "TARGET_STALE",
    );
  });

  add("ambiguous duplicate geometry is refused", () => {
    const elements = [
      element("John Smith", 72, 700, 80, 12),
      element("John Smith", 72, 700, 80, 12),
    ];

    assertThrows(
      () =>
        resolveDomSelectionToEngineTarget({
          pageIndex: 0,
          elements,
          selectedText: "John Smith",
          selectionRects: [rect(72, 700, 80, 12)],
        }),
      "TARGET_AMBIGUOUS",
    );
  });

  add("pdf.js inferred-space selection is refused when engine has no literal space", () => {
    const elements = [
      element("John", 72, 700, 32, 12),
      element("Smith", 110, 700, 40, 12),
    ];

    assertThrows(
      () =>
        resolveDomSelectionToEngineTarget({
          pageIndex: 0,
          elements,
          selectedText: "John Smith",
          selectionRects: [rect(72, 700, 78, 12)],
        }),
      "TEXT_MODEL_MISMATCH",
    );
  });

  add("column geometry selects the intended repeated term", () => {
    const elements = [
      element("Total", 72, 700, 38, 12),
      element("Total", 300, 700, 38, 12),
    ];
    const target = resolveDomSelectionToEngineTarget({
      pageIndex: 0,
      elements,
      selectedText: "Total",
      selectionRects: [rect(300, 700, 38, 12)],
    });
    const result = applyTargetedEdit({ pageIndex: 0, elements, target, replacement: "Amount" });

    assertEqual(result.text, "TotalAmount");
    assertDeepEqual(result.changedElementIndexes, [1]);
  });

  return {
    pass: cases.every((candidate) => candidate.status === "PASS"),
    cases,
  };
}

export function element(text, x, y, w, h) {
  return { text, rect: rect(x, y, w, h) };
}

export function rect(x, y, w, h) {
  return { x, y, w, h };
}

function fingerprintPage({ pageIndex, elements }) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    pageIndex,
    elements: elements.map((element) => ({
      text: element.text,
      rect: element.rect,
    })),
  }));
  return hash.digest("hex");
}

function rangesForText(text, needle) {
  const ranges = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    ranges.push({ start: index, end: index + needle.length });
    index = text.indexOf(needle, index + Math.max(1, needle.length));
  }
  return ranges;
}

function elementRectsForRange(map, start, end) {
  return map.spans
    .filter((span) => span.end > start && span.start < end)
    .map((span) => span.rect);
}

function geometryOverlapScore(selectionRects, engineRects) {
  const selectionArea = sumArea(selectionRects);
  const engineArea = sumArea(engineRects);

  if (selectionArea <= 0 || engineArea <= 0) {
    return 0;
  }

  let overlap = 0;
  for (const selectionRect of selectionRects) {
    for (const engineRect of engineRects) {
      overlap += intersectionArea(selectionRect, engineRect);
    }
  }

  return overlap / Math.max(selectionArea, engineArea);
}

function intersectionArea(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function sumArea(rects) {
  return rects.reduce((total, candidate) => total + candidate.w * candidate.h, 0);
}

function range(start, endInclusive) {
  return Array.from({ length: endInclusive - start + 1 }, (_, offset) => start + offset);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${inspect(actual)} to equal ${inspect(expected)}.`);
  }
}

function assertDeepEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${inspect(actual)} to equal ${inspect(expected)}.`);
  }
}

function assertThrows(run, expectedCode) {
  try {
    run();
  } catch (error) {
    if (error instanceof DirectClickEditError && error.code === expectedCode) {
      return;
    }
    throw new Error(`Expected ${expectedCode}, got ${error instanceof Error ? error.message : inspect(error)}.`);
  }

  throw new Error(`Expected ${expectedCode}, but no error was thrown.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPhase0Spike();
  for (const testCase of result.cases) {
    console.log(`${testCase.status} ${testCase.name}`);
    if (testCase.error) {
      console.log(`  ${testCase.error}`);
    }
  }
  if (!result.pass) {
    process.exitCode = 1;
  }
}
