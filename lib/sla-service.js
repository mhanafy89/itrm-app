// SLA service: orchestrates the pure engine (lib/sla-engine.js) and a repository (lib/sla-repository.js).
//
//   updateStageStatus()  one entry point; the status picked decides whether the SLA starts, pauses,
//                        resumes, completes, is cancelled or reopened. startSLA/pauseSLA/resumeSLA/
//                        completeStage/cancelStage/reopenStage are strict wrappers around it.
//   getRequestSla()      live metrics for one request;  getDashboard() roll-up across requests
//   syncFromLegacy()     reconciles edits made through the old request form (stage_id / status_id)
//
// Every write runs in one transaction that first locks the request row (UPDLOCK), so two people
// changing the same request serialize instead of corrupting the open work/hold segments.
const E = require("./sla-engine");

const { STATUS, ACTION, norm } = E;

class SlaError extends Error {
  constructor(statusCode, errors) {
    super(errors[0]);
    this.statusCode = statusCode;
    this.errors = errors;
  }
}
const fail = (statusCode, ...errors) => {
  throw new SlaError(statusCode, errors);
};

const isDone = (s) => s.status === STATUS.COMPLETED || s.status === STATUS.CANCELLED;

// Chooses the legacy status lookup value that matches the engine's state, or null to leave it alone.
// A legacy status is kept when it already expresses the same intent (e.g. "Pending for Approval" while
// work is In Progress), so the old Status column is never churned needlessly.
function pickLegacyStatus({ statuses, legacyStatus, stages }) {
  const current = E.deriveCurrentStage(stages);
  let intent, state, prefer;
  if (!current) {
    const allCancelled = stages.length > 0 && stages.every((s) => s.status === STATUS.CANCELLED);
    intent = allCancelled ? "cancelled" : "done";
    state = "Done";
    prefer = allCancelled ? ["cancelled", "canceled"] : ["completed", "closed"];
  } else if (current.status === STATUS.ON_HOLD) {
    [intent, state, prefer] = ["hold", "Paused", ["on hold", "hold"]];
  } else if (current.status === STATUS.IN_PROGRESS) {
    [intent, state, prefer] = ["active", "Active", ["in progress"]];
  } else if (current.status === STATUS.NOT_YET_ESTIMATED) {
    [intent, state, prefer] = ["idle", "Active", ["not yet estimated", "not estimated", "not started"]];
  } else {
    [intent, state, prefer] = ["idle", "Active", ["not started"]];
  }

  const existing = statuses.find((s) => norm(s.name) === norm(legacyStatus));
  if (existing && E.classifyLegacyStatus(existing.name, existing.state) === intent) return null;
  for (const name of prefer) {
    const hit = statuses.find((s) => norm(s.name) === name && s.state === state);
    if (hit) return hit.name;
  }
  return null;
}

const groupBy = (rows, key) => {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
};

class SlaService {
  // repo: see lib/sla-repository.js | getConfig: async () => SLA config (lib/sla.js getConfig) | now: injectable clock
  constructor({ repo, getConfig, now = () => new Date() }) {
    this.repo = repo;
    this.getConfig = getConfig;
    this.now = now;
  }

  // ----- pure calculations, exposed for reuse (no database access) -----
  calculateStageSLA(args) { return E.calculateStageSLA(args); }
  calculateRemainingEffort(args) { return E.calculateRemainingEffort(args); }
  calculateConsumedEffort(args) { return E.calculateConsumedEffort(args); }
  calculateExpectedCompletionDate(args) { return E.calculateExpectedCompletionDate(args); }

  // ----- state-changing operations -----

