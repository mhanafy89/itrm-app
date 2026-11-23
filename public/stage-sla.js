// Stage SLA (effort-driven) screens: the per-request panel inside the request details drawer and the
// dashboard section. Talks to /api/requests/:id/sla, /stage-status, /sla/history and /api/sla/dashboard.
// Relies on globals from app.js: api, escapeHtml, formatCommentDate, dashboardTile, state, loadData,
// openViewPanel, populateViewPanel.

const STAGE_STATUS_ACTIONS = {
  "Not Yet Estimated": [{ label: "Estimate", status: "Not Started", ask: "estimate" }, { label: "Cancel", status: "Cancelled", confirm: true }],
  "Not Started": [{ label: "Start", status: "In Progress" }, { label: "Cancel", status: "Cancelled", confirm: true }],
  "In Progress": [{ label: "Hold", status: "On Hold", ask: "note" }, { label: "Complete", status: "Completed", ask: "actual" }, { label: "Cancel", status: "Cancelled", confirm: true }],
  "On Hold": [{ label: "Resume", status: "In Progress" }, { label: "Complete", status: "Completed", ask: "actual" }, { label: "Cancel", status: "Cancelled", confirm: true }],
  "Completed": [{ label: "Reopen", status: "In Progress", ask: "note" }],
  "Cancelled": [{ label: "Reinstate", status: "Not Started" }],
};
const HEALTH_ORDER = { Breached: 0, "At Risk": 1, "On Track": 2 };

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]+/g, "");
const fmtNum = (v) => (v === null || v === undefined ? "\u2014" : String(v));

function healthBadge(health) {
  return health ? `<span class="sla-health sla-health-${slug(health)}">${escapeHtml(health)}</span>` : `<span class="sla-health sla-health-none">\u2014</span>`;
}

function statusChip(status) {
  return `<span class="stage-status stage-status-${slug(status)}">${escapeHtml(status)}</span>`;
}

// Utilization bar: the fill is capped at 100% of the track, the number shows the real value.
function utilizationCell(pct, health) {
  if (pct === null || pct === undefined) return "\u2014";
  return `<div class="util-cell" title="${escapeHtml(health || "")}"><div class="util-track"><div class="util-fill util-fill-${slug(health)}" style="width:${Math.min(pct, 100)}%"></div></div><span>${pct}%</span></div>`;
}

// ---------- request details drawer ----------

function stageSlaSectionHtml() {
  return `<section class="view-section" id="stageSlaSection">
    <h3>Stage SLA (effort-driven)</h3>
    <div id="stageSlaBody"><div class="comment-loading">Loading\u2026</div></div>
  </section>`;
}

