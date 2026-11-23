const { query, queryOne, transaction, isUniqueViolation } = require("../db/database");
const { validateIncident } = require("./validation");
const { sendJson, parseId } = require("../lib/http-helpers");
const { resolveChangedBy } = require("../lib/current-user");
const { withSla } = require("../lib/sla");
const { parseSystemIds, setSystems } = require("../lib/systems");

const BOOLEAN_FIELDS = ["newgen_related", "estimated"];

const WRITABLE_FIELDS = [
  "incident_id",
  "cr",
  "business_unit_id",
  "requester_id",
  "title",
  "description",
  "priority_id",
  "stage_id",
  "status_id",
  "newgen_related",
  "estimated",
  "tech_owner_id",
  "dev_planned_start_date",
  "dev_planned_end_date",
  "qa_planned_start_date",
  "qa_planned_end_date",
  "uat_planned_start_date",
  "uat_planned_date",
  "cab_date",
  "deployment_planned_end_date",
  "closed_date",
  "rm_id",
];

// Fields that reference lookup tables -- the only fields the bulk-update
// endpoint is allowed to touch, since it exists specifically for editing
// lookup values across many records at once.
const LOOKUP_FIELDS = [
  "business_unit_id",
  "requester_id",
  "priority_id",
  "stage_id",
  "status_id",
  "tech_owner_id",
  "rm_id",
];

const BASE_COLUMNS = ["id", ...WRITABLE_FIELDS, "created_at", "updated_at", "created_by", "updated_by"]
  .map((c) => `inc.${c}`)
  .join(", ");

const LIST_SELECT = `
  SELECT
    ${BASE_COLUMNS},
    bu.name  AS business_unit,
    p.name   AS priority,
    s.name   AS stage,
    st.name  AS status,
    (SELECT STRING_AGG(tow.name, ', ') WITHIN GROUP (ORDER BY tow.name)
       FROM incident_tech_owners incto
       JOIN tech_owners tow ON tow.id = incto.tech_owner_id
      WHERE incto.incident_id = inc.id) AS tech_owner,
    (SELECT STRING_AGG(CAST(incto2.tech_owner_id AS NVARCHAR(10)), ',')
       FROM incident_tech_owners incto2
      WHERE incto2.incident_id = inc.id) AS tech_owner_ids,
    (SELECT STRING_AGG(sy.name, ', ') WITHIN GROUP (ORDER BY sy.name)
       FROM incident_systems incs
       JOIN systems sy ON sy.id = incs.system_id
      WHERE incs.incident_id = inc.id) AS system,
    (SELECT STRING_AGG(CAST(incs2.system_id AS NVARCHAR(10)), ',')
       FROM incident_systems incs2
      WHERE incs2.incident_id = inc.id) AS system_ids,
    re.name  AS requester,
    rm.name AS rm,
    (SELECT TOP 1 ic.body       FROM incident_comments ic WHERE ic.incident_id = inc.id ORDER BY ic.created_at DESC, ic.id DESC) AS last_comment,
    (SELECT TOP 1 ic.created_at FROM incident_comments ic WHERE ic.incident_id = inc.id ORDER BY ic.created_at DESC, ic.id DESC) AS last_comment_at
  FROM incidents inc
  LEFT JOIN business_units bu ON bu.id = inc.business_unit_id
  LEFT JOIN priorities p      ON p.id  = inc.priority_id
  LEFT JOIN stages s          ON s.id  = inc.stage_id
  LEFT JOIN statuses st       ON st.id = inc.status_id
  LEFT JOIN requesters re     ON re.id  = inc.requester_id
  LEFT JOIN rms rm            ON rm.id  = inc.rm_id
`;

function normalizeBody(body) {
  const out = {};
  for (const field of WRITABLE_FIELDS) {
    let value = body[field];
    if (BOOLEAN_FIELDS.includes(field)) {
      value = value ? 1 : 0;
    } else if (value === "" || value === undefined) {
      value = null;
    }
    out[field] = value;
  }
  return out;
}