  startSLA(requestId, stage, user, opts = {}) {
    return this.updateStageStatus(requestId, { stage, status: STATUS.IN_PROGRESS, ...opts }, user, { expect: [ACTION.START] });
  }
  pauseSLA(requestId, stage, user, opts = {}) {
    return this.updateStageStatus(requestId, { stage, status: STATUS.ON_HOLD, ...opts }, user, { expect: [ACTION.PAUSE] });
  }
  resumeSLA(requestId, stage, user, opts = {}) {
    return this.updateStageStatus(requestId, { stage, status: STATUS.IN_PROGRESS, ...opts }, user, { expect: [ACTION.RESUME] });
  }
  completeStage(requestId, stage, user, opts = {}) {
    return this.updateStageStatus(requestId, { stage, status: STATUS.COMPLETED, ...opts }, user, { expect: [ACTION.COMPLETE] });
  }
  cancelStage(requestId, stage, user, opts = {}) {
    return this.updateStageStatus(requestId, { stage, status: STATUS.CANCELLED, ...opts }, user, { expect: [ACTION.CANCEL] });
  }
  reopenStage(requestId, stage, user, opts = {}) {
    return this.updateStageStatus(requestId, { stage, status: STATUS.IN_PROGRESS, ...opts }, user, { expect: [ACTION.REOPEN] });
  }

  // POST /api/requests/:id/stage-status. `input`: { stage, status, plannedEffort?, actualEffortDays?, note? }.
  async updateStageStatus(requestId, input, user, { expect } = {}) {
    const { errors, clean } = E.validateStageStatusInput(input);
    if (errors.length) fail(400, ...errors);

    return this.repo.transaction(async (tx) => {
      const ctx = await this._load(tx, requestId, { user, source: "api" });
      const stage = ctx.stages.find((s) => norm(s.stage_name) === norm(clean.stage));
      if (!stage) fail(404, `Stage "${clean.stage}" is not tracked for this request. Tracked stages: ${ctx.stages.map((s) => s.stage_name).join(", ")}.`);

      const before = this._currentName(ctx);
      const result = await this._apply(ctx, stage, clean.status, { ...clean, expect });
      if (result.changed) await this._settle(ctx, before, result.action);
      return {
        transition: { stage: stage.stage_name, from: result.from, to: stage.status, action: result.action, changed: result.changed },
        ...(await this._buildSla(ctx)),
      };
    });
  }

  // ----- reads -----

  async getRequestSla(requestId) {
    const request = await this.repo.getRequest(requestId);
    if (!request) fail(404, "Request not found.");
    const stages = await this.repo.listStages(requestId);
    if (!stages.length) {
      // First look at a request created before the engine existed: build its tracking from the legacy fields.
      return this.repo.transaction(async (tx) => this._buildSla(await this._load(tx, requestId, { user: null, source: "migration" })));
    }
    return this._buildSla({ tx: this.repo, request, cfg: await this._settings(), now: this.now(), stages });
  }

  async getHistory(requestId) {
    if (!(await this.repo.getRequest(requestId))) fail(404, "Request not found.");
    const [statusHistory, stageHistory, pauses] = await Promise.all([
      this.repo.listStatusHistory(requestId),
      this.repo.listStageHistory(requestId),
      this.repo.listPauses(requestId),
    ]);
    return { statusHistory, stageHistory, pauses };
  }

