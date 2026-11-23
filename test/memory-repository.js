// In-memory stand-in for SqlSlaRepository: same method surface, same return shapes (Date objects, numbers),
// plus transaction rollback (state is snapshotted and restored when the callback throws).
class MemorySlaRepository {
  constructor() {
    this.state = { requests: new Map(), stages: [], work: [], pauses: [], statusHistory: [], stageHistory: [], seq: 0 };
    this.failOn = null; // method name to make throw once, for rollback tests
  }

  addRequest({ id, br_no = null, title = "Test request", priority = "Medium", stage = null, status = null }) {
    this.state.requests.set(id, { id, br_no, title, priority, stage, status });
  }

  _next() { return ++this.state.seq; }
  _clone(v) { return structuredClone(v); }
  _maybeFail(name) {
    if (this.failOn === name) {
      this.failOn = null;
      throw new Error(`forced failure in ${name}`);
    }
  }

  async transaction(fn) {
    const snapshot = structuredClone(this.state);
    try {
      return await fn(this);
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  async getRequest(id) { const r = this.state.requests.get(id); return r ? { ...r } : undefined; }
  async listTrackedRequests() { return [...this.state.requests.values()].filter((r) => this.state.stages.some((s) => s.business_request_id === r.id)).map((r) => ({ ...r })); }
  async listRequestIdsWithoutTracking() { return [...this.state.requests.keys()].filter((id) => !this.state.stages.some((s) => s.business_request_id === id)); }

  async listRequestIdsWithStaleActiveStages(pipelineNames) {
    const names = new Set(pipelineNames.map((n) => n.toLowerCase()));
    const ids = this.state.stages
      .filter((s) => (s.status === "In Progress" || s.status === "On Hold") && !names.has(s.stage_name.toLowerCase()))
      .map((s) => s.business_request_id);
    return [...new Set(ids)];
  }
  async hasUserActivity(requestId) {
    return this.state.statusHistory.some((h) => h.business_request_id === requestId && h.source !== "migration")
      || this.state.stageHistory.some((h) => h.business_request_id === requestId && h.source !== "migration");
  }
  async deleteTracking(requestId) {
    const ids = new Set(this.state.stages.filter((s) => s.business_request_id === requestId).map((s) => s.id));
    this.state.stages = this.state.stages.filter((s) => !ids.has(s.id));
    this.state.work = this.state.work.filter((w) => !ids.has(w.request_stage_id));
    this.state.pauses = this.state.pauses.filter((p) => !ids.has(p.request_stage_id));
    this.state.statusHistory = this.state.statusHistory.filter((h) => !ids.has(h.request_stage_id));
    this.state.stageHistory = this.state.stageHistory.filter((h) => !(h.business_request_id === requestId && h.source === "migration"));
  }

  async listStages(requestId) {
    return this._clone(this.state.stages.filter((s) => s.business_request_id === requestId).sort((a, b) => a.stage_order - b.stage_order || a.id - b.id));
  }
  async listAllStages() { return this._clone(this.state.stages); }
  async insertStage(row) {
    const id = this._next();
    this.state.stages.push({ ...this._clone(row), id });
    return id;
  }
  async updateStage(id, patch) {
    this._maybeFail("updateStage");
    Object.assign(this.state.stages.find((s) => s.id === id), this._clone(patch));
  }

  async listWork(requestId) { return this._clone(this.state.work.filter((w) => w.business_request_id === requestId)); }
  async listAllWork() { return this._clone(this.state.work); }
  async openWork({ request_stage_id, business_request_id, started_at, created_by }) {
    this.state.work.push({ id: this._next(), request_stage_id, business_request_id, started_at, ended_at: null, end_reason: null, working_days: null, created_by });
  }
  async closeWork(id, endedAt, reason, workingDays) {
    Object.assign(this.state.work.find((w) => w.id === id), { ended_at: endedAt, end_reason: reason, working_days: workingDays });
  }

  async listPauses(requestId) { return this._clone(this.state.pauses.filter((p) => p.business_request_id === requestId)); }
  async listAllPauses() { return this._clone(this.state.pauses); }
  async openPause({ request_stage_id, business_request_id, paused_at, reason, paused_by }) {
    this.state.pauses.push({ id: this._next(), request_stage_id, business_request_id, paused_at, resumed_at: null, hold_days: null, reason, paused_by, resumed_by: null });
  }
  async closePause(id, resumedAt, holdDays, resumedBy) {
    Object.assign(this.state.pauses.find((p) => p.id === id), { resumed_at: resumedAt, hold_days: holdDays, resumed_by: resumedBy });
  }

  async insertStatusHistory(h) { this._maybeFail("insertStatusHistory"); this.state.statusHistory.push({ id: this._next(), ...this._clone(h) }); }
  async insertStageHistory(h) { this.state.stageHistory.push({ id: this._next(), ...this._clone(h) }); }
  async listStatusHistory(requestId) { return this._clone(this.state.statusHistory.filter((h) => h.business_request_id === requestId)).reverse(); }
  async listStageHistory(requestId) { return this._clone(this.state.stageHistory.filter((h) => h.business_request_id === requestId)).reverse(); }

  async setLegacyFields(requestId, { stageName, statusName }) {
    const r = this.state.requests.get(requestId);
    if (stageName) r.stage = stageName;
    if (statusName) r.status = statusName;
  }
}

module.exports = { MemorySlaRepository };
