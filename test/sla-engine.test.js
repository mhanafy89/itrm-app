const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../lib/sla-engine");

const { STATUS, HEALTH, ACTION } = E;
// Local-time dates. 2026-11-23 is a Monday.
const at = (day, hour = 9) => new Date(2026, 10, day, hour, 0, 0);
const FRI_SAT = [5, 6];
const SAT_SUN = [0, 6];

const stageRow = (over = {}) => ({
  id: 1, stage_name: "Development", stage_order: 3, status: STATUS.IN_PROGRESS,
  stage_effort_days: 10, actual_effort_days: 0, started_at: at(23), completed_at: null, ...over,
});

test("workingDaysBetween excludes the configured weekend and the start day", () => {
  assert.equal(E.workingDaysBetween(at(23), at(27), FRI_SAT), 3); // Tue, Wed, Thu
  assert.equal(E.workingDaysBetween(at(23), at(27), SAT_SUN), 4); // Tue..Fri
  assert.equal(E.workingDaysBetween(at(23), at(30), SAT_SUN), 5);
  assert.equal(E.workingDaysBetween(at(23, 9), at(23, 17), SAT_SUN), 0);
  assert.equal(E.workingDaysBetween(at(27), at(23), SAT_SUN), 0);
});

test("addWorkingDays skips weekends and rounds fractions up", () => {
  assert.equal(E.addWorkingDays("2026-11-23", 5, SAT_SUN), "2026-11-30");
  assert.equal(E.addWorkingDays("2026-11-23", 5, FRI_SAT), "2026-11-30");
  assert.equal(E.addWorkingDays("2026-11-23", 6.67, SAT_SUN), "2026-12-02");
  assert.equal(E.addWorkingDays("2026-11-23", 0, SAT_SUN), "2026-11-23");
});

test("a weekend covering every day is treated as no weekend (no infinite loop)", () => {
  assert.equal(E.addWorkingDays("2026-11-23", 2, [0, 1, 2, 3, 4, 5, 6]), "2026-11-25");
});

test("priority adjusts the target only: multiplier (legacy) and divisor modes", () => {
  assert.equal(E.round2(E.calculateExpectedSlaDays(10, 1, "divisor")), 10);
  assert.equal(E.round2(E.calculateExpectedSlaDays(10, 1.5, "divisor")), 6.67);
  assert.equal(E.round2(E.calculateExpectedSlaDays(10, 0.75, "divisor")), 13.33);
  assert.equal(E.round2(E.calculateExpectedSlaDays(10, 0.4, "multiplier")), 4);
  assert.equal(E.calculateExpectedSlaDays(null, 1.5, "divisor"), 0);
  assert.equal(E.calculateExpectedSlaDays(10, 0, "divisor"), 10); // invalid factor ignored
});

test("consumed effort sums several work segments and ignores the gaps (holds)", () => {
  const workSegments = [
    { started_at: at(23), ended_at: at(25) },   // Tue, Wed = 2
    { started_at: at(30), ended_at: at(32) },   // Dec 1, Dec 2 = 2 (hold 25 -> 30 not counted)
    { started_at: at(32), ended_at: null },      // open, runs to now = Dec 2 -> Dec 3 = 1
  ];
  const now = new Date(2026, 11, 3, 10);
  assert.equal(E.calculateConsumedEffort({ workSegments, now, weekend: SAT_SUN }), 5);
});

test("hold days accumulate across multiple pause/resume cycles, including an open hold", () => {
  const pauses = [
    { paused_at: at(24), resumed_at: at(26) },            // Wed, Thu = 2
    { paused_at: new Date(2026, 11, 1), resumed_at: null }, // open since Dec 1
  ];
  const now = new Date(2026, 11, 3, 10);                    // Dec 2, Dec 3 = 2
  assert.equal(E.calculateHoldDays({ pauses, now, weekend: SAT_SUN }), 4);
});

