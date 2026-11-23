// Import & merge wizard backend.
//
// Pipeline: parse (csv/xlsx -> rows) -> analyze (map + classify each row as
// new / update / duplicate / invalid, with field-level diffs) -> commit
// (insert / update / skip per the user's decisions, auto-creating missing
// lookup values, writing entity history AND a full import batch history).
//
// Everything is re-validated server-side on commit; the browser's analysis is
// never trusted for the actual writes.

const { query, queryOne } = require("../db/database");
const { sendJson, parseId } = require("../lib/http-helpers");
const { parseCsv } = require("../lib/csv-reader");
const { parseXlsx } = require("../lib/xlsx-reader");
const { validateBusinessRequest, validateIncident, isValidDateString } = require("./validation");
const { resolveChangedBy } = require("../lib/current-user");

const MAX_ROWS = 20000;

// ---- Target (entity) definitions --------------------------------------

const BR_FIELDS = [
  { field: "br_no", label: "BR No", type: "text" },
  { field: "cr", label: "CR", type: "text" },
  { field: "submission_date", label: "Submission Date", type: "date" },
  { field: "title", label: "Title", type: "text", required: true },
  { field: "description", label: "Description", type: "text" },
  { field: "business_unit", label: "Business Unit", type: "lookup", table: "business_units", idField: "business_unit_id" },
  { field: "business_category", label: "Business Category", type: "lookup", table: "business_categories", idField: "business_category_id" },
  { field: "requester", label: "Requester", type: "lookup", table: "requesters", idField: "requester_id" },
  { field: "priority", label: "Priority", type: "lookup", table: "priorities", idField: "priority_id" },
  { field: "stage", label: "Stage", type: "lookup", table: "stages", idField: "stage_id" },
  { field: "status", label: "Status", type: "lookup", table: "statuses", idField: "status_id" },
  { field: "tech_owner", label: "Tech Owner", type: "lookup", table: "tech_owners", idField: "tech_owner_id" },
  { field: "rm", label: "RM", type: "lookup", table: "rms", idField: "rm_id" },
  { field: "regulator", label: "Regulator", type: "lookup", table: "regulators", idField: "regulator_id" },
  { field: "newgen_related", label: "Newgen Related", type: "bool" },
  { field: "estimated", label: "Estimated", type: "bool" },
  { field: "ba_required", label: "BA Required", type: "bool" },
  { field: "brd_assigned", label: "BRD Assigned", type: "bool" },
  { field: "regulatory", label: "Regulatory", type: "bool" },
  { field: "regulatory_deadline", label: "Regulatory Deadline", type: "date" },
  { field: "analysis_planned_start_date", label: "Analysis Planned Start Date", type: "date" },
  { field: "analysis_planned_end_date", label: "Analysis Planned End Date", type: "date" },
  { field: "dev_planned_start_date", label: "Dev Planned Start Date", type: "date" },
  { field: "dev_planned_end_date", label: "Dev Planned End Date", type: "date" },
  { field: "qa_planned_start_date", label: "QA Planned Start Date", type: "date" },
  { field: "qa_planned_end_date", label: "QA Planned End Date", type: "date" },
  { field: "uat_planned_start_date", label: "UAT Planned Start Date", type: "date" },
  { field: "uat_planned_date", label: "UAT Planned End Date", type: "date" },
  { field: "cab_date", label: "CAB Date", type: "date" },
  { field: "deployment_planned_end_date", label: "Deployment Planned End Date", type: "date" },
  { field: "closed_date", label: "Closed Date", type: "date" },
];

