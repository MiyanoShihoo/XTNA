/**
 * Dependency-free PDF report writer for the dossier exporter.
 *
 * Two gaps the text-only writer had:
 *
 * 1. **CJK text.** A TrueType font is read from disk (cmap format 4/12, hmtx,
 *    hhea/head/OS/2 metrics), embedded as a CIDFontType2 descendant with
 *    Identity-H encoding and a ToUnicode map. No glyph subsetting: the whole
 *    font is embedded, so the file grows by the font size.
 * 2. **Mermaid diagrams.** The dossier only emits two shapes — `flowchart
 *    LR|TB` and `sequenceDiagram` — so those are parsed and drawn as PDF
 *    vector operations (boxes, lines, filled arrow heads, labels). Anything
 *    else is reported as unrendered rather than drawn approximately.
 */
import { existsSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 50;
const TOP_Y = 800;
const LINE_HEIGHT = 14;
const LINES_PER_PAGE = 52;
const BODY_SIZE = 10;
const DIAGRAM_SIZE = 8;

const CJK_FONT_CANDIDATES = [
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/Deng.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/System/Library/Fonts/PingFang.ttc",
];

const isCjk = (code) =>
  (code >= 0x2e80 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xff00 && code <= 0xffef);

const textWidth = (text, size) => {
  let width = 0;
  for (const character of text)
    width += isCjk(character.codePointAt(0) ?? 0) ? size : size * 0.52;
  return width;
};

/** Parse the tables a CIDFontType2 descriptor needs. */
export const readTrueType = (path) => {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint32(0);
  if (tag === 0x4f54544f)
    throw new Error("OTTO/CFF fonts are not supported; pass a TrueType (.ttf)");
  if (tag !== 0x00010000 && tag !== 0x74727565)
    throw new Error("not a TrueType font (missing 0x00010000/true signature)");
  const tables = new Map();
  const numTables = view.getUint16(4);
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const name = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(name, {
      offset: view.getUint32(record + 8),
      length: view.getUint32(record + 12),
    });
  }
  const table = (name) => {
    const entry = tables.get(name);
    if (entry === undefined)
      throw new Error(`font is missing the ${name} table`);
    return entry;
  };
  const head = table("head");
  const hhea = table("hhea");
  const maxp = table("maxp");
  const hmtx = table("hmtx");
  const cmap = table("cmap");
  const unitsPerEm = view.getUint16(head.offset + 18);
  const bbox = [
    view.getInt16(head.offset + 36),
    view.getInt16(head.offset + 38),
    view.getInt16(head.offset + 40),
    view.getInt16(head.offset + 42),
  ];
  const ascent = view.getInt16(hhea.offset + 4);
  const descent = view.getInt16(hhea.offset + 6);
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const os2 = tables.get("OS/2");
  const capHeight =
    os2 === undefined
      ? Math.round(ascent * 0.7)
      : view.getInt16(os2.offset + 88);

  const widths = new Map();
  const widthOf = (gid) => {
    if (widths.has(gid)) return widths.get(gid);
    const index = Math.min(gid, numberOfHMetrics - 1);
    const width = view.getUint16(hmtx.offset + index * 4);
    widths.set(gid, width);
    return width;
  };

  // cmap: prefer a format 12 Unicode subtable, then a format 4 BMP subtable.
  const cmapCount = view.getUint16(cmap.offset + 2);
  let format12;
  let format4;
  for (let index = 0; index < cmapCount; index += 1) {
    const record = cmap.offset + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap.offset + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    if (format === 12 && (platform === 3 || platform === 0))
      format12 ??= offset;
    if (format === 4 && (platform === 3 || platform === 0)) format4 ??= offset;
    if (platform === 3 && encoding === 10 && format === 12) format12 = offset;
  }
  const glyphForCodePoint = (codePoint) => {
    if (format12 !== undefined) {
      const groups = view.getUint32(format12 + 12);
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const group = format12 + 16 + middle * 12;
        const start = view.getUint32(group);
        const end = view.getUint32(group + 4);
        if (codePoint < start) high = middle - 1;
        else if (codePoint > end) low = middle + 1;
        else return view.getUint32(group + 8) + (codePoint - start);
      }
      return 0;
    }
    if (format4 !== undefined && codePoint <= 0xffff) {
      const segCount = view.getUint16(format4 + 6) / 2;
      const endCodes = format4 + 14;
      const startCodes = endCodes + segCount * 2 + 2;
      const idDeltas = startCodes + segCount * 2;
      const idRangeOffsets = idDeltas + segCount * 2;
      for (let segment = 0; segment < segCount; segment += 1) {
        const end = view.getUint16(endCodes + segment * 2);
        if (codePoint > end) continue;
        const start = view.getUint16(startCodes + segment * 2);
        if (codePoint < start) break;
        const delta = view.getInt16(idDeltas + segment * 2);
        const rangeOffset = view.getUint16(idRangeOffsets + segment * 2);
        if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
        const glyphIndex = view.getUint16(
          idRangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2,
        );
        return glyphIndex === 0 ? 0 : (glyphIndex + delta) & 0xffff;
      }
    }
    return 0;
  };

  return {
    bytes,
    unitsPerEm,
    bbox,
    ascent,
    descent,
    capHeight,
    numGlyphs,
    glyphForCodePoint,
    widthOf,
  };
};