test("remaining effort: unknown until estimated, zero once finished", () => {
  assert.equal(E.calculateRemainingEffort({ status: STATUS.NOT_YET_ESTIMATED, plannedEffort: null }), null);
  assert.equal(E.calculateRemainingEffort({ status: STATUS.NOT_STARTED, plannedEffort: 15, actualEffort: 0 }), 15);
  assert.equal(E.calculateRemainingEffort({ status: STATUS.IN_PROGRESS, plannedEffort: 15, actualEffort: 4 }), 11);
  assert.equal(E.calculateRemainingEffort({ status: STATUS.IN_PROGRESS, plannedEffort: 5, actualEffort: 8 }), 0);
  assert.equal(E.calculateRemainingEffort({ status: STATUS.COMPLETED, plannedEffort: 15, actualEffort: 4 }), 0);
  assert.equal(E.calculateRemainingEffort({ status: STATUS.CANCELLED, plannedEffort: 15, actualEffort: 4 }), 0);
});

test("health thresholds: <=80 On Track, 80-100 At Risk, >100 Breached (configurable)", () => {
  const s = E.DEFAULT_ENGINE_SETTINGS;
  assert.equal(E.classifyHealth(0, s), HEALTH.ON_TRACK);
  assert.equal(E.classifyHealth(80, s), HEALTH.ON_TRACK);
  assert.equal(E.classifyHealth(80.01, s), HEALTH.AT_RISK);
  assert.equal(E.classifyHealth(100, s), HEALTH.AT_RISK);
  assert.equal(E.classifyHealth(100.01, s), HEALTH.BREACHED);
  assert.equal(E.classifyHealth(null, s), null);
  const strict = E.parseEngineSettings({ at_risk_threshold_pct: "60", breach_threshold_pct: "90" });
  assert.equal(E.classifyHealth(70, strict), HEALTH.AT_RISK);
  assert.equal(E.classifyHealth(95, strict), HEALTH.BREACHED);
});

test("engine settings: lenient parsing and strict validation", () => {
  assert.deepEqual(E.parseEngineSettings({}), E.DEFAULT_ENGINE_SETTINGS);
  assert.equal(E.parseEngineSettings({ priority_factor_mode: "DIVISOR" }).priority_factor_mode, "divisor");
  assert.equal(E.parseEngineSettings({ enforce_stage_order: "false" }).enforce_stage_order, false);
  assert.equal(E.parseEngineSettings({ at_risk_threshold_pct: "abc" }).at_risk_threshold_pct, 80);

  assert.deepEqual(E.validateEngineSettings({}).errors, []);
  assert.deepEqual(E.validateEngineSettings({ at_risk_threshold_pct: 70, breach_threshold_pct: 95 }).clean, { at_risk_threshold_pct: "70", breach_threshold_pct: "95" });
  assert.equal(E.validateEngineSettings({ at_risk_threshold_pct: 120, breach_threshold_pct: 100 }).errors.length, 1);
  assert.equal(E.validateEngineSettings({ priority_factor_mode: "x" }).errors.length, 1);
  assert.equal(E.validateEngineSettings({ enforce_stage_order: "maybe" }).errors.length, 1);
});

test("calculateStageSLA: hold time is excluded and priority does not change consumed effort", () => {
  const now = new Date(2026, 10, 30, 12); // Mon 30
  const input = {
    stage: stageRow({ stage_effort_days: 10 }),
    workSegments: [{ started_at: at(23), ended_at: at(25) }, { started_at: at(29), ended_at: null }], // 2 + 1
    pauses: [{ paused_at: at(25), resumed_at: at(29) }], // Thu 26, Fri 27 -> 2 (Sat/Sun weekend)
    weekend: SAT_SUN, now,
  };
  const medium = E.calculateStageSLA({ ...input, priorityFactor: 1, settings: E.parseEngineSettings({ priority_factor_mode: "divisor" }) });
  const critical = E.calculateStageSLA({ ...input, priorityFactor: 1.5, settings: E.parseEngineSettings({ priority_factor_mode: "divisor" }) });

  assert.equal(medium.consumedDays, 3);
  assert.equal(critical.consumedDays, 3); // identical: priority never touches consumption
  assert.equal(medium.holdDays, 2);
  assert.equal(medium.expectedSlaDays, 10);
  assert.equal(critical.expectedSlaDays, 6.67);
  assert.equal(medium.remaining, 7);
  assert.equal(critical.remaining, 7);          // remaining effort is raw planned - actual
  assert.equal(medium.utilizationPct, 30);
  assert.equal(critical.utilizationPct, 45);
  assert.equal(medium.slaState, HEALTH.ON_TRACK);
  assert.equal(medium.varianceDays, -7);
  // 7 days left at medium from Mon 30 Nov, weekend Sat/Sun -> Wed 9 Dec; critical has 3.67 -> 4 days -> Fri 4 Dec
  assert.equal(medium.expectedCompletionDate, "2026-12-09");
  assert.equal(critical.expectedCompletionDate, "2026-12-04");
});