  // Request- and stage-level metrics across every tracked request. Filters: priority, stage (current), health.
  async getDashboard({ priority, stage, health } = {}) {
    const cfg = await this._settings();
    const now = this.now();
    const [requests, stages, work, pauses] = await Promise.all([
      this.repo.listTrackedRequests(), this.repo.listAllStages(), this.repo.listAllWork(), this.repo.listAllPauses(),
    ]);
    const stagesByRequest = groupBy(stages, "business_request_id");
    const workByStage = groupBy(work, "request_stage_id");
    const pausesByStage = groupBy(pauses, "request_stage_id");

    const rows = [];
    const stageAgg = new Map();
    for (const req of requests) {
      const reqStages = stagesByRequest.get(req.id) || [];
      const factor = this._priorityFactor(cfg, req.priority);
      const metrics = reqStages.map((s) =>
        E.calculateStageSLA({ stage: s, workSegments: workByStage.get(s.id) || [], pauses: pausesByStage.get(s.id) || [], priorityFactor: factor, settings: cfg.settings, weekend: cfg.weekend, now })
      );
      const summary = E.summarizeRequest({ stageMetrics: metrics, settings: cfg.settings, weekend: cfg.weekend, now });
      const current = E.deriveCurrentStage(reqStages);
      const row = {
        requestId: req.id, brNo: req.br_no, title: req.title, priority: req.priority,
        currentStage: current ? current.stage_name : "Closed", status: current ? current.status : STATUS.COMPLETED,
        ...summary,
      };
      if (priority && norm(row.priority) !== norm(priority)) continue;
      if (stage && norm(row.currentStage) !== norm(stage)) continue;
      if (health && norm(row.slaHealth) !== norm(health)) continue;
      rows.push(row);

      for (const m of metrics) {
        if (m.isBackfilled || ![STATUS.IN_PROGRESS, STATUS.ON_HOLD, STATUS.COMPLETED].includes(m.status)) continue;
        const a = stageAgg.get(m.stage) || { stage: m.stage, order: m.order, requests: 0, plannedEffort: 0, expectedSlaDays: 0, actualEffort: 0, holdDays: 0 };
        a.requests++;
        a.plannedEffort += m.plannedEffort || 0;
        a.expectedSlaDays += m.expectedSlaDays;
        a.actualEffort += m.actualEffort;
        a.holdDays += m.holdDays;
        stageAgg.set(m.stage, a);
      }
    }

    const stageMetrics = [...stageAgg.values()].sort((a, b) => a.order - b.order).map((a) => {
      const utilization = a.expectedSlaDays > 0 ? (a.actualEffort / a.expectedSlaDays) * 100 : null;
      return {
        stage: a.stage, requests: a.requests,
        plannedEffort: E.round2(a.plannedEffort), actualEffort: E.round2(a.actualEffort),
        varianceDays: E.round2(a.actualEffort - a.plannedEffort), holdDays: E.round2(a.holdDays),
        utilizationPct: utilization === null ? null : E.round2(utilization), slaState: E.classifyHealth(utilization, cfg.settings),
      };
    });
    const sum = (key) => E.round2(rows.reduce((t, r) => t + r[key], 0));
    const counts = { [E.HEALTH.ON_TRACK]: 0, [E.HEALTH.AT_RISK]: 0, [E.HEALTH.BREACHED]: 0 };
    for (const r of rows) if (r.slaHealth) counts[r.slaHealth]++;

    return {
      thresholds: { atRiskPct: cfg.settings.at_risk_threshold_pct, breachPct: cfg.settings.breach_threshold_pct },
      totals: { requests: rows.length, plannedDays: sum("totalPlannedDays"), consumedDays: sum("totalConsumedDays"), holdDays: sum("totalHoldDays"), health: counts },
      stages: stageMetrics,
      requests: rows,
    };
  }

  // ----- migration / compatibility -----

  // Creates tracking for every request that has none (idempotent). Used at startup and by `node db/migrate.js backfill`.
  async backfillMissing({ user = "sla-migration", logger = console } = {}) {
    const ids = await this.repo.listRequestIdsWithoutTracking();
    let done = 0;
    for (const id of ids) {
      try {
        await this.repo.transaction((tx) => this._load(tx, id, { user, source: "migration" }));
        done++;
      } catch (err) {
        logger.error(`SLA backfill failed for request ${id}: ${err.message}`);
      }
    }
    return { total: ids.length, created: done };
  }

  // Reconciles the engine with the request's legacy stage/status after the old form saved it.
  // The legacy fields win here (they were just written by the user), so nothing is written back to them.
  async syncFromLegacy(requestId, user) {
    return this.repo.transaction(async (tx) => {
      const ctx = await this._load(tx, requestId, { user, source: "legacy-sync" });
      if (ctx.initialized) return { initialized: true };

      const before = this._currentName(ctx);
      const status = ctx.cfg.config.statuses.find((s) => norm(s.name) === norm(ctx.request.status));
      const intent = E.classifyLegacyStatus(ctx.request.status, status && status.state);
      const step = async (stage, to, note) => {
        try {
          await this._apply(ctx, stage, to, { force: true, note });
        } catch (err) {
          if (!(err instanceof SlaError)) throw err; // e.g. a stage without an estimate cannot be started: leave it
        }
      };

      if (intent === "done" || intent === "cancelled") {
        for (const s of [...ctx.stages]) {
          if (isDone(s)) continue;
          const active = s.status === STATUS.IN_PROGRESS || s.status === STATUS.ON_HOLD;
          await step(s, active && intent === "done" ? STATUS.COMPLETED : STATUS.CANCELLED, "Request closed in the request form");
        }
      } else {
        const target = ctx.stages.find((s) => norm(s.stage_name) === norm(ctx.request.stage));
        if (target) await this._alignToStage(ctx, target, intent, step);
        await this._applyIntent(ctx, intent, step);
      }
      await this._settle(ctx, before, null);
      return { initialized: false };
    });
  }