// Accepts the multi tech-owner selection sent by the form (`tech_owner_ids`, an array of ids).
function parseTechOwnerIds(body) {
  const raw = body.tech_owner_ids;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

async function setTechOwners(tx, id, techOwnerIds) {
  await tx.query("DELETE FROM incident_tech_owners WHERE incident_id = @id", { id });
  for (const towId of techOwnerIds) {
    await tx.query(
      "INSERT INTO incident_tech_owners (incident_id, tech_owner_id) VALUES (@id, @towId)",
      { id, towId }
    );
  }
}

function recordHistory(tx, id, changeType, snapshot, changedBy) {
  return tx.query(
    `INSERT INTO incident_history (incident_id, change_type, snapshot_json, changed_by)
     VALUES (@id, @changeType, @snapshot, @changedBy)`,
    { id, changeType, snapshot: JSON.stringify(snapshot), changedBy: changedBy || null }
  );
}

async function checkUniqueness(data, excludeId = null) {
  const errors = [];
  const exclude = excludeId ? " AND id <> @excludeId" : "";
  if (data.incident_id) {
    const q = await queryOne(`SELECT id FROM incidents WHERE incident_id = @value${exclude}`, { value: data.incident_id, excludeId });
    if (q) errors.push(`Incident ID "${data.incident_id}" is already in use.`);
  }
  if (data.cr) {
    const q = await queryOne(`SELECT id FROM incidents WHERE cr = @value${exclude}`, { value: data.cr, excludeId });
    if (q) errors.push(`CR "${data.cr}" is already in use by another incident.`);
  }
  return errors;
}

const UNIQUE_RACE_MESSAGE = "Incident ID or CR is already in use by another incident.";

async function list(req, res) {
  const { rows } = await query(`${LIST_SELECT} ORDER BY inc.updated_at DESC, inc.id DESC`);
  sendJson(res, 200, await withSla(rows, "incidents"));
}

async function getOne(req, res, params) {
  const id = parseId(params.id);
  const row = id && (await queryOne(`${LIST_SELECT} WHERE inc.id = @id`, { id }));
  if (!row) return sendJson(res, 404, { error: "Not found." });
  sendJson(res, 200, (await withSla([row], "incidents"))[0]);
}

async function create(req, res, params, body) {
  const errors = validateIncident(body);
  if (errors.length) return sendJson(res, 400, { errors });

  const techOwnerIds = parseTechOwnerIds(body);
  const systemIds = parseSystemIds(body);
  const data = normalizeBody(body);
  data.tech_owner_id = techOwnerIds[0] || null;
  const uniqueErrors = await checkUniqueness(data);
  if (uniqueErrors.length) return sendJson(res, 400, { errors: uniqueErrors });

  const changedBy = resolveChangedBy(req, body.changed_by);
  const columns = WRITABLE_FIELDS.join(", ");
  const placeholders = WRITABLE_FIELDS.map((f) => `@${f}`).join(", ");
  try {
    const created = await transaction(async (tx) => {
      const { id } = await tx.queryOne(
        `INSERT INTO incidents (${columns}, created_by, updated_by)
         OUTPUT INSERTED.id
         VALUES (${placeholders}, @changedBy, @changedBy)`,
        { ...data, changedBy }
      );
      await setTechOwners(tx, id, techOwnerIds);
      await setSystems(tx, "incident_systems", "incident_id", id, systemIds);
      const row = await tx.queryOne(`${LIST_SELECT} WHERE inc.id = @id`, { id });
      await recordHistory(tx, id, "create", row, changedBy);
      return row;
    });
    sendJson(res, 201, created);
  } catch (err) {
    if (isUniqueViolation(err)) return sendJson(res, 400, { errors: [UNIQUE_RACE_MESSAGE] });
    throw err;
  }
}

async function update(req, res, params, body) {
  const id = parseId(params.id);
  const existing = id && (await queryOne("SELECT id FROM incidents WHERE id = @id", { id }));
  if (!existing) return sendJson(res, 404, { error: "Not found." });

  const errors = validateIncident(body);
  if (errors.length) return sendJson(res, 400, { errors });

  const techOwnerIds = parseTechOwnerIds(body);
  const systemIds = parseSystemIds(body);
  const data = normalizeBody(body);
  data.tech_owner_id = techOwnerIds[0] || null;
  const uniqueErrors = await checkUniqueness(data, id);
  if (uniqueErrors.length) return sendJson(res, 400, { errors: uniqueErrors });

  const changedBy = resolveChangedBy(req, body.changed_by);
  const setClause = WRITABLE_FIELDS.map((f) => `${f} = @${f}`).join(", ");
  try {
    const updated = await transaction(async (tx) => {
      await tx.query(
        `UPDATE incidents SET ${setClause}, updated_at = SYSUTCDATETIME(), updated_by = @changedBy WHERE id = @id`,
        { ...data, changedBy, id }
      );
      await setTechOwners(tx, id, techOwnerIds);
      await setSystems(tx, "incident_systems", "incident_id", id, systemIds);
      const row = await tx.queryOne(`${LIST_SELECT} WHERE inc.id = @id`, { id });
      await recordHistory(tx, id, "update", row, changedBy);
      return row;
    });
    sendJson(res, 200, updated);
  } catch (err) {
    if (isUniqueViolation(err)) return sendJson(res, 400, { errors: [UNIQUE_RACE_MESSAGE] });
    throw err;
  }
}

async function remove(req, res, params, body) {
  const id = parseId(params.id);
  const existing = id && (await queryOne("SELECT * FROM incidents WHERE id = @id", { id }));
  if (!existing) return sendJson(res, 404, { error: "Not found." });

  const changedBy = resolveChangedBy(req, body && body.changed_by);
  await transaction(async (tx) => {
    await recordHistory(tx, id, "delete", existing, changedBy);
    await tx.query("DELETE FROM incidents WHERE id = @id", { id });
  });
  res.writeHead(204).end();
}

async function bulkUpdate(req, res, params, body) {
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) return sendJson(res, 400, { error: "Select at least one record to update." });

  const rawFields = body.fields && typeof body.fields === "object" ? body.fields : {};
  const fieldNames = Object.keys(rawFields).filter((f) => LOOKUP_FIELDS.includes(f));
  if (!fieldNames.length) return sendJson(res, 400, { error: "No valid lookup fields to update." });

  const data = {};
  for (const f of fieldNames) {
    const v = rawFields[f];
    data[f] = v === "" || v === undefined || v === null ? null : Number(v);
    if (data[f] !== null && !Number.isInteger(data[f])) return sendJson(res, 400, { error: `Invalid value for ${f}.` });
  }

  const changedBy = resolveChangedBy(req, body.changed_by);
  const setClause = fieldNames.map((f) => `${f} = @${f}`).join(", ");
  const updateSql = `UPDATE incidents SET ${setClause}, updated_at = SYSUTCDATETIME(), updated_by = @changedBy WHERE id = @id`;

  let updated = 0;
  const errors = [];
  for (const id of ids) {
    try {
      const found = await transaction(async (tx) => {
        const { rowsAffected } = await tx.query(updateSql, { ...data, changedBy, id });
        if (!rowsAffected) return false;
        if (fieldNames.includes("tech_owner_id")) {
          await setTechOwners(tx, id, data.tech_owner_id ? [data.tech_owner_id] : []);
        }
        const updatedRow = await tx.queryOne(`${LIST_SELECT} WHERE inc.id = @id`, { id });
        await recordHistory(tx, id, "bulk-update", updatedRow, changedBy);
        return true;
      });
      if (found) updated++;
      else errors.push(`Record ${id} not found.`);
    } catch (err) {
      errors.push(`Record ${id}: ${err.message}`);
    }
  }

  sendJson(res, 200, { updated, total: ids.length, errors });
}

