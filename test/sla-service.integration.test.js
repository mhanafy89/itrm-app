// Integration tests: real routes + service + engine, over HTTP, against the in-memory repository.
// (SQL itself is not exercised here -- see docs/SLA-ENGINE.md for the SQL Server smoke test.)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const Router = require("../lib/router");
const { readJsonBody } = require("../lib/http-helpers");
const { SlaService } = require("../lib/sla-service");
const { register } = require("../routes/requestSla");
const { MemorySlaRepository } = require("./memory-repository");

// Local-time instants. 2026-11-23 is a Monday; the weekend is Sat/Sun.
const at = (month, day, hour = 9) => new Date(2026, month - 1, day, hour, 0, 0);

function makeConfig(settingsOverride = {}) {
  return {
    stages: [
      { name: "Planning", stage_order: 1, is_pipeline: 1, effort_days: 3 },
      { name: "BA", stage_order: 2, is_pipeline: 1, effort_days: 5 },
      { name: "Development", stage_order: 3, is_pipeline: 1, effort_days: 15 },
      { name: "QA", stage_order: 4, is_pipeline: 1, effort_days: 5 },
      { name: "UAT", stage_order: 5, is_pipeline: 1, effort_days: 3 },
      { name: "Deployment", stage_order: 6, is_pipeline: 1, effort_days: 0 }, // not estimated yet
      { name: "Closed", stage_order: 7, is_pipeline: 0, effort_days: 0 },
    ],
    priorities: [
      { name: "Critical", factor: 1.5 }, { name: "High", factor: 1.25 }, { name: "Medium", factor: 1 }, { name: "Low", factor: 0.75 },
    ],
    categories: [],
    statuses: [
      { name: "Not Started", state: "Active" }, { name: "Not Yet Estimated", state: "Active" }, { name: "In Progress", state: "Active" },
      { name: "Pending for Approval", state: "Active" }, { name: "On Hold", state: "Paused" },
      { name: "Completed", state: "Done" }, { name: "Cancelled", state: "Done" },
    ],
    settings: { weekend_days: [0, 6], priority_factor_mode: "divisor", ...settingsOverride },
  };
}

async function setup(settingsOverride) {
  const repo = new MemorySlaRepository();
  const clock = { now: at(11, 23) };
  const service = new SlaService({ repo, getConfig: async () => makeConfig(settingsOverride), now: () => clock.now });

  const router = new Router();
  register(router, () => service);
  const server = http.createServer(async (req, res) => {
    const match = router.match(req.method, new URL(req.url, "http://x").pathname);
    if (!match) { res.writeHead(404).end(); return; }
    req.user = { name: "Alice", role: "read_write" };
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    try {
      await match.handler(req, res, match.params, body);
    } catch (err) {
      res.writeHead(500).end(String(err.stack));
    }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const post = (id, body, when) => { if (when) clock.now = when; return call("POST", `/api/requests/${id}/stage-status`, body); };
  return { repo, clock, service, call, post, get: (id) => call("GET", `/api/requests/${id}/sla`), close: () => server.close() };
}

const stageOf = (sla, name) => sla.stages.find((s) => s.stage === name);

test("GET /sla initializes tracking from the legacy stage/status and returns the documented shape", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Development", status: "In Progress", priority: "Medium" });
    const { status, body } = await t.get(1);
    assert.equal(status, 200);
    for (const key of ["currentStage", "status", "plannedEffort", "actualConsumed", "remaining", "holdDays", "expectedCompletionDate", "slaState"]) {
      assert.ok(key in body, `missing ${key}`);
    }
    assert.equal(body.currentStage, "Development");
    assert.equal(body.status, "In Progress");
    assert.equal(body.plannedEffort, 15);
    assert.equal(body.actualConsumed, 0);
    assert.equal(body.remaining, 15);
    assert.equal(body.slaState, "On Track");
    assert.equal(body.expectedCompletionDate, "2026-12-14"); // 15 working days from Mon 23 Nov
    // earlier stages are backfilled as Completed and excluded from the totals; Deployment has no estimate
    assert.equal(stageOf(body, "BA").status, "Completed");
    assert.equal(stageOf(body, "BA").isBackfilled, true);
    assert.equal(stageOf(body, "Deployment").status, "Not Yet Estimated");
    assert.equal(body.request.totalPlannedDays, 15 + 5 + 3);
    assert.equal(body.request.unestimatedStages, 1);
    // idempotent: a second read does not create a second set of rows
    await t.get(1);
    assert.equal((await t.repo.listStages(1)).length, 6);
  } finally { t.close(); }
});