  // ----- internals -----

  async _settings() {
    const config = await this.getConfig();
    return {
      config,
      settings: E.parseEngineSettings(config.settings),
      weekend: new Set(config.settings && config.settings.weekend_days ? config.settings.weekend_days : E.DEFAULT_WEEKEND),
    };
  }

  _priorityFactor(cfg, priorityName) {
    const p = cfg.config.priorities.find((x) => norm(x.name) === norm(priorityName));
    return p && Number(p.factor) > 0 ? Number(p.factor) : 1;
  }

  _closedName(cfg, stages) {
    const closed = cfg.config.stages.find((s) => norm(s.name) === "closed");
    return closed ? closed.name : stages.length ? [...stages].sort((a, b) => a.stage_order - b.stage_order).pop().stage_name : "Closed";
  }

  _currentName(ctx) {
    const current = E.deriveCurrentStage(ctx.stages);
    return current ? current.stage_name : this._closedName(ctx.cfg, ctx.stages);
  }

  // Locks the request, loads its stages (initializing them from the legacy fields on first contact).
  async _load(tx, requestId, { user, source }) {
    const request = await tx.getRequest(requestId, { lock: true });
    if (!request) fail(404, "Request not found.");
    const cfg = await this._settings();
    const now = this.now();
    let stages = await tx.listStages(requestId);
    let initialized = false;
    if (!stages.length) {
      stages = await this._initialize(tx, request, cfg, now, user);
      initialized = true;
    }
    return { tx, request, cfg, now, user, source, stages, initialized };
  }

  async _initialize(tx, request, cfg, now, user) {
    const pipeline = cfg.config.stages.filter((s) => s.is_pipeline);
    if (!pipeline.length) fail(409, "No pipeline stages are configured in the SLA settings.");
    const legacyStage = cfg.config.stages.find((s) => norm(s.name) === norm(request.stage)) || null;
    const status = cfg.config.statuses.find((s) => norm(s.name) === norm(request.status));
    const intent = E.classifyLegacyStatus(request.status, status && status.state);

    for (const p of E.planInitialStages({ pipeline, legacyStage, intent })) {
      const finished = p.status === STATUS.COMPLETED || p.status === STATUS.CANCELLED;
      const running = p.status === STATUS.IN_PROGRESS || p.status === STATUS.ON_HOLD;
      const stageId = await tx.insertStage({
        business_request_id: request.id,
        stage_name: p.stage_name,
        stage_order: p.stage_order,
        status: p.status,
        stage_effort_days: p.stage_effort_days,
        actual_effort_days: 0,
        remaining_effort_days: p.status === STATUS.NOT_YET_ESTIMATED ? null : finished ? 0 : p.stage_effort_days,
        sla_consumed_days: 0,
        total_hold_time: 0,
        started_at: running ? now : null,
        completed_at: p.status === STATUS.COMPLETED ? now : null,
        paused_at: p.status === STATUS.ON_HOLD ? now : null,
        resume_at: null,
        reopen_count: 0,
        is_backfilled: p.is_backfilled,
        updated_by: user,
        updated_at: now,
      });
      // Consumption starts now: legacy data has no record of earlier effort.
      if (p.status === STATUS.IN_PROGRESS) await tx.openWork({ request_stage_id: stageId, business_request_id: request.id, started_at: now, created_by: user });
      if (p.status === STATUS.ON_HOLD) await tx.openPause({ request_stage_id: stageId, business_request_id: request.id, paused_at: now, reason: "Imported from request status", paused_by: user });
      await tx.insertStatusHistory({
        request_stage_id: stageId, business_request_id: request.id, stage_name: p.stage_name,
        from_status: null, to_status: p.status, action: "init", source: "migration",
        planned_effort_days: p.stage_effort_days, consumed_days: 0, remaining_days: p.stage_effort_days,
        note: p.is_backfilled ? "Backfilled from legacy request data" : "Initialized from legacy request data",
        changed_by: user, changed_at: now,
      });
    }
    const stages = await tx.listStages(request.id);
    const current = E.deriveCurrentStage(stages);
    await tx.insertStageHistory({
      business_request_id: request.id, from_stage: request.stage || null,
      to_stage: current ? current.stage_name : this._closedName(cfg, stages),
      reason: "initialized", source: "migration", changed_by: user, changed_at: now,
    });
    return stages;
  }

