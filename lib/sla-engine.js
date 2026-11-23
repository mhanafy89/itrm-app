// Pure SLA calculation engine: no database, no clock, no I/O -- everything is passed in.
// The service layer (lib/sla-service.js) feeds it rows and persists the results.
//
// Concepts
//   plannedEffort  man-days planned for a stage (raw estimate, never changed by priority)
//   expectedSla    the stage target in working days = planned adjusted by the request priority
//   consumed       working days the stage spent In Progress (hold periods excluded, never priority-adjusted)
//   utilization    consumed / expectedSla  -> classified with the configurable thresholds
// Dates are counted at calendar-day granularity in the server's local time (same as lib/sla.js todayIso):
// a segment covers the working days in (start day, end day], so consecutive segments never double count.

const STATUS = Object.freeze({
  NOT_YET_ESTIMATED: "Not Yet Estimated",
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
});
const STATUSES = Object.values(STATUS);

const HEALTH = Object.freeze({ ON_TRACK: "On Track", AT_RISK: "At Risk", BREACHED: "Breached" });
const HEALTH_RANK = { [HEALTH.ON_TRACK]: 0, [HEALTH.AT_RISK]: 1, [HEALTH.BREACHED]: 2 };

const ACTION = Object.freeze({
  NOOP: "noop",
  ESTIMATE: "estimate",
  UNESTIMATE: "unestimate",
  START: "start",
  PAUSE: "pause",
  RESUME: "resume",
  COMPLETE: "complete",
  CANCEL: "cancel",
  REOPEN: "reopen",
  REINSTATE: "reinstate",
});

const DEFAULT_WEEKEND = [5, 6]; // Fri, Sat (Date#getUTCDay numbering) -- same default as lib/sla.js

const DEFAULT_ENGINE_SETTINGS = Object.freeze({
  at_risk_threshold_pct: 80,   // utilization above this is "At Risk"
  breach_threshold_pct: 100,   // utilization above this is "Breached"
  priority_factor_mode: "multiplier", // 'multiplier': planned x factor (legacy)  |  'divisor': planned / factor
  enforce_stage_order: true,   // a stage may only start once every earlier stage is Completed/Cancelled
  auto_start_next_stage: false, // start the next estimated stage automatically when a stage completes
});

const norm = (s) => String(s ?? "").trim().toLowerCase();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// ---------- settings ----------

const bool = (v, fallback) => (v === undefined || v === null || v === "" ? fallback : ["true", "1", "yes"].includes(norm(v)));

// Lenient: unknown / invalid values fall back to the defaults (used when loading stored rows).
function parseEngineSettings(raw = {}) {
  const d = DEFAULT_ENGINE_SETTINGS;
  const atRisk = Number(raw.at_risk_threshold_pct);
  const breach = Number(raw.breach_threshold_pct);
  const out = {
    at_risk_threshold_pct: Number.isFinite(atRisk) && atRisk > 0 ? atRisk : d.at_risk_threshold_pct,
    breach_threshold_pct: Number.isFinite(breach) && breach > 0 ? breach : d.breach_threshold_pct,
    priority_factor_mode: ["multiplier", "divisor"].includes(norm(raw.priority_factor_mode)) ? norm(raw.priority_factor_mode) : d.priority_factor_mode,
    enforce_stage_order: bool(raw.enforce_stage_order, d.enforce_stage_order),
    auto_start_next_stage: bool(raw.auto_start_next_stage, d.auto_start_next_stage),
  };
  if (out.at_risk_threshold_pct > out.breach_threshold_pct) out.at_risk_threshold_pct = out.breach_threshold_pct;
  return out;
}