test("full lifecycle: start, hold, resume, complete, next stage; hold time is not consumed", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "Not Started", priority: "Medium" });

    let r = await t.post(1, { stage: "Planning", status: "In Progress" }, at(11, 23));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.transition, { stage: "Planning", from: "Not Started", to: "In Progress", action: "start", changed: true });
    assert.equal(r.body.status, "In Progress");

    r = await t.post(1, { stage: "Planning", status: "On Hold", note: "waiting for business" }, at(11, 25)); // Mon -> Wed: 2 days consumed
    assert.equal(r.body.transition.action, "pause");
    assert.equal(r.body.actualConsumed, 2);

    t.clock.now = at(11, 27, 12); // still on hold on Fri: hold grows, consumption does not
    r = await t.get(1);
    assert.equal(r.body.status, "On Hold");
    assert.equal(r.body.actualConsumed, 2);
    assert.equal(r.body.holdDays, 2); // Thu, Fri

    r = await t.post(1, { stage: "Planning", status: "In Progress" }, at(11, 30)); // resume Mon 30; hold = Thu, Fri, Mon (the day a hold ends on belongs to the hold)
    assert.equal(r.body.transition.action, "resume");
    assert.equal(r.body.holdDays, 3);
    assert.equal(r.body.actualConsumed, 2);

    r = await t.post(1, { stage: "Planning", status: "Completed" }, at(12, 1)); // +1 working day (Tue)
    assert.equal(r.body.transition.action, "complete");
    assert.equal(stageOf(r.body, "Planning").actualEffort, 3);
    assert.equal(stageOf(r.body, "Planning").remaining, 0);
    assert.equal(stageOf(r.body, "Planning").holdDays, 3);
    assert.equal(r.body.currentStage, "BA"); // moved on
    assert.equal(r.body.status, "Not Started");

    // the legacy columns follow: stage moved to BA, status changed to "Not Started"
    const legacy = await t.repo.getRequest(1);
    assert.equal(legacy.stage, "BA");
    assert.equal(legacy.status, "Not Started");

    // audit: every status change and the stage move are recorded with who/when
    const h = await t.call("GET", "/api/requests/1/sla/history");
    const actions = h.body.statusHistory.filter((x) => x.stage_name === "Planning").map((x) => x.action).reverse();
    assert.deepEqual(actions, ["init", "start", "pause", "resume", "complete"]);
    assert.ok(h.body.statusHistory.every((x) => x.changed_by === "Alice" || x.source === "migration"));
    const move = h.body.stageHistory[0];
    assert.deepEqual([move.from_stage, move.to_stage, move.changed_by], ["Planning", "BA", "Alice"]);
    assert.equal(h.body.pauses.length, 1);
    assert.equal(h.body.pauses[0].hold_days, 3);
    assert.equal(h.body.pauses[0].reason, "waiting for business");
  } finally { t.close(); }
});

test("multiple pause/resume cycles accumulate hold time and keep every period", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1); // tracking starts Mon 23 09:00
    await t.post(1, { stage: "Planning", status: "On Hold" }, at(11, 24));   // consumed 1
    await t.post(1, { stage: "Planning", status: "In Progress" }, at(11, 26)); // held Wed, Thu = 2
    await t.post(1, { stage: "Planning", status: "On Hold" }, at(11, 27));   // consumed +1
    const r = await t.post(1, { stage: "Planning", status: "In Progress" }, at(12, 1)); // held Mon, Tue... Fri 27 -> Tue Dec 1: Mon 30, Tue = 2
    const planning = stageOf(r.body, "Planning");
    assert.equal(planning.consumedDays, 2);
    assert.equal(planning.holdDays, 4);
    assert.equal((await t.repo.listPauses(1)).length, 2);
  } finally { t.close(); }
});

test("priority changes the target, never the consumed effort", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Development", status: "Not Started", priority: "Medium" });
    t.repo.addRequest({ id: 2, stage: "Development", status: "Not Started", priority: "Critical" });
    for (const id of [1, 2]) await t.post(id, { stage: "Development", status: "In Progress", plannedEffort: 10 }, at(11, 23));
    t.clock.now = at(11, 27, 12); // 4 working days later (Tue-Fri)
    const [medium, critical] = [(await t.get(1)).body, (await t.get(2)).body];

    assert.equal(medium.actualConsumed, 4);
    assert.equal(critical.actualConsumed, 4);
    assert.equal(medium.plannedEffort, 10);
    assert.equal(medium.expectedSlaDays, 10);
    assert.equal(critical.expectedSlaDays, 6.67);
    assert.equal(medium.remaining, 6);
    assert.equal(critical.remaining, 6);
    assert.equal(medium.utilizationPct, 40);
    assert.equal(critical.utilizationPct, 60);
    assert.equal(medium.slaState, "On Track");

    t.clock.now = at(12, 2, 12); // 7 days consumed: 70% medium, 105% critical
    assert.equal((await t.get(1)).body.slaState, "On Track");
    const late = (await t.get(2)).body;
    assert.equal(late.slaState, "Breached");
    assert.equal(late.request.slaHealth, "Breached");
  } finally { t.close(); }
});

