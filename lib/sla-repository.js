// SQL Server access for the SLA engine. All statements are parameterized (db/database.js binds @name params).
// `db` is the db/database.js module (or anything exposing { query, queryOne, transaction }); inside
// transaction() every method runs on the single transaction connection.
//
// Dates: DATETIME2 values arrive as 'YYYY-MM-DD HH:MM:SS' UTC strings (see normalizeRows) and are converted
// to Date objects here; Date parameters are sent as-is (the mssql driver stores them as UTC).
const parseUtc = (v) => (v ? (v instanceof Date ? v : new Date(`${String(v).replace(" ", "T")}Z`)) : null);
const DATE_COLUMNS = ["started_at", "completed_at", "paused_at", "resume_at", "created_at", "updated_at", "ended_at", "resumed_at", "changed_at"];

function mapRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of DATE_COLUMNS) if (col in out) out[col] = parseUtc(out[col]);
  if ("is_backfilled" in out) out.is_backfilled = !!out.is_backfilled;
  for (const col of ["stage_effort_days", "actual_effort_days", "remaining_effort_days", "sla_consumed_days", "total_hold_time"]) {
    if (col in out && out[col] !== null) out[col] = Number(out[col]);
  }
  return out;
}

// Columns request_stages rows may be updated with (guards the dynamic SET list below).
const STAGE_COLUMNS = [
  "status", "stage_effort_days", "actual_effort_days", "remaining_effort_days", "sla_consumed_days", "total_hold_time",
  "started_at", "completed_at", "paused_at", "resume_at", "reopen_count", "is_backfilled", "updated_at", "updated_by",
];
const INSERT_STAGE_COLUMNS = ["business_request_id", "stage_name", "stage_order", ...STAGE_COLUMNS];

class SqlSlaRepository {
  constructor(db) {
    this.db = db;
  }

  // Runs fn(repo) in one transaction. Nested calls (already inside a transaction) just run inline.
  transaction(fn) {
    if (this.db.inTransaction) return fn(this);
    return this.db.transaction((exec) => fn(new SqlSlaRepository({ query: exec.query, queryOne: exec.queryOne, inTransaction: true })));
  }

  // lock: true takes an update lock on the request row so concurrent changes to one request serialize.
  async getRequest(id, { lock = false } = {}) {
    const hint = lock ? " WITH (UPDLOCK, HOLDLOCK)" : "";
    return this.db.queryOne(
      `SELECT br.id, br.br_no, br.title, p.name AS priority, s.name AS stage, st.name AS status
         FROM business_requests br${hint}
         LEFT JOIN priorities p ON p.id = br.priority_id
         LEFT JOIN stages s     ON s.id = br.stage_id
         LEFT JOIN statuses st  ON st.id = br.status_id
        WHERE br.id = @id`,
      { id }
    );
  }

  async listTrackedRequests() {
    const { rows } = await this.db.query(
      `SELECT br.id, br.br_no, br.title, p.name AS priority
         FROM business_requests br
         LEFT JOIN priorities p ON p.id = br.priority_id
        WHERE EXISTS (SELECT 1 FROM request_stages rs WHERE rs.business_request_id = br.id)
        ORDER BY br.id`
    );
    return rows;
  }

  async listRequestIdsWithoutTracking() {
    const { rows } = await this.db.query(
      `SELECT br.id FROM business_requests br
        WHERE NOT EXISTS (SELECT 1 FROM request_stages rs WHERE rs.business_request_id = br.id)
        ORDER BY br.id`
    );
    return rows.map((r) => r.id);
  }

  async listStages(requestId) {
    const { rows } = await this.db.query("SELECT * FROM request_stages WHERE business_request_id = @requestId ORDER BY stage_order, id", { requestId });
    return rows.map(mapRow);
  }

  async listAllStages() {
    const { rows } = await this.db.query("SELECT * FROM request_stages ORDER BY business_request_id, stage_order, id");
    return rows.map(mapRow);
  }

  async insertStage(row) {
    const params = Object.fromEntries(INSERT_STAGE_COLUMNS.map((c) => [c, row[c] === undefined ? null : row[c]]));
    params.is_backfilled = params.is_backfilled ? 1 : 0;
    const { id } = await this.db.queryOne(
      `INSERT INTO request_stages (${INSERT_STAGE_COLUMNS.join(", ")})
       OUTPUT INSERTED.id
       VALUES (${INSERT_STAGE_COLUMNS.map((c) => `@${c}`).join(", ")})`,
      params
    );
    return id;
  }

  async updateStage(id, patch) {
    const columns = Object.keys(patch).filter((c) => STAGE_COLUMNS.includes(c));
    if (!columns.length) return;
    const params = { id };
    for (const c of columns) params[c] = c === "is_backfilled" ? (patch[c] ? 1 : 0) : patch[c];
    await this.db.query(`UPDATE request_stages SET ${columns.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`, params);
  }