async function loadStageSla(requestId) {
  const el = document.getElementById("stageSlaBody");
  if (!el) return;
  try {
    const sla = await api(`/api/requests/${requestId}/sla`);
    if (state.viewingId !== requestId) return; // panel was closed or switched while loading
    el.innerHTML = renderStageSla(requestId, sla);
  } catch (err) {
    el.innerHTML = `<div class="comment-error">Could not load the stage SLA: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStageSla(requestId, sla) {
  const r = sla.request;
  const modeNote = sla.priority
    ? `Priority ${escapeHtml(sla.priority)} (factor ${sla.priorityFactor}, ${sla.priorityFactorMode === "divisor" ? "target = effort \u00F7 factor" : "target = effort \u00D7 factor"})`
    : "No priority set";

  const rows = sla.stages.map((s) => {
    const actions = (STAGE_STATUS_ACTIONS[s.status] || []).map((a, i) =>
      `<button type="button" class="btn btn-ghost stage-action write-only" data-stage="${escapeHtml(s.stage)}" data-action="${i}" data-status="${escapeHtml(s.status)}">${a.label}</button>`).join("");
    const editable = !["Completed", "Cancelled"].includes(s.status);
    const edit = editable ? `<button type="button" class="btn btn-ghost stage-action write-only" data-stage="${escapeHtml(s.stage)}" data-edit="1" data-planned="${s.plannedEffort ?? ""}" title="Change planned effort">&#9998;</button>` : "";
    return `<tr class="${s.stage === sla.currentStage ? "stage-current" : ""}${s.isBackfilled ? " stage-backfilled" : ""}">
      <td>${escapeHtml(s.stage)}${s.reopenCount ? ` <span class="stage-tag" title="Reopened ${s.reopenCount}x">\u21BB${s.reopenCount}</span>` : ""}${s.isBackfilled ? ` <span class="stage-tag" title="Created from legacy data: not counted in the totals">legacy</span>` : ""}
        <div class="stage-actions write-only">${edit}${actions}</div></td>
      <td>${statusChip(s.status)}</td>
      <td>${fmtNum(s.plannedEffort)}</td>
      <td>${s.expectedSlaDays ? s.expectedSlaDays : "\u2014"}</td>
      <td>${s.actualEffort}</td>
      <td>${fmtNum(s.remaining)}</td>
      <td>${s.holdDays || "\u2014"}</td>
      <td>${utilizationCell(s.utilizationPct, s.slaState)}</td></tr>`;
  }).join("");

  return `
    <div class="stage-sla-head">
      <span>Current stage <strong>${escapeHtml(sla.currentStage)}</strong></span>
      ${statusChip(sla.status)}
      ${healthBadge(sla.slaState)}
    </div>
    <dl class="view-grid">
      <div><dt>Planned effort (man-days)</dt><dd>${fmtNum(sla.plannedEffort)}</dd></div>
      <div><dt>Consumed (working days)</dt><dd>${sla.actualConsumed}</dd></div>
      <div><dt>Remaining effort</dt><dd>${fmtNum(sla.remaining)}</dd></div>
      <div><dt>Hold days</dt><dd>${sla.holdDays}</dd></div>
      <div><dt>Target (priority-adjusted days)</dt><dd>${sla.expectedSlaDays || "\u2014"}</dd></div>
      <div><dt>Expected completion (stage)</dt><dd>${escapeHtml(sla.expectedCompletionDate || "\u2014")}</dd></div>
    </dl>
    <p class="stage-sla-note">${modeNote}. Priority moves the target only, never the consumed effort.</p>
    <h4 class="stage-sla-sub">Request totals</h4>
    <dl class="view-grid">
      <div><dt>Total planned (man-days)</dt><dd>${r.totalPlannedDays}</dd></div>
      <div><dt>Total consumed</dt><dd>${r.totalConsumedDays}</dd></div>
      <div><dt>Total remaining</dt><dd>${r.totalRemainingDays}</dd></div>
      <div><dt>Total hold time (days)</dt><dd>${r.totalHoldDays}</dd></div>
      <div><dt>SLA utilization</dt><dd>${utilizationCell(r.utilizationPct, r.slaHealth)}</dd></div>
      <div><dt>SLA health</dt><dd>${healthBadge(r.slaHealth)}</dd></div>
      <div class="full"><dt>Expected completion (request)</dt><dd>${escapeHtml(r.expectedCompletionDate || "\u2014")}${r.unestimatedStages ? ` <span class="stage-sla-warn">${r.unestimatedStages} stage(s) not yet estimated: not included</span>` : ""}</dd></div>
    </dl>
    <h4 class="stage-sla-sub">Stages</h4>
    <div class="stage-sla-scroll"><table class="stage-sla-table" data-request="${requestId}">
      <thead><tr><th>Stage</th><th>Status</th><th title="Planned effort, man-days">Plan</th><th title="Priority-adjusted target, working days">Target</th><th title="Consumed working days">Used</th><th title="Remaining effort">Left</th><th title="Working days on hold">Hold</th><th>Utilization</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <details class="stage-sla-history" data-request="${requestId}"><summary>SLA history (status changes, stage moves, holds)</summary><div class="stage-sla-history-body"></div></details>`;
}