test("status rules are enforced with 409 / 400 / 404 responses", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "Not Started", priority: "Medium" });
    await t.get(1);

    assert.equal((await t.post(1, { stage: "Planning", status: "Completed" })).status, 409);     // Not Started -> Completed
    assert.equal((await t.post(1, { stage: "BA", status: "In Progress" })).status, 409);         // earlier stage unfinished
    assert.equal((await t.post(1, { stage: "Deployment", status: "Not Started" })).status, 409); // no estimate
    assert.equal((await t.post(1, { stage: "Planning", status: "Bogus" })).status, 400);
    assert.equal((await t.post(1, { status: "In Progress" })).status, 400);
    assert.equal((await t.post(1, { stage: "Nope", status: "In Progress" })).status, 404);
    assert.equal((await t.call("GET", "/api/requests/999/sla")).status, 404);
    assert.equal((await t.call("GET", "/api/requests/abc/sla")).status, 404);

    const bad = await t.post(1, { stage: "Planning", status: "In Progress", plannedEffort: -3 });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.body.errors));

    // an estimate unlocks the stage
    const ok = await t.post(1, { stage: "Deployment", status: "Not Started", plannedEffort: 2 });
    assert.equal(ok.status, 200);
    assert.equal(stageOf(ok.body, "Deployment").plannedEffort, 2);
    assert.equal(stageOf(ok.body, "Deployment").status, "Not Started");

    // nothing was written by the failed calls (only init rows + the estimate)
    assert.equal((await t.repo.listWork(1)).length, 0);
  } finally { t.close(); }
});

test("only one stage may be In Progress; stage order is enforced and can be switched off", async () => {
  const t = await setup({ enforce_stage_order: false });
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1);
    const r = await t.post(1, { stage: "BA", status: "In Progress" });
    assert.equal(r.status, 409);
    assert.match(r.body.errors[0], /already In Progress/);
    await t.post(1, { stage: "Planning", status: "On Hold" });
    assert.equal((await t.post(1, { stage: "BA", status: "In Progress" })).status, 200); // order rule off, Planning is held
  } finally { t.close(); }
});

test("reopening a completed stage keeps earlier effort, adds new work and bumps reopen_count", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1);
    await t.post(1, { stage: "Planning", status: "Completed" }, at(11, 25)); // 2 days
    assert.equal((await t.get(1)).body.currentStage, "BA");

    const reopened = await t.post(1, { stage: "Planning", status: "In Progress", note: "missed requirement" }, at(11, 26));
    assert.equal(reopened.body.transition.action, "reopen");
    assert.equal(reopened.body.currentStage, "Planning"); // the earliest unfinished stage again
    assert.equal(stageOf(reopened.body, "Planning").reopenCount, 1);
    assert.equal(stageOf(reopened.body, "Planning").completedAt, null);

    const done = await t.post(1, { stage: "Planning", status: "Completed" }, at(11, 30)); // Thu, Fri -> Mon = Thu(26)->Mon(30): Fri(27) + Mon(30) = 2
    assert.equal(stageOf(done.body, "Planning").actualEffort, 4);
    assert.equal(stageOf(done.body, "Planning").consumedDays, 4);

    const h = await t.call("GET", "/api/requests/1/sla/history");
    assert.ok(h.body.statusHistory.some((x) => x.action === "reopen" && x.note === "missed requirement"));
    assert.equal((await t.repo.listWork(1)).length, 2); // two work segments retained
  } finally { t.close(); }
});

test("completing with actualEffortDays stores the override; it is rejected for other statuses", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1);
    assert.equal((await t.post(1, { stage: "Planning", status: "On Hold", actualEffortDays: 2 })).status, 400);
    const r = await t.post(1, { stage: "Planning", status: "Completed", actualEffortDays: 4.5 }, at(11, 25));
    assert.equal(stageOf(r.body, "Planning").actualEffort, 4.5);
    assert.equal(stageOf(r.body, "Planning").consumedDays, 2);
    assert.equal(stageOf(r.body, "Planning").varianceDays, 1.5);
    assert.equal((await t.post(1, { stage: "Planning", status: "Completed", actualEffortDays: 9 })).status, 409);
  } finally { t.close(); }
});

