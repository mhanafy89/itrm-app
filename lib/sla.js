// SLA calculation: stage durations x priority factor x category factor, counted from a record's
// current stage through Deployment, in working days. Assumptions live in the sla_* tables; any
// lookup value without a stored row uses the defaults below.
const { query } = require("../db/database");

const norm = (s) => String(s ?? "").trim().toLowerCase();

const DEFAULT_STAGES = {
  analysis:   { stage_order: 1, is_pipeline: 1, br_days: 5,  incident_days: 2, effort_days: 2 },
  ba:         { stage_order: 2, is_pipeline: 1, br_days: 10, incident_days: 0, effort_days: 5 },
  development:{ stage_order: 3, is_pipeline: 1, br_days: 15, incident_days: 5, effort_days: 8 },
  qa:         { stage_order: 4, is_pipeline: 1, br_days: 7,  incident_days: 3, effort_days: 4 },
  uat:        { stage_order: 5, is_pipeline: 1, br_days: 5,  incident_days: 2, effort_days: 2 },
  cab:        { stage_order: 6, is_pipeline: 1, br_days: 3,  incident_days: 2, effort_days: 0.5 },
  deployment: { stage_order: 7, is_pipeline: 1, br_days: 3,  incident_days: 2, effort_days: 1 },
  // Not part of the standard pipeline: a vendor stage replacing Development, a triage stage, and "past the end".
  newgen:     { stage_order: 3, is_pipeline: 0, br_days: 30, incident_days: 30, effort_days: 0 },
  dmo:        { stage_order: 0, is_pipeline: 0, br_days: 2,  incident_days: 2, effort_days: 0 },
  closed:     { stage_order: 8, is_pipeline: 0, br_days: 0,  incident_days: 0, effort_days: 0 },
};
// Unknown stage names (e.g. "Draft") restart the pipeline from Analysis with no extra time.
const UNKNOWN_STAGE = { stage_order: 0, is_pipeline: 0, br_days: 0, incident_days: 0, effort_days: 0 };

const DEFAULT_PRIORITIES = {
  critical:   { factor: 0.4, response_hours: 1,  update_days: 1 },
  critcal:    { factor: 0.4, response_hours: 1,  update_days: 1 },
  high:       { factor: 0.7, response_hours: 4,  update_days: 2 },
  medium:     { factor: 1,   response_hours: 8,  update_days: 7 },
  low:        { factor: 1.5, response_hours: 16, update_days: 14 },
  "very low": { factor: 2,   response_hours: 24, update_days: 14 },
};
const UNKNOWN_PRIORITY = { factor: 1, response_hours: 8, update_days: 7 };

const DEFAULT_CATEGORIES = { normal: 1, regulatory: 0.8, "fast track": 0.6, "strategic projects": 1.5 };

const DONE_STATUSES = new Set(["completed", "compeleted", "closed", "cancelled", "canceled"]);
const PAUSED_STATUSES = new Set(["on hold"]);
const defaultState = (name) => (DONE_STATUSES.has(norm(name)) ? "Done" : PAUSED_STATUSES.has(norm(name)) ? "Paused" : "Active");

const DEFAULT_WEEKEND = [5, 6]; // Fri, Sat (Date#getUTCDay numbering)

const FLAGS = {
  done: "Closed / done",
  paused: "Paused - clock stopped",
  noPlan: "No plan - use SLA date",
  passed: "Planned date passed - re-baseline",
  atRisk: "Plan earlier than SLA - at risk",
  ok: "Plan within SLA",
};

// ---------- config loading ----------

async function lookupNames(table) {
  const orderBy = table === "business_categories" ? "name" : "sort_order, name";
  return (await query(`SELECT name FROM ${table} ORDER BY ${orderBy}`)).rows.map((r) => r.name);
}

// Lookup values first (in lookup order), then any stored rows whose lookup no longer exists.
function mergeNames(lookups, stored) {
  const seen = new Set(lookups.map(norm));
  return [...lookups, ...stored.map((s) => s.name).filter((n) => !seen.has(norm(n)))];
}

