import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HEALTH_PATH = "/api/v1/info/status";
const SECOND_OCCURRENCE = 1;

async function main() {
  const jarPath = process.env.RAIOPDF_ENGINE_JAR;
  if (!jarPath) {
    throw new Error("Set RAIOPDF_ENGINE_JAR to a built Stirling engine JAR before running this script.");
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "raiopdf-direct-click-live-"));
  const basePath = path.join(tempDir, "stirling-base");
  const logPath = path.join(tempDir, "stirling.log");
  const inputPdfPath = path.join(tempDir, "duplicate-name.pdf");
  const outputPdfPath = path.join(tempDir, "duplicate-name-edited.pdf");
  let engine = null;
  let logFd = null;

  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    writeFileSync(inputPdfPath, createDuplicateNamePdf());

    logFd = openSync(logPath, "w");
    engine = spawn(
      process.env.JAVA_BIN ?? "java",
      [
        "-Xmx1g",
        "-jar",
        jarPath,
        "--server.address=127.0.0.1",
        `--server.port=${port}`,
        "--springdoc.api-docs.enabled=false",
      ],
      {
        env: {
          ...process.env,
          STIRLING_BASE_PATH: basePath,
        },
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      },
    );

    await waitForHealth(baseUrl, engine, logPath);

    const inputJson = await convertPdfToJson(baseUrl, readFileSync(inputPdfPath), "duplicate-name.pdf");
    const inputText = joinedPageText(inputJson, 0);
    applyOccurrenceReplacement(inputJson, {
      pageIndex: 0,
      find: "John Smith",
      occurrenceIndex: SECOND_OCCURRENCE,
      replacement: "Jane Doe",
    });

    const outputBytes = await convertJsonToPdf(baseUrl, inputJson, "duplicate-name.json");
    writeFileSync(outputPdfPath, outputBytes);

    const outputJson = await convertPdfToJson(baseUrl, outputBytes, "duplicate-name-edited.pdf");
    const outputText = joinedPageText(outputJson, 0);

    assertEqual(countOccurrences(outputText, "John Smith"), 1, "first duplicate should remain");
    assertEqual(countOccurrences(outputText, "Jane Doe"), 1, "selected duplicate should be replaced");
    if (!outputText.includes("John Smith") || !outputText.includes("Jane Doe")) {
      throw new Error(`Unexpected output text: ${JSON.stringify(outputText)}`);
    }

    console.log("PASS live engine text-editor occurrence edit");
    console.log(`input:  ${JSON.stringify(inputText)}`);
    console.log(`output: ${JSON.stringify(outputText)}`);
    console.log(
      process.env.KEEP_DIRECT_CLICK_EDIT_TMP === "1"
        ? `temp:   ${tempDir}`
        : "temp:   cleaned",
    );
  } finally {
    if (engine) {
      engine.kill();
      await onceExit(engine);
    }
    if (logFd !== null) {
      closeSync(logFd);
    }
    if (process.env.KEEP_DIRECT_CLICK_EDIT_TMP !== "1") {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function convertPdfToJson(baseUrl, pdfBytes, filename) {
  const form = new FormData();
  form.append("fileInput", new Blob([pdfBytes], { type: "application/pdf" }), filename);

  const response = await fetch(`${baseUrl}/api/v1/convert/pdf/text-editor`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`convertPdfToJson failed: HTTP ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function convertJsonToPdf(baseUrl, document, filename) {
  const form = new FormData();
  const jsonBytes = Buffer.from(JSON.stringify(document), "utf8");
  form.append("fileInput", new Blob([jsonBytes], { type: "application/json" }), filename);

  const response = await fetch(`${baseUrl}/api/v1/convert/text-editor/pdf`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`convertJsonToPdf failed: HTTP ${response.status} ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function applyOccurrenceReplacement(document, { pageIndex, find, occurrenceIndex, replacement }) {
  const page = document.pages?.[pageIndex];
  const elements = page?.textElements;
  if (!Array.isArray(elements)) {
    throw new Error(`Page ${pageIndex} does not have textElements.`);
  }

  const map = buildTextMap(elements);
  const target = findOccurrence(map.text, find, occurrenceIndex);
  const first = map.spans.find((span) => target.start >= span.start && target.start < span.end);
  const last = [...map.spans].reverse().find((span) => target.end > span.start && target.end <= span.end);

  if (!first || !last) {
    throw new Error(`Occurrence did not map to text elements: ${JSON.stringify(target)}`);
  }

  if (first.index === last.index) {
    const element = elements[first.index];
    element.text = [
      element.text.slice(0, target.start - first.start),
      replacement,
      element.text.slice(target.end - last.start),
    ].join("");
    return;
  }

  elements[first.index].text = `${elements[first.index].text.slice(0, target.start - first.start)}${replacement}`;
  for (let index = first.index + 1; index < last.index; index += 1) {
    elements[index].text = "";
  }
  elements[last.index].text = elements[last.index].text.slice(target.end - last.start);
}

function joinedPageText(document, pageIndex) {
  const elements = document.pages?.[pageIndex]?.textElements;
  if (!Array.isArray(elements)) {
    throw new Error(`Page ${pageIndex} does not have textElements.`);
  }
  return elements.map((element) => element.text ?? "").join("");
}

function buildTextMap(elements) {
  let text = "";
  const spans = [];

  elements.forEach((element, index) => {
    const value = element.text ?? "";
    const start = text.length;
    text += value;
    spans.push({ index, start, end: text.length });
  });

  return { text, spans };
}

function findOccurrence(text, find, occurrenceIndex) {
  let found = -1;
  let from = 0;

  for (let count = 0; count <= occurrenceIndex; count += 1) {
    found = text.indexOf(find, from);
    if (found === -1) {
      throw new Error(
        `Could not find occurrence ${occurrenceIndex} of ${JSON.stringify(find)} in ${JSON.stringify(text)}.`,
      );
    }
    from = found + find.length;
  }

  return { start: found, end: found + find.length };
}

function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const found = text.indexOf(needle, from);
    if (found === -1) {
      return count;
    }
    count += 1;
    from = found + needle.length;
  }
}

async function waitForHealth(baseUrl, engine, logPath) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (engine.exitCode !== null) {
      throw new Error(`Engine exited before health was ready. Log:\n${readFileSync(logPath, "utf8")}`);
    }

    try {
      const response = await fetch(`${baseUrl}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the JVM finishes starting.
    }

    await delay(1000);
  }

  throw new Error(`Timed out waiting for engine health. Log:\n${readFileSync(logPath, "utf8")}`);
}

async function freePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not reserve a local port."));
        }
      });
    });
    server.on("error", reject);
  });
}

function createDuplicateNamePdf() {
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 700 Td",
    "(John Smith) Tj",
    "100 0 Td",
    "( v. ) Tj",
    "50 0 Td",
    "(John Smith) Tj",
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];

  objects.forEach((body, index) => {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "ascii"));
  });

  const bodyBytes = Buffer.concat(chunks);
  const xrefOffset = bodyBytes.length;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");

  return Buffer.concat([bodyBytes, Buffer.from(xref, "ascii")]);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function onceExit(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 3000).unref();
  });
}

await main();