// Strict: used by the config editor. Only keys present in `input` are validated and returned (as strings for sla_settings).
function validateEngineSettings(input = {}) {
  const errors = [];
  const clean = {};
  const has = (k) => input[k] !== undefined && input[k] !== null && input[k] !== "";

  for (const key of ["at_risk_threshold_pct", "breach_threshold_pct"]) {
    if (!has(key)) continue;
    const v = Number(input[key]);
    if (Number.isFinite(v) && v > 0 && v <= 1000) clean[key] = String(v);
    else errors.push(`${key}: must be a percentage above 0 and at most 1000.`);
  }
  if (has("priority_factor_mode")) {
    if (["multiplier", "divisor"].includes(norm(input.priority_factor_mode))) clean.priority_factor_mode = norm(input.priority_factor_mode);
    else errors.push("priority_factor_mode: must be 'multiplier' or 'divisor'.");
  }
  for (const key of ["enforce_stage_order", "auto_start_next_stage"]) {
    if (!has(key)) continue;
    if (typeof input[key] === "boolean") clean[key] = String(input[key]);
    else if (["true", "false"].includes(norm(input[key]))) clean[key] = norm(input[key]);
    else errors.push(`${key}: must be true or false.`);
  }
  if (!errors.length) {
    const merged = parseEngineSettings({ ...input, ...clean });
    const atRisk = has("at_risk_threshold_pct") ? Number(input.at_risk_threshold_pct) : merged.at_risk_threshold_pct;
    const breach = has("breach_threshold_pct") ? Number(input.breach_threshold_pct) : merged.breach_threshold_pct;
    if ((has("at_risk_threshold_pct") || has("breach_threshold_pct")) && atRisk > breach) {
      errors.push("at_risk_threshold_pct must not be greater than breach_threshold_pct.");
    }
  }
  return { errors, clean };
}

// ---------- working-day arithmetic ----------

const MS_DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const keyMs = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// A weekend covering all seven days would make every day non-working; treat it as "no weekend".
const weekendSet = (w) => {
  const set = w instanceof Set ? w : new Set(w ?? DEFAULT_WEEKEND);
  return set.size >= 7 ? new Set() : set;
};

// Working days in (from, to] by calendar day. 0 when `to` is not after `from`.
function workingDaysBetween(from, to, weekend) {
  if (!from || !to) return 0;
  const we = weekendSet(weekend);
  let ms = keyMs(dayKey(from));
  const end = keyMs(dayKey(to));
  let n = 0;
  while (ms < end) {
    ms += MS_DAY;
    if (!we.has(new Date(ms).getUTCDay())) n++;
  }
  return n;
}

// ISO date `days` working days after `startKey` (fractions round up; the start day itself is not counted).
function addWorkingDays(startKey, days, weekend) {
  const we = weekendSet(weekend);
  let left = Math.ceil(days - 1e-9);
  let ms = keyMs(startKey);
  while (left > 0) {
    ms += MS_DAY;
    if (!we.has(new Date(ms).getUTCDay())) left--;
  }
  return isoOf(ms);
}

// ---------- core calculations ----------

// Target in working days for a planned effort. Priority only moves the target, never the consumed effort.
function calculateExpectedSlaDays(plannedEffort, priorityFactor, mode = DEFAULT_ENGINE_SETTINGS.priority_factor_mode) {
  const planned = num(plannedEffort);
  if (!(planned > 0)) return 0;
  const f = Number(priorityFactor) > 0 ? Number(priorityFactor) : 1;
  return mode === "divisor" ? planned / f : planned * f;
}

// Working days spent In Progress; open segments (ended_at null) run up to `now`.
function calculateConsumedEffort({ workSegments = [], now, weekend }) {
  return round2(workSegments.reduce((sum, s) => sum + workingDaysBetween(s.started_at, s.ended_at || now, weekend), 0));
}

// Working days spent On Hold across every hold period, including one that is still open.
function calculateHoldDays({ pauses = [], now, weekend }) {
  return round2(pauses.reduce((sum, p) => sum + workingDaysBetween(p.paused_at, p.resumed_at || now, weekend), 0));
}

// Planned effort not yet consumed. Unknown (null) until estimated; nothing remains once Completed/Cancelled.
function calculateRemainingEffort({ status, plannedEffort, actualEffort }) {
  if (status === STATUS.NOT_YET_ESTIMATED || num(plannedEffort) === null) return null;
  if (status === STATUS.COMPLETED || status === STATUS.CANCELLED) return 0;
  return round2(Math.max(Number(plannedEffort) - Number(actualEffort || 0), 0));
}