async function history(req, res, params) {
  const id = parseId(params.id);
  const { rows } = id
    ? await query("SELECT * FROM incident_history WHERE incident_id = @id ORDER BY changed_at DESC, id DESC", { id })
    : { rows: [] };
  sendJson(res, 200, rows);
}

async function listComments(req, res, params) {
  const id = parseId(params.id);
  const { rows } = id
    ? await query(
        "SELECT id, body, created_at, created_by FROM incident_comments WHERE incident_id = @id ORDER BY created_at ASC, id ASC",
        { id }
      )
    : { rows: [] };
  sendJson(res, 200, rows);
}

async function addComment(req, res, params, body) {
  const id = parseId(params.id);
  const exists = id && (await queryOne("SELECT 1 AS found FROM incidents WHERE id = @id", { id }));
  if (!exists) return sendJson(res, 404, { error: "Incident not found." });

  const text = (body.body || "").trim();
  if (!text) return sendJson(res, 400, { error: "Comment body is required." });

  const createdBy = resolveChangedBy(req, body.created_by);
  const comment = await queryOne(
    `INSERT INTO incident_comments (incident_id, body, created_by)
     OUTPUT INSERTED.id, INSERTED.body, INSERTED.created_at, INSERTED.created_by
     VALUES (@id, @text, @createdBy)`,
    { id, text, createdBy }
  );
  sendJson(res, 201, comment);
}