export const defaultCjkFont = () =>
  CJK_FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? undefined;

/** Escape a PDF literal string (ASCII path). */
const pdfText = (value) =>
  value
    .replace(/\\/gu, "\\\\")
    .replace(/\(/gu, "\\(")
    .replace(/\)/gu, "\\)")
    .replace(/[^\x20-\x7e]/gu, "?");

const wrapLine = (line, width = 95) => {
  if (line.length === 0) return [""];
  const rows = [];
  let current = "";
  let currentWidth = 0;
  for (const character of line) {
    const weight = isCjk(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (currentWidth + weight > width && current.length > 0) {
      rows.push(current);
      current = character;
      currentWidth = weight;
    } else {
      current += character;
      currentWidth += weight;
    }
  }
  rows.push(current);
  return rows;
};

const plainLines = (markdown) => {
  const out = [];
  const source = markdown.split("\n");
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index] ?? "";
    if (line.startsWith("```")) {
      for (
        index += 1;
        index < source.length && source[index] !== "```";
        index += 1
      );
      continue;
    }
    if (line.trim().length === 0) {
      out.push("");
      continue;
    }
    out.push(
      line
        .replace(/^#+\s*/u, "")
        .replace(/`/gu, "")
        .replace(/^\|\s*/u, "")
        .replace(/\s*\|$/u, "")
        .replace(/\s*\|\s*/gu, " | "),
    );
  }
  return out;
};

/** Split the markdown into ordered text paragraphs and Mermaid blocks. */
const segmentsOf = (markdown) => {
  const segments = [];
  let text = [];
  let diagram = null;
  for (const line of markdown.split("\n")) {
    if (diagram !== null) {
      if (line === "```") {
        segments.push({ kind: "diagram", lines: diagram });
        diagram = null;
      } else diagram.push(line);
      continue;
    }
    if (line === "```mermaid") {
      if (text.length > 0) {
        segments.push({ kind: "text", lines: plainLines(text.join("\n")) });
        text = [];
      }
      diagram = [];
      continue;
    }
    text.push(line);
  }
  if (text.length > 0)
    segments.push({ kind: "text", lines: plainLines(text.join("\n")) });
  return segments;
};

const parseFlowchart = (lines) => {
  const header = lines[0]?.trim() ?? "";
  const direction =
    /(?:flowchart|graph)\s+(LR|TB|RL|BT)/u.exec(header)?.[1] ?? "TB";
  const nodes = new Map();
  const order = [];
  const edges = [];
  const nodePattern =
    /([A-Za-z_][\w-]*)\s*(?:\[([^\]]*)\]|\{([^}]*)\}|\(([^)]*)\))/gu;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("%%")) continue;
    for (const match of trimmed.matchAll(nodePattern)) {
      const id = match[1];
      const label = (match[2] ?? match[3] ?? match[4] ?? id).replace(
        /^"|"$/gu,
        "",
      );
      if (!nodes.has(id)) {
        nodes.set(id, label);
        order.push(id);
      }
    }
    const edge =
      /([A-Za-z_][\w-]*)\s*(?:-->|---|==>|-\.->)\s*(?:\|([^|]*)\|\s*)?([A-Za-z_][\w-]*)/u.exec(
        trimmed,
      );
    if (edge !== null)
      edges.push({ from: edge[1], to: edge[3], label: edge[2] });
    if (order.length > 60) break;
  }
  return { direction, nodes, order, edges };
};