test("calculateStageSLA: not started / not estimated never consume; completed keeps the stored actual", () => {
  const now = at(30);
  const base = { workSegments: [], pauses: [], weekend: SAT_SUN, now };
  const notStarted = E.calculateStageSLA({ ...base, stage: stageRow({ status: STATUS.NOT_STARTED, started_at: null }) });
  assert.equal(notStarted.consumedDays, 0);
  assert.equal(notStarted.remaining, 10);
  assert.equal(notStarted.utilizationPct, 0);

  const nye = E.calculateStageSLA({ ...base, stage: stageRow({ status: STATUS.NOT_YET_ESTIMATED, stage_effort_days: null }) });
  assert.equal(nye.remaining, null);
  assert.equal(nye.slaState, null);
  assert.equal(nye.expectedCompletionDate, null);

  const done = E.calculateStageSLA({
    ...base,
    stage: stageRow({ status: STATUS.COMPLETED, actual_effort_days: 12, completed_at: at(26) }),
    workSegments: [{ started_at: at(23), ended_at: at(26) }],
  });
  assert.equal(done.actualEffort, 12);       // manual override survives
  assert.equal(done.consumedDays, 3);
  assert.equal(done.remaining, 0);
  assert.equal(done.slaState, HEALTH.BREACHED);
  assert.equal(done.expectedCompletionDate, "2026-11-26");
});

test("deriveCurrentStage picks the earliest active stage, else the first unfinished, else null", () => {
  const mk = (order, status) => ({ id: order, stage_name: `S${order}`, stage_order: order, status });
  assert.equal(E.deriveCurrentStage([mk(1, STATUS.COMPLETED), mk(2, STATUS.ON_HOLD), mk(3, STATUS.NOT_STARTED)]).stage_name, "S2");
  assert.equal(E.deriveCurrentStage([mk(1, STATUS.COMPLETED), mk(2, STATUS.NOT_STARTED), mk(3, STATUS.NOT_STARTED)]).stage_name, "S2");
  assert.equal(E.deriveCurrentStage([mk(1, STATUS.COMPLETED), mk(2, STATUS.IN_PROGRESS)  , mk(3, STATUS.IN_PROGRESS)]).stage_name, "S2");
  assert.equal(E.deriveCurrentStage([mk(1, STATUS.COMPLETED), mk(2, STATUS.CANCELLED)]), null);
});

test("summarizeRequest totals, cancelled and backfilled handling, health = worst of stages", () => {
  const m = (over) => ({
    stage: "x", status: STATUS.NOT_STARTED, plannedEffort: 0, expectedSlaDays: 0, actualEffort: 0, remaining: 0,
    remainingExpectedDays: 0, holdDays: 0, slaState: null, isBackfilled: false, completedAt: null, ...over,
  });
  const stageMetrics = [
    m({ status: STATUS.COMPLETED, plannedEffort: 3, expectedSlaDays: 3, actualEffort: 2, holdDays: 1, slaState: HEALTH.ON_TRACK, completedAt: at(25) }),
    m({ status: STATUS.COMPLETED, plannedEffort: 99, expectedSlaDays: 99, actualEffort: 99, isBackfilled: true, slaState: HEALTH.BREACHED }), // ignored
    m({ status: STATUS.IN_PROGRESS, plannedEffort: 15, expectedSlaDays: 15, actualEffort: 4, remaining: 11, remainingExpectedDays: 11, holdDays: 2, slaState: HEALTH.ON_TRACK }),
    m({ status: STATUS.CANCELLED, plannedEffort: 5, expectedSlaDays: 5, actualEffort: 1, slaState: null }),
    m({ status: STATUS.NOT_STARTED, plannedEffort: 5, expectedSlaDays: 5, remaining: 5, remainingExpectedDays: 5 }),
    m({ status: STATUS.NOT_YET_ESTIMATED, plannedEffort: null }),
  ];
  const s = E.summarizeRequest({ stageMetrics, weekend: SAT_SUN, now: at(30) });
  assert.equal(s.totalPlannedDays, 3 + 15 + 1 + 5);     // cancelled stage counts only the effort already spent
  assert.equal(s.totalConsumedDays, 2 + 4 + 1);
  assert.equal(s.totalRemainingDays, 11 + 5);
  assert.equal(s.totalHoldDays, 3);
  assert.equal(s.unestimatedStages, 1);
  assert.equal(s.isFinished, false);
  assert.equal(s.slaHealth, HEALTH.ON_TRACK);
  assert.equal(s.expectedCompletionDate, "2026-12-22"); // 16 working days from Mon 30 Nov (Sat/Sun weekend)

  stageMetrics[2].slaState = HEALTH.AT_RISK;
  assert.equal(E.summarizeRequest({ stageMetrics, weekend: SAT_SUN, now: at(30) }).slaHealth, HEALTH.AT_RISK);
});

