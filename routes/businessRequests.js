const { query, queryOne, transaction, isUniqueViolation } = require("../db/database");
const { validateBusinessRequest } = require("./validation");
const { sendJson, parseId } = require("../lib/http-helpers");
const { resolveChangedBy } = require("../lib/current-user");
const { withSla } = require("../lib/sla");
const { syncLegacyRequest } = require("../lib/sla-service");
const { parseSystemIds, setSystems } = require("../lib/systems");

const BOOLEAN_FIELDS = ["newgen_related", "estimated", "ba_required", "brd_assigned", "regulatory"];

const WRITABLE_FIELDS = [
  "br_no",
  "cr",
  "submission_date",
  "business_unit_id",
  "business_category_id",
  "requester_id",
  "title",
  "description",
  "priority_id",
  "stage_id",
  "status_id",
  "newgen_related",
  "estimated",
  "ba_required",
  "brd_assigned",
  "tech_owner_id",
  "ba_owner_id",
  "regulatory",
  "regulator_id",
  "regulatory_deadline",
  "analysis_planned_start_date",
  "analysis_planned_end_date",
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
  "business_category_id",
  "requester_id",
  "priority_id",
  "stage_id",
  "status_id",
  "tech_owner_id",
  "ba_owner_id",
  "regulator_id",
  "rm_id",
];

// Explicit column list (not br.*): the legacy `requester` text column would otherwise
// collide with the joined `requester` name below, and SQL Server returns duplicate names as arrays.
const BASE_COLUMNS = ["id", ...WRITABLE_FIELDS, "comments", "created_at", "updated_at", "created_by", "updated_by"]
  .map((c) => `br.${c}`)
  .join(", ");