function calculateExpectedCompletionDate({ today, remainingDays, weekend }) {
  return addWorkingDays(dayKey(today), Math.max(Number(remainingDays) || 0, 0), weekend);
}

function classifyHealth(utilizationPct, settings = DEFAULT_ENGINE_SETTINGS) {
  if (utilizationPct === null || utilizationPct === undefined) return null;
  if (utilizationPct > settings.breach_threshold_pct) return HEALTH.BREACHED;
  if (utilizationPct > settings.at_risk_threshold_pct) return HEALTH.AT_RISK;
  return HEALTH.ON_TRACK;
}

const worstHealth = (list) => list.filter(Boolean).reduce((w, h) => (!w || HEALTH_RANK[h] > HEALTH_RANK[w] ? h : w), null);

// Every metric for one stage. `stage` is a request_stages row; segments/pauses belong to that stage.
function calculateStageSLA({ stage, workSegments = [], pauses = [], priorityFactor = 1, settings = DEFAULT_ENGINE_SETTINGS, weekend, now }) {
  const status = stage.status;
  const planned = num(stage.stage_effort_days);
  const consumed = calculateConsumedEffort({ workSegments, now, weekend });
  const holdDays = calculateHoldDays({ pauses, now, weekend });
  // A completed stage keeps the stored figure (which may be a manual override of the calendar-derived one).
  const actual = status === STATUS.COMPLETED ? Number(stage.actual_effort_days || 0) : consumed;
  const expectedRaw = calculateExpectedSlaDays(planned, priorityFactor, settings.priority_factor_mode);

  const started = [STATUS.IN_PROGRESS, STATUS.ON_HOLD, STATUS.COMPLETED].includes(status);
  const done = status === STATUS.COMPLETED || status === STATUS.CANCELLED;
  const remaining = calculateRemainingEffort({ status, plannedEffort: planned, actualEffort: actual });
  const remainingExpected = status === STATUS.NOT_YET_ESTIMATED || planned === null ? null : done ? 0 : Math.max(expectedRaw - consumed, 0);
  const utilizationPct = status === STATUS.NOT_YET_ESTIMATED || status === STATUS.CANCELLED || expectedRaw <= 0 ? null : (actual / expectedRaw) * 100;

  let expectedCompletionDate = null;
  if (status === STATUS.COMPLETED) expectedCompletionDate = stage.completed_at ? dayKey(stage.completed_at) : null;
  else if (remainingExpected !== null && !done) {
    // On Hold projects as if the stage resumed today.
    expectedCompletionDate = calculateExpectedCompletionDate({ today: now, remainingDays: remainingExpected, weekend });
  }

  return {
    stage: stage.stage_name,
    order: stage.stage_order,
    status,
    plannedEffort: planned,
    expectedSlaDays: round2(expectedRaw),
    consumedDays: consumed,
    actualEffort: round2(actual),
    remaining,
    remainingExpectedDays: remainingExpected === null ? null : round2(remainingExpected),
    holdDays,
    varianceDays: started && planned !== null ? round2(actual - planned) : null,
    utilizationPct: utilizationPct === null ? null : round2(utilizationPct),
    slaState: classifyHealth(utilizationPct, settings),
    startedAt: stage.started_at || null,
    completedAt: stage.completed_at || null,
    pausedAt: stage.paused_at || null,
    resumedAt: stage.resume_at || null,
    reopenCount: Number(stage.reopen_count || 0),
    isBackfilled: !!stage.is_backfilled,
    expectedCompletionDate,
  };
}