  // Applies one validated transition: segments, aggregates, audit row. Returns { action, from, changed }.
  async _apply(ctx, stage, toStatus, { plannedEffort, actualEffortDays, note, force = false, expect } = {}) {
    const { tx, now, cfg, user, source } = ctx;
    const plan = E.planTransition({ stage, toStatus, stages: ctx.stages, plannedEffort, settings: cfg.settings, force });
    if (plan.errors.length) fail(409, ...plan.errors);
    if (expect && !expect.includes(plan.action)) {
      fail(409, `"${stage.stage_name}" is ${stage.status}: that is not a ${expect.join("/")} operation.`);
    }
    if (plan.action === ACTION.NOOP) {
      if (actualEffortDays !== undefined && stage.status === STATUS.COMPLETED) fail(409, `"${stage.stage_name}" is already Completed: reopen it to change its recorded effort.`);
      return { action: plan.action, from: stage.status, changed: false };
    }

    const from = stage.status;
    const [allWork, allPauses] = await Promise.all([tx.listWork(stage.business_request_id), tx.listPauses(stage.business_request_id)]);
    const work = allWork.filter((w) => w.request_stage_id === stage.id);
    const pauses = allPauses.filter((p) => p.request_stage_id === stage.id);
    const openWork = work.find((w) => !w.ended_at);
    const openPause = pauses.find((p) => !p.resumed_at);
    const days = (since) => E.workingDaysBetween(since, now, cfg.weekend);

    const closeWork = async (reason) => {
      if (!openWork) return;
      await tx.closeWork(openWork.id, now, reason, days(openWork.started_at));
      openWork.ended_at = now;
    };
    const closePause = async () => {
      if (!openPause) return;
      await tx.closePause(openPause.id, now, days(openPause.paused_at), user);
      openPause.resumed_at = now;
    };
    const openNewWork = async () => {
      await tx.openWork({ request_stage_id: stage.id, business_request_id: stage.business_request_id, started_at: now, created_by: user });
      work.push({ request_stage_id: stage.id, started_at: now, ended_at: null });
    };

    const patch = { status: plan.toStatus, stage_effort_days: plan.plannedEffort, updated_by: user, updated_at: now };
    switch (plan.action) {
      case ACTION.START:
      case ACTION.REOPEN:
        patch.started_at = stage.started_at || now;
        patch.completed_at = null;
        patch.paused_at = null;
        if (plan.action === ACTION.REOPEN) patch.reopen_count = Number(stage.reopen_count || 0) + 1;
        await openNewWork();
        break;
      case ACTION.PAUSE:
        await closeWork("Hold");
        await tx.openPause({ request_stage_id: stage.id, business_request_id: stage.business_request_id, paused_at: now, reason: note || null, paused_by: user });
        pauses.push({ request_stage_id: stage.id, paused_at: now, resumed_at: null });
        patch.paused_at = now;
        break;
      case ACTION.RESUME:
        await closePause();
        await openNewWork();
        patch.paused_at = null;
        patch.resume_at = now;
        break;
      case ACTION.COMPLETE:
        await closeWork("Completed");
        await closePause();
        patch.completed_at = now;
        patch.paused_at = null;
        break;
      case ACTION.CANCEL:
        await closeWork("Cancelled");
        await closePause();
        patch.paused_at = null;
        patch.completed_at = null;
        break;
      case ACTION.REINSTATE:
        patch.completed_at = null;
        break;
      default: // estimate / unestimate: effort only
        break;
    }

    // Consumed effort comes from the segments only -- priority never enters. A completed stage stores its
    // actual effort (manual override if given), which then stays fixed until the stage is reopened.
    const consumed = E.calculateConsumedEffort({ workSegments: work, now, weekend: cfg.weekend });
    patch.sla_consumed_days = consumed;
    patch.actual_effort_days =
      plan.action === ACTION.COMPLETE ? (actualEffortDays !== undefined ? actualEffortDays : consumed)
        : plan.toStatus === STATUS.COMPLETED ? Number(stage.actual_effort_days || 0)
        : consumed;
    patch.total_hold_time = E.calculateHoldDays({ pauses, now, weekend: cfg.weekend });
    patch.remaining_effort_days = E.calculateRemainingEffort({ status: plan.toStatus, plannedEffort: plan.plannedEffort, actualEffort: patch.actual_effort_days });

    await tx.updateStage(stage.id, patch);
    Object.assign(stage, patch);
    await tx.insertStatusHistory({
      request_stage_id: stage.id, business_request_id: stage.business_request_id, stage_name: stage.stage_name,
      from_status: from, to_status: plan.toStatus, action: plan.action, source,
      planned_effort_days: plan.plannedEffort, consumed_days: consumed, remaining_days: patch.remaining_effort_days,
      note: note || null, changed_by: user, changed_at: now,
    });
    return { action: plan.action, from, changed: true };
  }