const LIST_SELECT = `
  SELECT
    ${BASE_COLUMNS},
    bu.name AS business_unit,
    bc.name AS business_category,
    p.name  AS priority,
    s.name  AS stage,
    st.name AS status,
    (SELECT STRING_AGG(tow.name, ', ') WITHIN GROUP (ORDER BY tow.name)
       FROM business_request_tech_owners brto
       JOIN tech_owners tow ON tow.id = brto.tech_owner_id
      WHERE brto.business_request_id = br.id) AS tech_owner,
    (SELECT STRING_AGG(CAST(brto2.tech_owner_id AS NVARCHAR(10)), ',')
       FROM business_request_tech_owners brto2
      WHERE brto2.business_request_id = br.id) AS tech_owner_ids,
    (SELECT STRING_AGG(sy.name, ', ') WITHIN GROUP (ORDER BY sy.name)
       FROM business_request_systems brs
       JOIN systems sy ON sy.id = brs.system_id
      WHERE brs.business_request_id = br.id) AS system,
    (SELECT STRING_AGG(CAST(brs2.system_id AS NVARCHAR(10)), ',')
       FROM business_request_systems brs2
      WHERE brs2.business_request_id = br.id) AS system_ids,
    r.name  AS regulator,
    COALESCE(re.name, br.requester) AS requester,
    rm.name AS rm,
    bao.name AS ba_owner,
    CASE WHEN EXISTS (
      SELECT 1 FROM business_request_history brh
      JOIN stages ba_stage ON LOWER(LTRIM(RTRIM(ba_stage.name))) = 'ba'
      WHERE brh.business_request_id = br.id
        AND TRY_CONVERT(INT, JSON_VALUE(brh.snapshot_json, '$.stage_id')) = ba_stage.id
    ) THEN 1 ELSE 0 END AS ba_stage_seen,
    (SELECT TOP 1 rc.body       FROM request_comments rc WHERE rc.business_request_id = br.id ORDER BY rc.created_at DESC, rc.id DESC) AS last_comment,
    (SELECT TOP 1 rc.created_at FROM request_comments rc WHERE rc.business_request_id = br.id ORDER BY rc.created_at DESC, rc.id DESC) AS last_comment_at
  FROM business_requests br
  LEFT JOIN business_units bu ON bu.id = br.business_unit_id
  LEFT JOIN business_categories bc ON bc.id = br.business_category_id
  LEFT JOIN priorities p      ON p.id  = br.priority_id
  LEFT JOIN stages s          ON s.id  = br.stage_id
  LEFT JOIN statuses st       ON st.id = br.status_id
  LEFT JOIN regulators r      ON r.id  = br.regulator_id
  LEFT JOIN requesters re     ON re.id  = br.requester_id
  LEFT JOIN rms rm            ON rm.id  = br.rm_id
  LEFT JOIN ba_owners bao     ON bao.id = br.ba_owner_id
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
  await tx.query("DELETE FROM business_request_tech_owners WHERE business_request_id = @id", { id });
  for (const towId of techOwnerIds) {
    await tx.query(
      "INSERT INTO business_request_tech_owners (business_request_id, tech_owner_id) VALUES (@id, @towId)",
      { id, towId }
    );
  }
}

function recordHistory(tx, id, changeType, snapshot, changedBy) {
  return tx.query(
    `INSERT INTO business_request_history (business_request_id, change_type, snapshot_json, changed_by)
     VALUES (@id, @changeType, @snapshot, @changedBy)`,
    { id, changeType, snapshot: JSON.stringify(snapshot), changedBy: changedBy || null }
  );
}

async function list(req, res) {
  const { rows } = await query(`${LIST_SELECT} ORDER BY br.updated_at DESC, br.id DESC`);
  sendJson(res, 200, await withSla(rows, "requests"));
}

async function getOne(req, res, params) {
  const id = parseId(params.id);
  const row = id && (await queryOne(`${LIST_SELECT} WHERE br.id = @id`, { id }));
  if (!row) return sendJson(res, 404, { error: "Not found." });
  sendJson(res, 200, (await withSla([row], "requests"))[0]);
}

async function checkUniqueness(data, excludeId = null) {
  const errors = [];
  const exclude = excludeId ? " AND id <> @excludeId" : "";
  if (data.br_no) {
    const q = await queryOne(`SELECT id FROM business_requests WHERE br_no = @value${exclude}`, { value: data.br_no, excludeId });
    if (q) errors.push(`BR No "${data.br_no}" is already in use by another request.`);
  }
  if (data.cr) {
    const q = await queryOne(`SELECT id FROM business_requests WHERE cr = @value${exclude}`, { value: data.cr, excludeId });
    if (q) errors.push(`CR "${data.cr}" is already in use by another request.`);
  }
  return errors;
}

const UNIQUE_RACE_MESSAGE = "BR No or CR is already in use by another request.";

async function create(req, res, params, body) {
  const errors = validateBusinessRequest(body);
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
        `INSERT INTO business_requests (${columns}, created_by, updated_by)
         OUTPUT INSERTED.id
         VALUES (${placeholders}, @changedBy, @changedBy)`,
        { ...data, changedBy }
      );
      await setTechOwners(tx, id, techOwnerIds);
      await setSystems(tx, "business_request_systems", "business_request_id", id, systemIds);
      const row = await tx.queryOne(`${LIST_SELECT} WHERE br.id = @id`, { id });
      await recordHistory(tx, id, "create", row, changedBy);
      return row;
    });
    await syncLegacyRequest(created.id, changedBy);
    sendJson(res, 201, created);
  } catch (err) {
    if (isUniqueViolation(err)) return sendJson(res, 400, { errors: [UNIQUE_RACE_MESSAGE] });
    throw err;
  }
}

async function update(req, res, params, body) {
  const id = parseId(params.id);
  const existing = id && (await queryOne("SELECT id FROM business_requests WHERE id = @id", { id }));
  if (!existing) return sendJson(res, 404, { error: "Not found." });

  const errors = validateBusinessRequest(body);
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
        `UPDATE business_requests SET ${setClause}, updated_at = SYSUTCDATETIME(), updated_by = @changedBy WHERE id = @id`,
        { ...data, changedBy, id }
      );
      await setTechOwners(tx, id, techOwnerIds);
      await setSystems(tx, "business_request_systems", "business_request_id", id, systemIds);
      const row = await tx.queryOne(`${LIST_SELECT} WHERE br.id = @id`, { id });
      await recordHistory(tx, id, "update", row, changedBy);
      return row;
    });
    await syncLegacyRequest(updated.id, changedBy);
    sendJson(res, 200, updated);
  } catch (err) {
    if (isUniqueViolation(err)) return sendJson(res, 400, { errors: [UNIQUE_RACE_MESSAGE] });
    throw err;
  }
}

async function remove(req, res, params, body) {
  const id = parseId(params.id);
  const existing = id && (await queryOne("SELECT * FROM business_requests WHERE id = @id", { id }));
  if (!existing) return sendJson(res, 404, { error: "Not found." });

  const changedBy = resolveChangedBy(req, body && body.changed_by);
  await transaction(async (tx) => {
    await recordHistory(tx, id, "delete", existing, changedBy);
    await tx.query("DELETE FROM business_requests WHERE id = @id", { id });
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
  const updateSql = `UPDATE business_requests SET ${setClause}, updated_at = SYSUTCDATETIME(), updated_by = @changedBy WHERE id = @id`;

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
        const updatedRow = await tx.queryOne(`${LIST_SELECT} WHERE br.id = @id`, { id });
        await recordHistory(tx, id, "bulk-update", updatedRow, changedBy);
        return true;
      });
      if (found) {
        updated++;
        if (fieldNames.includes("stage_id") || fieldNames.includes("status_id")) await syncLegacyRequest(id, changedBy);
      } else errors.push(`Record ${id} not found.`);
    } catch (err) {
      errors.push(`Record ${id}: ${err.message}`);
    }
  }

  sendJson(res, 200, { updated, total: ids.length, errors });
}

async function history(req, res, params) {
  const id = parseId(params.id);
  const { rows } = id
    ? await query("SELECT * FROM business_request_history WHERE business_request_id = @id ORDER BY changed_at DESC, id DESC", { id })
    : { rows: [] };
  sendJson(res, 200, rows);
}

async function listComments(req, res, params) {
  const id = parseId(params.id);
  const { rows } = id
    ? await query(
        "SELECT id, body, created_at, created_by FROM request_comments WHERE business_request_id = @id ORDER BY created_at ASC, id ASC",
        { id }
      )
    : { rows: [] };
  sendJson(res, 200, rows);
}

async function addComment(req, res, params, body) {
  const id = parseId(params.id);
  const exists = id && (await queryOne("SELECT 1 AS found FROM business_requests WHERE id = @id", { id }));
  if (!exists) return sendJson(res, 404, { error: "Request not found." });

  const text = (body.body || "").trim();
  if (!text) return sendJson(res, 400, { error: "Comment body is required." });

  const createdBy = resolveChangedBy(req, body.created_by);
  const comment = await queryOne(
    `INSERT INTO request_comments (business_request_id, body, created_by)
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
      ? await query("DELETE FROM request_comments WHERE id = @commentId AND business_request_id = @id", { id, commentId })
      : { rowsAffected: 0 };
  if (!rowsAffected) return sendJson(res, 404, { error: "Comment not found." });
  res.writeHead(204).end();
}