const layoutFlowchart = ({ direction, order, edges }) => {
  const rank = new Map(order.map((id) => [id, 0]));
  for (let pass = 0; pass < order.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const next = Math.min(12, (rank.get(edge.from) ?? 0) + 1);
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byRank = new Map();
  for (const id of order) {
    const value = rank.get(id) ?? 0;
    byRank.set(value, [...(byRank.get(value) ?? []), id]);
  }
  const boxWidth = 132;
  const boxHeight = 38;
  const gapRank = 58;
  const gapNode = 18;
  const positions = new Map();
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const horizontal = direction === "LR" || direction === "RL";
  let cursor = 0;
  for (const value of ranks) {
    const ids = byRank.get(value) ?? [];
    ids.forEach((id, index) => {
      if (horizontal)
        positions.set(id, {
          x: MARGIN_X + value * (boxWidth + gapRank),
          y: TOP_Y - 60 - index * (boxHeight + gapNode),
        });
      else
        positions.set(id, {
          x: MARGIN_X + index * (boxWidth + gapNode) + cursor,
          y: TOP_Y - 60 - value * (boxHeight + gapRank),
        });
    });
    if (!horizontal) cursor = 0;
  }
  return { positions, boxWidth, boxHeight };
};

const flowRuns = (text, x, y, size, cjk) => {
  const pieces = [];
  let ascii = "";
  let hex = "";
  const flushAscii = () => {
    if (ascii.length > 0)
      pieces.push(`/F1 ${String(size)} Tf (${pdfText(ascii)}) Tj`);
    ascii = "";
  };
  const flushHex = () => {
    if (hex.length > 0) pieces.push(`/F2 ${String(size)} Tf <${hex}> Tj`);
    hex = "";
  };
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20) continue;
    if (code <= 0x7e) {
      if (hex.length > 0) flushHex();
      ascii += character;
      continue;
    }
    const gid = cjk === undefined ? 0 : cjk.glyphForCodePoint(code);
    if (gid === 0) {
      if (hex.length > 0) flushHex();
      ascii += "?";
      continue;
    }
    if (ascii.length > 0) flushAscii();
    cjk.used.set(gid, code);
    hex += gid.toString(16).padStart(4, "0").toUpperCase();
  }
  flushHex();
  flushAscii();
  return `BT 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pieces.join(" ")} ET`;
};

const renderFlowchartPage = (diagram, title, cjk) => {
  const parsed = parseFlowchart(diagram);
  if (parsed.order.length === 0) return null;
  const { positions, boxWidth, boxHeight } = layoutFlowchart(parsed);
  const ops = [
    `BT /F1 12 Tf 1 0 0 1 ${MARGIN_X} ${TOP_Y} Tm (${pdfText(title)}) Tj ET`,
  ];
  for (const [id, position] of positions) {
    ops.push(
      `0.94 0.94 0.94 rg ${position.x.toFixed(1)} ${position.y.toFixed(1)} ${boxWidth} ${boxHeight} re f 0 0 0 RG 0.6 w ${position.x.toFixed(1)} ${position.y.toFixed(1)} ${boxWidth} ${boxHeight} re S`,
    );
    const label = parsed.nodes.get(id) ?? id;
    const width = textWidth(label, DIAGRAM_SIZE);
    ops.push(
      flowRuns(
        label,
        position.x + (boxWidth - width) / 2,
        position.y + boxHeight / 2 - 3,
        DIAGRAM_SIZE,
        cjk,
      ),
    );
  }
  for (const edge of parsed.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
    const startX =
      from.x + (horizontal ? (to.x > from.x ? boxWidth : 0) : boxWidth / 2);
    const startY =
      from.y + (horizontal ? boxHeight / 2 : to.y > from.y ? 0 : boxHeight);
    const endX =
      to.x + (horizontal ? (to.x > from.x ? 0 : boxWidth) : boxWidth / 2);
    const endY =
      to.y + (horizontal ? boxHeight / 2 : to.y > from.y ? boxHeight : 0);
    ops.push(
      `0.2 0.2 0.2 RG 0.7 w ${startX.toFixed(1)} ${startY.toFixed(1)} m ${endX.toFixed(1)} ${endY.toFixed(1)} l S`,
    );
    const angle = Math.atan2(endY - startY, endX - startX);
    const size = 6;
    const left = [
      endX - size * Math.cos(angle - 0.4),
      endY - size * Math.sin(angle - 0.4),
    ];
    const right = [
      endX - size * Math.cos(angle + 0.4),
      endY - size * Math.sin(angle + 0.4),
    ];
    ops.push(
      `0 0 0 rg ${endX.toFixed(1)} ${endY.toFixed(1)} m ${left[0]?.toFixed(1)} ${left[1]?.toFixed(1)} l ${right[0]?.toFixed(1)} ${right[1]?.toFixed(1)} l f`,
    );
    if (edge.label !== undefined && edge.label.length > 0)
      ops.push(
        flowRuns(
          edge.label,
          (startX + endX) / 2 - textWidth(edge.label, 7) / 2,
          (startY + endY) / 2 + 3,
          7,
          cjk,
        ),
      );
  }
  return ops;
};