test("planTransition: allowed moves map to start / pause / resume / complete / cancel / reopen", () => {
  const stages = [stageRow({ id: 1, stage_order: 3, status: STATUS.NOT_STARTED })];
  const plan = (status, to, extra = {}) => E.planTransition({ stage: stageRow({ status }), toStatus: to, stages: [], ...extra });
  assert.equal(plan(STATUS.NOT_STARTED, STATUS.IN_PROGRESS).action, ACTION.START);
  assert.equal(plan(STATUS.IN_PROGRESS, STATUS.ON_HOLD).action, ACTION.PAUSE);
  assert.equal(plan(STATUS.ON_HOLD, STATUS.IN_PROGRESS).action, ACTION.RESUME);
  assert.equal(plan(STATUS.IN_PROGRESS, STATUS.COMPLETED).action, ACTION.COMPLETE);
  assert.equal(plan(STATUS.ON_HOLD, STATUS.COMPLETED).action, ACTION.COMPLETE);
  assert.equal(plan(STATUS.IN_PROGRESS, STATUS.CANCELLED).action, ACTION.CANCEL);
  assert.equal(plan(STATUS.COMPLETED, STATUS.IN_PROGRESS).action, ACTION.REOPEN);
  assert.equal(plan(STATUS.CANCELLED, STATUS.NOT_STARTED).action, ACTION.REINSTATE);
  assert.equal(plan(STATUS.IN_PROGRESS, STATUS.IN_PROGRESS).action, ACTION.NOOP);
  assert.ok(stages.length);
});

test("planTransition: rejects illegal moves and unestimated starts", () => {
  const plan = (stage, to, extra = {}) => E.planTransition({ stage: stageRow(stage), toStatus: to, stages: [], ...extra });
  assert.match(plan({ status: STATUS.NOT_STARTED }, STATUS.COMPLETED).errors[0], /Cannot change/);
  assert.match(plan({ status: STATUS.COMPLETED }, STATUS.ON_HOLD).errors[0], /Cannot change/);
  assert.match(plan({ status: STATUS.CANCELLED }, STATUS.IN_PROGRESS).errors[0], /Cannot change/);
  const unestimated = plan({ status: STATUS.NOT_YET_ESTIMATED, stage_effort_days: null }, STATUS.IN_PROGRESS);
  assert.match(unestimated.errors[0], /no planned effort/);
  assert.equal(plan({ status: STATUS.NOT_YET_ESTIMATED, stage_effort_days: null }, STATUS.IN_PROGRESS, { plannedEffort: 4 }).errors.length, 0);
  // estimating a not-yet-estimated stage in place turns it into Not Started
  const estimated = plan({ status: STATUS.NOT_YET_ESTIMATED, stage_effort_days: null }, STATUS.NOT_YET_ESTIMATED, { plannedEffort: 6 });
  assert.equal(estimated.toStatus, STATUS.NOT_STARTED);
  assert.equal(estimated.action, ACTION.ESTIMATE);
});