function renderStageSlaHistory(h) {
  const entries = [
    ...h.statusHistory.map((x) => ({ at: x.changed_at, by: x.changed_by, html:
      `<strong>${escapeHtml(x.stage_name)}</strong>: ${x.from_status ? `${escapeHtml(x.from_status)} &rarr; ` : ""}${escapeHtml(x.to_status)}
       <span class="history-nochange">(${escapeHtml(x.action)}${x.source !== "api" ? `, ${escapeHtml(x.source)}` : ""}${x.consumed_days !== null && x.consumed_days !== undefined ? `, consumed ${x.consumed_days}d` : ""})</span>
       ${x.note ? `<div class="history-nochange">${escapeHtml(x.note)}</div>` : ""}` })),
    ...h.stageHistory.map((x) => ({ at: x.changed_at, by: x.changed_by, html: `<strong>Stage moved:</strong> ${escapeHtml(x.from_stage || "\u2014")} &rarr; ${escapeHtml(x.to_stage)}` })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!entries.length) return `<div class="comment-empty">No SLA history yet.</div>`;
  const holds = h.pauses.length
    ? `<h4 class="stage-sla-sub">Hold periods</h4><ul class="history-changes">${h.pauses.map((p) =>
        `<li>${escapeHtml(formatCommentDate(p.paused_at))} &rarr; ${p.resumed_at ? escapeHtml(formatCommentDate(p.resumed_at)) : "<em>still on hold</em>"}${p.hold_days !== null && p.hold_days !== undefined ? ` (${p.hold_days} working days)` : ""}${p.reason ? ` &ndash; ${escapeHtml(p.reason)}` : ""}</li>`).join("")}</ul>`
    : "";
  return entries.map((e) => `<div class="history-item"><div class="history-item-header">
      <span class="comment-date">${escapeHtml(formatCommentDate(e.at))}</span><span class="comment-author">&bull; ${escapeHtml(e.by || "system")}</span></div>
      <div>${e.html}</div></div>`).join("") + holds;
}

const NUMBER_FIELD = { type: "number", step: "0.5" };

// Modal form for a stage action. Resolves with { fieldName: value } (empty optional fields omitted) or null when cancelled.
function openStageActionDialog({ title, message, fields = [], okLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    let dlg = document.getElementById("stageActionDialog");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "stageActionDialog";
      dlg.className = "stage-dialog";
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = `<form class="stage-dialog-form" novalidate>
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ""}
      ${fields.map((f) => `<label>${escapeHtml(f.label)}${f.required ? "" : " <em>(optional)</em>"}
        ${f.type === "textarea"
          ? `<textarea name="${f.name}" rows="2" maxlength="500"></textarea>`
          : `<input name="${f.name}" type="number" min="${f.min}" max="${f.max}" step="${f.step}" value="${escapeHtml(f.value ?? "")}" />`}
        ${f.hint ? `<small>${escapeHtml(f.hint)}</small>` : ""}</label>`).join("")}
      <div class="stage-dialog-error hidden"></div>
      <div class="stage-dialog-actions">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${escapeHtml(okLabel)}</button>
      </div></form>`;

    let result = null;
    dlg.onclose = () => resolve(result);
    dlg.querySelector("[data-cancel]").onclick = () => dlg.close();
    dlg.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const raw = dlg.querySelector(`[name="${f.name}"]`).value.trim();
        if (raw === "") {
          if (f.required) return showDialogError(dlg, `${f.label} is required.`);
          continue;
        }
        if (f.type === "textarea") { values[f.name] = raw; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < f.min || n > f.max) return showDialogError(dlg, `${f.label} must be a number between ${f.min} and ${f.max}.`);
        values[f.name] = n;
      }
      result = values;
      dlg.close();
    };
    dlg.showModal();
    const first = dlg.querySelector("input, textarea");
    if (first) first.focus();
  });
}