async function loadConfig() {
  const [stageNames, prioNames, catNames, statusNames, st, pr, ca, ss, settings] = await Promise.all([
    lookupNames("stages"),
    lookupNames("priorities"),
    lookupNames("business_categories"),
    lookupNames("statuses"),
    query("SELECT name, stage_order, is_pipeline, br_days, incident_days, effort_days FROM sla_stages"),
    query("SELECT name, factor, response_hours, update_days FROM sla_priorities"),
    query("SELECT name, factor FROM sla_categories"),
    query("SELECT name, state FROM sla_statuses"),
    query("SELECT setting_key, setting_value FROM sla_settings"),
  ]);
  const byName = (rows) => new Map(rows.rows.map((r) => [norm(r.name), r]));
  const stored = { st: byName(st), pr: byName(pr), ca: byName(ca), ss: byName(ss) };

  const stages = mergeNames(stageNames, st.rows).map((name) => {
    const row = stored.st.get(norm(name)) || { ...(DEFAULT_STAGES[norm(name)] || UNKNOWN_STAGE) };
    return {
      name,
      stage_order: Number(row.stage_order),
      is_pipeline: row.is_pipeline ? 1 : 0,
      br_days: Number(row.br_days),
      incident_days: Number(row.incident_days),
      effort_days: Number(row.effort_days),
    };
  });
  const priorities = mergeNames(prioNames, pr.rows).map((name) => {
    const row = stored.pr.get(norm(name)) || DEFAULT_PRIORITIES[norm(name)] || UNKNOWN_PRIORITY;
    return { name, factor: Number(row.factor), response_hours: Number(row.response_hours), update_days: Number(row.update_days) };
  });
  const categories = mergeNames(catNames, ca.rows).map((name) => {
    const row = stored.ca.get(norm(name));
    return { name, factor: row ? Number(row.factor) : DEFAULT_CATEGORIES[norm(name)] ?? 1 };
  });
  const statuses = mergeNames(statusNames, ss.rows).map((name) => {
    const row = stored.ss.get(norm(name));
    return { name, state: row ? row.state : defaultState(name) };
  });

  const weekendRow = settings.rows.find((r) => r.setting_key === "weekend_days");
  const weekend_days = weekendRow
    ? weekendRow.setting_value.split(",").filter((s) => s !== "").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : DEFAULT_WEEKEND;

  return { stages, priorities, categories, statuses, settings: { weekend_days } };
}

// Short cache: assumptions change rarely but every list request needs them.
let cache = null;
const CACHE_MS = 15000;

async function getConfig() {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), config: await loadConfig() };
  return cache.config;
}

function invalidateConfig() {
  cache = null;
}

// ---------- calculation ----------

function buildIndex(config) {
  const map = (list) => new Map(list.map((x) => [norm(x.name), x]));
  const stages = map(config.stages);
  return {
    stage: (name) => stages.get(norm(name)) || DEFAULT_STAGES[norm(name)] || UNKNOWN_STAGE,
    priority: (() => { const m = map(config.priorities); return (n) => m.get(norm(n)) || UNKNOWN_PRIORITY; })(),
    category: (() => { const m = map(config.categories); return (n) => m.get(norm(n)); })(),
    status: (() => { const m = map(config.statuses); return (n) => (m.get(norm(n)) || { state: defaultState(n) }).state; })(),
    pipeline: config.stages.filter((s) => s.is_pipeline).sort((a, b) => a.stage_order - b.stage_order),
    weekend: new Set(config.settings.weekend_days),
  };
}

const MS_DAY = 86400000;
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMs = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function addWorkingDays(startIso, days, weekend) {
  let ms = utcMs(startIso);
  let left = days;
  while (left > 0) {
    ms += MS_DAY;
    if (!weekend.has(new Date(ms).getUTCDay())) left--;
  }
  return isoOf(ms);
}

// `type` is "requests" or "incidents".
function computeSla(record, type, idx, today) {
  const state = idx.status(record.status);
  if (state === "Done") {
    return { sla_state: state, sla_remaining_days: 0, sla_effort_days: 0, sla_target_date: null, sla_gap_days: null, sla_flag: FLAGS.done, sla_breakdown: [] };
  }

  const daysKey = type === "incidents" ? "incident_days" : "br_days";
  const factor = idx.priority(record.priority).factor * (type === "incidents" ? 1 : idx.category(record.business_category)?.factor ?? 1);
  const scale = (base) => (base > 0 ? Math.max(1, Math.ceil(Math.round(base * factor * 1e6) / 1e6)) : 0);

  const cur = idx.stage(record.stage);
  const breakdown = [];
  let total = 0;
  let effort = 0;
  const add = (stage) => {
    const days = scale(stage[daysKey]);
    if (days <= 0) return;
    breakdown.push({ stage: stage.name, days });
    total += days;
    effort += stage.effort_days;
  };

  if (!cur.is_pipeline && cur[daysKey] > 0) add({ ...cur, name: record.stage });
  for (const s of idx.pipeline) {
    if (cur.is_pipeline ? s.stage_order >= cur.stage_order : s.stage_order > cur.stage_order) add(s);
  }

  const target = addWorkingDays(today, total, idx.weekend);
  const planned = record.deployment_planned_end_date || null;
  const gap = planned ? Math.round((utcMs(target) - utcMs(planned)) / MS_DAY) : null;

  let flag;
  if (state === "Paused") flag = FLAGS.paused;
  else if (!planned) flag = FLAGS.noPlan;
  else if (planned < today) flag = FLAGS.passed;
  else if (gap > 0) flag = FLAGS.atRisk;
  else flag = FLAGS.ok;

  return {
    sla_state: state,
    sla_remaining_days: total,
    sla_effort_days: effort,
    sla_target_date: target,
    sla_gap_days: gap,
    sla_flag: flag,
    sla_breakdown: breakdown,
  };
}

// Adds sla_* fields (including the per-stage breakdown) to each row.
async function withSla(rows, type) {
  const idx = buildIndex(await getConfig());
  const today = todayIso();
  return rows.map((r) => ({ ...r, ...computeSla(r, type, idx, today) }));
}

module.exports = { FLAGS, DEFAULT_WEEKEND, norm, loadConfig, getConfig, invalidateConfig, buildIndex, computeSla, addWorkingDays, todayIso, withSla };