async function exportData(req, res) {
  const [{ rows: requests }, { rows: comments }] = await Promise.all([
    query(`${LIST_SELECT} ORDER BY br.updated_at DESC, br.id DESC`),
    query("SELECT business_request_id, body, created_at FROM request_comments ORDER BY created_at ASC, id ASC"),
  ]);
  const byRequest = new Map();
  for (const c of comments) {
    if (!byRequest.has(c.business_request_id)) byRequest.set(c.business_request_id, []);
    byRequest.get(c.business_request_id).push(`[${c.created_at}] ${c.body}`);
  }
  const data = (await withSla(requests, "requests")).map((r) => ({ ...r, all_comments: (byRequest.get(r.id) || []).join("\n") }));
  sendJson(res, 200, data);
}

// ---- Personal "My Follow-ups" bookmarks (per logged-in user) ----

async function listFollowedIds(req, res) {
  const { rows } = await query(
    "SELECT business_request_id AS id FROM business_request_follows WHERE user_id = @userId",
    { userId: req.user.id }
  );
  sendJson(res, 200, rows.map((r) => r.id));
}

async function follow(req, res, params) {
  const id = parseId(params.id);
  if (!id) return sendJson(res, 400, { error: "Invalid id." });
  const exists = await queryOne("SELECT 1 AS found FROM business_requests WHERE id = @id", { id });
  if (!exists) return sendJson(res, 404, { error: "Not found." });

  await query(
    `IF NOT EXISTS (SELECT 1 FROM business_request_follows WHERE user_id = @userId AND business_request_id = @id)
     INSERT INTO business_request_follows (user_id, business_request_id) VALUES (@userId, @id)`,
    { userId: req.user.id, id }
  );
  res.writeHead(204).end();
}

async function unfollow(req, res, params) {
  const id = parseId(params.id);
  if (!id) return sendJson(res, 400, { error: "Invalid id." });
  await query("DELETE FROM business_request_follows WHERE user_id = @userId AND business_request_id = @id", {
    userId: req.user.id,
    id,
  });
  res.writeHead(204).end();
}

function register(router) {
  router.get("/api/business-requests/followed", listFollowedIds);
  router.get("/api/business-requests", list);
  router.get("/api/business-requests/:id", getOne);
  router.post("/api/business-requests", create);
  router.post("/api/business-requests/bulk-update", bulkUpdate);
  router.put("/api/business-requests/:id", update);
  router.delete("/api/business-requests/:id", remove);
  router.get("/api/business-requests/:id/history", history);
  router.get("/api/business-requests/:id/comments", listComments);
  router.post("/api/business-requests/:id/comments", addComment);
  router.delete("/api/business-requests/:id/comments/:commentId", deleteComment);
  router.post("/api/business-requests/:id/follow", follow);
  router.delete("/api/business-requests/:id/follow", unfollow);
  router.get("/api/export", exportData);
}

module.exports = { register };
