// Dependency-free .xlsx reader. An .xlsx file is a ZIP archive of XML parts;
// we unzip the needed parts with Node's built-in zlib (no native modules) and
// parse just enough XML to return the first worksheet as rows of strings.
//
// Supported: shared strings, inline strings, numbers, booleans, and Excel
// date serials (converted to YYYY-MM-DD when a cell carries a date number).
// This targets the well-formed output that Excel / LibreOffice / exporters
// produce; it is not a general-purpose spreadsheet engine.

const zlib = require("zlib");

// ---- Minimal ZIP reader ------------------------------------------------

function findEndOfCentralDirectory(buf) {
  // EOCD signature 0x06054b50, scanned from the end (comment may follow it).
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Not a valid .xlsx file (missing ZIP end-of-central-directory).");
}

function readZipEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break; // central dir header sig
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    // Jump to the local header to find where the actual data starts.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = Buffer.from(compData); // stored
    else if (method === 8) content = zlib.inflateRawSync(compData); // deflate
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);

    entries.set(name, content);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---- Tiny XML helpers --------------------------------------------------

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // must be last
}

function getAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function columnLetterToIndex(ref) {
  const letters = ref.replace(/[0-9]/g, "");
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1; // 0-based
}

// ---- Shared strings ----------------------------------------------------

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner))) text += t[1];
    out.push(decodeXmlEntities(text));
  }
  return out;
}

// ---- Date detection (Excel serial numbers) -----------------------------

function excelSerialToISO(serial) {
  // Excel's epoch is 1899-12-30 (it wrongly treats 1900 as a leap year).
  const ms = Math.round(serial) * 86400000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  return d.toISOString().slice(0, 10);
}

// Style indexes whose number format is a date, discovered from styles.xml.
function parseDateStyleIndexes(stylesXml) {
  const dateStyleIdx = new Set();
  if (!stylesXml) return dateStyleIdx;

  // Custom number formats that look like dates.
  const dateFmtIds = new Set();
  const fmtRe = /<numFmt\b[^>]*\/>/g;
  let f;
  while ((f = fmtRe.exec(stylesXml))) {
    const code = (getAttr(f[0], "formatCode") || "").toLowerCase();
    const id = getAttr(f[0], "numFmtId");
    if (id && /[dmy]/.test(code) && !code.includes("[")) dateFmtIds.add(id);
  }
  // Built-in date format ids (14-22, 45-47).
  for (const id of [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]) dateFmtIds.add(String(id));

  const cellXfsMatch = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfsMatch) return dateStyleIdx;
  const xfRe = /<xf\b[^>]*\/?>/g;
  let xf;
  let i = 0;
  while ((xf = xfRe.exec(cellXfsMatch[1]))) {
    const numFmtId = getAttr(xf[0], "numFmtId");
    if (numFmtId && dateFmtIds.has(numFmtId)) dateStyleIdx.add(i);
    i++;
  }
  return dateStyleIdx;
}

// ---- Worksheet ---------------------------------------------------------

function resolveFirstSheetPath(entries) {
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) return "xl/worksheets/sheet1.xml";

  const firstSheet = workbook.toString("utf8").match(/<sheet\b[^>]*>/);
  const rid = firstSheet ? getAttr(firstSheet[0], "r:id") : null;
  if (!rid) return "xl/worksheets/sheet1.xml";

  const relsXml = rels.toString("utf8");
  const relRe = /<Relationship\b[^>]*>/g;
  let r;
  while ((r = relRe.exec(relsXml))) {
    if (getAttr(r[0], "Id") === rid) {
      let target = getAttr(r[0], "Target") || "";
      target = target.replace(/^\//, "").replace(/^xl\//, "");
      return "xl/" + target;
    }
  }
  return "xl/worksheets/sheet1.xml";
}

function parseWorksheet(xml, sharedStrings, dateStyleIdx) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cellRe.exec(rowMatch[1]))) {
      const attrs = c[1];
      const inner = c[2] || "";
      const ref = getAttr(attrs, "r");
      const type = getAttr(attrs, "t");
      const styleIdx = getAttr(attrs, "s");
      const colIdx = ref ? columnLetterToIndex(ref) : cells.length;

      let value = "";
      if (type === "inlineStr") {
        const t = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = t ? decodeXmlEntities(t[1]) : "";
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        const raw = v ? v[1] : "";
        if (type === "s") {
          value = sharedStrings[parseInt(raw, 10)] ?? "";
        } else if (type === "str") {
          value = decodeXmlEntities(raw);
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else if (raw !== "" && styleIdx !== null && dateStyleIdx.has(parseInt(styleIdx, 10))) {
          value = excelSerialToISO(parseFloat(raw));
        } else {
          value = raw;
        }
      }

      cells[colIdx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}

function parseXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const sharedStrings = parseSharedStrings(
    entries.get("xl/sharedStrings.xml") ? entries.get("xl/sharedStrings.xml").toString("utf8") : ""
  );
  const dateStyleIdx = parseDateStyleIndexes(
    entries.get("xl/styles.xml") ? entries.get("xl/styles.xml").toString("utf8") : ""
  );

  const sheetPath = resolveFirstSheetPath(entries);
  const sheetBuf = entries.get(sheetPath) || entries.get("xl/worksheets/sheet1.xml");
  if (!sheetBuf) throw new Error("No worksheet found in the .xlsx file.");

  const rows = parseWorksheet(sheetBuf.toString("utf8"), sharedStrings, dateStyleIdx);

  // Normalize ragged rows to the widest row so headers line up with cells.
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push("");

  // Drop trailing empty rows.
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();

  return rows;
}

module.exports = { parseXlsx };