  // After a change: optionally auto-start the next stage, audit the stage movement, and mirror the
  // result into the legacy stage/status columns (not for legacy-sync, where those fields are the input).
  async _settle(ctx, beforeName, action) {
    const { tx, cfg, now, user, source } = ctx;
    if (action === ACTION.COMPLETE && cfg.settings.auto_start_next_stage) {
      const next = E.deriveCurrentStage(ctx.stages);
      if (next && next.status === STATUS.NOT_STARTED) {
        try {
          await this._apply(ctx, next, STATUS.IN_PROGRESS, { note: "Started automatically when the previous stage completed" });
        } catch (err) {
          if (!(err instanceof SlaError)) throw err; // not startable (e.g. blocked by another active stage): stays Not Started
        }
      }
    }

    const afterName = this._currentName(ctx);
    if (afterName !== beforeName) {
      await tx.insertStageHistory({ business_request_id: ctx.request.id, from_stage: beforeName, to_stage: afterName, reason: "stage-change", source, changed_by: user, changed_at: now });
    }
    if (source === "legacy-sync") return;

    const statusName = pickLegacyStatus({ statuses: cfg.config.statuses, legacyStatus: ctx.request.status, stages: ctx.stages });
    const stageName = afterName !== beforeName ? afterName : null;
    if (statusName || stageName) {
      await tx.setLegacyFields(ctx.request.id, { stageName, statusName, user, now });
      if (stageName) ctx.request.stage = stageName;
      if (statusName) ctx.request.status = statusName;
    }
  }

  // Legacy stage moved: close what was skipped (forward) or bring the target back (backward).
  async _alignToStage(ctx, target, intent, step) {
    for (const s of [...ctx.stages]) {
      if (s.stage_order < target.stage_order && !isDone(s)) {
        const active = s.status === STATUS.IN_PROGRESS || s.status === STATUS.ON_HOLD;
        await step(s, active ? STATUS.COMPLETED : STATUS.CANCELLED, "Skipped: request moved forward in the request form");
      }
    }
    if (isDone(target) && intent !== "idle") {
      for (const s of ctx.stages) {
        if (s.stage_order > target.stage_order && s.status === STATUS.IN_PROGRESS) {
          await step(s, STATUS.ON_HOLD, "Paused: request moved back to an earlier stage");
        }
      }
      await step(target, target.status === STATUS.CANCELLED ? STATUS.NOT_STARTED : STATUS.IN_PROGRESS, "Request moved back in the request form");
    }
  }