function showDialogError(dlg, message) {
  const el = dlg.querySelector(".stage-dialog-error");
  el.textContent = message;
  el.classList.remove("hidden");
}

const NOTE_FIELD = { name: "note", label: "Reason / note", type: "textarea" };
const PLANNED_FIELD = { ...NUMBER_FIELD, name: "plannedEffort", label: "Planned effort (man-days)", required: true, min: 0.01, max: 999 };

// Which dialog (if any) an action needs before it is sent. null = send straight away.
function dialogForAction(action, stage) {
  if (action.ask === "estimate") return { title: `Estimate "${stage}"`, message: "The stage becomes Not Started once it has a planned effort.", fields: [PLANNED_FIELD], okLabel: "Save estimate" };
  if (action.ask === "note") return { title: `${action.label} "${stage}"`, fields: [NOTE_FIELD], okLabel: action.label };
  if (action.ask === "actual") {
    return {
      title: `Complete "${stage}"`,
      fields: [{ ...NUMBER_FIELD, name: "actualEffortDays", label: "Actual effort (man-days)", min: 0, max: 9999, hint: "Leave blank to use the calculated working days spent In Progress." }, NOTE_FIELD],
      okLabel: "Complete",
    };
  }
  if (action.confirm) return { title: `${action.label} "${stage}"`, message: "The SLA stops and the stage's remaining effort is excluded from the request totals.", fields: [NOTE_FIELD], okLabel: action.label, danger: true };
  return null;
}