const renderSequencePage = (diagram, title, cjk) => {
  const participants = [];
  const messages = [];
  for (const line of diagram) {
    const participant = /^\s*participant\s+(\S+)\s+as\s+(.+)$/u.exec(line);
    if (participant !== null) {
      participants.push({ id: participant[1], name: participant[2].trim() });
      continue;
    }
    const message = /^\s*(\S+?)\s*-{1,2}>{1,2}\s*(\S+?)\s*:\s*(.+)$/u.exec(
      line,
    );
    if (message !== null)
      messages.push({
        from: message[1],
        to: message[2],
        text: message[3].trim(),
      });
  }
  if (participants.length === 0 && messages.length === 0) return null;
  for (const message of messages) {
    for (const id of [message.from, message.to]) {
      if (!participants.some((entry) => entry.id === id))
        participants.push({ id, name: id });
    }
  }
  const column = Math.min(
    150,
    (PAGE_WIDTH - MARGIN_X * 2) / Math.max(participants.length, 1),
  );
  const xOf = (id) =>
    MARGIN_X +
    participants.findIndex((entry) => entry.id === id) * column +
    column / 2;
  const top = TOP_Y - 30;
  const bottom = 120;
  const ops = [
    `BT /F1 12 Tf 1 0 0 1 ${MARGIN_X} ${TOP_Y - 4} Tm (${pdfText(title)}) Tj ET`,
  ];
  for (const participant of participants) {
    const x = xOf(participant.id);
    ops.push(`0.94 0.94 0.94 rg ${(x - 50).toFixed(1)} ${top} 100 26 re f`);
    ops.push(
      flowRuns(
        participant.name,
        x - textWidth(participant.name, DIAGRAM_SIZE) / 2,
        top + 9,
        DIAGRAM_SIZE,
        cjk,
      ),
    );
    ops.push(
      `0.5 0.5 0.5 RG 0.5 w [3 3] 0 d ${x.toFixed(1)} ${(top - 4).toFixed(1)} m ${x.toFixed(1)} ${bottom} l S 0 d`,
    );
  }
  let y = top - 30;
  for (const message of messages.slice(0, 26)) {
    const fromX = xOf(message.from);
    const toX = xOf(message.to);
    const direction = toX >= fromX ? 1 : -1;
    ops.push(
      `0.1 0.1 0.1 RG 0.8 w ${fromX.toFixed(1)} ${y.toFixed(1)} m ${toX.toFixed(1)} ${y.toFixed(1)} l S`,
    );
    ops.push(
      `0 0 0 rg ${toX.toFixed(1)} ${y.toFixed(1)} m ${(toX - direction * 6).toFixed(1)} ${(y + 3).toFixed(1)} l ${(toX - direction * 6).toFixed(1)} ${(y - 3).toFixed(1)} l f`,
    );
    const label = message.text;
    ops.push(
      flowRuns(
        label,
        (fromX + toX) / 2 - textWidth(label, 7) / 2,
        y + 5,
        7,
        cjk,
      ),
    );
    y -= 30;
    if (y < bottom + 20) break;
  }
  return ops;
};