  // Legacy status -> the current stage's status (Active starts/resumes, Paused holds).
  async _applyIntent(ctx, intent, step) {
    if (intent !== "active" && intent !== "hold") return;
    let subject = E.deriveCurrentStage(ctx.stages);
    if (!subject) {
      // Everything was finished but the request is open again: reopen the last completed stage.
      subject = [...ctx.stages].sort((a, b) => b.stage_order - a.stage_order).find((s) => s.status === STATUS.COMPLETED);
      if (!subject) return;
    }
    if (intent === "active" && [STATUS.NOT_STARTED, STATUS.ON_HOLD, STATUS.COMPLETED].includes(subject.status)) {
      await step(subject, STATUS.IN_PROGRESS, "Status set to active in the request form");
    } else if (intent === "hold" && subject.status === STATUS.COMPLETED) {
      await step(subject, STATUS.IN_PROGRESS, "Request reopened in the request form");
      await step(subject, STATUS.ON_HOLD, "Status set to on hold in the request form");
    } else if (intent === "hold" && subject.status === STATUS.IN_PROGRESS) {
      await step(subject, STATUS.ON_HOLD, "Status set to on hold in the request form");
    }
  }

  // Full response for one request: current-stage headline fields, request roll-up, per-stage metrics.
  async _buildSla(ctx) {
    const { tx, request, cfg, now, stages } = ctx;
    const [work, pauses] = await Promise.all([tx.listWork(request.id), tx.listPauses(request.id)]);
    const workByStage = groupBy(work, "request_stage_id");
    const pausesByStage = groupBy(pauses, "request_stage_id");
    const factor = this._priorityFactor(cfg, request.priority);

    const sorted = [...stages].sort((a, b) => a.stage_order - b.stage_order || a.id - b.id);
    const metrics = sorted.map((s) =>
      E.calculateStageSLA({ stage: s, workSegments: workByStage.get(s.id) || [], pauses: pausesByStage.get(s.id) || [], priorityFactor: factor, settings: cfg.settings, weekend: cfg.weekend, now })
    );
    const summary = E.summarizeRequest({ stageMetrics: metrics, settings: cfg.settings, weekend: cfg.weekend, now });

    const current = E.deriveCurrentStage(stages);
    const headline = current
      ? metrics.find((m) => m.stage === current.stage_name)
      : [...metrics].sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0) || b.order - a.order)[0];
    const allCancelled = stages.length > 0 && stages.every((s) => s.status === STATUS.CANCELLED);

    return {
      requestId: request.id,
      priority: request.priority || null,
      priorityFactor: factor,
      priorityFactorMode: cfg.settings.priority_factor_mode,
      currentStage: current ? current.stage_name : this._closedName(cfg, stages),
      status: current ? current.status : allCancelled ? STATUS.CANCELLED : STATUS.COMPLETED,
      plannedEffort: headline ? headline.plannedEffort : null,
      actualConsumed: headline ? headline.actualEffort : 0,
      remaining: headline ? headline.remaining : null,
      holdDays: headline ? headline.holdDays : 0,
      expectedCompletionDate: headline ? headline.expectedCompletionDate : null,
      slaState: headline ? headline.slaState : null,
      expectedSlaDays: headline ? headline.expectedSlaDays : 0,
      utilizationPct: headline ? headline.utilizationPct : null,
      request: summary,
      stages: metrics,
    };
  }
}

// ---------- default wiring (lazy so tests can import this module without a database) ----------

let defaultService = null;
function getDefaultService() {
  if (!defaultService) {
    const database = require("../db/database");
    const { SqlSlaRepository } = require("./sla-repository");
    const { getConfig } = require("./sla");
    defaultService = new SlaService({ repo: new SqlSlaRepository(database), getConfig });
  }
  return defaultService;
}

// Called after the old request form saves; never throws (the request save already succeeded).
// SLA_ENGINE_SYNC=false switches the reconciliation off.
async function syncLegacyRequest(requestId, user) {
  if (process.env.SLA_ENGINE_SYNC === "false") return;
  try {
    await getDefaultService().syncFromLegacy(requestId, user);
  } catch (err) {
    console.error(`SLA sync failed for request ${requestId}:`, err.message);
  }
}

module.exports = { SlaService, SlaError, pickLegacyStatus, getDefaultService, syncLegacyRequest, ...E };