  // ----- work (In Progress) segments -----
  async listWork(requestId) {
    const { rows } = await this.db.query("SELECT * FROM sla_effort_tracking WHERE business_request_id = @requestId ORDER BY started_at, id", { requestId });
    return rows.map(mapRow);
  }
  async listAllWork() {
    const { rows } = await this.db.query("SELECT * FROM sla_effort_tracking");
    return rows.map(mapRow);
  }
  openWork({ request_stage_id, business_request_id, started_at, created_by }) {
    return this.db.query(
      "INSERT INTO sla_effort_tracking (request_stage_id, business_request_id, started_at, created_by) VALUES (@request_stage_id, @business_request_id, @started_at, @created_by)",
      { request_stage_id, business_request_id, started_at, created_by: created_by || null }
    );
  }
  closeWork(id, endedAt, reason, workingDays) {
    return this.db.query("UPDATE sla_effort_tracking SET ended_at = @endedAt, end_reason = @reason, working_days = @workingDays WHERE id = @id AND ended_at IS NULL", { id, endedAt, reason, workingDays });
  }

  // ----- hold periods -----
  async listPauses(requestId) {
    const { rows } = await this.db.query("SELECT * FROM sla_pause_history WHERE business_request_id = @requestId ORDER BY paused_at, id", { requestId });
    return rows.map(mapRow);
  }
  async listAllPauses() {
    const { rows } = await this.db.query("SELECT * FROM sla_pause_history");
    return rows.map(mapRow);
  }
  openPause({ request_stage_id, business_request_id, paused_at, reason, paused_by }) {
    return this.db.query(
      "INSERT INTO sla_pause_history (request_stage_id, business_request_id, paused_at, reason, paused_by) VALUES (@request_stage_id, @business_request_id, @paused_at, @reason, @paused_by)",
      { request_stage_id, business_request_id, paused_at, reason: reason || null, paused_by: paused_by || null }
    );
  }
  closePause(id, resumedAt, holdDays, resumedBy) {
    return this.db.query("UPDATE sla_pause_history SET resumed_at = @resumedAt, hold_days = @holdDays, resumed_by = @resumedBy WHERE id = @id AND resumed_at IS NULL", { id, resumedAt, holdDays, resumedBy: resumedBy || null });
  }

  // ----- audit trail (append-only) -----
  insertStatusHistory(h) {
    return this.db.query(
      `INSERT INTO request_stage_status_history
         (request_stage_id, business_request_id, stage_name, from_status, to_status, action, source, planned_effort_days, consumed_days, remaining_days, note, changed_by, changed_at)
       VALUES
         (@request_stage_id, @business_request_id, @stage_name, @from_status, @to_status, @action, @source, @planned_effort_days, @consumed_days, @remaining_days, @note, @changed_by, @changed_at)`,
      {
        request_stage_id: h.request_stage_id, business_request_id: h.business_request_id, stage_name: h.stage_name,
        from_status: h.from_status ?? null, to_status: h.to_status, action: h.action, source: h.source,
        planned_effort_days: h.planned_effort_days ?? null, consumed_days: h.consumed_days ?? null, remaining_days: h.remaining_days ?? null,
        note: h.note ?? null, changed_by: h.changed_by ?? null, changed_at: h.changed_at,
      }
    );
  }
  insertStageHistory(h) {
    return this.db.query(
      `INSERT INTO request_stage_history (business_request_id, from_stage, to_stage, reason, source, changed_by, changed_at)
       VALUES (@business_request_id, @from_stage, @to_stage, @reason, @source, @changed_by, @changed_at)`,
      { business_request_id: h.business_request_id, from_stage: h.from_stage ?? null, to_stage: h.to_stage, reason: h.reason, source: h.source, changed_by: h.changed_by ?? null, changed_at: h.changed_at }
    );
  }
  async listStatusHistory(requestId) {
    const { rows } = await this.db.query("SELECT * FROM request_stage_status_history WHERE business_request_id = @requestId ORDER BY changed_at DESC, id DESC", { requestId });
    return rows.map(mapRow);
  }
  async listStageHistory(requestId) {
    const { rows } = await this.db.query("SELECT * FROM request_stage_history WHERE business_request_id = @requestId ORDER BY changed_at DESC, id DESC", { requestId });
    return rows.map(mapRow);
  }

  // Mirrors the engine state into the legacy stage_id / status_id. Names that do not exist in the lookup
  // tables are ignored (the matching column is left unchanged).
  async setLegacyFields(requestId, { stageName, statusName, user, now }) {
    await this.db.query(
      `UPDATE business_requests
          SET stage_id   = COALESCE((SELECT id FROM stages   WHERE name = @stageName),  stage_id),
              status_id  = COALESCE((SELECT id FROM statuses WHERE name = @statusName), status_id),
              updated_at = @now,
              updated_by = @updatedBy
        WHERE id = @requestId`,
      { requestId, stageName: stageName || null, statusName: statusName || null, updatedBy: user || null, now }
    );
  }
}

module.exports = { SqlSlaRepository };