async function deleteComment(req, res, params) {
  const id = parseId(params.id);
  const commentId = parseId(params.commentId);
  const { rowsAffected } =
    id && commentId
      ? await query("DELETE FROM incident_comments WHERE id = @commentId AND incident_id = @id", { id, commentId })
      : { rowsAffected: 0 };
  if (!rowsAffected) return sendJson(res, 404, { error: "Comment not found." });
  res.writeHead(204).end();
}

async function exportData(req, res) {
  const [{ rows }, { rows: comments }] = await Promise.all([
    query(`${LIST_SELECT} ORDER BY inc.updated_at DESC, inc.id DESC`),
    query("SELECT incident_id, body, created_at FROM incident_comments ORDER BY created_at ASC, id ASC"),
  ]);
  const byIncident = new Map();
  for (const c of comments) {
    if (!byIncident.has(c.incident_id)) byIncident.set(c.incident_id, []);
    byIncident.get(c.incident_id).push(`[${c.created_at}] ${c.body}`);
  }
  const data = (await withSla(rows, "incidents")).map((r) => ({ ...r, all_comments: (byIncident.get(r.id) || []).join("\n") }));
  sendJson(res, 200, data);
}

// ---- Personal "My Follow-ups" bookmarks (per logged-in user) ----

async function listFollowedIds(req, res) {
  const { rows } = await query(
    "SELECT incident_id AS id FROM incident_follows WHERE user_id = @userId",
    { userId: req.user.id }
  );
  sendJson(res, 200, rows.map((r) => r.id));
}

async function follow(req, res, params) {
  const id = parseId(params.id);
  if (!id) return sendJson(res, 400, { error: "Invalid id." });
  const exists = await queryOne("SELECT 1 AS found FROM incidents WHERE id = @id", { id });
  if (!exists) return sendJson(res, 404, { error: "Not found." });

  await query(
    `IF NOT EXISTS (SELECT 1 FROM incident_follows WHERE user_id = @userId AND incident_id = @id)
     INSERT INTO incident_follows (user_id, incident_id) VALUES (@userId, @id)`,
    { userId: req.user.id, id }
  );
  res.writeHead(204).end();
}

async function unfollow(req, res, params) {
  const id = parseId(params.id);
  if (!id) return sendJson(res, 400, { error: "Invalid id." });
  await query("DELETE FROM incident_follows WHERE user_id = @userId AND incident_id = @id", {
    userId: req.user.id,
    id,
  });
  res.writeHead(204).end();
}

function register(router) {
  // static routes must come before :id to avoid ambiguity
  router.get("/api/incidents/export", exportData);
  router.get("/api/incidents/followed", listFollowedIds);
  router.get("/api/incidents", list);
  router.get("/api/incidents/:id", getOne);
  router.post("/api/incidents", create);
  router.post("/api/incidents/bulk-update", bulkUpdate);
  router.put("/api/incidents/:id", update);
  router.delete("/api/incidents/:id", remove);
  router.get("/api/incidents/:id/history", history);
  router.get("/api/incidents/:id/comments", listComments);
  router.post("/api/incidents/:id/comments", addComment);
  router.delete("/api/incidents/:id/comments/:commentId", deleteComment);
  router.post("/api/incidents/:id/follow", follow);
  router.delete("/api/incidents/:id/follow", unfollow);
}

module.exports = { register };