test("planTransition: stage order and single active stage are enforced unless forced", () => {
  const dev = stageRow({ id: 3, stage_order: 3, status: STATUS.NOT_STARTED });
  const ba = stageRow({ id: 2, stage_name: "BA", stage_order: 2, status: STATUS.IN_PROGRESS });
  const run = (extra) => E.planTransition({ stage: dev, toStatus: STATUS.IN_PROGRESS, stages: [ba, dev], ...extra });
  assert.equal(run().errors.length, 2);                       // BA already running AND not finished
  assert.equal(run({ force: true }).errors.length, 0);
  assert.equal(run({ settings: E.parseEngineSettings({ enforce_stage_order: "false" }) }).errors.length, 1); // still one active stage at a time
  const baDone = { ...ba, status: STATUS.COMPLETED };
  assert.equal(E.planTransition({ stage: dev, toStatus: STATUS.IN_PROGRESS, stages: [baDone, dev] }).errors.length, 0);
  // resuming from hold is exempt from the order rule
  const held = { ...dev, status: STATUS.ON_HOLD };
  assert.equal(E.planTransition({ stage: held, toStatus: STATUS.IN_PROGRESS, stages: [{ ...ba, status: STATUS.NOT_STARTED }, held] }).errors.length, 0);
});

test("legacy status classification and initial stage planning", () => {
  assert.equal(E.classifyLegacyStatus("In Progress", "Active"), "active");
  assert.equal(E.classifyLegacyStatus("Pending for Approval", "Active"), "active");
  assert.equal(E.classifyLegacyStatus("Not Started", "Active"), "idle");
  assert.equal(E.classifyLegacyStatus("Not yet Estimated", "Active"), "idle");
  assert.equal(E.classifyLegacyStatus("On Hold", "Paused"), "hold");
  assert.equal(E.classifyLegacyStatus("Cancelled", "Done"), "cancelled");
  assert.equal(E.classifyLegacyStatus("Completed", "Done"), "done");

  const pipeline = [
    { name: "Analysis", stage_order: 1, effort_days: 2 }, { name: "BA", stage_order: 2, effort_days: 5 },
    { name: "Development", stage_order: 3, effort_days: 8 }, { name: "QA", stage_order: 4, effort_days: 0 },
  ];
  const statuses = (p) => p.map((s) => `${s.stage_name}:${s.status}${s.is_backfilled ? "*" : ""}`).join(" ");
  assert.equal(
    statuses(E.planInitialStages({ pipeline, legacyStage: { stage_order: 3 }, intent: "active" })),
    "Analysis:Completed* BA:Completed* Development:In Progress QA:Not Yet Estimated"
  );
  assert.equal(
    statuses(E.planInitialStages({ pipeline, legacyStage: { stage_order: 3 }, intent: "hold" })),
    "Analysis:Completed* BA:Completed* Development:On Hold QA:Not Yet Estimated"
  );
  assert.equal(
    statuses(E.planInitialStages({ pipeline, legacyStage: { stage_order: 2 }, intent: "idle" })),
    "Analysis:Completed* BA:Not Started Development:Not Started QA:Not Yet Estimated"
  );
  assert.equal(
    statuses(E.planInitialStages({ pipeline, legacyStage: null, intent: "active" })),
    "Analysis:In Progress BA:Not Started Development:Not Started QA:Not Yet Estimated"
  );
  assert.equal(
    statuses(E.planInitialStages({ pipeline, legacyStage: { stage_order: 8 }, intent: "done" })),
    "Analysis:Completed* BA:Completed* Development:Completed* QA:Completed*"
  );
  assert.equal(
    statuses(E.planInitialStages({ pipeline, legacyStage: { stage_order: 3 }, intent: "cancelled" })),
    "Analysis:Completed* BA:Completed* Development:Cancelled* QA:Cancelled*"
  );
});

test("validateStageStatusInput", () => {
  const ok = E.validateStageStatusInput({ stage: " Development ", status: "on hold", note: "waiting for vendor" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.clean.stage, "Development");
  assert.equal(ok.clean.status, "On Hold");

  assert.equal(E.validateStageStatusInput({}).errors.length, 2);
  assert.match(E.validateStageStatusInput({ stage: "QA", status: "Done" }).errors[0], /status must be one of/);
  assert.equal(E.validateStageStatusInput({ stage: "QA", status: "In Progress", plannedEffort: -2 }).errors.length, 1);
  assert.equal(E.validateStageStatusInput({ stage: "QA", status: "In Progress", plannedEffort: "abc" }).errors.length, 1);
  assert.equal(E.validateStageStatusInput({ stage: "QA", status: "In Progress", actualEffortDays: 3 }).errors.length, 1);
  assert.deepEqual(E.validateStageStatusInput({ stage: "QA", status: "Completed", actualEffortDays: 3 }).errors, []);
  assert.equal(E.validateStageStatusInput({ stage: "QA", status: "Completed", note: "x".repeat(501) }).errors.length, 1);
});