const renderDiagramPage = (lines, index, cjk) => {
  const title = `Diagram ${String(index)}`;
  if (lines.some((line) => /^\s*sequenceDiagram/u.test(line)))
    return renderSequencePage(lines, title, cjk);
  if (lines.some((line) => /^\s*(flowchart|graph)\s/u.test(line)))
    return renderFlowchartPage(lines, title, cjk);
  return [
    `BT /F1 10 Tf 1 0 0 1 ${MARGIN_X} ${TOP_Y} Tm (${pdfText(`${title}: this Mermaid shape is not rendered`)}) Tj ET`,
  ];
};

/** Encode one line as font runs; returns the content-stream fragment. */
const lineRuns = (line, cjk) => {
  if (line.length === 0) return "";
  const pieces = [];
  let ascii = "";
  let hex = "";
  const flushAscii = () => {
    if (ascii.length > 0) pieces.push(`(${pdfText(ascii)}) Tj`);
    ascii = "";
  };
  const flushHex = () => {
    if (hex.length > 0) pieces.push(`<${hex}> Tj`);
    hex = "";
  };
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7e) {
      if (hex.length > 0) flushHex();
      ascii += character;
      continue;
    }
    if (cjk === undefined) {
      if (hex.length > 0) flushHex();
      ascii += "?";
      continue;
    }
    const gid = cjk.glyphForCodePoint(code);
    if (gid === 0) {
      if (hex.length > 0) flushHex();
      ascii += "?";
      continue;
    }
    if (ascii.length > 0) flushAscii();
    hex += gid.toString(16).padStart(4, "0").toUpperCase();
    cjk.used.set(gid, code);
  }
  flushHex();
  flushAscii();
  return pieces
    .map((piece) =>
      piece.startsWith("<") ? `/F2 ${BODY_SIZE} Tf ${piece}` : piece,
    )
    .join(" ");
};