test("cancelling a stage stops its SLA and drops its remaining effort from the totals", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "BA", status: "In Progress", priority: "Medium" });
    await t.get(1);
    const r = await t.post(1, { stage: "BA", status: "Cancelled" }, at(11, 24)); // 1 day spent
    assert.equal(stageOf(r.body, "BA").status, "Cancelled");
    assert.equal(stageOf(r.body, "BA").remaining, 0);
    assert.equal(stageOf(r.body, "BA").slaState, null);
    assert.equal(r.body.currentStage, "Development");
    // BA contributes only the 1 spent day; Development + QA + UAT planned in full
    assert.equal(r.body.request.totalPlannedDays, 1 + 15 + 5 + 3);
    assert.equal(r.body.request.totalConsumedDays, 1);

    t.clock.now = at(12, 15); // consumption no longer grows once cancelled
    assert.equal(stageOf((await t.get(1)).body, "BA").consumedDays, 1);
  } finally { t.close(); }
});

test("auto_start_next_stage starts the next estimated stage when one completes", async () => {
  const t = await setup({ auto_start_next_stage: true });
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1);
    const r = await t.post(1, { stage: "Planning", status: "Completed" }, at(11, 24));
    assert.equal(r.body.currentStage, "BA");
    assert.equal(r.body.status, "In Progress");
    assert.equal((await t.repo.getRequest(1)).status, "In Progress");
  } finally { t.close(); }
});

test("completing the last stage finishes the request", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "UAT", status: "In Progress", priority: "Medium" });
    await t.get(1);
    await t.post(1, { stage: "UAT", status: "Completed" }, at(11, 25));
    // Deployment has no estimate, so it is still pending; cancel it to finish
    let r = await t.get(1);
    assert.equal(r.body.currentStage, "Deployment");
    r = await t.post(1, { stage: "Deployment", status: "Cancelled" }, at(11, 25));
    assert.equal(r.body.currentStage, "Closed");
    assert.equal(r.body.status, "Completed");
    assert.equal(r.body.request.isFinished, true);
    const legacy = await t.repo.getRequest(1);
    assert.equal(legacy.stage, "Closed");
    assert.equal(legacy.status, "Completed");
  } finally { t.close(); }
});

test("a failure mid-transition rolls everything back", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1);
    t.repo.failOn = "insertStatusHistory";
    await assert.rejects(() => t.service.updateStageStatus(1, { stage: "Planning", status: "On Hold" }, "Alice"), /forced failure/);
    const [planning] = await t.repo.listStages(1);
    assert.equal(planning.status, "In Progress");
    assert.equal((await t.repo.listPauses(1)).length, 0);
    assert.equal((await t.repo.listWork(1)).filter((w) => w.ended_at).length, 0);
  } finally { t.close(); }
});

test("legacy form edits are reconciled: stage moved forward, status on hold, request closed", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "In Progress", priority: "Medium" });
    await t.get(1);

    // user moves the request to BA in the old form (status still In Progress)
    t.clock.now = at(11, 25);
    t.repo.state.requests.get(1).stage = "BA";
    await t.service.syncFromLegacy(1, "Bob");
    let sla = (await t.get(1)).body;
    assert.equal(stageOf(sla, "Planning").status, "Completed");
    assert.equal(stageOf(sla, "Planning").actualEffort, 2);
    assert.equal(sla.currentStage, "BA");
    assert.equal(sla.status, "In Progress");

    // user sets the status to On Hold
    t.clock.now = at(11, 26);
    t.repo.state.requests.get(1).status = "On Hold";
    await t.service.syncFromLegacy(1, "Bob");
    assert.equal((await t.get(1)).body.status, "On Hold");

    // calling sync again changes nothing (idempotent)
    const before = JSON.stringify(t.repo.state.statusHistory);
    await t.service.syncFromLegacy(1, "Bob");
    assert.equal(JSON.stringify(t.repo.state.statusHistory), before);

    // user moves it back to Planning in the old form with status In Progress: Planning is reopened, BA paused
    t.repo.state.requests.get(1).stage = "Planning";
    t.repo.state.requests.get(1).status = "In Progress";
    await t.service.syncFromLegacy(1, "Bob");
    sla = (await t.get(1)).body;
    assert.equal(sla.currentStage, "Planning");
    assert.equal(sla.status, "In Progress");
    assert.equal(stageOf(sla, "Planning").reopenCount, 1);

    // closing it in the old form completes/cancels everything and leaves the legacy fields as typed
    t.repo.state.requests.get(1).stage = "Closed";
    t.repo.state.requests.get(1).status = "Completed";
    await t.service.syncFromLegacy(1, "Bob");
    sla = (await t.get(1)).body;
    assert.equal(sla.request.isFinished, true);
    assert.equal(sla.status, "Completed");
    assert.equal((await t.repo.getRequest(1)).stage, "Closed");
  } finally { t.close(); }
});