async function postStageStatus(requestId, payload) {
  try {
    await api(`/api/requests/${requestId}/stage-status`, { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    alert(err.message);
    return;
  }
  // The engine may also have moved the legacy stage/status, so reload the list and re-render the open drawer.
  await loadData();
  const fresh = state.requests.find((r) => r.id === requestId);
  if (fresh && state.viewingId === requestId) populateViewPanel(fresh);
  if (state.screen === "stagesla") loadStageSlaDashboard();
}

async function handleStageActionClick(e) {
  const btn = e.target.closest(".stage-action");
  const table = e.target.closest(".stage-sla-table");
  if (!btn || !table) return;
  const requestId = Number(table.dataset.request);
  const stage = btn.dataset.stage;

  if (btn.dataset.edit) {
    const values = await openStageActionDialog({
      title: `Planned effort for "${stage}"`, fields: [{ ...PLANNED_FIELD, value: btn.dataset.planned }], okLabel: "Save",
    });
    if (!values) return;
    const status = btn.closest("tr").querySelector(".stage-status").textContent.trim();
    return postStageStatus(requestId, { stage, status, ...values });
  }
  const action = STAGE_STATUS_ACTIONS[btn.dataset.status][Number(btn.dataset.action)];
  const dialog = dialogForAction(action, stage);
  const values = dialog ? await openStageActionDialog(dialog) : {};
  if (values) postStageStatus(requestId, { stage, status: action.status, ...values });
}

async function handleStageHistoryToggle(e) {
  const details = e.target.closest && e.target.closest(".stage-sla-history");
  if (!details || !details.open || details.dataset.loaded) return;
  const body = details.querySelector(".stage-sla-history-body");
  body.innerHTML = `<div class="comment-loading">Loading\u2026</div>`;
  try {
    body.innerHTML = renderStageSlaHistory(await api(`/api/requests/${details.dataset.request}/sla/history`));
    details.dataset.loaded = "1";
  } catch {
    body.innerHTML = `<div class="comment-error">Could not load the SLA history.</div>`;
  }
}

// ---------- dashboard ----------

// The request rows open the details drawer from state.requests, so load both together.
async function loadStageSlaScreen() {
  await Promise.all([loadRequests(), loadStageSlaDashboard()]);
}

async function loadStageSlaDashboard() {
  const wrap = document.getElementById("stageSlaDashboard");
  if (!wrap) return;
  const health = document.getElementById("stageSlaHealthFilter").value;
  try {
    renderStageSlaDashboard(await api(`/api/sla/dashboard${health ? `?health=${encodeURIComponent(health)}` : ""}`));
  } catch (err) {
    document.getElementById("stageSlaTiles").innerHTML = `<div class="comment-error">Could not load the stage SLA dashboard: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStageSlaDashboard(d) {
  document.getElementById("stageSlaThresholds").textContent =
    `Utilization = consumed working days \u00F7 priority-adjusted target. On Track up to ${d.thresholds.atRiskPct}%, At Risk up to ${d.thresholds.breachPct}%, Breached above. Request health is the worst of its overall utilization and any single stage.`;
  const h = d.totals.health;
  document.getElementById("stageSlaTiles").innerHTML = [
    dashboardTile(d.totals.requests, "Tracked requests"),
    dashboardTile(h["On Track"], "On Track"),
    dashboardTile(h["At Risk"], "At Risk", h["At Risk"] ? "kpi-warning" : ""),
    dashboardTile(h["Breached"], "Breached", h["Breached"] ? "kpi-danger" : ""),
    dashboardTile(d.totals.plannedDays, "Planned man-days"),
    dashboardTile(d.totals.consumedDays, "Consumed man-days"),
    dashboardTile(d.totals.holdDays, "Hold days"),
  ].join("");

  const table = (heads, rows) =>
    `<thead><tr>${heads.map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${heads.length}" class="breakdown-empty">No data.</td></tr>`}</tbody>`;
  document.getElementById("stageSlaStageTable").innerHTML = table(
    ["Stage", "Requests", "Planned", "Actual", "Variance", "Hold (days)", "Utilization"],
    d.stages.map((s) => `<tr><td>${escapeHtml(s.stage)}</td><td>${s.requests}</td><td>${s.plannedEffort}</td><td>${s.actualEffort}</td>
      <td class="${s.varianceDays > 0 ? "var-over" : ""}">${s.varianceDays > 0 ? "+" : ""}${s.varianceDays}</td><td>${s.holdDays}</td><td>${utilizationCell(s.utilizationPct, s.slaState)}</td></tr>`).join("")
  );

  const requests = [...d.requests].sort((a, b) =>
    (HEALTH_ORDER[a.slaHealth] ?? 3) - (HEALTH_ORDER[b.slaHealth] ?? 3) || (b.utilizationPct ?? -1) - (a.utilizationPct ?? -1));
  document.getElementById("stageSlaRequestTable").innerHTML = table(
    ["BR No", "Title", "Priority", "Stage", "Status", "Planned", "Consumed", "Hold", "Utilization", "Health", "Expected"],
    requests.map((r) => `<tr class="clickable-row" data-id="${r.requestId}"><td>${escapeHtml(r.brNo || "\u2014")}</td>
      <td class="stage-sla-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</td><td>${escapeHtml(r.priority || "\u2014")}</td>
      <td>${escapeHtml(r.currentStage)}</td><td>${statusChip(r.status)}</td><td>${r.totalPlannedDays}</td><td>${r.totalConsumedDays}</td><td>${r.totalHoldDays}</td>
      <td>${utilizationCell(r.utilizationPct, r.slaHealth)}</td><td>${healthBadge(r.slaHealth)}</td><td>${escapeHtml(r.expectedCompletionDate || "\u2014")}</td></tr>`).join("")
  );
}

function wireStageSla() {
  // The drawer content is re-rendered, so listen on its stable container.
  const body = document.getElementById("viewPanelBody");
  body.addEventListener("click", handleStageActionClick);
  body.addEventListener("toggle", handleStageHistoryToggle, true);

  document.getElementById("stageSlaHealthFilter").addEventListener("change", loadStageSlaDashboard);
  document.getElementById("stageSlaRefreshBtn").addEventListener("click", loadStageSlaScreen);
  document.getElementById("stageSlaRequestTable").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    const request = tr && state.requests.find((r) => r.id === Number(tr.dataset.id));
    if (request) openViewPanel(request);
  });
}