const INCIDENT_FIELDS = [
  { field: "incident_id", label: "Incident ID", type: "text" },
  { field: "cr", label: "CR", type: "text" },
  { field: "title", label: "Title", type: "text", required: true },
  { field: "description", label: "Description", type: "text" },
  { field: "business_unit", label: "Business Unit", type: "lookup", table: "business_units", idField: "business_unit_id" },
  { field: "requester", label: "Requester", type: "lookup", table: "requesters", idField: "requester_id" },
  { field: "priority", label: "Priority", type: "lookup", table: "priorities", idField: "priority_id" },
  { field: "stage", label: "Stage", type: "lookup", table: "stages", idField: "stage_id" },
  { field: "status", label: "Status", type: "lookup", table: "statuses", idField: "status_id" },
  { field: "tech_owner", label: "Tech Owner", type: "lookup", table: "tech_owners", idField: "tech_owner_id" },
  { field: "rm", label: "RM", type: "lookup", table: "rms", idField: "rm_id" },
  { field: "newgen_related", label: "Newgen Related", type: "bool" },
  { field: "estimated", label: "Estimated", type: "bool" },
  { field: "dev_planned_start_date", label: "Dev Planned Start Date", type: "date" },
  { field: "dev_planned_end_date", label: "Dev Planned End Date", type: "date" },
  { field: "qa_planned_start_date", label: "QA Planned Start Date", type: "date" },
  { field: "qa_planned_end_date", label: "QA Planned End Date", type: "date" },
  { field: "uat_planned_start_date", label: "UAT Planned Start Date", type: "date" },
  { field: "uat_planned_date", label: "UAT Planned End Date", type: "date" },
  { field: "cab_date", label: "CAB Date", type: "date" },
  { field: "deployment_planned_end_date", label: "Deployment Planned End Date", type: "date" },
  { field: "closed_date", label: "Closed Date", type: "date" },
];

// Storage columns written on insert/update (col + whether it's a 0/1 boolean).
const BR_ENTITY_COLS = [
  ["br_no", 0], ["cr", 0], ["submission_date", 0], ["business_unit_id", 0], ["business_category_id", 0], ["requester_id", 0], ["title", 0], ["description", 0],
  ["priority_id", 0], ["stage_id", 0], ["status_id", 0], ["newgen_related", 1], ["estimated", 1],
  ["ba_required", 1], ["brd_assigned", 1], ["tech_owner_id", 0], ["regulatory", 1], ["regulator_id", 0],
  ["regulatory_deadline", 0], ["analysis_planned_start_date", 0], ["analysis_planned_end_date", 0], ["dev_planned_start_date", 0], ["dev_planned_end_date", 0],
  ["qa_planned_start_date", 0], ["qa_planned_end_date", 0], ["uat_planned_start_date", 0], ["uat_planned_date", 0],
  ["cab_date", 0], ["deployment_planned_end_date", 0], ["rm_id", 0],
  ["closed_date", 0],
].map(([col, bool]) => ({ col, bool: !!bool }));

const INCIDENT_ENTITY_COLS = [
  ["incident_id", 0], ["cr", 0], ["business_unit_id", 0], ["requester_id", 0], ["title", 0], ["description", 0],
  ["priority_id", 0], ["stage_id", 0], ["status_id", 0], ["newgen_related", 1], ["estimated", 1],
  ["tech_owner_id", 0], ["dev_planned_start_date", 0], ["dev_planned_end_date", 0], ["qa_planned_start_date", 0],
  ["qa_planned_end_date", 0], ["uat_planned_start_date", 0], ["uat_planned_date", 0],
  ["cab_date", 0], ["deployment_planned_end_date", 0], ["rm_id", 0],
  ["closed_date", 0],
].map(([col, bool]) => ({ col, bool: !!bool }));

const TARGETS = {
  business_requests: {
    table: "business_requests",
    label: "Business Requests",
    historyTable: "business_request_history",
    historyKey: "business_request_id",
    idKeys: [{ field: "br_no", label: "BR No" }, { field: "cr", label: "CR" }],
    fields: BR_FIELDS,
    entityCols: BR_ENTITY_COLS,
    validate: validateBusinessRequest,
    techOwnerJunction: { table: "business_request_tech_owners", key: "business_request_id" },
  },
  incidents: {
    table: "incidents",
    label: "Incidents",
    historyTable: "incident_history",
    historyKey: "incident_id",
    idKeys: [{ field: "incident_id", label: "Incident ID" }, { field: "cr", label: "CR" }],
    fields: INCIDENT_FIELDS,
    entityCols: INCIDENT_ENTITY_COLS,
    validate: validateIncident,
    techOwnerJunction: { table: "incident_tech_owners", key: "incident_id" },
  },
};