// The stage the request is "at": the earliest stage that is In Progress / On Hold, else the earliest unfinished one.
// null when every stage is Completed/Cancelled (request finished).
function deriveCurrentStage(stages) {
  const sorted = [...stages].sort((a, b) => a.stage_order - b.stage_order || (a.id ?? 0) - (b.id ?? 0));
  return (
    sorted.find((s) => s.status === STATUS.IN_PROGRESS || s.status === STATUS.ON_HOLD) ||
    sorted.find((s) => s.status !== STATUS.COMPLETED && s.status !== STATUS.CANCELLED) ||
    null
  );
}

// Request-level roll-up of calculateStageSLA results.
//   * Backfilled stages (legacy data with no effort history) are excluded from all totals.
//   * A cancelled stage contributes only the effort already spent: its remaining effort is dropped.
//   * Health = worst of the overall utilization and every individual stage's health.
function summarizeRequest({ stageMetrics, settings = DEFAULT_ENGINE_SETTINGS, weekend, now }) {
  const tracked = stageMetrics.filter((m) => !m.isBackfilled);
  let planned = 0, expected = 0, consumed = 0, remaining = 0, hold = 0, remainingExpected = 0, unestimated = 0;
  for (const m of tracked) {
    hold += m.holdDays;
    if (m.status === STATUS.NOT_YET_ESTIMATED) { unestimated++; continue; }
    consumed += m.actualEffort;
    if (m.status === STATUS.CANCELLED) { planned += m.actualEffort; expected += m.actualEffort; continue; }
    planned += m.plannedEffort || 0;
    expected += m.expectedSlaDays;
    remaining += m.remaining || 0;
    remainingExpected += m.remainingExpectedDays || 0;
  }
  const utilizationPct = expected > 0 ? (consumed / expected) * 100 : null;
  const pending = stageMetrics.filter((m) => ![STATUS.COMPLETED, STATUS.CANCELLED].includes(m.status));
  const lastCompleted = [...stageMetrics].filter((m) => m.completedAt).sort((a, b) => b.completedAt - a.completedAt)[0];

  return {
    totalPlannedDays: round2(planned),
    totalExpectedDays: round2(expected),
    totalConsumedDays: round2(consumed),
    totalRemainingDays: round2(remaining),
    totalHoldDays: round2(hold),
    varianceDays: round2(consumed - planned),
    utilizationPct: utilizationPct === null ? null : round2(utilizationPct),
    slaHealth: worstHealth([classifyHealth(utilizationPct, settings), ...tracked.filter((m) => m.status !== STATUS.CANCELLED).map((m) => m.slaState)]),
    unestimatedStages: unestimated,
    isFinished: pending.length === 0,
    expectedCompletionDate: pending.length
      ? calculateExpectedCompletionDate({ today: now, remainingDays: remainingExpected, weekend })
      : lastCompleted ? dayKey(lastCompleted.completedAt) : null,
  };
}

// ---------- status transitions (state machine) ----------

const ALLOWED = {
  [STATUS.NOT_YET_ESTIMATED]: [STATUS.NOT_STARTED, STATUS.IN_PROGRESS, STATUS.CANCELLED],
  [STATUS.NOT_STARTED]: [STATUS.NOT_YET_ESTIMATED, STATUS.IN_PROGRESS, STATUS.CANCELLED],
  [STATUS.IN_PROGRESS]: [STATUS.ON_HOLD, STATUS.COMPLETED, STATUS.CANCELLED],
  [STATUS.ON_HOLD]: [STATUS.IN_PROGRESS, STATUS.COMPLETED, STATUS.CANCELLED],
  [STATUS.COMPLETED]: [STATUS.IN_PROGRESS], // reopen
  [STATUS.CANCELLED]: [STATUS.NOT_STARTED, STATUS.NOT_YET_ESTIMATED], // reinstate
};

// Maps a user-supplied status ("on hold", "ON HOLD") to its canonical spelling, or null.
const canonicalStatus = (s) => STATUSES.find((x) => norm(x) === norm(s)) || null;

