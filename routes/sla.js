const { transaction } = require("../db/database");
const { sendJson } = require("../lib/http-helpers");
const { loadConfig, invalidateConfig } = require("../lib/sla");

const STATES = ["Active", "Paused", "Done"];

const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const list = (v) => (Array.isArray(v) ? v : []);

// Returns { errors } or { clean } so the caller can reject the whole payload before touching the DB.
function validate(body) {
  const errors = [];
  const seen = new Set();
  const clean = { stages: [], priorities: [], categories: [], statuses: [], weekend_days: [] };

  const nameOf = (kind, row) => {
    const name = String(row?.name ?? "").trim();
    if (!name || name.length > 200) {
      errors.push(`${kind}: every row needs a name (max 200 characters).`);
      return null;
    }
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push(`${kind}: "${name}" appears more than once.`);
      return null;
    }
    seen.add(key);
    return name;
  };
  const check = (cond, msg) => { if (!cond) errors.push(msg); return cond; };

  for (const r of list(body.stages)) {
    const name = nameOf("Stages", r);
    if (!name) continue;
    const row = { name, stage_order: num(r.stage_order), is_pipeline: r.is_pipeline ? 1 : 0, br_days: num(r.br_days), incident_days: num(r.incident_days), effort_days: num(r.effort_days) };
    if (check(Number.isInteger(row.stage_order) && row.stage_order >= 0 && row.stage_order <= 99, `Stage "${name}": order must be a whole number 0-99.`)
      && check(Number.isInteger(row.br_days) && row.br_days >= 0 && row.br_days <= 365, `Stage "${name}": request days must be a whole number 0-365.`)
      && check(Number.isInteger(row.incident_days) && row.incident_days >= 0 && row.incident_days <= 365, `Stage "${name}": incident days must be a whole number 0-365.`)
      && check(row.effort_days >= 0 && row.effort_days <= 999, `Stage "${name}": effort must be 0-999.`)) {
      clean.stages.push(row);
    }
  }
  for (const r of list(body.priorities)) {
    const name = nameOf("Priorities", r);
    if (!name) continue;
    const row = { name, factor: num(r.factor), response_hours: num(r.response_hours), update_days: num(r.update_days) };
    if (check(row.factor > 0 && row.factor <= 10, `Priority "${name}": factor must be above 0 and at most 10.`)
      && check(row.response_hours >= 0 && row.response_hours <= 999, `Priority "${name}": response hours must be 0-999.`)
      && check(Number.isInteger(row.update_days) && row.update_days >= 0 && row.update_days <= 365, `Priority "${name}": update cadence must be a whole number of days 0-365.`)) {
      clean.priorities.push(row);
    }
  }
  for (const r of list(body.categories)) {
    const name = nameOf("Categories", r);
    if (!name) continue;
    const row = { name, factor: num(r.factor) };
    if (check(row.factor > 0 && row.factor <= 10, `Category "${name}": factor must be above 0 and at most 10.`)) clean.categories.push(row);
  }
  for (const r of list(body.statuses)) {
    const name = nameOf("Statuses", r);
    if (!name) continue;
    if (check(STATES.includes(r.state), `Status "${name}": state must be Active, Paused or Done.`)) clean.statuses.push({ name, state: r.state });
  }

  const weekend = [...new Set(list(body.settings?.weekend_days).map(Number))];
  if (check(weekend.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && weekend.length < 7, "Weekend days must be day numbers 0-6, and not every day.")) {
    clean.weekend_days = weekend;
  }
  return errors.length ? { errors } : { clean };
}

async function getConfig(req, res) {
  sendJson(res, 200, await loadConfig());
}

// Full replace: the editor always submits every row, so stored rows mirror what the user sees.
async function putConfig(req, res, params, body) {
  const { errors, clean } = validate(body || {});
  if (errors) return sendJson(res, 400, { errors });

  await transaction(async (tx) => {
    for (const t of ["sla_stages", "sla_priorities", "sla_categories", "sla_statuses", "sla_settings"]) {
      await tx.query(`DELETE FROM ${t}`);
    }
    for (const s of clean.stages) {
      await tx.query(
        `INSERT INTO sla_stages (name, stage_order, is_pipeline, br_days, incident_days, effort_days)
         VALUES (@name, @stage_order, @is_pipeline, @br_days, @incident_days, @effort_days)`, s);
    }
    for (const p of clean.priorities) {
      await tx.query("INSERT INTO sla_priorities (name, factor, response_hours, update_days) VALUES (@name, @factor, @response_hours, @update_days)", p);
    }
    for (const c of clean.categories) await tx.query("INSERT INTO sla_categories (name, factor) VALUES (@name, @factor)", c);
    for (const s of clean.statuses) await tx.query("INSERT INTO sla_statuses (name, state) VALUES (@name, @state)", s);
    await tx.query("INSERT INTO sla_settings (setting_key, setting_value) VALUES (N'weekend_days', @value)", { value: clean.weekend_days.join(",") });
  });
  invalidateConfig();
  sendJson(res, 200, await loadConfig());
}

async function resetConfig(req, res) {
  await transaction(async (tx) => {
    for (const t of ["sla_stages", "sla_priorities", "sla_categories", "sla_statuses", "sla_settings"]) {
      await tx.query(`DELETE FROM ${t}`);
    }
  });
  invalidateConfig();
  sendJson(res, 200, await loadConfig());
}

function register(router) {
  router.get("/api/sla/config", getConfig);
  router.put("/api/sla/config", putConfig);
  router.post("/api/sla/config/reset", resetConfig);
}

module.exports = { register, validate };