test("backfillMissing creates tracking once for every untracked request", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "QA", status: "On Hold" });
    t.repo.addRequest({ id: 2, stage: "Closed", status: "Completed" });
    t.repo.addRequest({ id: 3, stage: "Draft", status: "Cancelled" });
    assert.deepEqual(await t.service.backfillMissing({ logger: { error() {} } }), { total: 3, created: 3 });
    assert.deepEqual(await t.service.backfillMissing(), { total: 0, created: 0 });

    const sla1 = (await t.get(1)).body;
    assert.equal(sla1.currentStage, "QA");
    assert.equal(sla1.status, "On Hold");
    assert.equal((await t.get(2)).body.status, "Completed");
    assert.equal((await t.get(3)).body.status, "Cancelled");
  } finally { t.close(); }
});

test("dashboard rolls up stage and request metrics with filters", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, br_no: "BR-1", stage: "Development", status: "Not Started", priority: "Medium" });
    t.repo.addRequest({ id: 2, br_no: "BR-2", stage: "Development", status: "Not Started", priority: "Critical" });
    for (const id of [1, 2]) await t.post(id, { stage: "Development", status: "In Progress", plannedEffort: 10 }, at(11, 23));
    t.clock.now = at(12, 2, 12); // 7 working days later

    const d = (await t.call("GET", "/api/sla/dashboard")).body;
    assert.equal(d.totals.requests, 2);
    assert.deepEqual(d.thresholds, { atRiskPct: 80, breachPct: 100 });
    assert.equal(d.totals.health["On Track"], 1);
    assert.equal(d.totals.health["Breached"], 1);
    const dev = d.stages.find((s) => s.stage === "Development");
    assert.equal(dev.requests, 2);
    assert.equal(dev.plannedEffort, 20);
    assert.equal(dev.actualEffort, 14);
    assert.equal(dev.varianceDays, -6);

    const critical = (await t.call("GET", "/api/sla/dashboard?priority=critical")).body;
    assert.deepEqual(critical.requests.map((r) => r.brNo), ["BR-2"]);
    const breached = (await t.call("GET", "/api/sla/dashboard?health=Breached")).body;
    assert.deepEqual(breached.requests.map((r) => r.brNo), ["BR-2"]);
  } finally { t.close(); }
});

test("thresholds are configurable", async () => {
  const t = await setup({ at_risk_threshold_pct: 30, breach_threshold_pct: 50 });
  try {
    t.repo.addRequest({ id: 1, stage: "Development", status: "Not Started", priority: "Medium" });
    await t.post(1, { stage: "Development", status: "In Progress", plannedEffort: 10 }, at(11, 23));
    t.clock.now = at(11, 26, 12); // 3 of 10 days = 30% -> On Track (<= 30)
    assert.equal((await t.get(1)).body.slaState, "On Track");
    t.clock.now = at(11, 27, 12); // 40% -> At Risk
    assert.equal((await t.get(1)).body.slaState, "At Risk");
    t.clock.now = at(12, 1, 12);  // 6 days = 60% -> Breached
    assert.equal((await t.get(1)).body.slaState, "Breached");
  } finally { t.close(); }
});

test("service wrappers (startSLA / pauseSLA / resumeSLA / completeStage) check the operation", async () => {
  const t = await setup();
  try {
    t.repo.addRequest({ id: 1, stage: "Planning", status: "Not Started", priority: "Medium" });
    await assert.rejects(() => t.service.pauseSLA(1, "Planning", "Alice"), (e) => e.statusCode === 409); // not running
    await t.service.startSLA(1, "Planning", "Alice");
    await assert.rejects(() => t.service.resumeSLA(1, "Planning", "Alice"), (e) => e.statusCode === 409); // not on hold
    await t.service.pauseSLA(1, "Planning", "Alice", { note: "blocked" });
    await t.service.resumeSLA(1, "Planning", "Alice");
    const r = await t.service.completeStage(1, "Planning", "Alice");
    assert.equal(r.transition.to, "Completed");
  } finally { t.close(); }
});