// Decides whether `stage` may move to `toStatus` and which action that is. Pure: nothing is persisted here.
//   stages: every request_stages row of the request;  plannedEffort: optional new estimate sent with the change
//   force:  skips the stage-order and single-active-stage rules (used when reconciling legacy edits)
// Returns { action, toStatus, errors, plannedEffort } -- a non-empty `errors` means the change is rejected.
function planTransition({ stage, toStatus, stages = [], plannedEffort, settings = DEFAULT_ENGINE_SETTINGS, force = false }) {
  const from = stage.status;
  const errors = [];
  const estimate = plannedEffort !== undefined && plannedEffort !== null ? Number(plannedEffort) : num(stage.stage_effort_days);
  const estimated = estimate > 0;
  const estimateChanged = plannedEffort !== undefined && plannedEffort !== null && Number(plannedEffort) !== num(stage.stage_effort_days);
  // Estimating a not-yet-estimated stage makes it Not Started.
  if (from === STATUS.NOT_YET_ESTIMATED && toStatus === from && plannedEffort > 0) toStatus = STATUS.NOT_STARTED;

  if (from === toStatus) {
    return { action: estimateChanged ? ACTION.ESTIMATE : ACTION.NOOP, toStatus, errors, plannedEffort: estimateChanged ? estimate : num(stage.stage_effort_days) };
  }
  if (!ALLOWED[from].includes(toStatus)) {
    errors.push(`Cannot change "${stage.stage_name}" from ${from} to ${toStatus}.`);
    return { action: null, toStatus, errors, plannedEffort: estimate };
  }
  if ((toStatus === STATUS.NOT_STARTED || toStatus === STATUS.IN_PROGRESS) && !estimated) {
    errors.push(`"${stage.stage_name}" has no planned effort: send plannedEffort (man-days, above 0) before it can be ${toStatus === STATUS.IN_PROGRESS ? "started" : "marked Not Started"}.`);
  }
  if (toStatus === STATUS.NOT_YET_ESTIMATED && plannedEffort > 0) {
    errors.push("A stage with a planned effort cannot be set to Not Yet Estimated.");
  }
  if (toStatus === STATUS.IN_PROGRESS && !force) {
    const active = stages.find((s) => s.id !== stage.id && s.status === STATUS.IN_PROGRESS);
    if (active) errors.push(`"${active.stage_name}" is already In Progress: put it On Hold or complete it first.`);
    if (settings.enforce_stage_order && from !== STATUS.ON_HOLD) {
      const unfinished = stages.filter((s) => s.stage_order < stage.stage_order && s.status !== STATUS.COMPLETED && s.status !== STATUS.CANCELLED);
      if (unfinished.length) errors.push(`Earlier stage(s) must be Completed or Cancelled first: ${unfinished.map((s) => s.stage_name).join(", ")}.`);
    }
  }

  let action;
  if (toStatus === STATUS.IN_PROGRESS) action = from === STATUS.ON_HOLD ? ACTION.RESUME : from === STATUS.COMPLETED ? ACTION.REOPEN : ACTION.START;
  else if (toStatus === STATUS.ON_HOLD) action = ACTION.PAUSE;
  else if (toStatus === STATUS.COMPLETED) action = ACTION.COMPLETE;
  else if (toStatus === STATUS.CANCELLED) action = ACTION.CANCEL;
  else if (toStatus === STATUS.NOT_YET_ESTIMATED) action = ACTION.UNESTIMATE;
  else action = from === STATUS.CANCELLED ? ACTION.REINSTATE : ACTION.ESTIMATE;

  return { action, toStatus, errors, plannedEffort: toStatus === STATUS.NOT_YET_ESTIMATED ? null : estimate };
}

// ---------- initial state for requests that pre-date the engine ----------

// Interprets a legacy request status (free lookup name + its configured Active/Paused/Done state):
//   'idle' not started / not estimated | 'active' | 'hold' | 'done' | 'cancelled'
function classifyLegacyStatus(name, state) {
  const n = norm(name);
  if (["cancelled", "canceled"].includes(n)) return "cancelled";
  if (state === "Done") return "done";
  if (state === "Paused" || ["on hold", "hold"].includes(n)) return "hold";
  if (["not started", "not yet estimated", "not estimated", ""].includes(n)) return "idle";
  return "active";
}