/** Build a complete PDF for a dossier markdown document. */
export const buildPdfReport = ({ title, markdown, fontPath }) => {
  let cjk;
  const resolvedFont = fontPath ?? defaultCjkFont();
  if (resolvedFont !== undefined) {
    try {
      cjk = readTrueType(resolvedFont);
      cjk.used = new Map();
    } catch (error) {
      process.stderr.write(
        `pdf: CJK font not usable (${String(error)}); non-ASCII becomes "?"\n`,
      );
      cjk = undefined;
    }
  }

  const segments = segmentsOf(markdown);
  const body = [];
  let diagramIndex = 0;
  for (const segment of segments) {
    if (segment.kind === "diagram") {
      diagramIndex += 1;
      body.push({
        kind: "diagram",
        ops: renderDiagramPage(segment.lines, diagramIndex, cjk),
      });
    } else
      for (const line of segment.lines)
        for (const row of wrapLine(line))
          body.push({ kind: "line", line: row });
  }
  // Pages: text pages interleaved with diagram pages, in document order.
  const pages = [];
  let current = [];
  const flushText = () => {
    if (current.some((line) => line.trim().length > 0))
      pages.push({ kind: "text", lines: current });
    current = [];
  };
  for (const entry of body) {
    if (entry.kind === "diagram") {
      flushText();
      pages.push({ kind: "diagram", ops: entry.ops });
      continue;
    }
    if (current.length >= LINES_PER_PAGE) flushText();
    current.push(entry.line);
  }
  flushText();
  if (pages.length === 0) pages.push({ kind: "text", lines: [""] });

  const objects = [];
  const add = (body_) => {
    objects.push(body_);
    return objects.length;
  };
  const catalogId = add("");
  const pagesId = add("");
  const helveticaId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  let cjkFontId = 0;
  let cjkCidFontId = 0;
  let cjkDescriptorId = 0;
  let cjkToUnicodeId = 0;
  let cjkFileId = 0;
  if (cjk !== undefined) {
    cjkFontId = add("");
    cjkCidFontId = add("");
    cjkDescriptorId = add("");
    cjkToUnicodeId = add("");
    cjkFileId = add("");
  }
  const pageObjects = [];
  for (const page of pages) {
    const contentId = add("");
    const pageId = add("");
    pageObjects.push({ pageId, contentId, page });
  }
  objects[catalogId - 1] =
    "<< /Type /Catalog /Pages " + String(pagesId) + " 0 R >>";
  objects[pagesId - 1] =
    "<< /Type /Pages /Kids [" +
    pageObjects.map((entry) => `${String(entry.pageId)} 0 R`).join(" ") +
    `] /Count ${String(pageObjects.length)} >>`;

  const fontResources =
    cjk === undefined
      ? "/Font << /F1 " + String(helveticaId) + " 0 R >>"
      : `/Font << /F1 ${String(helveticaId)} 0 R /F2 ${String(cjkFontId)} 0 R >>`;

  pageObjects.forEach(({ pageId, contentId, page }) => {
    const content =
      page.kind === "diagram"
        ? page.ops.join("\n")
        : [
            "BT",
            `/F1 ${BODY_SIZE} Tf`,
            `${String(LINE_HEIGHT)} TL`,
            `1 0 0 1 ${String(MARGIN_X)} ${String(TOP_Y)} Tm`,
            ...page.lines.map((line) => `${lineRuns(line, cjk)} T*`),
            "ET",
          ].join("\n");
    objects[pageId - 1] =
      `<< /Type /Page /Parent ${String(pagesId)} 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources << ${fontResources} >> /Contents ${String(contentId)} 0 R >>`;
    objects[contentId - 1] =
      `<< /Length ${String(Buffer.byteLength(content, "latin1"))} >>\nstream\n${content}\nendstream`;
  });

  if (cjk !== undefined) {
    const scale = 1000 / cjk.unitsPerEm;
    const widths = [];
    for (const [gid, _code] of cjk.used)
      widths.push(`${String(gid)} [${Math.round(cjk.widthOf(gid) * scale)}]`);
    objects[cjkFontId - 1] =
      `<< /Type /Font /Subtype /Type0 /BaseFont /XTNACJK /Encoding /Identity-H /DescendantFonts [${String(cjkCidFontId)} 0 R] /ToUnicode ${String(cjkToUnicodeId)} 0 R >>`;
    objects[cjkCidFontId - 1] =
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /XTNACJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${String(cjkDescriptorId)} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${widths.join(" ")}] >>`;
    objects[cjkDescriptorId - 1] =
      `<< /Type /FontDescriptor /FontName /XTNACJK /Flags 4 /FontBBox [${cjk.bbox.map((value) => String(Math.round(value * scale))).join(" ")}] /ItalicAngle 0 /Ascent ${String(Math.round(cjk.ascent * scale))} /Descent ${String(Math.round(cjk.descent * scale))} /CapHeight ${String(Math.round(cjk.capHeight * scale))} /StemV 80 /FontFile2 ${String(cjkFileId)} 0 R >>`;
    const mappingRows = [...cjk.used].map(
      ([gid, code]) =>
        `<${gid.toString(16).padStart(4, "0").toUpperCase()}> <${code.toString(16).padStart(4, "0").toUpperCase()}>`,
    );
    const mappingBlocks = [];
    for (let start = 0; start < mappingRows.length; start += 100)
      mappingBlocks.push(
        `${String(Math.min(100, mappingRows.length - start))} beginbfchar\n${mappingRows
          .slice(start, start + 100)
          .join("\n")}\nendbfchar`,
      );
    const toUnicode = [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /Adobe-Identity-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000> <FFFF>",
      "endcodespacerange",
      ...(mappingBlocks.length > 0
        ? mappingBlocks
        : ["1 beginbfchar\n<0000> <0000>\nendbfchar"]),
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end",
    ].join("\n");
    objects[cjkToUnicodeId - 1] =
      `<< /Length ${String(Buffer.byteLength(toUnicode, "latin1"))} >>\nstream\n${toUnicode}\nendstream`;
    const compressed = deflateSync(cjk.bytes, { level: 9 });
    objects[cjkFileId - 1] = Buffer.concat([
      Buffer.from(
        `<< /Length ${String(compressed.length)} /Length1 ${String(cjk.bytes.length)} /Filter /FlateDecode >>\nstream\n`,
        "latin1",
      ),
      compressed,
      Buffer.from("\nendstream", "latin1"),
    ]);
  }

  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((object, index) => {
    offsets[index + 1] = offset;
    const body_ = Buffer.isBuffer(object)
      ? object
      : Buffer.from(String(object), "latin1");
    const head = Buffer.from(`${String(index + 1)} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, body_, tail);
    offset += head.length + body_.length + tail.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.length; id += 1)
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalogId)} 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`,
      "latin1",
    ),
  );
  return {
    bytes: Buffer.concat(chunks),
    font: resolvedFont,
    diagrams: diagramIndex,
    cjk,
  };
};