// Header aliases used to auto-detect column mappings.
const FIELD_ALIASES = {
  br_no: ["brno", "br", "brnumber", "requestno", "requestnumber", "businessrequestno"],
  incident_id: ["incidentid", "incidentno", "incidentnumber", "incident", "inc", "id"],
  cr: ["cr", "crno", "crnumber", "changerequest", "changerequestno"],
  submission_date: ["submissiondate", "dateofsubmission", "submitted", "submitteddate", "requestdate"],
  title: ["title", "subject", "summary", "requesttitle", "name"],
  description: ["description", "desc", "details", "detail"],
  business_unit: ["businessunit", "bu", "department", "dept", "unit"],
  business_category: ["businesscategory", "category", "bucategory", "requestcategory"],
  requester: ["requester", "requestedby", "requestor", "raisedby"],
  priority: ["priority", "prio"],
  stage: ["stage", "phase"],
  status: ["status", "state"],
  tech_owner: ["techowner", "technicalowner", "owner", "developer", "assignedto"],
  rm: ["rm", "relationshipmanager", "relmanager"],
  regulator: ["regulator", "regulatorybody"],
  newgen_related: ["newgenrelated", "newgen"],
  estimated: ["estimated", "isestimated"],
  ba_required: ["barequired", "ba", "businessanalyst"],
  brd_assigned: ["brdassigned", "brd"],
  regulatory: ["regulatory", "isregulatory"],
  regulatory_deadline: ["regulatorydeadline", "regdeadline"],
  analysis_planned_start_date: ["analysisplannedstartdate", "analysisstartdate", "analysisstart"],
  analysis_planned_end_date: ["analysisplannedenddate", "analysisplanned", "analysisdate", "analysis"],
  dev_planned_start_date: ["devplannedstartdate", "devstartdate", "devstart"],
  dev_planned_end_date: ["devplannedenddate", "devplanned", "devdate", "development", "dev"],
  qa_planned_start_date: ["qaplannedstartdate", "qastartdate", "qastart"],
  qa_planned_end_date: ["qaplannedenddate", "qaplanned", "qadate", "qa", "testing"],
  uat_planned_start_date: ["uatplannedstartdate", "uatstartdate", "uatstart"],
  uat_planned_date: ["uatplannedenddate", "uatplanneddate", "uatplanned", "uatdate", "uat"],
  cab_date: ["cabdate", "cab", "changeadvisoryboarddate", "cabapprovaldate"],
  deployment_planned_end_date: ["deploymentplannedenddate", "deploymentplanned", "deploydate", "deployment", "deploy", "golive"],
  closed_date: ["closeddate", "closedon", "closuredate", "completeddate", "completiondate", "resolveddate"],
};

// ---- Small utilities ---------------------------------------------------

function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseBool(v) {
  if (v === undefined || v === null) return 0;
  const s = String(v).trim().toLowerCase();
  return ["1", "y", "yes", "true", "t", "x", "\u2713", "checked", "on"].includes(s) ? 1 : 0;
}