// Builds the initial request_stages for a request from its legacy stage/status.
//   pipeline:     sla_stages rows (name, stage_order, effort_days) with is_pipeline = 1
//   legacyStage:  the sla_stages row of the request's current stage, or null (unknown stage = start of the pipeline)
// Stages before the current one are Completed (backfilled: no effort history exists); the current stage takes the
// status the legacy status implies; later stages are Not Started (or Not Yet Estimated without a default effort).
function planInitialStages({ pipeline, legacyStage, intent }) {
  const sorted = [...pipeline].sort((a, b) => a.stage_order - b.stage_order);
  const curOrder = legacyStage ? Number(legacyStage.stage_order) : 0;
  let cur = sorted.findIndex((s) => Number(s.stage_order) >= curOrder);
  if (cur === -1) cur = sorted.length; // past the end of the pipeline, e.g. "Closed"

  return sorted.map((s, i) => {
    const planned = Number(s.effort_days) > 0 ? Number(s.effort_days) : null;
    const base = { stage_name: s.name, stage_order: Number(s.stage_order), stage_effort_days: planned, is_backfilled: false };
    if (i < cur) return { ...base, status: STATUS.COMPLETED, is_backfilled: true };
    if (intent === "done") return { ...base, status: STATUS.COMPLETED, is_backfilled: true };
    if (intent === "cancelled") return { ...base, status: STATUS.CANCELLED, is_backfilled: true };
    if (planned === null) return { ...base, status: STATUS.NOT_YET_ESTIMATED };
    if (i === cur && intent === "active") return { ...base, status: STATUS.IN_PROGRESS };
    if (i === cur && intent === "hold") return { ...base, status: STATUS.ON_HOLD };
    return { ...base, status: STATUS.NOT_STARTED };
  });
}

// ---------- input validation for POST /stage-status ----------

function validateStageStatusInput(body) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const stage = String(b.stage ?? "").trim();
  if (!stage) errors.push("stage is required.");
  else if (stage.length > 200) errors.push("stage must be at most 200 characters.");

  const status = canonicalStatus(b.status);
  if (!b.status) errors.push("status is required.");
  else if (!status) errors.push(`status must be one of: ${STATUSES.join(", ")}.`);

  const optionalNumber = (key, label, max, { positive }) => {
    if (b[key] === undefined || b[key] === null || b[key] === "") return undefined;
    const v = Number(b[key]);
    if (!Number.isFinite(v) || v > max || (positive ? v <= 0 : v < 0)) {
      errors.push(`${label} must be a number ${positive ? "above" : "of at least"} 0 and at most ${max}.`);
      return undefined;
    }
    return round2(v);
  };
  const plannedEffort = optionalNumber("plannedEffort", "plannedEffort", 999, { positive: true });
  const actualEffortDays = optionalNumber("actualEffortDays", "actualEffortDays", 9999, { positive: false });
  if (actualEffortDays !== undefined && status !== STATUS.COMPLETED) errors.push("actualEffortDays can only be sent together with status Completed.");

  let note;
  if (b.note !== undefined && b.note !== null && b.note !== "") {
    note = String(b.note).trim();
    if (note.length > 500) errors.push("note must be at most 500 characters.");
  }
  return { errors, clean: { stage, status, plannedEffort, actualEffortDays, note } };
}

module.exports = {
  STATUS, STATUSES, HEALTH, ACTION, DEFAULT_WEEKEND, DEFAULT_ENGINE_SETTINGS,
  norm, round2, dayKey,
  parseEngineSettings, validateEngineSettings,
  workingDaysBetween, addWorkingDays,
  calculateExpectedSlaDays, calculateConsumedEffort, calculateHoldDays, calculateRemainingEffort,
  calculateExpectedCompletionDate, classifyHealth, worstHealth,
  calculateStageSLA, summarizeRequest, deriveCurrentStage,
  canonicalStatus, planTransition, classifyLegacyStatus, planInitialStages, validateStageStatusInput,
};
