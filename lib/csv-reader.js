// Dependency-free CSV parser. Handles quoted fields, embedded commas and
// newlines, escaped double-quotes (""), and both CRLF / LF line endings.
// Returns an array of rows, each row an array of string cells.

function parseCsv(text) {
  // Strip a leading UTF-8 BOM if present (Excel loves to add one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++; // consume CRLF as one break
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else {
      field += ch;
      sawAny = true;
    }
  }

  // Flush the final field/row if the file didn't end with a newline.
  if (sawAny || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing fully-empty rows.
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();

  return rows;
}

module.exports = { parseCsv };