function normalizeDate(v) {
  if (v === undefined || v === null) return { value: null };
  const s = String(v).trim();
  if (s === "") return { value: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidDateString(s) ? { value: s } : { error: `"${s}" is not a valid date` };
  if (/^\d+(\.\d+)?$/.test(s)) {
    const ms = Math.round(parseFloat(s)) * 86400000 + Date.UTC(1899, 11, 30);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return { value: d.toISOString().slice(0, 10) };
  }
  const m = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
  if (m) {
    let [, a, b, c] = m;
    let yyyy, mm, dd;
    if (a.length === 4) {
      yyyy = a; mm = b; dd = c;
    } else {
      // Ambiguous: assume DD/MM/YYYY, but swap if the first part can't be a day.
      yyyy = c; dd = a; mm = b;
      if (parseInt(a, 10) > 12 && parseInt(b, 10) <= 12) { dd = a; mm = b; }
      else if (parseInt(b, 10) > 12) { mm = a; dd = b; }
    }
    const iso = `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (isValidDateString(iso)) return { value: iso };
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { value: d.toISOString().slice(0, 10) };
  return { error: `"${s}" is not a recognizable date` };
}

// Mutable lookup maps (name<->id) loaded once per request and shared across its rows.
class Lookups {
  constructor() { this.maps = {}; }
  async load() {
    const tables = new Set();
    for (const def of Object.values(TARGETS)) {
      for (const f of def.fields) if (f.type === "lookup") tables.add(f.table);
    }
    await Promise.all([...tables].map(async (table) => {
      const byName = new Map();
      const byId = new Map();
      const { rows } = await query(`SELECT id, name FROM ${table}`);
      for (const r of rows) {
        byName.set(String(r.name).trim().toLowerCase(), r);
        byId.set(r.id, r.name);
      }
      this.maps[table] = { byName, byId };
    }));
    return this;
  }
  _map(table) {
    return this.maps[table];
  }
  resolve(table, name) {
    const n = String(name ?? "").trim();
    if (!n) return { id: null, name: "" };
    const hit = this._map(table).byName.get(n.toLowerCase());
    return hit ? { id: hit.id, name: hit.name } : { id: null, name: n, missing: true };
  }
  nameFor(table, id) {
    if (id == null) return "";
    return this._map(table).byId.get(id) || "";
  }
  async create(table, name) {
    const clean = String(name).trim();
    const { id } = await queryOne(`INSERT INTO ${table} (name) OUTPUT INSERTED.id VALUES (@name)`, { name: clean });
    const rec = { id, name: clean };
    this._map(table).byName.set(clean.toLowerCase(), rec);
    this._map(table).byId.set(rec.id, clean);
    return rec;
  }
}

// ---- Parsing -----------------------------------------------------------

function decodeAndParse(filename, contentBase64) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  const buf = Buffer.from(contentBase64 || "", "base64");
  let matrix;
  let fileType;
  if (ext === "csv" || ext === "txt") {
    matrix = parseCsv(buf.toString("utf8"));
    fileType = "csv";
  } else if (ext === "xlsx") {
    matrix = parseXlsx(buf);
    fileType = "xlsx";
  } else {
    const err = new Error("Unsupported file type. Please upload a .xlsx or .csv file.");
    err.statusCode = 400;
    throw err;
  }

  if (!matrix.length) return { fileType, headers: [], rows: [] };

  const headers = matrix[0].map((h, i) => (String(h).trim() || `Column ${i + 1}`));
  const rows = [];
  for (let i = 1; i < matrix.length && rows.length < MAX_ROWS; i++) {
    const arr = matrix[i];
    if (arr.every((c) => String(c).trim() === "")) continue;
    const obj = {};
    headers.forEach((h, j) => { obj[h] = arr[j] !== undefined ? arr[j] : ""; });
    rows.push(obj);
  }
  return { fileType, headers, rows };
}

function suggestMapping(target, headers) {
  const def = TARGETS[target];
  const normHeaders = headers.map((h) => ({ header: h, norm: normalizeHeader(h) }));
  const used = new Set();
  const mapping = {};
  for (const f of def.fields) {
    const candidates = [normalizeHeader(f.field), normalizeHeader(f.label), ...(FIELD_ALIASES[f.field] || [])];
    const hit = normHeaders.find((h) => !used.has(h.header) && candidates.includes(h.norm));
    if (hit) {
      mapping[f.field] = hit.header;
      used.add(hit.header);
    } else {
      mapping[f.field] = null;
    }
  }
  return mapping;
}

// ---- Mapping + classification -----------------------------------------

function mapRow(target, mapping, row) {
  const def = TARGETS[target];
  const mapped = {};
  for (const f of def.fields) {
    const header = mapping[f.field];
    if (header && Object.prototype.hasOwnProperty.call(row, header)) {
      mapped[f.field] = row[header];
    }
  }
  return mapped;
}

function buildRecord(target, mapped, lookups) {
  const def = TARGETS[target];
  const store = {};
  const display = {};
  const errors = [];
  const newLookups = [];
  const mappedFields = new Set();

  for (const f of def.fields) {
    if (!Object.prototype.hasOwnProperty.call(mapped, f.field)) continue;
    mappedFields.add(f.field);
    const raw = mapped[f.field];

    if (f.type === "lookup") {
      const r = lookups.resolve(f.table, raw);
      store[f.idField] = r.id;
      display[f.field] = r.name;
      if (r.missing) newLookups.push({ field: f.field, label: f.label, table: f.table, idField: f.idField, name: r.name });
    } else if (f.type === "bool") {
      store[f.field] = parseBool(raw);
      display[f.field] = store[f.field] ? "Yes" : "No";
    } else if (f.type === "date") {
      const d = normalizeDate(raw);
      if (d.error) errors.push(`${f.label}: ${d.error}`);
      store[f.field] = d.value ?? null;
      display[f.field] = d.value || "";
    } else {
      const s = raw == null ? null : String(raw).trim();
      store[f.field] = s === "" ? null : s;
      display[f.field] = s || "";
    }
  }
  return { store, display, errors, newLookups, mappedFields };
}

function keyOf(target, store) {
  for (const k of TARGETS[target].idKeys) {
    const val = store[k.field];
    if (val != null && String(val).trim() !== "") return { field: k.field, label: k.label, value: String(val).trim() };
  }
  return { field: null, label: null, value: "" };
}

async function findExisting(target, store) {
  const def = TARGETS[target];
  for (const k of def.idKeys) {
    const val = store[k.field];
    if (val != null && String(val).trim() !== "") {
      const row = await queryOne(`SELECT TOP 1 * FROM ${def.table} WHERE ${k.field} = @value ORDER BY id`, { value: String(val).trim() });
      if (row) return { row, matchedBy: k.label };
    }
  }
  return null;
}

function displayForExisting(lookups, row, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === "lookup") out[f.field] = lookups.nameFor(f.table, row[f.idField]);
    else if (f.type === "bool") out[f.field] = row[f.field] ? "Yes" : "No";
    else out[f.field] = row[f.field] == null ? "" : String(row[f.field]);
  }
  return out;
}

function computeDiffs(target, rec, existingRow, lookups) {
  const def = TARGETS[target];
  const diffs = [];
  for (const f of def.fields) {
    if (!rec.mappedFields.has(f.field)) continue;
    let changed = false;
    let currentDisp;
    let uploadedDisp;

    if (f.type === "lookup") {
      currentDisp = lookups.nameFor(f.table, existingRow[f.idField]);
      uploadedDisp = rec.display[f.field] || "";
      changed = currentDisp.trim().toLowerCase() !== uploadedDisp.trim().toLowerCase();
    } else if (f.type === "bool") {
      const cur = existingRow[f.field] ? 1 : 0;
      const up = rec.store[f.field] ? 1 : 0;
      changed = cur !== up;
      currentDisp = cur ? "Yes" : "No";
      uploadedDisp = up ? "Yes" : "No";
    } else {
      const cur = existingRow[f.field] == null ? "" : String(existingRow[f.field]).trim();
      const up = rec.store[f.field] == null ? "" : String(rec.store[f.field]).trim();
      changed = cur !== up;
      currentDisp = cur;
      uploadedDisp = up;
    }
    if (changed) diffs.push({ field: f.field, label: f.label, current: currentDisp, uploaded: uploadedDisp });
  }
  return diffs;
}

async function classifyRecord(target, rowIndex, mapped, lookups) {
  const def = TARGETS[target];
  const rec = buildRecord(target, mapped, lookups);
  const key = keyOf(target, rec.store);
  const mappedFieldDefs = def.fields.filter((f) => rec.mappedFields.has(f.field));
  const uploaded = {};
  for (const f of mappedFieldDefs) uploaded[f.field] = rec.display[f.field] || "";

  const base = {
    rowIndex,
    key: key.value,
    keyField: key.field,
    title: rec.store.title || "",
    uploaded,
    newLookups: rec.newLookups,
    mappedFields: [...rec.mappedFields],
  };

  if (rec.errors.length) {
    return { ...base, outcome: "invalid", suggestedAction: "skip", entityId: null, diffs: [], errors: rec.errors };
  }

  const existing = await findExisting(target, rec.store);
  if (!existing) {
    if (!rec.store.title) {
      return { ...base, outcome: "invalid", suggestedAction: "skip", entityId: null, diffs: [], errors: ["Title is required to insert a new record."] };
    }
    return { ...base, outcome: "new", suggestedAction: "insert", entityId: null, diffs: [], errors: [], current: {} };
  }

  const diffs = computeDiffs(target, rec, existing.row, lookups);
  const current = displayForExisting(lookups, existing.row, mappedFieldDefs);
  if (diffs.length === 0) {
    return { ...base, outcome: "duplicate", suggestedAction: "skip", entityId: existing.row.id, matchedBy: existing.matchedBy, diffs: [], errors: [], current };
  }
  return { ...base, outcome: "update", suggestedAction: "update", entityId: existing.row.id, matchedBy: existing.matchedBy, diffs, errors: [], current };
}

function summarize(records) {
  const s = { total: records.length, new: 0, update: 0, duplicate: 0, invalid: 0 };
  for (const r of records) {
    if (r.outcome === "new") s.new++;
    else if (r.outcome === "update") s.update++;
    else if (r.outcome === "duplicate") s.duplicate++;
    else if (r.outcome === "invalid") s.invalid++;
  }
  return s;
}

// ---- Commit helpers ----------------------------------------------------

async function applyLookupCreation(target, rec, lookups) {
  const def = TARGETS[target];
  for (const f of def.fields) {
    if (f.type !== "lookup" || !rec.mappedFields.has(f.field)) continue;
    const name = rec.display[f.field];
    if (name && rec.store[f.idField] == null) {
      rec.store[f.idField] = (await lookups.create(f.table, name)).id;
    }
  }
}

function buildEntityBody(target, rec, existingRow) {
  const def = TARGETS[target];
  const body = {};
  for (const { col, bool } of def.entityCols) {
    if (existingRow) body[col] = existingRow[col];
    else body[col] = bool ? 0 : null;
  }
  // Overlay only the columns that were actually mapped from the file.
  Object.assign(body, rec.store);
  return body;
}

// Keeps the multi tech-owner junction table in sync with the single tech_owner_id
// column imported rows carry (import only ever assigns one owner per row).
async function syncTechOwnerJunction(target, id, techOwnerId) {
  const def = TARGETS[target];
  if (!def.techOwnerJunction) return;
  const { table, key } = def.techOwnerJunction;
  await query(`DELETE FROM ${table} WHERE ${key} = @id`, { id });
  if (techOwnerId) await query(`INSERT INTO ${table} (${key}, tech_owner_id) VALUES (@id, @techOwnerId)`, { id, techOwnerId });
}

async function insertEntity(target, body, changedBy) {
  const def = TARGETS[target];
  const cols = def.entityCols.map((c) => c.col);
  const placeholders = cols.map((c) => `@${c}`).join(", ");
  const { id } = await queryOne(
    `INSERT INTO ${def.table} (${cols.join(", ")}, created_by, updated_by)
     OUTPUT INSERTED.id
     VALUES (${placeholders}, @changedBy, @changedBy)`,
    { ...body, changedBy }
  );
  await syncTechOwnerJunction(target, id, body.tech_owner_id);
  await recordEntityHistory(target, id, "create", changedBy);
  return id;
}

async function updateEntity(target, id, body, changedBy) {
  const def = TARGETS[target];
  const setClause = def.entityCols.map((c) => `${c.col} = @${c.col}`).join(", ");
  await query(
    `UPDATE ${def.table} SET ${setClause}, updated_at = SYSUTCDATETIME(), updated_by = @changedBy WHERE id = @id`,
    { ...body, changedBy, id }
  );
  await syncTechOwnerJunction(target, id, body.tech_owner_id);
  await recordEntityHistory(target, id, "update", changedBy);
}

async function recordEntityHistory(target, id, changeType, changedBy) {
  const def = TARGETS[target];
  const snapshot = await queryOne(`SELECT * FROM ${def.table} WHERE id = @id`, { id });
  await query(
    `INSERT INTO ${def.historyTable} (${def.historyKey}, change_type, snapshot_json, changed_by) VALUES (@id, @changeType, @snapshot, @changedBy)`,
    { id, changeType, snapshot: JSON.stringify(snapshot), changedBy: changedBy || null }
  );
}

async function keyConflict(target, store, excludeId) {
  const def = TARGETS[target];
  for (const k of def.idKeys) {
    const val = store[k.field];
    if (val == null || String(val).trim() === "") continue;
    const row = await queryOne(
      `SELECT TOP 1 id FROM ${def.table} WHERE ${k.field} = @value${excludeId ? " AND id <> @excludeId" : ""}`,
      { value: String(val).trim(), excludeId: excludeId || null }
    );
    if (row) return `${k.label} "${String(val).trim()}" is already used by another record.`;
  }
  return null;
}

// ---- HTTP handlers -----------------------------------------------------

function fields(req, res) {
  const out = {};
  for (const [key, def] of Object.entries(TARGETS)) {
    out[key] = { label: def.label, idKeys: def.idKeys, fields: def.fields.map((f) => ({ field: f.field, label: f.label, type: f.type, required: !!f.required })) };
  }
  sendJson(res, 200, out);
}

function parse(req, res, params, body) {
  const { filename, contentBase64, target } = body || {};
  if (!contentBase64) return sendJson(res, 400, { error: "No file content received." });
  const parsed = decodeAndParse(filename, contentBase64);
  const suggestion = target && TARGETS[target] ? suggestMapping(target, parsed.headers) : null;
  sendJson(res, 200, { fileType: parsed.fileType, filename: filename || "", headers: parsed.headers, rows: parsed.rows, totalRows: parsed.rows.length, suggestedMapping: suggestion });
}

async function analyze(req, res, params, body) {
  const { target, mapping, rows } = body || {};
  if (!TARGETS[target]) return sendJson(res, 400, { error: "Unknown import target." });
  if (!Array.isArray(rows)) return sendJson(res, 400, { error: "No rows to analyze." });
  if (rows.length > MAX_ROWS) return sendJson(res, 400, { error: `Too many rows (max ${MAX_ROWS}).` });

  const lookups = await new Lookups().load();
  const records = [];
  for (let i = 0; i < rows.length; i++) {
    records.push(await classifyRecord(target, i, mapRow(target, mapping || {}, rows[i]), lookups));
  }
  sendJson(res, 200, { target, records, summary: summarize(records) });
}

async function commit(req, res, params, body) {
  const { target, filename, fileType, mapping, rows, decisions } = body || {};
  if (!TARGETS[target]) return sendJson(res, 400, { error: "Unknown import target." });
  if (!Array.isArray(rows)) return sendJson(res, 400, { error: "No rows to import." });
  if (rows.length > MAX_ROWS) return sendJson(res, 400, { error: `Too many rows (max ${MAX_ROWS}).` });

  const changedBy = resolveChangedBy(req, body && body.changed_by);
  const decisionMap = decisions || {};
  const lookups = await new Lookups().load();

  const { id: batchId } = await queryOne(
    `INSERT INTO import_batches (filename, file_type, target, created_by, total_rows)
     OUTPUT INSERTED.id
     VALUES (@filename, @fileType, @target, @changedBy, @total)`,
    { filename: filename || null, fileType: fileType || null, target, changedBy, total: rows.length }
  );

  const counts = { new: 0, updated: 0, duplicate: 0, skipped: 0, invalid: 0, error: 0 };
  const errors = [];
  const rowSql = `INSERT INTO import_batch_rows (batch_id, row_index, action, outcome, entity_id, key_value, title, diff_json, message, raw_json)
     VALUES (@batch_id, @row_index, @action, @outcome, @entity_id, @key_value, @title, @diff_json, @message, @raw_json)`;

  for (let i = 0; i < rows.length; i++) {
    const mapped = mapRow(target, mapping || {}, rows[i]);
    const cls = await classifyRecord(target, i, mapped, lookups);
    const rec = buildRecord(target, mapped, lookups);
    let action = decisionMap[String(i)] || decisionMap[i] || cls.suggestedAction;
    let outcome = "skipped";
    let message = null;
    let entityId = cls.entityId || null;

    try {
      if (cls.outcome === "invalid") {
        action = "skip";
        outcome = "invalid";
        message = (cls.errors || []).join(" ");
        counts.invalid++;
      } else if (action === "skip") {
        outcome = cls.outcome === "duplicate" ? "duplicate" : "skipped";
        if (outcome === "duplicate") counts.duplicate++; else counts.skipped++;
      } else if (action === "insert") {
        await applyLookupCreation(target, rec, lookups);
        const conflict = await keyConflict(target, rec.store, null);
        const validationErrors = TARGETS[target].validate(buildEntityBody(target, rec, null));
        if (conflict) throw new Error(conflict);
        if (validationErrors.length) throw new Error(validationErrors.join(" "));
        entityId = await insertEntity(target, buildEntityBody(target, rec, null), changedBy);
        outcome = "new";
        counts.new++;
      } else if (action === "update") {
        const existing = await findExisting(target, rec.store);
        if (!existing) throw new Error("No matching record found to update.");
        entityId = existing.row.id;
        await applyLookupCreation(target, rec, lookups);
        const merged = buildEntityBody(target, rec, existing.row);
        const conflict = await keyConflict(target, merged, existing.row.id);
        const validationErrors = TARGETS[target].validate(merged);
        if (conflict) throw new Error(conflict);
        if (validationErrors.length) throw new Error(validationErrors.join(" "));
        await updateEntity(target, existing.row.id, merged, changedBy);
        outcome = "updated";
        counts.updated++;
      }
    } catch (err) {
      outcome = "error";
      message = err.message;
      counts.error++;
      errors.push({ rowIndex: i, key: cls.key, message: err.message });
    }

    await query(rowSql, {
      batch_id: batchId,
      row_index: i,
      action,
      outcome,
      entity_id: entityId,
      key_value: cls.key || null,
      title: cls.title || null,
      diff_json: cls.diffs && cls.diffs.length ? JSON.stringify(cls.diffs) : null,
      message,
      raw_json: JSON.stringify(mapped),
    });
  }

  const summary = { total: rows.length, ...counts };
  await query(
    `UPDATE import_batches SET new_count=@new, updated_count=@updated, duplicate_count=@duplicate,
       skipped_count=@skipped, invalid_count=@invalid, error_count=@error, summary_json=@summary_json WHERE id=@id`,
    { ...counts, summary_json: JSON.stringify(summary), id: batchId }
  );

  sendJson(res, 200, { batchId, summary, errors });
}

async function history(req, res) {
  const { rows } = await query("SELECT TOP 200 * FROM import_batches ORDER BY created_at DESC, id DESC");
  sendJson(res, 200, rows);
}

async function historyDetail(req, res, params) {
  const id = parseId(params.id);
  const batch = id && (await queryOne("SELECT * FROM import_batches WHERE id = @id", { id }));
  if (!batch) return sendJson(res, 404, { error: "Import batch not found." });
  const { rows } = await query("SELECT * FROM import_batch_rows WHERE batch_id = @id ORDER BY row_index ASC", { id });
  sendJson(res, 200, { batch, rows });
}

function register(router) {
  router.get("/api/import/fields", fields);
  router.post("/api/import/parse", parse);
  router.post("/api/import/analyze", analyze);
  router.post("/api/import/commit", commit);
  router.get("/api/import/history", history);
  router.get("/api/import/history/:id", historyDetail);
}

module.exports = { register };
