const state = {
  lookups: null,
  requests: [],
  incidents: [],
  editingId: null,
  viewingId: null,
  visibleCols: null,
  incidentVisibleCols: null,
  sort: { key: null, dir: "asc" },
  screen: "requests",
  selectedIds: new Set(),
  viewMode: "open", // "open" | "closed" -- toggles whether Completed/Cancelled records are shown
  currentUser: null, // { id, username, name, role } once logged in
  followedRequestIds: new Set(),
  followedIncidentIds: new Set(),
};

// Reference-counted so nested/overlapping panels (e.g. bulk edit opened while
// a filter dropdown is open) don't unlock the page prematurely.
let scrollLockCount = 0;
function lockBodyScroll() {
  scrollLockCount++;
  document.body.classList.add("scroll-locked");
}
function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.classList.remove("scroll-locked");
}

const PIPELINE_FIELDS = [
  { key: "analysis_planned_start_date", label: "Analysis Planned Start Date" },
  { key: "analysis_planned_end_date", label: "Analysis Planned End Date" },
  { key: "dev_planned_start_date", label: "Dev Planned Start Date" },
  { key: "dev_planned_end_date", label: "Dev Planned End Date" },
  { key: "qa_planned_start_date", label: "QA Planned Start Date" },
  { key: "qa_planned_end_date", label: "QA Planned End Date" },
  { key: "uat_planned_start_date", label: "UAT Planned Start Date" },
  { key: "uat_planned_date", label: "UAT Planned End Date" },
  { key: "cab_date", label: "CAB Date" },
  { key: "deployment_planned_end_date", label: "Deployment Planned End Date" },
];

const INCIDENT_PIPELINE_FIELDS = PIPELINE_FIELDS.filter(
  (f) => f.key !== "analysis_planned_start_date" && f.key !== "analysis_planned_end_date"
);

const TABLE_COLUMNS = [
  { key: "br_no",                       label: "BR No",                   defaultVisible: true },
  { key: "cr",                          label: "CR",                      defaultVisible: true, wrap: true },
  { key: "submission_date",             label: "Submission Date",         defaultVisible: true },
  { key: "title",                       label: "Title",                   defaultVisible: true,  required: true, wrap: true },
  { key: "description",                 label: "Description",             defaultVisible: false, wrap: true, maxLen: 120 },
  { key: "business_unit",               label: "Business Unit",           defaultVisible: true },
  { key: "business_category",           label: "Business Category",       defaultVisible: false },
  { key: "requester",                   label: "Requester",               defaultVisible: false },
  { key: "priority",                    label: "Priority",                defaultVisible: true },
  { key: "stage",                       label: "Stage",                   defaultVisible: true },
  { key: "status",                      label: "Status",                  defaultVisible: true },
  { key: "tech_owner",                  label: "Tech Owner",              defaultVisible: true },
  { key: "rm",                          label: "RM",                      defaultVisible: true },
  { key: "newgen_related",              label: "Newgen Related",          defaultVisible: false, bool: true },
  { key: "estimated",                   label: "Estimated",               defaultVisible: false, bool: true },
  { key: "ba_required",                 label: "BA Required",             defaultVisible: false, bool: true },
  { key: "brd_assigned",                label: "BRD Assigned",            defaultVisible: false, bool: true },
  { key: "regulatory",                  label: "Regulatory",              defaultVisible: false, bool: true },
  { key: "regulator",                   label: "Regulator",               defaultVisible: false },
  { key: "regulatory_deadline",         label: "Regulatory Deadline",     defaultVisible: false },
  { key: "analysis_planned_start_date", label: "Analysis Planned Start",  defaultVisible: false },
  { key: "analysis_planned_end_date",   label: "Analysis Planned",        defaultVisible: false },
  { key: "dev_planned_start_date",      label: "Dev Planned Start",       defaultVisible: false },
  { key: "dev_planned_end_date",        label: "Dev Planned End",             defaultVisible: false },
  { key: "qa_planned_start_date",       label: "QA Planned Start",        defaultVisible: false },
  { key: "qa_planned_end_date",         label: "QA Planned End",              defaultVisible: false },
  { key: "uat_planned_start_date",      label: "UAT Planned Start",       defaultVisible: false },
  { key: "uat_planned_date",            label: "UAT Planned End",             defaultVisible: false },
  { key: "cab_date",                    label: "CAB Date",                defaultVisible: false },
  { key: "deployment_planned_end_date", label: "Deployment Planned End",      defaultVisible: true },
  { key: "closed_date",                 label: "Closed Date",             defaultVisible: false },
  { key: "last_comment",                label: "Last Comment",            defaultVisible: true,  wrap: true, maxLen: 80 },
  { key: "created_at",                  label: "Created Date",            defaultVisible: false, datetime: true },
  { key: "updated_at",                  label: "Last Updated",            defaultVisible: false, datetime: true },
  { key: "age_days",                    label: "Days Since Update",       defaultVisible: false, num: true },
];

const INCIDENT_TABLE_COLUMNS = [
  { key: "incident_id",                 label: "Incident ID",             defaultVisible: true },
  { key: "cr",                          label: "CR",                      defaultVisible: true },
  { key: "title",                       label: "Title",                   defaultVisible: true,  required: true, wrap: true },
  { key: "description",                 label: "Description",             defaultVisible: false, wrap: true, maxLen: 120 },
  { key: "business_unit",               label: "Business Unit",           defaultVisible: true },
  { key: "requester",                   label: "Requester",               defaultVisible: false },
  { key: "priority",                    label: "Priority",                defaultVisible: true },
  { key: "stage",                       label: "Stage",                   defaultVisible: true },
  { key: "status",                      label: "Status",                  defaultVisible: true },
  { key: "tech_owner",                  label: "Tech Owner",              defaultVisible: true },
  { key: "rm",                          label: "RM",                      defaultVisible: true },
  { key: "newgen_related",              label: "Newgen Related",          defaultVisible: false, bool: true },
  { key: "estimated",                   label: "Estimated",               defaultVisible: false, bool: true },
  { key: "dev_planned_start_date",      label: "Dev Planned Start",       defaultVisible: false },
  { key: "dev_planned_end_date",        label: "Dev Planned End",             defaultVisible: false },
  { key: "qa_planned_start_date",       label: "QA Planned Start",        defaultVisible: false },
  { key: "qa_planned_end_date",         label: "QA Planned End",              defaultVisible: false },
  { key: "uat_planned_start_date",      label: "UAT Planned Start",       defaultVisible: false },
  { key: "uat_planned_date",            label: "UAT Planned End",             defaultVisible: false },
  { key: "cab_date",                    label: "CAB Date",                defaultVisible: false },
  { key: "deployment_planned_end_date", label: "Deployment Planned End",      defaultVisible: true },
  { key: "closed_date",                 label: "Closed Date",             defaultVisible: false },
  { key: "last_comment",                label: "Last Comment",            defaultVisible: true,  wrap: true, maxLen: 80 },
  { key: "created_at",                  label: "Created Date",            defaultVisible: false, datetime: true },
  { key: "updated_at",                  label: "Last Updated",            defaultVisible: false, datetime: true },
  { key: "age_days",                    label: "Days Since Update",       defaultVisible: false, num: true },
];

const EXPORT_COLUMNS = [
  { key: "br_no",                        label: "BR No" },
  { key: "cr",                           label: "CR" },
  { key: "submission_date",              label: "Submission Date" },
  { key: "title",                        label: "Title" },
  { key: "business_unit",                label: "Business Unit" },
  { key: "business_category",            label: "Business Category" },
  { key: "requester",                    label: "Requester" },
  { key: "priority",                     label: "Priority" },
  { key: "stage",                        label: "Stage" },
  { key: "status",                       label: "Status" },
  { key: "tech_owner",                   label: "Tech Owner" },
  { key: "rm",                           label: "RM" },
  { key: "newgen_related",               label: "Newgen Related",          bool: true },
  { key: "estimated",                    label: "Estimated",               bool: true },
  { key: "ba_required",                  label: "BA Required",             bool: true },
  { key: "brd_assigned",                 label: "BRD Assigned",            bool: true },
  { key: "regulatory",                   label: "Regulatory",              bool: true },
  { key: "regulator",                    label: "Regulator" },
  { key: "regulatory_deadline",          label: "Regulatory Deadline" },
  { key: "analysis_planned_start_date",  label: "Analysis Planned Start" },
  { key: "analysis_planned_end_date",    label: "Analysis Planned End" },
  { key: "dev_planned_start_date",       label: "Dev Planned Start" },
  { key: "dev_planned_end_date",         label: "Dev Planned End" },
  { key: "qa_planned_start_date",        label: "QA Planned Start" },
  { key: "qa_planned_end_date",          label: "QA Planned End" },
  { key: "uat_planned_start_date",       label: "UAT Planned Start" },
  { key: "uat_planned_date",             label: "UAT Planned End" },
  { key: "cab_date",                     label: "CAB Date" },
  { key: "deployment_planned_end_date",  label: "Deployment Planned End" },
  { key: "closed_date",                  label: "Closed Date" },
  { key: "all_comments",                 label: "Comments" },
  { key: "created_at",                   label: "Created Date" },
  { key: "updated_at",                   label: "Last Updated" },
  { key: "age_days",                     label: "Days Since Update" },
];

const INCIDENT_EXPORT_COLUMNS = [
  { key: "incident_id",                  label: "Incident ID" },
  { key: "cr",                           label: "CR" },
  { key: "title",                        label: "Title" },
  { key: "business_unit",                label: "Business Unit" },
  { key: "requester",                    label: "Requester" },
  { key: "priority",                     label: "Priority" },
  { key: "stage",                        label: "Stage" },
  { key: "status",                       label: "Status" },
  { key: "tech_owner",                   label: "Tech Owner" },
  { key: "rm",                           label: "RM" },
  { key: "newgen_related",               label: "Newgen Related",  bool: true },
  { key: "estimated",                    label: "Estimated",       bool: true },
  { key: "dev_planned_start_date",       label: "Dev Planned Start" },
  { key: "dev_planned_end_date",         label: "Dev Planned End" },
  { key: "qa_planned_start_date",        label: "QA Planned Start" },
  { key: "qa_planned_end_date",          label: "QA Planned End" },
  { key: "uat_planned_start_date",       label: "UAT Planned Start" },
  { key: "uat_planned_date",             label: "UAT Planned End" },
  { key: "cab_date",                     label: "CAB Date" },
  { key: "deployment_planned_end_date",  label: "Deployment Planned End" },
  { key: "closed_date",                  label: "Closed Date" },
  { key: "all_comments",                 label: "Comments" },
  { key: "created_at",                   label: "Created Date" },
  { key: "updated_at",                   label: "Last Updated" },
  { key: "age_days",                     label: "Days Since Update" },
];

const SLA_FLAGS = [
  { code: "atrisk",   label: "Plan earlier than SLA - at risk" },
  { code: "passed",   label: "Planned date passed - re-baseline" },
  { code: "noplan",   label: "No plan - use SLA date" },
  { code: "ok",       label: "Plan within SLA" },
  { code: "paused",   label: "Paused - clock stopped" },
  { code: "done",     label: "Closed / done" },
];
const SLA_FLAG_AT_RISK = SLA_FLAGS[0].label;
const SLA_FLAG_PASSED = SLA_FLAGS[1].label;

const SLA_TABLE_COLUMNS = [
  { key: "sla_flag",           label: "SLA Status",    defaultVisible: true, sla: true },
  { key: "sla_target_date",    label: "SLA Target",    defaultVisible: true },
  { key: "sla_remaining_days", label: "SLA Days Left", defaultVisible: false, num: true },
];
const SLA_EXPORT_COLUMNS = [
  { key: "sla_flag",           label: "SLA Status" },
  { key: "sla_state",          label: "SLA State" },
  { key: "sla_remaining_days", label: "SLA Remaining (working days)" },
  { key: "sla_effort_days",    label: "SLA Remaining Effort (man-days)" },
  { key: "sla_target_date",    label: "SLA Target Date" },
  { key: "sla_gap_days",       label: "SLA Target vs Planned (days)" },
];
for (const cols of [TABLE_COLUMNS, INCIDENT_TABLE_COLUMNS]) {
  cols.splice(cols.findIndex((c) => c.key === "status") + 1, 0, { key: "system", label: "System", defaultVisible: true });
}
for (const cols of [EXPORT_COLUMNS, INCIDENT_EXPORT_COLUMNS]) {
  cols.splice(cols.findIndex((c) => c.key === "status") + 1, 0, { key: "system", label: "System" });
}
for (const cols of [TABLE_COLUMNS, INCIDENT_TABLE_COLUMNS]) {
  cols.splice(cols.findIndex((c) => c.key === "last_comment"), 0, ...SLA_TABLE_COLUMNS);
}
for (const cols of [EXPORT_COLUMNS, INCIDENT_EXPORT_COLUMNS]) {
  cols.splice(cols.findIndex((c) => c.key === "all_comments"), 0, ...SLA_EXPORT_COLUMNS);
}

const COLS_STORAGE_KEY = "itrm_visible_cols";
const INCIDENT_COLS_STORAGE_KEY = "itrm_incident_cols";

function activeColumns() {
  return state.screen === "incidents" ? INCIDENT_TABLE_COLUMNS : TABLE_COLUMNS;
}
function activeData() {
  return state.screen === "incidents" ? state.incidents : state.requests;
}
function activeApiBase() {
  return state.screen === "incidents" ? "/api/incidents" : "/api/business-requests";
}
function entityType() {
  return state.screen === "incidents" ? "incidents" : "requests";
}

// ---- Personal "My Follow-ups" bookmarks ----

function apiBaseForType(type) {
  return type === "incidents" ? "/api/incidents" : "/api/business-requests";
}
function followedSetForType(type) {
  return type === "incidents" ? state.followedIncidentIds : state.followedRequestIds;
}
function isFollowed(type, id) {
  return followedSetForType(type).has(id);
}

async function loadFollowedIds() {
  const [reqIds, incIds] = await Promise.all([
    api("/api/business-requests/followed"),
    api("/api/incidents/followed"),
  ]);
  state.followedRequestIds = new Set(reqIds);
  state.followedIncidentIds = new Set(incIds);
}

async function toggleFollow(type, id, shouldFollow) {
  try {
    await api(`${apiBaseForType(type)}/${id}/follow`, { method: shouldFollow ? "POST" : "DELETE" });
    const set = followedSetForType(type);
    if (shouldFollow) set.add(id);
    else set.delete(id);

    if (entityType() === type) renderTable();
    if (state.viewingId === id && entityType() === type) updateViewFollowButton(type, id);
    if (state.editingId === id && entityType() === type) updateFormFollowButton(type, id);
    if (state.screen === "myfollowups") renderMyFollowupsTable();
  } catch (err) {
    alert(err.message);
  }
}

function updateViewFollowButton(type, id) {
  const btn = document.getElementById("viewFollowBtn");
  const followed = isFollowed(type, id);
  btn.classList.toggle("following", followed);
  btn.innerHTML = followed ? "\u2605 Following" : "\u2606 Follow";
}

function updateFormFollowButton(type, id) {
  const btn = document.getElementById("formFollowBtn");
  const followed = isFollowed(type, id);
  btn.classList.toggle("following", followed);
  btn.innerHTML = followed ? "\u2605 Following" : "\u2606 Follow";
}

function loadColumnPrefs() {
  const key = state.screen === "incidents" ? INCIDENT_COLS_STORAGE_KEY : COLS_STORAGE_KEY;
  const cols = activeColumns();
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(saved)) return new Set(saved);
  } catch {}
  return new Set(cols.filter((c) => c.defaultVisible).map((c) => c.key));
}

function saveColumnPrefs() {
  const key = state.screen === "incidents" ? INCIDENT_COLS_STORAGE_KEY : COLS_STORAGE_KEY;
  localStorage.setItem(key, JSON.stringify([...state.visibleCols]));
}

// ---- Row density (Comfortable / Compact) ----
const DENSITY_STORAGE_KEY = "itrm_density";

function loadDensityPref() {
  const v = localStorage.getItem(DENSITY_STORAGE_KEY);
  return v === "compact" ? "compact" : "comfortable";
}

function applyDensity(mode) {
  document.getElementById("requestsTable").classList.toggle("density-compact", mode === "compact");
  document.querySelectorAll('#densityDropdown input[name="density"]').forEach((r) => { r.checked = r.value === mode; });
  localStorage.setItem(DENSITY_STORAGE_KEY, mode);
}

function renderTableHeader() {
  const tr = document.querySelector("#requestsTable thead tr");
  const cols = activeColumns().filter((c) => state.visibleCols.has(c.key));
  const selectAllTh = `<th class="select-col"><input type="checkbox" id="selectAllCheckbox" title="Select all" /></th>`;
  tr.innerHTML = selectAllTh + cols.map((c) => {
    const isActive = state.sort.key === c.key;
    const classes = ["th-sortable", c.wrap ? "td-wrap" : ""].filter(Boolean).join(" ");
    const arrow = isActive ? `<span class="th-sort-arrow">${state.sort.dir === "asc" ? "\u25b2" : "\u25bc"}</span>` : "";
    return `<th class="${classes}" data-sort-key="${c.key}">${escapeHtml(c.label)}${arrow}</th>`;
  }).join("") + "<th></th>";
}

function renderColConfigDropdown() {
  document.getElementById("colConfigDropdown").innerHTML = activeColumns().map(
    (c) => `<label class="multi-select-option${c.required ? " col-required-row" : ""}">
      <input type="checkbox" value="${c.key}" ${state.visibleCols.has(c.key) ? "checked" : ""} ${c.required ? "disabled" : ""} />
      ${escapeHtml(c.label)}${c.required ? `<span class="col-required-badge">always</span>` : ""}
    </label>`
  ).join("");
}

const LOOKUP_SELECTS = [
  { url: "priorities", select: "priority_id" },
  { url: "stages", select: "stage_id" },
  { url: "statuses", select: "status_id" },
  { url: "regulators", select: "regulator_id" },
  { url: "business-categories", select: "business_category_id" },
];

const FORM_COMBOS = [
  { url: "business-units", id: "business_unit_id" },
  { url: "requesters",     id: "requester_id" },
  { url: "rms",            id: "rm_id" },
];

// Form fields that let the user pick several lookup values at once (checkbox dropdown).
const FORM_MULTI_SELECTS = [
  { url: "tech-owners", id: "tech_owner_ids" },
  { url: "systems", id: "system_ids" },
];

const FILTER_MULTISELECTS = [
  { url: "stages", id: "filterStage" },
  { url: "statuses", id: "filterStatus" },
  { url: "priorities", id: "filterPriority" },
  { url: "sla-flags", id: "filterSla" },
  { url: "business-units", id: "filterBusinessUnit", searchable: true },
  { url: "business-categories", id: "filterBusinessCategory", searchable: true },
  { url: "requesters", id: "filterRequester", searchable: true },
  { url: "tech-owners", id: "filterTechOwner", searchable: true },
  { url: "systems", id: "filterSystem", searchable: true },
  { url: "rms", id: "filterRm", searchable: true },
];

const FLAG_FILTERS = [
  { key: "newgen_related", label: "Newgen Related" },
  { key: "estimated",      label: "Estimated" },
  { key: "ba_required",    label: "BA Required" },
  { key: "brd_assigned",   label: "BRD Assigned" },
  { key: "regulatory",     label: "Regulatory" },
];

// Lookup-backed fields eligible for the "bulk edit" panel (updates many
// selected records' lookup fields at once). `brOnly` fields are hidden
// on the Incidents screen since that table has no regulator column.
const BULK_EDIT_FIELDS = [
  { key: "business_unit_id", label: "Business Unit", url: "business-units" },
  { key: "business_category_id", label: "Business Category", url: "business-categories", brOnly: true },
  { key: "requester_id",     label: "Requester",     url: "requesters" },
  { key: "priority_id",      label: "Priority",      url: "priorities" },
  { key: "stage_id",         label: "Stage",         url: "stages" },
  { key: "status_id",        label: "Status",        url: "statuses" },
  { key: "tech_owner_id",    label: "Tech Owner",    url: "tech-owners" },
  { key: "regulator_id",     label: "Regulator",     url: "regulators", brOnly: true },
  { key: "rm_id",            label: "RM",            url: "rms" },
];

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401 && path !== "/api/auth/login") showLoginScreen();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || (body.errors && body.errors.join(" ")) || `Request failed (${res.status})`);
    err.errors = body.errors;
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function optionHtml(items, placeholder) {
  return (
    `<option value="">${placeholder}</option>` +
    items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join("")
  );
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function resetDropdownSearch(id) {
  const s = document.querySelector(`#${id} .multi-select-search`);
  if (!s) return;
  s.value = "";
  document.querySelectorAll(`#${id} .multi-select-option`).forEach((o) => (o.style.display = ""));
}

function setFormComboValue(id, value) {
  const hidden = document.getElementById(id);
  if (!hidden) return;
  const wrap = hidden.closest(".form-combo");
  if (!wrap) return;
  hidden.value = value ?? "";
  const strVal = String(value ?? "");
  const match = strVal ? [...wrap.querySelectorAll(".form-combo-option")].find((o) => o.dataset.value === strVal) : null;
  wrap.querySelector(".form-combo-input").value = match ? match.textContent : "";
}

function populateFormCombos() {
  for (const { url, id } of FORM_COMBOS) {
    const hidden = document.getElementById(id);
    if (!hidden) continue;
    const wrap = hidden.closest(".form-combo");
    if (!wrap) continue;
    const items = state.lookups[url] || [];
    wrap.querySelector(".form-combo-dropdown").innerHTML =
      `<div class="form-combo-option" data-value="">-- select --</div>` +
      items.map((i) => `<div class="form-combo-option" data-value="${i.id}">${escapeHtml(i.name)}</div>`).join("");
  }
}

// Re-fills the checkbox list for each form multi-select, preserving whatever is currently checked
// (e.g. after adding a new lookup value via the "+" button, which reloads all lookups).
function populateFormMultiSelects() {
  for (const { url, id } of FORM_MULTI_SELECTS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const checked = new Set(getMultiSelectValues(id));
    const items = state.lookups[url] || [];
    el.querySelector(".multi-select-dropdown").innerHTML =
      `<div class="multi-select-search-wrap"><input type="search" class="multi-select-search" placeholder="Search\u2026" autocomplete="off" /></div>` +
      items.map((i) =>
        `<label class="multi-select-option"><input type="checkbox" value="${i.id}" ${checked.has(String(i.id)) ? "checked" : ""} />` +
        `<span class="multi-select-option-label">${escapeHtml(i.name)}</span></label>`
      ).join("");
    updateMultiSelectTrigger(id);
  }
}

function setFormMultiSelectValues(id, values) {
  const set = new Set((values || []).map(String));
  document.querySelectorAll(`#${id} .multi-select-dropdown input[type=checkbox]`).forEach((cb) => {
    cb.checked = set.has(cb.value);
  });
  resetDropdownSearch(id);
  updateMultiSelectTrigger(id);
}

function getMultiSelectValues(id) {
  return Array.from(document.querySelectorAll(`#${id} .multi-select-dropdown input[type=checkbox]:checked`)).map((cb) => cb.value);
}

function updateMultiSelectTrigger(id) {
  const el = document.getElementById(id);
  const trigger = el.querySelector(".multi-select-trigger");
  const checked = getMultiSelectValues(id);
  if (checked.length === 0) {
    trigger.textContent = el.dataset.allLabel;
  } else if (checked.length === 1) {
    trigger.textContent = el.querySelector(".multi-select-dropdown input:checked").closest("label").querySelector(".multi-select-option-label").textContent.trim();
  } else {
    trigger.textContent = `${checked.length} ${el.dataset.countSuffix}`;
  }
  trigger.classList.toggle("active", checked.length > 0);
}

// Selects only the given value's checkbox (clears the rest).
function setMultiSelectOnly(id, value) {
  document.querySelectorAll(`#${id} .multi-select-dropdown input[type=checkbox]`).forEach((cb) => {
    cb.checked = cb.value === value;
  });
}

// Selects every value except the given one -- the inverse of "Only".
function setMultiSelectExclude(id, value) {
  document.querySelectorAll(`#${id} .multi-select-dropdown input[type=checkbox]`).forEach((cb) => {
    cb.checked = cb.value !== value;
  });
}

function populateFilterMultiSelects() {
  for (const { url, id, searchable } of FILTER_MULTISELECTS) {
    const items = state.lookups[url] || [];
    const dropdown = document.querySelector(`#${id} .multi-select-dropdown`);
    const searchHtml = searchable
      ? `<div class="multi-select-search-wrap"><input type="search" class="multi-select-search" placeholder="Search\u2026" autocomplete="off" /></div>`
      : "";
    dropdown.innerHTML = searchHtml + items
      .map(
        (i) =>
          `<label class="multi-select-option"><input type="checkbox" value="${i.id}" />` +
          `<span class="multi-select-option-label">${escapeHtml(i.name)}</span>` +
          `<span class="multi-select-option-actions">` +
          `<button type="button" class="ms-action" data-action="only">Only</button>` +
          `<button type="button" class="ms-action" data-action="exclude">Exclude</button>` +
          `</span></label>`
      )
      .join("");
    updateMultiSelectTrigger(id);
  }
}

async function loadLookups() {
  state.lookups = await api("/api/lookups");
  state.lookups["sla-flags"] = SLA_FLAGS.map((f) => ({ id: f.label, name: f.label }));
  for (const { url, select } of LOOKUP_SELECTS) {
    const items = state.lookups[url] || [];
    document.getElementById(select).innerHTML = optionHtml(items, "-- select --");
  }
  populateFormCombos();
  populateFormMultiSelects();
  populateFilterMultiSelects();
}

async function loadRequests() {
  state.requests = enrichAging(await api("/api/business-requests"));
  renderTable();
}

async function loadIncidents() {
  state.incidents = enrichAging(await api("/api/incidents"));
  renderTable();
}

async function loadData() {
  if (state.screen === "incidents") await loadIncidents();
  else await loadRequests();
}

function switchScreen(screen) {
  if (state.screen === screen) return;
  state.screen = screen;
  state.selectedIds.clear();
  document.querySelectorAll(".screen-tab").forEach((t) => t.classList.toggle("active", t.dataset.screen === screen));

  const isQuery = screen === "query";
  const isFollowup = screen === "followup";
  const isMyFollowups = screen === "myfollowups";
  const isDashboard = screen === "dashboard";
  document.getElementById("listScreen").classList.toggle("hidden", isQuery || isFollowup || isMyFollowups || isDashboard);
  document.getElementById("queryScreen").classList.toggle("hidden", !isQuery);
  document.getElementById("followupScreen").classList.toggle("hidden", !isFollowup);
  document.getElementById("myFollowupsScreen").classList.toggle("hidden", !isMyFollowups);
  document.getElementById("dashboardScreen").classList.toggle("hidden", !isDashboard);
  document.getElementById("newRequestBtn").classList.toggle("hidden", isQuery || isFollowup || isMyFollowups || isDashboard);

  if (isFollowup) {
    loadFollowupData();
    return;
  }

  if (isMyFollowups) {
    loadMyFollowupsData();
    return;
  }

  if (isDashboard) {
    loadDashboardData();
    return;
  }

  if (!isQuery) {
    state.sort = { key: null, dir: "asc" };
    state.visibleCols = loadColumnPrefs();
    document.getElementById("newRequestBtn").textContent = screen === "incidents" ? "+ New Incident" : "+ New Request";
    document.querySelectorAll("[data-br-only]").forEach((el) => el.classList.toggle("hidden", screen === "incidents"));
    document.getElementById("flagFiltersSection").classList.toggle("hidden", screen === "incidents");
    clearFilters();
    renderTableHeader();
    renderColConfigDropdown();
    loadData();
  }
}

// ---- Follow-up screen: flag records whose current stage's planned end date ----
// ---- is overdue or due within the next few days.                            ----
const STAGE_DUE_DATE_FIELDS = {
  analysis: { field: "analysis_planned_end_date", label: "Analysis Planned End" },
  development: { field: "dev_planned_end_date", label: "Dev Planned End" },
  qa: { field: "qa_planned_end_date", label: "QA Planned End" },
  uat: { field: "uat_planned_date", label: "UAT Planned End" },
  cab: { field: "cab_date", label: "CAB Date" },
  deployment: { field: "deployment_planned_end_date", label: "Deployment Planned End" },
};

const FOLLOWUP_DONE_STATUSES = new Set(["compeleted", "completed", "cancelled", "canceled"]);
const FOLLOWUP_THRESHOLD_DAYS = 5;

function daysRemaining(dateStr) {
  const due = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today) / 86400000);
}

// ---- Aging / staleness: flags open records with no update in a while. ----
const STALE_THRESHOLD_DAYS = 14;

function parseDateLoose(s) {
  if (!s) return null;
  let iso = s;
  if (!s.includes("T")) iso = s.length <= 10 ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysSince(dtStr) {
  const d = parseDateLoose(dtStr);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// Adds computed age_days/is_stale fields to each row, based on updated_at.
function enrichAging(rows) {
  for (const r of rows) {
    r.age_days = daysSince(r.updated_at);
    r.is_stale = !isDoneStatus(r.status) && r.age_days != null && r.age_days >= STALE_THRESHOLD_DAYS ? 1 : 0;
  }
  return rows;
}

function computeFollowupRows() {
  const includeIncidents = document.getElementById("followupIncludeIncidents").checked;
  const sources = [{ type: "requests", rows: state.requests, idField: "br_no" }];
  if (includeIncidents) sources.push({ type: "incidents", rows: state.incidents, idField: "incident_id" });

  const out = [];
  for (const { type, rows, idField } of sources) {
    for (const r of rows) {
      const mapping = STAGE_DUE_DATE_FIELDS[String(r.stage || "").trim().toLowerCase()];
      if (!mapping) continue;
      const dateValue = r[mapping.field];
      if (!dateValue) continue;
      if (FOLLOWUP_DONE_STATUSES.has(String(r.status || "").trim().toLowerCase())) continue;
      const remaining = daysRemaining(dateValue);
      if (remaining === null || remaining > FOLLOWUP_THRESHOLD_DAYS) continue;
      out.push({ type, idField, record: r, refNo: r[idField], dueLabel: mapping.label, dueDate: dateValue, remaining });
    }
  }
  out.sort((a, b) => a.remaining - b.remaining);
  return out;
}

function followupRemainingLabel(remaining) {
  if (remaining < 0) return `${Math.abs(remaining)}d overdue`;
  if (remaining === 0) return "Due today";
  return `${remaining}d left`;
}

function renderFollowupTable() {
  renderFollowupSlaTable();
  const tbody = document.getElementById("followupBody");
  const footer = document.getElementById("followupFooter");
  const rows = computeFollowupRows();

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty">Nothing overdue or due soon.</td></tr>`;
    footer.textContent = "0 records";
    return;
  }
  footer.textContent = `${rows.length} record${rows.length !== 1 ? "s" : ""}`;

  tbody.innerHTML = rows.map((f) => {
    const r = f.record;
    const cls = f.remaining < 0 ? "followup-overdue" : "followup-soon";
    return `<tr class="clickable-row ${cls}" data-type="${f.type}" data-id="${r.id}">
      <td>${f.type === "incidents" ? "Incident" : "BR"}</td>
      <td>${escapeHtml(f.refNo)}</td>
      <td>${escapeHtml(r.cr)}</td>
      <td class="td-wrap">${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.business_unit)}</td>
      <td>${escapeHtml(r.stage)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.priority)}</td>
      <td>${escapeHtml(f.dueLabel)}: ${escapeHtml(f.dueDate)}</td>
      <td><span class="followup-badge ${cls}">${followupRemainingLabel(f.remaining)}</span></td>
      <td>${escapeHtml(r.tech_owner)}</td>
      <td>${escapeHtml(r.rm)}</td>
    </tr>`;
  }).join("");
}

function computeSlaRiskRows() {
  const includeIncidents = document.getElementById("followupIncludeIncidents").checked;
  const sources = [{ type: "requests", rows: state.requests, idField: "br_no" }];
  if (includeIncidents) sources.push({ type: "incidents", rows: state.incidents, idField: "incident_id" });

  const out = [];
  for (const { type, rows, idField } of sources) {
    for (const r of rows) {
      if (r.sla_flag === SLA_FLAG_AT_RISK || r.sla_flag === SLA_FLAG_PASSED) out.push({ type, record: r, refNo: r[idField] });
    }
  }
  out.sort((a, b) => (b.record.sla_gap_days ?? -Infinity) - (a.record.sla_gap_days ?? -Infinity));
  return out;
}

function renderFollowupSlaTable() {
  const tbody = document.getElementById("followupSlaBody");
  const footer = document.getElementById("followupSlaFooter");
  const rows = computeSlaRiskRows();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty">No SLA risks.</td></tr>`;
    footer.textContent = "0 records";
    return;
  }
  footer.textContent = `${rows.length} record${rows.length !== 1 ? "s" : ""}`;
  tbody.innerHTML = rows.map((f) => {
    const r = f.record;
    const gap = r.sla_gap_days == null ? "" : r.sla_gap_days > 0 ? `+${r.sla_gap_days}d` : `${r.sla_gap_days}d`;
    return `<tr class="clickable-row" data-type="${f.type}" data-id="${r.id}">
      <td>${f.type === "incidents" ? "Incident" : "BR"}</td>
      <td>${escapeHtml(f.refNo)}</td>
      <td class="td-wrap">${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.stage)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.priority)}</td>
      <td>${escapeHtml(r.deployment_planned_end_date)}</td>
      <td>${escapeHtml(r.sla_target_date)}</td>
      <td>${escapeHtml(gap)}</td>
      <td>${renderSlaBadge(r.sla_flag)}</td>
      <td>${escapeHtml(r.tech_owner)}</td>
    </tr>`;
  }).join("");
}

async function loadFollowupData() {
  const tasks = [loadRequests()];
  if (document.getElementById("followupIncludeIncidents").checked) tasks.push(loadIncidents());
  await Promise.all(tasks);
  renderFollowupTable();
}

function openFollowupRecord(type, id) {
  const screen = type === "incidents" ? "incidents" : "requests";
  const record = (screen === "incidents" ? state.incidents : state.requests).find((r) => r.id === id);
  switchScreen(screen);
  if (record) openViewPanel(record);
}

function wireFollowupEvents() {
  document.getElementById("followupBody").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-id]");
    if (row) openFollowupRecord(row.dataset.type, Number(row.dataset.id));
  });
  document.getElementById("followupSlaBody").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-id]");
    if (row) openFollowupRecord(row.dataset.type, Number(row.dataset.id));
  });
  document.getElementById("followupRefreshBtn").addEventListener("click", loadFollowupData);
  document.getElementById("followupIncludeIncidents").addEventListener("change", loadFollowupData);
}

// ---- My Follow-ups screen: records the current user chose to bookmark. ----

function computeMyFollowupRows() {
  const sources = [
    { type: "requests", rows: state.requests, idField: "br_no" },
    { type: "incidents", rows: state.incidents, idField: "incident_id" },
  ];
  const out = [];
  for (const { type, rows, idField } of sources) {
    const followedIds = followedSetForType(type);
    for (const r of rows) {
      if (followedIds.has(r.id)) out.push({ type, idField, record: r, refNo: r[idField] });
    }
  }
  return out;
}

function renderMyFollowupsTable() {
  const tbody = document.getElementById("myFollowupsBody");
  const footer = document.getElementById("myFollowupsFooter");
  const rows = computeMyFollowupRows();

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">You're not following anything yet. Use the \u2606 star button to follow a request or incident.</td></tr>`;
    footer.textContent = "0 records";
    return;
  }
  footer.textContent = `${rows.length} record${rows.length !== 1 ? "s" : ""}`;

  tbody.innerHTML = rows.map((f) => {
    const r = f.record;
    return `<tr class="clickable-row" data-type="${f.type}" data-id="${r.id}">
      <td>${f.type === "incidents" ? "Incident" : "BR"}</td>
      <td>${escapeHtml(f.refNo)}</td>
      <td class="td-wrap">${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.business_unit)}</td>
      <td>${escapeHtml(r.stage)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.priority)}</td>
      <td>${escapeHtml(r.tech_owner)}</td>
      <td><button type="button" class="btn btn-ghost myfollowups-unfollow" data-type="${f.type}" data-id="${r.id}">Unfollow</button></td>
    </tr>`;
  }).join("");
}

async function loadMyFollowupsData() {
  await Promise.all([loadRequests(), loadIncidents(), loadFollowedIds()]);
  renderMyFollowupsTable();
}

function wireMyFollowupsEvents() {
  document.getElementById("myFollowupsBody").addEventListener("click", (e) => {
    const unfollowBtn = e.target.closest(".myfollowups-unfollow");
    if (unfollowBtn) {
      toggleFollow(unfollowBtn.dataset.type, Number(unfollowBtn.dataset.id), false);
      return;
    }
    const row = e.target.closest("tr[data-id]");
    if (row) openFollowupRecord(row.dataset.type, Number(row.dataset.id));
  });
  document.getElementById("myFollowupsRefreshBtn").addEventListener("click", loadMyFollowupsData);
}

// ---- Dashboard screen: KPI tiles + breakdowns summarizing both trackers. ----
function isDoneStatus(status) {
  return FOLLOWUP_DONE_STATUSES.has(String(status || "").trim().toLowerCase());
}

function countBy(rows, key) {
  const counts = new Map();
  for (const r of rows) {
    const label = r[key] && String(r[key]).trim() ? String(r[key]).trim() : "(none)";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderBreakdown(containerId, entries, suffix = "") {
  const container = document.getElementById(containerId);
  if (!entries.length) {
    container.innerHTML = `<div class="breakdown-empty">No data.</div>`;
    return;
  }
  const max = Math.max(...entries.map(([, count]) => count));
  container.innerHTML = entries.map(([label, count]) => `
    <div class="breakdown-row">
      <span class="breakdown-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <div class="breakdown-bar-track"><div class="breakdown-bar-fill" style="width: ${max ? Math.round((count / max) * 100) : 0}%"></div></div>
      <span class="breakdown-count">${count}${suffix}</span>
    </div>`).join("");
}

function dashboardTile(num, label, variant = "") {
  return `<div class="kpi-tile ${variant}"><div class="kpi-num">${num}</div><div class="kpi-lbl">${escapeHtml(label)}</div></div>`;
}

// ---- Cycle-time: average days from submission/creation to close, grouped by a lookup field. ----
function computeAvgCloseDays(rows, groupKey) {
  const sums = new Map(); // label -> { total, count }
  for (const r of rows) {
    if (!isDoneStatus(r.status)) continue;
    const start = parseDateLoose(r.submission_date) || parseDateLoose(r.created_at);
    const end = parseDateLoose(r.closed_date) || parseDateLoose(r.updated_at);
    if (!start || !end) continue;
    const days = Math.round((end.getTime() - start.getTime()) / 86400000);
    if (days < 0) continue;
    const label = r[groupKey] && String(r[groupKey]).trim() ? String(r[groupKey]).trim() : "(none)";
    const cur = sums.get(label) || { total: 0, count: 0 };
    cur.total += days;
    cur.count += 1;
    sums.set(label, cur);
  }
  return [...sums.entries()]
    .map(([label, { total, count }]) => [label, Math.round((total / count) * 10) / 10])
    .sort((a, b) => b[1] - a[1]);
}

// ---- Monthly volume trend: records created vs. closed per month. ----
function monthKeyFromDate(d) {
  return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : null;
}

function monthLabelFromKey(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: "short", year: "numeric" });
}

function computeMonthlyTrend(rows, months = 6) {
  const now = new Date();
  const keys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(monthKeyFromDate(d));
  }
  const created = Object.fromEntries(keys.map((k) => [k, 0]));
  const closed = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const createdKey = monthKeyFromDate(parseDateLoose(r.created_at));
    if (createdKey && createdKey in created) created[createdKey]++;
    if (isDoneStatus(r.status)) {
      const closedKey = monthKeyFromDate(parseDateLoose(r.closed_date) || parseDateLoose(r.updated_at));
      if (closedKey && closedKey in closed) closed[closedKey]++;
    }
  }
  return keys.map((k) => ({ label: monthLabelFromKey(k), created: created[k], closed: closed[k] }));
}

function renderMonthlyTrend(containerId, rows) {
  const container = document.getElementById(containerId);
  const maxVal = Math.max(1, ...rows.flatMap((r) => [r.created, r.closed]));
  container.innerHTML = `<table class="trend-table">
    <thead><tr><th>Month</th><th>Created</th><th>Closed</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.label)}</td>
        <td><div class="trend-bar-wrap"><div class="trend-bar trend-bar-created" style="width:${Math.round((r.created / maxVal) * 100)}%"></div><span>${r.created}</span></div></td>
        <td><div class="trend-bar-wrap"><div class="trend-bar trend-bar-closed" style="width:${Math.round((r.closed / maxVal) * 100)}%"></div><span>${r.closed}</span></div></td>
      </tr>`).join("")}</tbody></table>`;
}

function renderDashboard() {
  const requests = state.requests;
  const incidents = state.incidents;
  const openRequests = requests.filter((r) => !isDoneStatus(r.status));
  const openIncidents = incidents.filter((r) => !isDoneStatus(r.status));
  const regulatoryOpen = requests.filter((r) => r.regulatory && !isDoneStatus(r.status));
  const followup = computeFollowupRows();
  const overdue = followup.filter((f) => f.remaining < 0);
  const dueSoon = followup.filter((f) => f.remaining >= 0);
  const slaAtRisk = [...requests, ...incidents].filter((r) => r.sla_flag === SLA_FLAG_AT_RISK);
  const slaRebaseline = [...requests, ...incidents].filter((r) => r.sla_flag === SLA_FLAG_PASSED);
  const staleRequests = openRequests.filter((r) => r.is_stale);
  const staleIncidents = openIncidents.filter((r) => r.is_stale);

  document.getElementById("dashboardTiles").innerHTML = [
    dashboardTile(requests.length, "Business Requests"),
    dashboardTile(openRequests.length, "Open Business Requests"),
    dashboardTile(incidents.length, "Incidents"),
    dashboardTile(openIncidents.length, "Open Incidents"),
    dashboardTile(overdue.length, "Overdue", overdue.length ? "kpi-danger" : ""),
    dashboardTile(dueSoon.length, "Due within 5 Days", dueSoon.length ? "kpi-warning" : ""),
    dashboardTile(slaAtRisk.length, "SLA At Risk", slaAtRisk.length ? "kpi-danger" : ""),
    dashboardTile(slaRebaseline.length, "Needs Re-baseline", slaRebaseline.length ? "kpi-warning" : ""),
    dashboardTile(regulatoryOpen.length, "Open Regulatory BRs"),
    dashboardTile(staleRequests.length, `Stale BRs (${STALE_THRESHOLD_DAYS}+ days)`, staleRequests.length ? "kpi-warning" : ""),
    dashboardTile(staleIncidents.length, `Stale Incidents (${STALE_THRESHOLD_DAYS}+ days)`, staleIncidents.length ? "kpi-warning" : ""),
  ].join("");

  renderBreakdown("dashboardBrStage", countBy(requests, "stage"));
  renderBreakdown("dashboardBrStatus", countBy(requests, "status"));
  renderBreakdown("dashboardBrUnit", countBy(requests, "business_unit"));
  renderBreakdown("dashboardIncStatus", countBy(incidents, "status"));
  renderBreakdown("dashboardBrSla", countBy(openRequests, "sla_flag"));
  renderBreakdown("dashboardIncSla", countBy(openIncidents, "sla_flag"));

  const daysByStage = new Map();
  for (const r of [...openRequests, ...openIncidents]) {
    if (r.sla_state === "Done") continue;
    for (const s of r.sla_breakdown || []) daysByStage.set(s.stage, (daysByStage.get(s.stage) || 0) + s.days);
  }
  renderBreakdown("dashboardSlaStage", [...daysByStage.entries()].sort((a, b) => b[1] - a[1]));

  renderBreakdown("dashboardAvgCloseUnit", computeAvgCloseDays([...requests, ...incidents], "business_unit"), "d");
  renderBreakdown("dashboardAvgCloseCategory", computeAvgCloseDays(requests, "business_category"), "d");
  renderMonthlyTrend("dashboardTrend", computeMonthlyTrend([...requests, ...incidents]));
}


async function loadDashboardData() {
  await Promise.all([loadRequests(), loadIncidents()]);
  renderDashboard();
}

function wireDashboardEvents() {
  document.getElementById("dashboardRefreshBtn").addEventListener("click", loadDashboardData);
}

function applyFilters(rows) {
  if (state.viewMode !== "all") {
    rows = rows.filter((r) => isDoneStatus(r.status) === (state.viewMode === "closed"));
  }
  const search = document.getElementById("searchInput").value.trim().toLowerCase();
  const stageFilter = getMultiSelectValues("filterStage");
  const statusFilter = getMultiSelectValues("filterStatus");
  const priorityFilter = getMultiSelectValues("filterPriority");
  const buFilter = getMultiSelectValues("filterBusinessUnit");
  const bcFilter = getMultiSelectValues("filterBusinessCategory");
  const requesterFilter = getMultiSelectValues("filterRequester");
  const techOwnerFilter = getMultiSelectValues("filterTechOwner");
  const systemFilter = getMultiSelectValues("filterSystem");
  const rmFilter = getMultiSelectValues("filterRm");
  const slaFilter = getMultiSelectValues("filterSla");
  const idField = state.screen === "incidents" ? "incident_id" : "br_no";
  if (search) rows = rows.filter((r) => [r[idField], r.title, r.description, r.cr].some((f) => (f || "").toLowerCase().includes(search)));
  if (stageFilter.length) rows = rows.filter((r) => stageFilter.includes(String(r.stage_id)));
  if (statusFilter.length) rows = rows.filter((r) => statusFilter.includes(String(r.status_id)));
  if (priorityFilter.length) rows = rows.filter((r) => priorityFilter.includes(String(r.priority_id)));
  if (buFilter.length) rows = rows.filter((r) => buFilter.includes(String(r.business_unit_id)));
  if (bcFilter.length) rows = rows.filter((r) => bcFilter.includes(String(r.business_category_id)));
  if (requesterFilter.length) rows = rows.filter((r) => requesterFilter.includes(String(r.requester_id)));
  if (techOwnerFilter.length) rows = rows.filter((r) => String(r.tech_owner_ids || "").split(",").some((id) => techOwnerFilter.includes(id)));
  if (rmFilter.length) rows = rows.filter((r) => rmFilter.includes(String(r.rm_id)));
  if (systemFilter.length) rows = rows.filter((r) => String(r.system_ids || "").split(",").some((id) => systemFilter.includes(id)));
  if (slaFilter.length) rows = rows.filter((r) => slaFilter.includes(r.sla_flag));
  if (document.getElementById("staleFilterBtn")?.classList.contains("active")) {
    rows = rows.filter((r) => r.is_stale == 1);
  }
  document.querySelectorAll("#flagFiltersSection .filter-flag-btn.active").forEach((btn) => {
    rows = rows.filter((r) => r[btn.dataset.flag] == 1);
  });
  return rows;
}

function hasActiveFilters() {
  if (document.getElementById("searchInput").value.trim()) return true;
  if (FILTER_MULTISELECTS.some(({ id }) => getMultiSelectValues(id).length > 0)) return true;
  if (document.getElementById("staleFilterBtn")?.classList.contains("active")) return true;
  return document.querySelectorAll("#flagFiltersSection .filter-flag-btn.active").length > 0;
}

function updateClearFiltersBtn() {
  document.getElementById("clearFiltersBtn").classList.toggle("hidden", !hasActiveFilters());
}

function clearFilters() {
  document.getElementById("searchInput").value = "";
  FILTER_MULTISELECTS.forEach(({ id }) => {
    document.querySelectorAll(`#${id} .multi-select-dropdown input[type=checkbox]`).forEach((cb) => { cb.checked = false; });
    resetDropdownSearch(id);
    updateMultiSelectTrigger(id);
  });
  document.querySelectorAll(".filter-flag-btn").forEach((btn) => btn.classList.remove("active"));
  updateClearFiltersBtn();
  renderTable();
}

// ---- Saved filters ----

const SAVED_FILTERS_KEY = "itrm_saved_filters";

function loadSavedFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_FILTERS_KEY));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function persistSavedFilters(list) {
  localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(list));
}

function getCurrentFilterState() {
  return {
    search: document.getElementById("searchInput").value.trim(),
    filters: Object.fromEntries(FILTER_MULTISELECTS.map(({ id }) => [id, getMultiSelectValues(id)])),
    flags: [...document.querySelectorAll("#flagFiltersSection .filter-flag-btn.active")].map((b) => b.dataset.flag),
  };
}

function applyFilterState(saved) {
  document.getElementById("searchInput").value = saved.search || "";
  for (const { id } of FILTER_MULTISELECTS) {
    const active = new Set(saved.filters?.[id] || []);
    document.querySelectorAll(`#${id} .multi-select-dropdown input[type=checkbox]`).forEach((cb) => {
      cb.checked = active.has(cb.value);
    });
    resetDropdownSearch(id);
    updateMultiSelectTrigger(id);
  }
  const activeFlags = new Set(saved.flags || []);
  document.querySelectorAll(".filter-flag-btn").forEach((btn) => {
    btn.classList.toggle("active", activeFlags.has(btn.dataset.flag));
  });
  updateClearFiltersBtn();
  renderTable();
}

function saveCurrentFilter(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = loadSavedFilters();
  list.push({ name: trimmed, state: getCurrentFilterState() });
  persistSavedFilters(list);
  document.getElementById("savedFilterName").value = "";
  renderSavedFiltersList();
}

function deleteSavedFilter(index) {
  const list = loadSavedFilters();
  list.splice(index, 1);
  persistSavedFilters(list);
  renderSavedFiltersList();
}

function renderSavedFiltersList() {
  const list = loadSavedFilters();
  const el = document.getElementById("savedFiltersList");
  if (!list.length) {
    el.innerHTML = `<div class="saved-filters-empty">No saved filters yet.</div>`;
    return;
  }
  el.innerHTML = list.map((f, i) => `
    <div class="saved-filter-item">
      <span class="saved-filter-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <div class="saved-filter-actions">
        <button type="button" class="btn btn-ghost saved-filter-apply" data-index="${i}">Apply</button>
        <button type="button" class="btn btn-ghost saved-filter-delete" data-index="${i}" title="Delete">&times;</button>
      </div>
    </div>`).join("");
}

function applySorting(rows) {
  const { key, dir } = state.sort;
  if (!key) return rows;
  const col = activeColumns().find((c) => c.key === key);
  return [...rows].sort((a, b) => {
    let av = a[key] ?? "";
    let bv = b[key] ?? "";
    if (av === "" && bv !== "") return 1;
    if (bv === "" && av !== "") return -1;
    let cmp;
    if (col?.bool) {
      cmp = (av ? 1 : 0) - (bv ? 1 : 0);
    } else if (col?.num) {
      cmp = Number(av) - Number(bv);
    } else {
      av = String(av).toLowerCase();
      bv = String(bv).toLowerCase();
      cmp = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

function renderWorkflowBadge(value, type) {
  const text = String(value ?? "");
  if (!text) return "";
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `<span class="workflow-badge workflow-badge-${type} workflow-badge-${type}-${normalized}">${escapeHtml(text)}</span>`;
}

function renderSlaBadge(flag) {
  const f = SLA_FLAGS.find((x) => x.label === flag);
  return f ? `<span class="sla-badge sla-badge-${f.code}">${escapeHtml(f.label)}</span>` : escapeHtml(flag);
}

function updateViewToggle() {
  const toggle = document.getElementById("viewToggle");
  if (!toggle) return;
  const data = activeData();
  const closedCount = data.filter((r) => isDoneStatus(r.status)).length;
  const counts = { open: data.length - closedCount, closed: closedCount, all: data.length };
  const labels = { open: "Open", closed: "Closed", all: "All" };
  toggle.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    const view = btn.dataset.view;
    btn.classList.toggle("active", view === state.viewMode);
    btn.textContent = `${labels[view]} (${counts[view]})`;
  });
}

function updateStaleFilterBtn() {
  const btn = document.getElementById("staleFilterBtn");
  if (!btn) return;
  const count = activeData().filter((r) => r.is_stale).length;
  btn.textContent = `Stale (${STALE_THRESHOLD_DAYS}+ days) (${count})`;
}

function renderTable() {
  const tbody = document.getElementById("requestsBody");
  const allIds = new Set(activeData().map((r) => r.id));
  for (const id of state.selectedIds) {
    if (!allIds.has(id)) state.selectedIds.delete(id);
  }

  updateViewToggle();
  updateStaleFilterBtn();
  const rows = applySorting(applyFilters(activeData()));
  const visibleCols = activeColumns().filter((c) => state.visibleCols.has(c.key));
  const colCount = visibleCols.length + 2; // + select column + actions column
  const total = activeData().length;
  const footer = document.getElementById("tableFooter");
  footer.textContent = rows.length === total
    ? `${total} record${total !== 1 ? "s" : ""}`
    : `${rows.length} of ${total} record${total !== 1 ? "s" : ""}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty">No requests found.</td></tr>`;
    updateBulkActionsBar();
    syncSelectAllCheckbox(rows);
    return;
  }

  tbody.innerHTML = rows.map((r) => {
    const cells = visibleCols.map((c) => {
      let v;
      if (c.bool) {
        v = r[c.key] ? "\u2713" : "";
      } else if (c.datetime) {
        v = escapeHtml(formatCommentDate(r[c.key]));
      } else if (["priority", "stage", "status"].includes(c.key)) {
        v = renderWorkflowBadge(r[c.key], c.key);
      } else if (c.sla) {
        v = renderSlaBadge(r[c.key]);
      } else if (c.key === "age_days") {
        v = r.age_days == null ? "" : `<span class="${r.is_stale ? "age-stale" : ""}">${r.age_days}</span>`;
      } else {
        const raw = r[c.key] != null ? String(r[c.key]) : "";
        v = c.maxLen && raw.length > c.maxLen
          ? escapeHtml(raw.substring(0, c.maxLen)) + "\u2026"
          : escapeHtml(raw);
      }
      return `<td${c.wrap ? ' class="td-wrap"' : ""}>${v}</td>`;
    }).join("");
    const checked = state.selectedIds.has(r.id) ? "checked" : "";
    const selectCell = `<td class="select-col"><input type="checkbox" class="row-select-checkbox" data-id="${r.id}" ${checked} /></td>`;
    const highlighted = r.id === state.viewingId ? " row-highlighted" : "";
    const followed = isFollowed(entityType(), r.id);
    const followBtn = `<button class="btn btn-ghost row-follow${followed ? " following" : ""}" data-id="${r.id}" title="${followed ? "Unfollow" : "Follow"}">${followed ? "\u2605" : "\u2606"}</button>`;
    return `<tr class="clickable-row${highlighted}" data-id="${r.id}">${selectCell}${cells}<td>${followBtn}<button class="btn btn-ghost row-edit write-only" data-id="${r.id}">Edit</button></td></tr>`;
  }).join("");

  updateBulkActionsBar();
  syncSelectAllCheckbox(rows);
}

function syncSelectAllCheckbox(rows) {
  const cb = document.getElementById("selectAllCheckbox");
  if (!cb) return;
  if (!rows.length) {
    cb.checked = false;
    cb.indeterminate = false;
    return;
  }
  const selectedCount = rows.filter((r) => state.selectedIds.has(r.id)).length;
  cb.checked = selectedCount > 0 && selectedCount === rows.length;
  cb.indeterminate = selectedCount > 0 && selectedCount < rows.length;
}

function updateBulkActionsBar() {
  const bar = document.getElementById("bulkActionsBar");
  const count = state.selectedIds.size;
  bar.classList.toggle("hidden", count === 0);
  document.getElementById("bulkSelectedCount").textContent = `${count} selected`;
}

function clearSelection() {
  state.selectedIds.clear();
  renderTable();
}

// ---- Email selected records via Outlook ----

function selectedRowsInTableOrder() {
  return applySorting(applyFilters(activeData())).filter((r) => state.selectedIds.has(r.id));
}

function emailColumns() {
  return activeColumns().filter((c) => state.visibleCols.has(c.key));
}

function buildEmailTableHtml(rows, cols) {
  const th = "border:1px solid #bbb;padding:4px 8px;background:#e8eaed;text-align:left;font-weight:bold;";
  const td = "border:1px solid #bbb;padding:4px 8px;vertical-align:top;";
  const head = cols.map((c) => `<th style="${th}">${escapeHtml(c.label)}</th>`).join("");
  const body = rows.map((r) =>
    `<tr>${cols.map((c) => `<td style="${td}">${escapeHtml(getTableCopyCellValue(r, c))}</td>`).join("")}</tr>`
  ).join("");
  return `<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function buildEmlDraft({ to, cc, subject, messageHtml, tableHtml }) {
  const html = `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">${messageHtml}${tableHtml}</body></html>`;
  const encodedSubject = `=?UTF-8?B?${utf8ToBase64(subject)}?=`;
  const headers = [
    "X-Unsent: 1", // makes Outlook open the file as an editable draft
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const b64 = utf8ToBase64(html).replace(/.{1,76}/g, "$&\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + b64;
}

function cleanAddressList(value) {
  return value.split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean).join("; ");
}

function openEmailModal() {
  const rows = selectedRowsInTableOrder();
  if (!rows.length) return;
  const label = state.screen === "incidents" ? "incident" : "business request";
  document.getElementById("emailCount").textContent = `(${rows.length} record${rows.length !== 1 ? "s" : ""})`;
  document.getElementById("emailSubject").value = `ITRM Tracker - ${rows.length} ${label}${rows.length !== 1 ? "s" : ""}`;
  document.getElementById("emailMessage").value = "";
  const errorsEl = document.getElementById("emailErrors");
  errorsEl.textContent = "";
  errorsEl.classList.add("hidden");
  document.getElementById("emailOverlay").classList.remove("hidden");
  document.getElementById("emailModal").classList.remove("hidden");
  lockBodyScroll();
}

function closeEmailModal() {
  document.getElementById("emailOverlay").classList.add("hidden");
  document.getElementById("emailModal").classList.add("hidden");
  unlockBodyScroll();
}

function handleEmailOpenInOutlook() {
  const rows = selectedRowsInTableOrder();
  const errorsEl = document.getElementById("emailErrors");
  if (!rows.length) {
    errorsEl.textContent = "No selected records are visible.";
    errorsEl.classList.remove("hidden");
    return;
  }
  const subject = document.getElementById("emailSubject").value.trim() || "ITRM Tracker";
  const message = document.getElementById("emailMessage").value.trim();
  const messageHtml = message
    ? `<p>${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>`
    : "";
  const eml = buildEmlDraft({
    to: cleanAddressList(document.getElementById("emailTo").value),
    cc: cleanAddressList(document.getElementById("emailCc").value),
    subject,
    messageHtml,
    tableHtml: buildEmailTableHtml(rows, emailColumns()),
  });
  const blob = new Blob([eml], { type: "message/rfc822" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ITRM-draft-${new Date().toISOString().slice(0, 10)}.eml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  closeEmailModal();
}

async function handleEmailCopyTable() {
  const rows = selectedRowsInTableOrder();
  const cols = emailColumns();
  const errorsEl = document.getElementById("emailErrors");
  try {
    const html = buildEmailTableHtml(rows, cols);
    const text = [cols.map((c) => toClipboardSafeText(c.label)).join("\t"),
      ...rows.map((r) => cols.map((c) => toClipboardSafeText(getTableCopyCellValue(r, c))).join("\t"))].join("\n");
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
    } else {
      await copyToClipboard(text);
    }
    errorsEl.classList.add("hidden");
    const btn = document.getElementById("emailCopyBtn");
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch (err) {
    errorsEl.textContent = "Copy failed: " + err.message;
    errorsEl.classList.remove("hidden");
  }
}

function activeBulkEditFields() {
  const isIncidents = state.screen === "incidents";
  return BULK_EDIT_FIELDS.filter((f) => !isIncidents || !f.brOnly);
}

function openBulkEditModal() {
  if (!state.selectedIds.size) return;
  const count = state.selectedIds.size;
  document.getElementById("bulkEditCount").textContent = `(${count} record${count !== 1 ? "s" : ""})`;

  document.getElementById("bulkEditFields").innerHTML = activeBulkEditFields().map(({ key, label, url }) => {
    const items = (state.lookups && state.lookups[url]) || [];
    return `<label>${escapeHtml(label)}
      <select data-bulk-field="${key}">
        <option value="">-- No change --</option>
        ${items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join("")}
      </select>
    </label>`;
  }).join("");

  const errorsEl = document.getElementById("bulkEditErrors");
  errorsEl.textContent = "";
  errorsEl.classList.add("hidden");
  document.getElementById("bulkEditOverlay").classList.remove("hidden");
  document.getElementById("bulkEditModal").classList.remove("hidden");
  lockBodyScroll();
}

function closeBulkEditModal() {
  document.getElementById("bulkEditOverlay").classList.add("hidden");
  document.getElementById("bulkEditModal").classList.add("hidden");
  unlockBodyScroll();
}

async function handleBulkEditApply() {
  const fields = {};
  document.querySelectorAll("#bulkEditFields [data-bulk-field]").forEach((sel) => {
    if (sel.value !== "") fields[sel.dataset.bulkField] = sel.value;
  });

  const errorsEl = document.getElementById("bulkEditErrors");
  if (!Object.keys(fields).length) {
    errorsEl.textContent = "Choose at least one field to update.";
    errorsEl.classList.remove("hidden");
    return;
  }

  try {
    const result = await api(`${activeApiBase()}/bulk-update`, {
      method: "POST",
      body: JSON.stringify({ ids: [...state.selectedIds], fields }),
    });
    closeBulkEditModal();
    clearSelection();
    await loadData();
    if (result && result.errors && result.errors.length) {
      alert(`Updated ${result.updated} of ${result.total} record(s). Some records failed:\n${result.errors.join("\n")}`);
    }
  } catch (err) {
    errorsEl.textContent = err.errors ? err.errors.join(" ") : err.message;
    errorsEl.classList.remove("hidden");
  }
}

const FIELD_DEPENDENCIES = {
  estimated:   ["dev_planned_start_date", "dev_planned_end_date", "qa_planned_start_date", "qa_planned_end_date", "uat_planned_start_date", "uat_planned_date", "cab_date", "deployment_planned_end_date"],
  ba_required: ["analysis_planned_start_date", "analysis_planned_end_date"],
  regulatory:  ["regulator_id", "regulatory_deadline"],
};

function syncFormFieldStates(clearOnDisable) {
  const isIncidents = state.screen === "incidents";
  const deps = isIncidents
    ? { estimated: FIELD_DEPENDENCIES.estimated }
    : FIELD_DEPENDENCIES;
  for (const [flag, fieldIds] of Object.entries(deps)) {
    const enabled = document.getElementById(flag).checked;
    for (const id of fieldIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.disabled = !enabled;
      el.closest("label").classList.toggle("field-disabled", !enabled);
      if (!enabled && clearOnDisable) el.value = "";
    }
  }
  if (!isIncidents) {
    const regulatorBtn = document.querySelector('[data-lookup="regulators"]');
    if (regulatorBtn) regulatorBtn.disabled = !document.getElementById("regulatory").checked;
  }
}

function openForm(request) {
  const isIncidents = state.screen === "incidents";
  document.getElementById("requestForm").reset();
  document.getElementById("dateErrors").innerHTML = "";
  document.getElementById("formErrors").classList.add("hidden");
  state.editingId = request ? request.id : null;

  // Show/hide BR-only fields
  document.querySelectorAll("[data-br-only]").forEach((el) => el.classList.toggle("hidden", isIncidents));
  document.getElementById("refNoLabel").textContent = isIncidents ? "Incident ID" : "BR No";

  const refLabel = isIncidents ? "Incident" : "Request";
  const refNo = request ? (isIncidents ? request.incident_id : request.br_no) : null;
  document.getElementById("formTitle").textContent = request
    ? `Edit ${refLabel}${refNo ? " - " + refNo : ""}`
    : `New ${refLabel}`;
  document.getElementById("deleteBtn").classList.toggle("hidden", !request);
  const formFollowBtn = document.getElementById("formFollowBtn");
  formFollowBtn.classList.toggle("hidden", !request);
  if (request) updateFormFollowButton(isIncidents ? "incidents" : "requests", request.id);

  const fields = [
    "id", "br_no", "cr", "submission_date", "business_unit_id", "business_category_id", "requester_id", "title", "description",
    "priority_id", "stage_id", "status_id", "regulator_id",
    "regulatory_deadline", "rm_id", "closed_date",
    ...PIPELINE_FIELDS.map((f) => f.key),
  ];
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) el.value = request ? (request[key] ?? "") : "";
  }
  // For incidents, map incident_id into the br_no input
  if (isIncidents && request) {
    document.getElementById("br_no").value = request.incident_id ?? "";
  }
  for (const { id } of FORM_COMBOS) {
    setFormComboValue(id, request ? (request[id] ?? "") : "");
  }
  setFormMultiSelectValues("tech_owner_ids", request && request.tech_owner_ids ? String(request.tech_owner_ids).split(",") : []);
  setFormMultiSelectValues("system_ids", request && request.system_ids ? String(request.system_ids).split(",") : []);
  const boolFields = isIncidents
    ? ["newgen_related", "estimated"]
    : ["newgen_related", "estimated", "ba_required", "brd_assigned", "regulatory"];
  for (const key of boolFields) {
    document.getElementById(key).checked = request ? !!request[key] : false;
  }

  const commentSection = document.getElementById("formCommentSection");
  if (request) {
    commentSection.classList.remove("hidden");
    document.getElementById("newCommentText").value = "";
    document.getElementById("formCommentList").innerHTML = `<div class="comment-loading">Loading…</div>`;
    loadAndRenderComments(request.id, "formCommentList");
  } else {
    commentSection.classList.add("hidden");
  }

  syncFormFieldStates(false);
  document.getElementById("overlay").classList.remove("hidden");
  document.getElementById("formPanel").classList.remove("hidden");
  lockBodyScroll();
}

function closeForm() {
  document.getElementById("overlay").classList.add("hidden");
  document.getElementById("formPanel").classList.add("hidden");
  state.editingId = null;
  unlockBodyScroll();
}

// ---- client-side mirror of the server's two-sided pipeline date validation ----
function validatePipelineDatesClientSide() {
  const pf = state.screen === "incidents" ? INCIDENT_PIPELINE_FIELDS : PIPELINE_FIELDS;
  const values = {};
  for (const { key } of pf) {
    values[key] = document.getElementById(key).value || null;
  }

  const errors = [];
  for (let i = 0; i < pf.length; i++) {
    const { key, label } = pf[i];
    const value = values[key];
    if (!value) continue;

    if (i > 0) {
      const prev = pf[i - 1];
      if (values[prev.key] && value < values[prev.key]) {
        errors.push(`${label} must be on or after ${prev.label}.`);
      }
    }
    if (i < pf.length - 1) {
      const next = pf[i + 1];
      if (values[next.key] && value > values[next.key]) {
        errors.push(`${label} must be on or before ${next.label}.`);
      }
    }
  }

  document.getElementById("dateErrors").innerHTML = errors.map((e) => `<div class="field-error">${escapeHtml(e)}</div>`).join("");
  return errors;
}

async function handleAddLookup(type) {
  const name = prompt(`New value for ${type.replace("-", " ")}:`);
  if (!name || !name.trim()) return;
  try {
    await api(`/api/lookups/${type}`, { method: "POST", body: JSON.stringify({ name: name.trim() }) });
    await loadLookups();
  } catch (err) {
    alert(err.message);
  }
}

function collectFormData() {
  const data = {};
  if (state.screen === "incidents") {
    const fields = [
      "cr", "business_unit_id", "requester_id", "title", "description",
      "priority_id", "stage_id", "status_id", "rm_id", "closed_date",
      ...INCIDENT_PIPELINE_FIELDS.map((f) => f.key),
    ];
    for (const key of fields) data[key] = document.getElementById(key).value || null;
    data.incident_id = document.getElementById("br_no").value || null;
    for (const key of ["newgen_related", "estimated"]) {
      data[key] = document.getElementById(key).checked;
    }
  } else {
    const fields = [
      "br_no", "cr", "submission_date", "business_unit_id", "business_category_id", "requester_id", "title", "description",
      "priority_id", "stage_id", "status_id", "regulator_id",
      "regulatory_deadline", "rm_id", "closed_date",
      ...PIPELINE_FIELDS.map((f) => f.key),
    ];
    for (const key of fields) data[key] = document.getElementById(key).value || null;
    for (const key of ["newgen_related", "estimated", "ba_required", "brd_assigned", "regulatory"]) {
      data[key] = document.getElementById(key).checked;
    }
  }
  data.tech_owner_ids = getMultiSelectValues("tech_owner_ids");
  data.system_ids = getMultiSelectValues("system_ids");
  return data;
}

async function handleSubmit(e) {
  e.preventDefault();
  if (validatePipelineDatesClientSide().length) return;

  const data = collectFormData();
  const formErrorsEl = document.getElementById("formErrors");
  formErrorsEl.classList.add("hidden");

  try {
    if (state.editingId) {
      await api(`${activeApiBase()}/${state.editingId}`, { method: "PUT", body: JSON.stringify(data) });
    } else {
      await api(activeApiBase(), { method: "POST", body: JSON.stringify(data) });
    }
    closeForm();
    await loadData();
  } catch (err) {
    formErrorsEl.textContent = err.errors ? err.errors.join(" ") : err.message;
    formErrorsEl.classList.remove("hidden");
  }
}

async function handleDelete() {
  if (!state.editingId) return;
  const label = state.screen === "incidents" ? "incident" : "business request";
  if (!confirm(`Delete this ${label}? This cannot be undone.`)) return;
  await api(`${activeApiBase()}/${state.editingId}`, { method: "DELETE" });
  closeForm();
  await loadData();
}

// ---- View panel (read-only) ----

function formatCommentDate(dtStr) {
  if (!dtStr) return "";
  const d = new Date(dtStr.includes("T") ? dtStr : dtStr.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? dtStr : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderCommentThread(comments, listEl) {
  if (!comments.length) {
    listEl.innerHTML = `<div class="comment-empty">No comments yet.</div>`;
    return;
  }
  listEl.innerHTML = comments
    .map(
      (c) => `<div class="comment-item" data-comment-id="${c.id}">
        <div class="comment-meta">
          <span class="comment-date">${escapeHtml(formatCommentDate(c.created_at))}</span>
          ${c.created_by ? `<span class="comment-author">&bull; ${escapeHtml(c.created_by)}</span>` : ""}
          <button hidden type="button" class="btn btn-ghost comment-delete-btn write-only" data-comment-id="${c.id}" title="Delete comment">&times;</button>
        </div>
        <p class="comment-body">${escapeHtml(c.body)}</p>
      </div>`
    )
    .join("");
  listEl.scrollTop = listEl.scrollHeight;
}

async function loadAndRenderComments(recordId, listElId) {
  const base = activeApiBase();
  try {
    const comments = await api(`${base}/${recordId}/comments`);
    const el = document.getElementById(listElId);
    if (el) {
      renderCommentThread(comments, el);
      el.onclick = async (e) => {
        const btn = e.target.closest(".comment-delete-btn");
        if (!btn) return;
        if (!confirm("Delete this comment?")) return;
        await api(`${base}/${recordId}/comments/${btn.dataset.commentId}`, { method: "DELETE" });
        await loadAndRenderComments(recordId, listElId);
        loadData();
      };
    }
  } catch {
    const el = document.getElementById(listElId);
    if (el) el.innerHTML = `<div class="comment-error">Could not load comments.</div>`;
  }
}

async function handleAddComment(recordId, panel) {
  const textareaId = panel === "view" ? "viewNewCommentText" : "newCommentText";
  const listId = panel === "view" ? "viewCommentList" : "formCommentList";
  const textarea = document.getElementById(textareaId);
  const body = textarea.value.trim();
  if (!body) return;
  try {
    await api(`${activeApiBase()}/${recordId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    textarea.value = "";
    await loadAndRenderComments(recordId, listId);
    loadData();
  } catch (err) {
    alert(err.message);
  }
}

function openViewPanel(request) {
  state.viewingId = request.id;
  const isIncidents = state.screen === "incidents";
  const refNo = isIncidents ? request.incident_id : request.br_no;
  const label = isIncidents ? "Incident" : "Request";
  document.getElementById("viewPanelTitle").textContent = `${label}${refNo ? " \u2013 " + refNo : ""}`;
  document.getElementById("viewPanelBody").innerHTML = renderViewBody(request);
  wireViewCopyButtons();
  updateViewFollowButton(entityType(), request.id);
  document.getElementById("viewOverlay").classList.remove("hidden");
  document.getElementById("viewPanel").classList.remove("hidden");
  lockBodyScroll();
  loadAndRenderComments(request.id, "viewCommentList");
  loadAndRenderHistory(request.id, "viewHistoryList");
  document.getElementById("viewAddCommentBtn").onclick = () => handleAddComment(request.id, "view");
  document.getElementById("viewNewCommentText").onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleAddComment(request.id, "view");
  };
}

function closeViewPanel() {
  document.getElementById("viewOverlay").classList.add("hidden");
  document.getElementById("viewPanel").classList.add("hidden");
  state.viewingId = null;
  unlockBodyScroll();
  document.querySelectorAll("#requestsBody tr.row-highlighted").forEach((tr) => tr.classList.remove("row-highlighted"));
}

const HISTORY_CHANGE_LABELS = { create: "Created", update: "Updated", "bulk-update": "Bulk Updated", delete: "Deleted" };

// Fields that change on every save regardless of user intent -- not useful in a diff.
const HISTORY_DIFF_EXCLUDE = new Set(["created_at", "updated_at", "last_comment"]);

function formatHistoryValue(col, value) {
  if (value === null || value === undefined || value === "") return "\u2014";
  if (col.bool) return value ? "Yes" : "No";
  if (col.datetime) return formatCommentDate(value);
  const raw = String(value);
  return col.maxLen && raw.length > col.maxLen ? raw.slice(0, col.maxLen) + "\u2026" : raw;
}

function diffSnapshots(prev, curr, columns) {
  const changes = [];
  for (const col of columns) {
    if (HISTORY_DIFF_EXCLUDE.has(col.key)) continue;
    const before = prev ? prev[col.key] : undefined;
    const after = curr[col.key];
    const beforeNorm = before === undefined || before === null ? "" : String(before);
    const afterNorm = after === undefined || after === null ? "" : String(after);
    if (beforeNorm === afterNorm) continue;
    changes.push({ label: col.label, before: formatHistoryValue(col, before), after: formatHistoryValue(col, after) });
  }
  return changes;
}

function renderHistoryList(entries, listEl) {
  if (!entries.length) {
    listEl.innerHTML = `<div class="comment-empty">No history yet.</div>`;
    return;
  }
  const columns = activeColumns();
  listEl.innerHTML = entries
    .map((h, i) => {
      let snapshot = null;
      try { snapshot = JSON.parse(h.snapshot_json); } catch {}
      const older = entries[i + 1];
      let prevSnapshot = null;
      if (older) {
        try { prevSnapshot = JSON.parse(older.snapshot_json); } catch {}
      }
      // No older entry (first recorded state) or a delete -- nothing meaningful to diff.
      const changes = snapshot && older && h.change_type !== "delete" ? diffSnapshots(prevSnapshot, snapshot, columns) : [];
      const changesHtml = changes.length
        ? `<ul class="history-changes">${changes
            .map((c) => `<li><strong>${escapeHtml(c.label)}:</strong> ${escapeHtml(c.before)} &rarr; ${escapeHtml(c.after)}</li>`)
            .join("")}</ul>`
        : (h.change_type === "update" || h.change_type === "bulk-update")
          ? `<div class="history-nochange">No tracked field changes.</div>`
          : "";
      return `<div class="history-item">
      <div class="history-item-header">
        <span class="history-badge history-badge-${h.change_type}">${HISTORY_CHANGE_LABELS[h.change_type] || h.change_type}</span>
        <span class="comment-date">${escapeHtml(formatCommentDate(h.changed_at))}</span>
        ${h.changed_by ? `<span class="comment-author">&bull; ${escapeHtml(h.changed_by)}</span>` : `<span class="comment-author">&bull; unknown user</span>`}
      </div>
      ${changesHtml}
    </div>`;
    })
    .join("");
}

async function loadAndRenderHistory(recordId, listElId) {
  const el = document.getElementById(listElId);
  try {
    const entries = await api(`${activeApiBase()}/${recordId}/history`);
    if (el) renderHistoryList(entries, el);
  } catch {
    if (el) el.innerHTML = `<div class="comment-error">Could not load history.</div>`;
  }
}

function copyFieldButton(value) {
  if (!value) return "";
  return `<button type="button" class="copy-field-btn" data-copy-value="${escapeHtml(value)}" title="Copy" aria-label="Copy">\u2398</button>`;
}

function renderSlaSection(r) {
  if (!r.sla_flag) return "";
  const val = (v) => escapeHtml(v ?? "\u2014");
  const done = r.sla_state === "Done";
  const gap = r.sla_gap_days == null ? "\u2014" : r.sla_gap_days > 0 ? `${r.sla_gap_days} days after planned` : `${Math.abs(r.sla_gap_days)} days before planned`;
  const steps = (r.sla_breakdown || []).map((s) => `${escapeHtml(s.stage)} ${s.days}d`).join(" + ");
  return `
    <section class="view-section">
      <h3>SLA</h3>
      <dl class="view-grid">
        <div><dt>SLA Status</dt><dd>${renderSlaBadge(r.sla_flag)}</dd></div>
        <div><dt>SLA State</dt><dd>${val(r.sla_state)}</dd></div>
        <div><dt>Remaining (working days)</dt><dd>${done ? "\u2014" : val(r.sla_remaining_days)}</dd></div>
        <div><dt>Remaining Effort (man-days)</dt><dd>${done ? "\u2014" : val(r.sla_effort_days)}</dd></div>
        <div><dt>SLA Target Date</dt><dd>${val(r.sla_target_date)}</dd></div>
        <div><dt>Target vs Planned Go-Live</dt><dd>${escapeHtml(done ? "\u2014" : gap)}</dd></div>
        ${steps ? `<div class="full"><dt>Time by Stage (working days)</dt><dd>${steps}</dd></div>` : ""}
      </dl>
    </section>`;
}

function renderViewBody(r) {
  const isIncidents = state.screen === "incidents";
  const bool = (v) => v
    ? `<span class="view-badge view-badge-yes">Yes</span>`
    : `<span class="view-badge view-badge-no">No</span>`;
  const val = (v) => escapeHtml(v || "\u2014");
  const refLabel = isIncidents ? "Incident ID" : "BR No";
  const refVal = isIncidents ? r.incident_id : r.br_no;
  return `
    <section class="view-section">
      <h3>Basic Info</h3>
      <dl class="view-grid">
        <div><dt>${refLabel}</dt><dd class="view-copyable">${val(refVal)}${copyFieldButton(refVal)}</dd></div>
        <div><dt>CR</dt><dd class="view-copyable">${val(r.cr)}${copyFieldButton(r.cr)}</dd></div>
        ${!isIncidents ? `<div><dt>Submission Date</dt><dd>${val(r.submission_date)}</dd></div>` : ""}
        <div class="full"><dt>Title</dt><dd>${val(r.title)}</dd></div>
        <div><dt>Business Unit</dt><dd>${val(r.business_unit)}</dd></div>
        ${!isIncidents ? `<div><dt>Business Category</dt><dd>${val(r.business_category)}</dd></div>` : ""}
        <div><dt>Requester</dt><dd>${val(r.requester)}</dd></div>
        ${r.description ? `<div class="full"><dt>Description</dt><dd>${val(r.description)}</dd></div>` : ""}
      </dl>
    </section>
    <section class="view-section">
      <h3>Classification</h3>
      <dl class="view-grid">
        <div><dt>Priority</dt><dd>${val(r.priority)}</dd></div>
        <div><dt>Stage</dt><dd>${val(r.stage)}</dd></div>
        <div><dt>Status</dt><dd>${val(r.status)}</dd></div>
        <div class="full"><dt>System</dt><dd>${val(r.system)}</dd></div>
      </dl>
    </section>
    <section class="view-section">
      <h3>Flags &amp; Ownership</h3>
      <dl class="view-grid">
        <div><dt>Newgen Related</dt><dd>${bool(r.newgen_related)}</dd></div>
        <div><dt>Estimated</dt><dd>${bool(r.estimated)}</dd></div>
        ${!isIncidents ? `
        <div><dt>BA Required</dt><dd>${bool(r.ba_required)}</dd></div>
        <div><dt>BRD Assigned</dt><dd>${bool(r.brd_assigned)}</dd></div>
        ` : ""}
        <div><dt>Tech Owner</dt><dd>${val(r.tech_owner)}</dd></div>
        <div><dt>RM</dt><dd>${val(r.rm)}</dd></div>
        ${!isIncidents ? `
        <div><dt>Regulatory</dt><dd>${bool(r.regulatory)}</dd></div>
        ${r.regulatory ? `<div><dt>Regulator</dt><dd>${val(r.regulator)}</dd></div><div><dt>Regulatory Deadline</dt><dd>${val(r.regulatory_deadline)}</dd></div>` : ""}
        ` : ""}
      </dl>
    </section>
    <section class="view-section">
      <h3>Pipeline Dates</h3>
      <dl class="view-grid">
        ${!isIncidents ? `<div><dt>Analysis Planned Start</dt><dd>${val(r.analysis_planned_start_date)}</dd></div><div><dt>Analysis Planned End</dt><dd>${val(r.analysis_planned_end_date)}</dd></div>` : ""}
        <div><dt>Dev Planned Start</dt><dd>${val(r.dev_planned_start_date)}</dd></div>
        <div><dt>Dev Planned End</dt><dd>${val(r.dev_planned_end_date)}</dd></div>
        <div><dt>QA Planned Start</dt><dd>${val(r.qa_planned_start_date)}</dd></div>
        <div><dt>QA Planned End</dt><dd>${val(r.qa_planned_end_date)}</dd></div>
        <div><dt>UAT Planned Start</dt><dd>${val(r.uat_planned_start_date)}</dd></div>
        <div><dt>UAT Planned End</dt><dd>${val(r.uat_planned_date)}</dd></div>
        <div><dt>CAB Date</dt><dd>${val(r.cab_date)}</dd></div>
        <div><dt>Deployment Planned End</dt><dd>${val(r.deployment_planned_end_date)}</dd></div>
        <div><dt>Closed Date</dt><dd>${val(r.closed_date)}</dd></div>
      </dl>
    </section>
    ${renderSlaSection(r)}
    <section class="view-section">
      <h3>Record Info</h3>
      <dl class="view-grid">
        <div><dt>Created Date</dt><dd>${escapeHtml(formatCommentDate(r.created_at))}</dd></div>
        <div><dt>Created By</dt><dd>${val(r.created_by)}</dd></div>
        <div><dt>Last Updated</dt><dd>${escapeHtml(formatCommentDate(r.updated_at))}</dd></div>
        <div><dt>Updated By</dt><dd>${val(r.updated_by)}</dd></div>
      </dl>
    </section>
    <section class="view-section">
      <h3>Audit Trail</h3>
      <div class="history-list" id="viewHistoryList"><div class="comment-loading">Loading…</div></div>
    </section>
    <section class="view-section view-section-comments">
      <h3>Comments</h3>
      <div class="comment-list" id="viewCommentList"><div class="comment-loading">Loading…</div></div>
      <div class="comment-add">
        <textarea id="viewNewCommentText" placeholder="Write a comment… (Ctrl+Enter to post)" rows="2" maxlength="2000"></textarea>
        <button type="button" id="viewAddCommentBtn" class="btn btn-primary">Post</button>
      </div>
    </section>`;
}

// ---- Query screen ----

let schemaCache = null;
let lastQueryResult = null;

async function runQuery() {
  const sql = document.getElementById("queryInput").value.trim();
  if (!sql) return;
  const resultsEl = document.getElementById("queryResults");
  resultsEl.innerHTML = `<div class="query-running">Running…</div>`;
  lastQueryResult = null;
  try {
    const data = await api("/api/query", { method: "POST", body: JSON.stringify({ sql }) });
    lastQueryResult = data;
    renderQueryResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<div class="query-error">${escapeHtml(err.message)}</div>`;
  }
}

function renderQueryResults({ columns, rows, rowCount }) {
  const el = document.getElementById("queryResults");
  if (!rowCount) {
    el.innerHTML = `<div class="query-empty">Query returned no rows.</div>`;
    return;
  }
  const warning = rowCount > 500
    ? ` <span class="query-warning">&mdash; large result set, consider adding TOP (n)</span>`
    : "";
  el.innerHTML =
    `<div class="query-meta">${rowCount} row${rowCount !== 1 ? "s" : ""}${warning}` +
    `<button type="button" class="btn query-export-btn" title="Export to Excel">&#8595; Export</button></div>` +
    `<div class="query-table-wrap"><table class="query-table"><thead><tr>` +
    columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
    `</tr></thead><tbody>` +
    rows.map((r) =>
      `<tr>${columns.map((c) => {
        const v = r[c];
        return v == null
          ? `<td><span class="query-null">NULL</span></td>`
          : `<td>${escapeHtml(String(v))}</td>`;
      }).join("")}</tr>`
    ).join("") +
    `</tbody></table></div>`;
}

function exportQueryResults() {
  if (!lastQueryResult) return;
  const { columns, rows } = lastQueryResult;
  const exportCols = columns.map((c) => ({ key: c, label: c }));
  const xml = toSpreadsheetML(rows, exportCols).replace(
    /ss:Name="[^"]*"/,
    'ss:Name="Query Result"'
  );
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([xml], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ITRM-Query-${date}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}

async function toggleSchemaPanel() {
  const panel = document.getElementById("schemaPanel");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  if (!schemaCache) {
    document.getElementById("schemaPanelBody").innerHTML = `<div style="padding:10px 12px;color:var(--text-muted)">Loading…</div>`;
    panel.classList.remove("hidden");
    try {
      schemaCache = await api("/api/query/schema");
    } catch (err) {
      document.getElementById("schemaPanelBody").innerHTML = `<div style="padding:10px 12px;color:var(--danger)">${escapeHtml(err.message)}</div>`;
      return;
    }
  }
  document.getElementById("schemaPanelBody").innerHTML = schemaCache.tables.map((t) =>
    `<details class="schema-table"><summary class="schema-table-name">${escapeHtml(t.name)}</summary>` +
    `<ul class="schema-cols">${t.columns.map((c) =>
      `<li><span class="schema-col-name">${escapeHtml(c.name)}</span> <span class="schema-col-type">${escapeHtml(c.type)}</span></li>`
    ).join("")}</ul></details>`
  ).join("");
  panel.classList.remove("hidden");
}

// ---- Lookups management screen ----

const LOOKUP_LABELS = {
  "business-units": "Business Units",
  "business-categories": "Business Categories",
  priorities: "Priorities",
  stages: "Stages",
  statuses: "Statuses",
  "tech-owners": "Tech Owners",
  regulators: "Regulators",
  requesters: "Requesters",
  rms: "RMs",
  systems: "Systems",
};

let currentLookupType = "business-units";

function openLookupsScreen() {
  currentLookupType = "business-units";
  renderLookupTabs();
  selectLookupTab(currentLookupType);
  document.getElementById("lookupsOverlay").classList.remove("hidden");
  document.getElementById("lookupsModal").classList.remove("hidden");
  lockBodyScroll();
}

function closeLookupsScreen() {
  document.getElementById("lookupsOverlay").classList.add("hidden");
  document.getElementById("lookupsModal").classList.add("hidden");
  unlockBodyScroll();
}

function renderLookupTabs() {
  document.getElementById("lookupTabs").innerHTML = Object.entries(LOOKUP_LABELS)
    .map(([type, label]) => `<button class="lookup-tab${type === currentLookupType ? " active" : ""}" data-type="${type}">${escapeHtml(label)}</button>`)
    .join("");
}

function selectLookupTab(type) {
  currentLookupType = type;
  document.querySelectorAll(".lookup-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.type === type));
  document.getElementById("lookupNewName").value = "";
  renderLookupList(type);
}

function renderLookupList(type) {
  const items = state.lookups ? (state.lookups[type] || []) : [];
  const list = document.getElementById("lookupList");
  if (!items.length) {
    list.innerHTML = `<li class="lookup-empty">No items yet.</li>`;
    return;
  }
  list.innerHTML = items
    .map(
      (item) => `
    <li class="lookup-item" data-id="${item.id}">
      <span class="lookup-item-name">${escapeHtml(item.name)}</span>
      <div class="lookup-item-actions">
        <button class="btn btn-ghost lookup-edit-btn" data-id="${item.id}">Edit</button>
        <button class="btn btn-ghost lookup-delete-btn" data-id="${item.id}">Delete</button>
      </div>
    </li>`
    )
    .join("");
}

async function handleLookupAdd() {
  const input = document.getElementById("lookupNewName");
  const name = input.value.trim();
  if (!name) return;
  try {
    await api(`/api/lookups/${currentLookupType}`, { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    await loadLookups();
    renderLookupList(currentLookupType);
  } catch (err) {
    alert(err.message);
  }
}

function handleLookupEdit(type, id, currentName) {
  const li = document.querySelector(`#lookupList .lookup-item[data-id="${id}"]`);
  if (!li) return;
  li.innerHTML = `
    <input type="text" class="lookup-inline-input" value="${escapeHtml(currentName)}" maxlength="100" />
    <div class="lookup-item-actions">
      <button class="btn btn-primary lookup-save-btn" data-id="${id}">Save</button>
      <button class="btn btn-ghost lookup-cancel-btn">Cancel</button>
    </div>`;
  const input = li.querySelector(".lookup-inline-input");
  input.focus();
  input.select();
  li.querySelector(".lookup-save-btn").addEventListener("click", async () => {
    const newName = input.value.trim();
    if (!newName) return;
    try {
      await api(`/api/lookups/${type}/${id}`, { method: "PUT", body: JSON.stringify({ name: newName }) });
      await loadLookups();
      renderLookupList(type);
    } catch (err) {
      alert(err.message);
      renderLookupList(type);
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") li.querySelector(".lookup-save-btn").click();
    else if (e.key === "Escape") renderLookupList(type);
  });
  li.querySelector(".lookup-cancel-btn").addEventListener("click", () => renderLookupList(type));
}

async function handleLookupDelete(type, id, name) {
  if (!confirm(`Delete "${name}"?\n\nThis will fail if it is referenced by existing records.`)) return;
  try {
    await api(`/api/lookups/${type}/${id}`, { method: "DELETE" });
    await loadLookups();
    renderLookupList(type);
  } catch (err) {
    alert(err.message);
  }
}

// ---- SLA settings (assumptions editor) ----

const SLA_TABS = {
  stages: {
    label: "Stage times",
    hint: "Working days per stage for a medium-priority, normal-category case. A pipeline stage counts when the case is at or before it. A non-pipeline stage (e.g. Newgen vendor development, DMO triage) adds its own days, then continues after its order. Order 0 restarts at Analysis.",
  },
  priorities: {
    label: "Priority factors",
    hint: "Stage days are multiplied by the factor and rounded up (minimum 1 day). Response and update cadence are reference targets.",
  },
  categories: {
    label: "Category factors",
    hint: "Extra multiplier for business requests by business category. Incidents ignore it.",
  },
  statuses: {
    label: "Status handling",
    hint: "Done statuses have no remaining time. Paused statuses stop the SLA clock (the target is shown as if resumed today).",
  },
  general: { label: "General", hint: "Days that do not count as working days." },
};
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let slaCfg = null;
let slaTab = "stages";

const slaInput = (type, i, field, value, attrs = "") =>
  `<input type="${type}" data-row="${i}" data-field="${field}" value="${escapeHtml(value)}" ${attrs} />`;

function renderSlaSettingsTable() {
  const wrap = document.getElementById("slaTableWrap");
  const table = (heads, rows) =>
    `<table class="sla-table"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  const nameCell = (r) => `<td class="sla-name">${escapeHtml(r.name)}</td>`;

  if (slaTab === "stages") {
    wrap.innerHTML = table(
      ["Stage", "Order", "Pipeline", "Request days", "Incident days", "Effort (man-days)"],
      slaCfg.stages.map((r, i) => `<tr>${nameCell(r)}
        <td>${slaInput("number", i, "stage_order", r.stage_order, 'min="0" max="99" step="1"')}</td>
        <td><input type="checkbox" data-row="${i}" data-field="is_pipeline" ${r.is_pipeline ? "checked" : ""} /></td>
        <td>${slaInput("number", i, "br_days", r.br_days, 'min="0" max="365" step="1"')}</td>
        <td>${slaInput("number", i, "incident_days", r.incident_days, 'min="0" max="365" step="1"')}</td>
        <td>${slaInput("number", i, "effort_days", r.effort_days, 'min="0" max="999" step="0.5"')}</td></tr>`).join("")
    );
  } else if (slaTab === "priorities") {
    wrap.innerHTML = table(
      ["Priority", "Factor", "Response (business hours)", "Status update every (days)"],
      slaCfg.priorities.map((r, i) => `<tr>${nameCell(r)}
        <td>${slaInput("number", i, "factor", r.factor, 'min="0.1" max="10" step="0.05"')}</td>
        <td>${slaInput("number", i, "response_hours", r.response_hours, 'min="0" max="999" step="0.5"')}</td>
        <td>${slaInput("number", i, "update_days", r.update_days, 'min="0" max="365" step="1"')}</td></tr>`).join("")
    );
  } else if (slaTab === "categories") {
    wrap.innerHTML = table(
      ["Business category", "Factor"],
      slaCfg.categories.map((r, i) => `<tr>${nameCell(r)}
        <td>${slaInput("number", i, "factor", r.factor, 'min="0.1" max="10" step="0.05"')}</td></tr>`).join("")
    );
  } else if (slaTab === "statuses") {
    wrap.innerHTML = table(
      ["Status", "SLA state"],
      slaCfg.statuses.map((r, i) => `<tr>${nameCell(r)}<td><select data-row="${i}" data-field="state">${
        ["Active", "Paused", "Done"].map((s) => `<option ${s === r.state ? "selected" : ""}>${s}</option>`).join("")
      }</select></td></tr>`).join("")
    );
  } else {
    const weekend = new Set(slaCfg.settings.weekend_days);
    wrap.innerHTML = `<div class="sla-weekend"><strong>Weekend days</strong>${WEEKDAY_NAMES.map((n, d) =>
      `<label><input type="checkbox" data-weekday="${d}" ${weekend.has(d) ? "checked" : ""} /> ${n}</label>`).join("")}</div>`;
  }
}

function renderSlaTabs() {
  document.getElementById("slaTabs").innerHTML = Object.entries(SLA_TABS)
    .map(([key, t]) => `<button class="lookup-tab${key === slaTab ? " active" : ""}" data-tab="${key}">${escapeHtml(t.label)}</button>`)
    .join("");
  document.getElementById("slaTabHint").textContent = SLA_TABS[slaTab].hint;
  renderSlaSettingsTable();
}

function showSlaErrors(messages) {
  const el = document.getElementById("slaErrors");
  el.innerHTML = messages.map((m) => `<div>${escapeHtml(m)}</div>`).join("");
  el.classList.toggle("hidden", !messages.length);
}

async function openSlaSettings() {
  try {
    slaCfg = await api("/api/sla/config");
  } catch (err) {
    alert("Could not load SLA settings: " + err.message);
    return;
  }
  slaTab = "stages";
  showSlaErrors([]);
  renderSlaTabs();
  document.getElementById("slaSettingsOverlay").classList.remove("hidden");
  document.getElementById("slaSettingsModal").classList.remove("hidden");
  lockBodyScroll();
}

function closeSlaSettings() {
  document.getElementById("slaSettingsOverlay").classList.add("hidden");
  document.getElementById("slaSettingsModal").classList.add("hidden");
  unlockBodyScroll();
}

async function applySlaConfigResult(cfg) {
  slaCfg = cfg;
  renderSlaTabs();
  await loadData();
}

async function saveSlaSettings() {
  showSlaErrors([]);
  try {
    await applySlaConfigResult(await api("/api/sla/config", { method: "PUT", body: JSON.stringify(slaCfg) }));
    closeSlaSettings();
  } catch (err) {
    showSlaErrors(err.errors || [err.message]);
  }
}

async function resetSlaSettings() {
  if (!confirm("Reset all SLA assumptions to the built-in defaults?")) return;
  try {
    await applySlaConfigResult(await api("/api/sla/config/reset", { method: "POST", body: "{}" }));
  } catch (err) {
    showSlaErrors([err.message]);
  }
}

function wireSlaSettings() {
  document.getElementById("slaSettingsBtn").addEventListener("click", openSlaSettings);
  document.getElementById("closeSlaSettingsBtn").addEventListener("click", closeSlaSettings);
  document.getElementById("slaSettingsOverlay").addEventListener("click", closeSlaSettings);
  document.getElementById("slaSaveBtn").addEventListener("click", saveSlaSettings);
  document.getElementById("slaResetBtn").addEventListener("click", resetSlaSettings);
  document.getElementById("slaTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".lookup-tab");
    if (!btn) return;
    slaTab = btn.dataset.tab;
    renderSlaTabs();
  });
  document.getElementById("slaTableWrap").addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.weekday !== undefined) {
      const days = new Set(slaCfg.settings.weekend_days);
      if (el.checked) days.add(Number(el.dataset.weekday));
      else days.delete(Number(el.dataset.weekday));
      slaCfg.settings.weekend_days = [...days].sort();
      return;
    }
    if (el.dataset.row === undefined) return;
    const row = slaCfg[slaTab][Number(el.dataset.row)];
    const field = el.dataset.field;
    if (el.type === "checkbox") row[field] = el.checked ? 1 : 0;
    else if (el.type === "number") row[field] = el.value === "" ? "" : Number(el.value);
    else row[field] = el.value;
  });
}

// ---- Export to Excel (SpreadsheetML, no external dependencies) ----

function xmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#10;");
}

function getExportCols(mode) {
  const isIncidents = state.screen === "incidents";
  const allCols = isIncidents ? INCIDENT_EXPORT_COLUMNS : EXPORT_COLUMNS;
  if (mode === "all") return allCols;
  const tableCols = activeColumns();
  return tableCols
    .filter((c) => state.visibleCols.has(c.key))
    .map((c) => c.key === "last_comment" ? { key: "all_comments", label: "Comments" } : { key: c.key, label: c.label, bool: c.bool });
}

function toSpreadsheetML(rows, columns) {
  const headerRow = `    <Row>\n${columns.map((c) =>
    `      <Cell ss:StyleID="h"><Data ss:Type="String">${xmlEscape(c.label)}</Data></Cell>`).join("\n")}\n    </Row>`;

  const dataRows = rows.map((r) => `    <Row>\n${columns.map((c) => {
    const raw = c.bool ? (r[c.key] ? "Yes" : "No") : (r[c.key] ?? "");
    const style = c.key === "all_comments" ? ` ss:StyleID="wrap"` : "";
    return `      <Cell${style}><Data ss:Type="String">${xmlEscape(raw)}</Data></Cell>`;
  }).join("\n")}\n    </Row>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n  <Styles>\n    <Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#E8EAED" ss:Pattern="Solid"/></Style>\n    <Style ss:ID="wrap"><Alignment ss:WrapText="1" ss:Vertical="Top"/></Style>\n  </Styles>\n  <Worksheet ss:Name="${state.screen === "incidents" ? "Incidents" : "Business Requests"}">\n    <Table>\n${headerRow}\n${dataRows}\n    </Table>\n  </Worksheet>\n</Workbook>`;
}

function getTableCopyCellValue(row, col) {
  if (col.bool) return row[col.key] ? "Yes" : "No";
  if (col.datetime) return formatCommentDate(row[col.key]);
  const key = col.key === "all_comments" ? "last_comment" : col.key;
  const raw = row[key] != null ? String(row[key]) : "";
  return col.maxLen && raw.length > col.maxLen ? raw.substring(0, col.maxLen) + "…" : raw;
}

function toClipboardSafeText(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function buildTableCopyText(mode) {
  const cols = mode === "all"
    ? (state.screen === "incidents" ? INCIDENT_EXPORT_COLUMNS : EXPORT_COLUMNS)
    : activeColumns().filter((c) => state.visibleCols.has(c.key));
  const rows = applySorting(applyFilters(activeData()));
  const header = cols.map((c) => toClipboardSafeText(c.label)).join("\t");
  const dataRows = rows.map((row) =>
    cols.map((col) => toClipboardSafeText(getTableCopyCellValue(row, col))).join("\t")
  );
  return { text: [header, ...dataRows].join("\n"), count: rows.length };
}

function fallbackCopyText(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("Clipboard copy is blocked.");
}

async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    fallbackCopyText(text);
  }
}

function wireViewCopyButtons() {
  document.querySelectorAll("#viewPanelBody .copy-field-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await copyToClipboard(btn.dataset.copyValue);
        const oldText = btn.textContent;
        btn.textContent = "\u2713";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = oldText; btn.classList.remove("copied"); }, 1200);
      } catch (err) {
        alert("Copy failed: " + err.message);
      }
    });
  });
}

async function handleCopyDisplayedTable(mode = "displayed") {
  const { text, count } = buildTableCopyText(mode);
  if (!count) {
    alert("No rows to copy.");
    return;
  }

  try {
    await copyToClipboard(text);

    const btn = document.getElementById("copyTableBtn");
    const oldText = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = oldText;
    }, 1200);
  } catch (err) {
    alert("Copy failed: " + err.message);
  }
}

async function handleExport(mode) {
  document.getElementById("exportDropdown").classList.add("hidden");
  try {
    const exportUrl = state.screen === "incidents" ? "/api/incidents/export" : "/api/export";
    const allData = await api(exportUrl);
    const filtered = applyFilters(allData);
    const cols = getExportCols(mode);
    const xml = toSpreadsheetML(filtered, cols);
    const date = new Date().toISOString().slice(0, 10);
    const prefix = state.screen === "incidents" ? "ITRM-Incidents" : "ITRM-Requests";
    const blob = new Blob([xml], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${prefix}-${date}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export failed: " + err.message);
  }
}

function wireEvents() {
  document.getElementById("newRequestBtn").addEventListener("click", () => openForm(null));
  document.getElementById("closeFormBtn").addEventListener("click", closeForm);
  document.getElementById("overlay").addEventListener("click", closeForm);
  document.getElementById("requestForm").addEventListener("submit", handleSubmit);
  document.getElementById("deleteBtn").addEventListener("click", handleDelete);

  document.querySelectorAll(".pipeline-date").forEach((el) => el.addEventListener("change", validatePipelineDatesClientSide));
  document.querySelectorAll(".btn-add").forEach((btn) => btn.addEventListener("click", () => handleAddLookup(btn.dataset.lookup)));
  Object.keys(FIELD_DEPENDENCIES).forEach((id) => {
    document.getElementById(id).addEventListener("change", () => syncFormFieldStates(true));
  });

  document.getElementById("requestsBody").addEventListener("click", (e) => {
    if (e.target.closest(".row-select-checkbox")) return;
    const followBtn = e.target.closest(".row-follow");
    if (followBtn) {
      const id = Number(followBtn.dataset.id);
      toggleFollow(entityType(), id, !followBtn.classList.contains("following"));
      return;
    }
    const editBtn = e.target.closest(".row-edit");
    if (editBtn) {
      const record = activeData().find((r) => String(r.id) === editBtn.dataset.id);
      if (record) openForm(record);
      return;
    }
    const row = e.target.closest("tr[data-id]");
    if (row) {
      const request = activeData().find((r) => String(r.id) === row.dataset.id);
      if (request) {
        document.querySelectorAll("#requestsBody tr.row-highlighted").forEach((tr) => tr.classList.remove("row-highlighted"));
        row.classList.add("row-highlighted");
        openViewPanel(request);
      }
    }
  });

  document.getElementById("requestsBody").addEventListener("change", (e) => {
    const checkbox = e.target.closest(".row-select-checkbox");
    if (!checkbox) return;
    const id = Number(checkbox.dataset.id);
    if (checkbox.checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
    updateBulkActionsBar();
    syncSelectAllCheckbox(applySorting(applyFilters(activeData())));
  });

  document.querySelector("#requestsTable thead").addEventListener("change", (e) => {
    if (e.target.id !== "selectAllCheckbox") return;
    const rows = applySorting(applyFilters(activeData()));
    if (e.target.checked) rows.forEach((r) => state.selectedIds.add(r.id));
    else rows.forEach((r) => state.selectedIds.delete(r.id));
    renderTable();
  });

  document.getElementById("bulkEditBtn").addEventListener("click", openBulkEditModal);
  document.getElementById("bulkClearBtn").addEventListener("click", clearSelection);
  document.getElementById("bulkEmailBtn").addEventListener("click", openEmailModal);
  document.getElementById("closeEmailBtn").addEventListener("click", closeEmailModal);
  document.getElementById("emailOverlay").addEventListener("click", closeEmailModal);
  document.getElementById("emailCancelBtn").addEventListener("click", closeEmailModal);
  document.getElementById("emailOpenBtn").addEventListener("click", handleEmailOpenInOutlook);
  document.getElementById("emailCopyBtn").addEventListener("click", handleEmailCopyTable);
  document.getElementById("closeBulkEditBtn").addEventListener("click", closeBulkEditModal);
  document.getElementById("bulkEditOverlay").addEventListener("click", closeBulkEditModal);
  document.getElementById("bulkEditCancelBtn").addEventListener("click", closeBulkEditModal);
  document.getElementById("bulkEditApplyBtn").addEventListener("click", handleBulkEditApply);

  document.getElementById("searchInput").addEventListener("input", () => { updateClearFiltersBtn(); renderTable(); });
  document.getElementById("clearFiltersBtn").addEventListener("click", clearFilters);
  document.getElementById("viewToggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".view-toggle-btn");
    if (!btn || btn.dataset.view === state.viewMode) return;
    state.viewMode = btn.dataset.view;
    state.selectedIds.clear();
    renderTable();
  });
  document.getElementById("staleFilterBtn").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
    updateClearFiltersBtn();
    renderTable();
  });
  document.getElementById("flagFiltersSection").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-flag-btn");
    if (!btn) return;
    btn.classList.toggle("active");
    updateClearFiltersBtn();
    renderTable();
  });

  // Saved filters
  document.getElementById("savedFiltersTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = document.getElementById("savedFiltersDropdown");
    if (dd.classList.contains("hidden")) { renderSavedFiltersList(); dd.classList.remove("hidden"); }
    else dd.classList.add("hidden");
  });
  document.getElementById("savedFiltersDropdown").addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("saveFilterBtn").addEventListener("click", () => saveCurrentFilter(document.getElementById("savedFilterName").value));
  document.getElementById("savedFilterName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCurrentFilter(document.getElementById("savedFilterName").value);
  });
  document.getElementById("savedFiltersList").addEventListener("click", (e) => {
    const applyBtn = e.target.closest(".saved-filter-apply");
    const delBtn = e.target.closest(".saved-filter-delete");
    if (applyBtn) {
      const entry = loadSavedFilters()[Number(applyBtn.dataset.index)];
      if (entry) { applyFilterState(entry.state); document.getElementById("savedFiltersDropdown").classList.add("hidden"); }
    } else if (delBtn) {
      deleteSavedFilter(Number(delBtn.dataset.index));
    }
  });

  document.querySelectorAll(".multi-select-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const dropdown = trigger.nextElementSibling;
      const isOpen = !dropdown.classList.contains("hidden");
      document.querySelectorAll(".multi-select-dropdown").forEach((d) => d.classList.add("hidden"));
      if (!isOpen) {
        dropdown.classList.remove("hidden");
        const s = dropdown.querySelector(".multi-select-search");
        if (s) { resetDropdownSearch(trigger.closest(".multi-select").id); s.focus(); }
      }
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".multi-select-dropdown").forEach((d) => d.classList.add("hidden"));
    document.querySelectorAll(".form-combo-dropdown").forEach((d) => d.classList.add("hidden"));
    document.getElementById("colConfigDropdown").classList.add("hidden");
    document.getElementById("densityDropdown").classList.add("hidden");
    document.getElementById("exportDropdown").classList.add("hidden");
    document.getElementById("savedFiltersDropdown").classList.add("hidden");
  });
  document.querySelectorAll(".multi-select-dropdown").forEach((dropdown) => {
    dropdown.addEventListener("click", (e) => {
      e.stopPropagation();
      const actionBtn = e.target.closest(".ms-action");
      if (!actionBtn) return;
      e.preventDefault(); // stop the enclosing <label> from also toggling its checkbox
      const id = dropdown.closest(".multi-select").id;
      const value = actionBtn.closest(".multi-select-option").querySelector("input[type=checkbox]").value;
      if (actionBtn.dataset.action === "only") setMultiSelectOnly(id, value);
      else setMultiSelectExclude(id, value);
      updateMultiSelectTrigger(id);
      updateClearFiltersBtn();
      renderTable();
    });
    dropdown.addEventListener("input", (e) => {
      if (e.target.matches(".multi-select-search")) {
        const term = e.target.value.toLowerCase();
        dropdown.querySelectorAll(".multi-select-option").forEach((opt) => {
          const label = opt.querySelector(".multi-select-option-label").textContent.toLowerCase();
          opt.style.display = label.includes(term) ? "" : "none";
        });
      }
    });
    dropdown.addEventListener("change", (e) => {
      if (e.target.matches("input[type=checkbox]")) {
        const msEl = dropdown.closest(".multi-select");
        updateMultiSelectTrigger(msEl.id);
        if (!msEl.classList.contains("form-multi-select")) {
          updateClearFiltersBtn();
          renderTable();
        }
      }
    });
  });

  // Form combo dropdowns (searchable selects for BU, Requester, Tech Owner)
  document.querySelectorAll(".form-combo").forEach((combo) => {
    const input = combo.querySelector(".form-combo-input");
    const dropdown = combo.querySelector(".form-combo-dropdown");
    const hidden = combo.querySelector(".form-combo-value");

    combo.addEventListener("click", (e) => e.stopPropagation());

    input.addEventListener("focus", () => {
      input.select();
      dropdown.querySelectorAll(".form-combo-option").forEach((o) => (o.style.display = ""));
      dropdown.classList.remove("hidden");
    });

    input.addEventListener("input", () => {
      const term = input.value.toLowerCase();
      dropdown.querySelectorAll(".form-combo-option").forEach((opt) => {
        opt.style.display = !opt.dataset.value || opt.textContent.toLowerCase().includes(term) ? "" : "none";
      });
      dropdown.classList.remove("hidden");
    });

    dropdown.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus on input so blur fires after we set value
      const opt = e.target.closest(".form-combo-option");
      if (!opt) return;
      hidden.value = opt.dataset.value;
      input.value = opt.dataset.value ? opt.textContent : "";
      dropdown.classList.add("hidden");
      dropdown.querySelectorAll(".form-combo-option").forEach((o) => (o.style.display = ""));
    });

    input.addEventListener("blur", () => {
      setTimeout(() => {
        dropdown.classList.add("hidden");
        dropdown.querySelectorAll(".form-combo-option").forEach((o) => (o.style.display = ""));
        const match = [...dropdown.querySelectorAll(".form-combo-option")].find((o) => o.dataset.value === hidden.value);
        input.value = match && hidden.value ? match.textContent : "";
      }, 150);
    });
  });

  // Form panel comments
  document.getElementById("addCommentBtn").addEventListener("click", () => {
    if (state.editingId) handleAddComment(state.editingId, "form");
  });
  document.getElementById("newCommentText").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && state.editingId) handleAddComment(state.editingId, "form");
  });

  // View panel
  document.getElementById("viewEditBtn").addEventListener("click", () => {
    const record = activeData().find((r) => r.id === state.viewingId);
    closeViewPanel();
    if (record) openForm(record);
  });
  document.getElementById("viewFollowBtn").addEventListener("click", (e) => {
    const type = entityType();
    toggleFollow(type, state.viewingId, !e.currentTarget.classList.contains("following"));
  });
  document.getElementById("formFollowBtn").addEventListener("click", (e) => {
    const type = entityType();
    toggleFollow(type, state.editingId, !e.currentTarget.classList.contains("following"));
  });
  document.getElementById("closeViewBtn").addEventListener("click", closeViewPanel);
  document.getElementById("viewOverlay").addEventListener("click", closeViewPanel);

  // Export
  document.getElementById("exportTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("exportDropdown").classList.toggle("hidden");
  });
  document.getElementById("exportDropdown").addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = e.target.closest(".export-option");
    if (btn) handleExport(btn.dataset.mode);
  });
  document.getElementById("copyTableBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("copyDropdown").classList.toggle("hidden");
  });
  document.getElementById("copyDropdown").addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = e.target.closest(".copy-option");
    if (btn) {
      document.getElementById("copyDropdown").classList.add("hidden");
      handleCopyDisplayedTable(btn.dataset.mode);
    }
  });

  // Table header sort
  document.querySelector("#requestsTable thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort-key]");
    if (!th) return;
    const key = th.dataset.sortKey;
    state.sort.dir = state.sort.key === key && state.sort.dir === "asc" ? "desc" : "asc";
    state.sort.key = key;
    renderTableHeader();
    renderTable();
  });

  // Row density
  document.getElementById("densityTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("densityDropdown").classList.toggle("hidden");
  });
  document.getElementById("densityDropdown").addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.matches('input[name="density"]')) {
      applyDensity(e.target.value);
      document.getElementById("densityDropdown").classList.add("hidden");
    }
  });

  // Column config
  document.getElementById("colConfigTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("colConfigDropdown").classList.toggle("hidden");
  });
  document.getElementById("colConfigDropdown").addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("colConfigDropdown").addEventListener("change", (e) => {
    if (!e.target.matches("input[type=checkbox]")) return;
    if (e.target.checked) state.visibleCols.add(e.target.value);
    else state.visibleCols.delete(e.target.value);
    saveColumnPrefs();
    renderTableHeader();
    renderTable();
  });

  // Screen tabs
  document.querySelectorAll(".screen-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchScreen(tab.dataset.screen));
  });

  // Query screen
  document.getElementById("runQueryBtn").addEventListener("click", runQuery);
  document.getElementById("queryInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); }
  });
  document.getElementById("schemaToggleBtn").addEventListener("click", toggleSchemaPanel);
  document.getElementById("schemaPanelClose").addEventListener("click", () => {
    document.getElementById("schemaPanel").classList.add("hidden");
  });
  document.getElementById("queryResults").addEventListener("click", (e) => {
    if (e.target.closest(".query-export-btn")) exportQueryResults();
  });

  // Lookups screen
  document.getElementById("manageLookupsBtn").addEventListener("click", openLookupsScreen);
  document.getElementById("closeLookupsBtn").addEventListener("click", closeLookupsScreen);
  document.getElementById("lookupsOverlay").addEventListener("click", closeLookupsScreen);
  document.getElementById("lookupAddBtn").addEventListener("click", handleLookupAdd);
  document.getElementById("lookupNewName").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLookupAdd(); });
  document.getElementById("lookupTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".lookup-tab");
    if (tab) selectLookupTab(tab.dataset.type);
  });
  document.getElementById("lookupList").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".lookup-edit-btn");
    const deleteBtn = e.target.closest(".lookup-delete-btn");
    if (editBtn) {
      const id = editBtn.dataset.id;
      const item = (state.lookups[currentLookupType] || []).find((i) => String(i.id) === id);
      if (item) handleLookupEdit(currentLookupType, id, item.name);
    } else if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      const item = (state.lookups[currentLookupType] || []).find((i) => String(i.id) === id);
      handleLookupDelete(currentLookupType, id, item ? item.name : "this item");
    }
  });

  wireImportWizard();
  wireFollowupEvents();
  wireMyFollowupsEvents();
  wireDashboardEvents();
  wireSlaSettings();
}

// Heartbeat: poll /healthz every 20 s and show/hide the connection-lost banner
(function startHeartbeat() {
  const banner = document.getElementById("dbLostBanner");
  let lost = false;
  async function ping() {
    try {
      const res = await fetch("/healthz");
      if (res.ok) {
        if (lost) { lost = false; banner.classList.add("hidden"); await loadData(); }
      } else {
        throw new Error("not ok");
      }
    } catch {
      if (!lost) { lost = true; banner.classList.remove("hidden"); }
    }
  }
  setInterval(ping, 20_000);
})();

// =====================================================================
//  Authentication
// =====================================================================

function showLoginScreen() {
  document.body.classList.add("unauthenticated");
  document.getElementById("loginScreen").classList.remove("hidden");
}

function hideLoginScreen() {
  document.body.classList.remove("unauthenticated");
  document.getElementById("loginScreen").classList.add("hidden");
}

function applyCurrentUser(user) {
  state.currentUser = user;
  document.body.classList.toggle("read-only", user.role !== "read_write");
  document.getElementById("currentUserName").textContent =
    `${user.name} (${user.role === "read_write" ? "Read/Write" : "Read Only"})`;
}

async function fetchCurrentUser() {
  try {
    const res = await fetch("/api/auth/me", { headers: { "Content-Type": "application/json" } });
    if (!res.ok) return null;
    return (await res.json()).user;
  } catch {
    return null;
  }
}

function wireAuthEvents() {
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorEl = document.getElementById("loginError");
    errorEl.classList.add("hidden");
    try {
      const { user } = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      document.getElementById("loginForm").reset();
      applyCurrentUser(user);
      hideLoginScreen();
      await startApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    location.reload();
  });

  document.getElementById("changePasswordBtn").addEventListener("click", openChangePasswordModal);
  document.getElementById("closeChangePasswordBtn").addEventListener("click", closeChangePasswordModal);
  document.getElementById("changePasswordCancelBtn").addEventListener("click", closeChangePasswordModal);
  document.getElementById("changePasswordOverlay").addEventListener("click", closeChangePasswordModal);
  document.getElementById("changePasswordForm").addEventListener("submit", handleChangePassword);
}

function openChangePasswordModal() {
  document.getElementById("changePasswordForm").reset();
  document.getElementById("changePasswordErrors").classList.add("hidden");
  document.getElementById("changePasswordSuccess").classList.add("hidden");
  document.getElementById("changePasswordOverlay").classList.remove("hidden");
  document.getElementById("changePasswordModal").classList.remove("hidden");
  lockBodyScroll();
}

function closeChangePasswordModal() {
  document.getElementById("changePasswordOverlay").classList.add("hidden");
  document.getElementById("changePasswordModal").classList.add("hidden");
  unlockBodyScroll();
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmNewPassword = document.getElementById("confirmNewPassword").value;
  const errorsEl = document.getElementById("changePasswordErrors");
  const successEl = document.getElementById("changePasswordSuccess");
  errorsEl.classList.add("hidden");
  successEl.classList.add("hidden");

  if (newPassword !== confirmNewPassword) {
    errorsEl.textContent = "New password and confirmation do not match.";
    errorsEl.classList.remove("hidden");
    return;
  }

  try {
    await api("/api/auth/me/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.getElementById("changePasswordForm").reset();
    successEl.classList.remove("hidden");
  } catch (err) {
    errorsEl.textContent = err.errors ? err.errors.join(" ") : err.message;
    errorsEl.classList.remove("hidden");
  }
}

(async function bootstrap() {
  wireAuthEvents();
  const user = await fetchCurrentUser();
  if (user) {
    applyCurrentUser(user);
    await startApp();
  } else {
    showLoginScreen();
  }
})();

async function startApp() {
  state.visibleCols = loadColumnPrefs();
  renderTableHeader();
  renderColConfigDropdown();
  wireEvents();
  applyDensity(loadDensityPref());
  await loadLookups();
  await loadFollowedIds();
  await loadRequests();
  state.incidentVisibleCols = (() => {
    const saved = (() => { try { return JSON.parse(localStorage.getItem(INCIDENT_COLS_STORAGE_KEY)); } catch { return null; } })();
    return new Set(Array.isArray(saved) ? saved : INCIDENT_TABLE_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));
  })();
}

// =====================================================================
//  Import & Merge Wizard
// =====================================================================

const IMPORT_STEP_LABELS = [
  "Upload", "Auto-detect", "Map columns", "Preview",
  "Compare", "Differences", "Decide", "Merge", "Summary",
];

const IMPORT = {
  step: 1,
  target: "business_requests",
  fileName: "",
  fileType: "",
  headers: [],
  rows: [],
  fieldMeta: null,     // /api/import/fields response
  mapping: {},
  records: [],
  summary: null,
  decisions: {},       // rowIndex -> 'insert' | 'update' | 'skip'
  result: null,
  historyView: false,
  error: "",
};

function targetFields() {
  return (IMPORT.fieldMeta && IMPORT.fieldMeta[IMPORT.target] && IMPORT.fieldMeta[IMPORT.target].fields) || [];
}
function targetKeyFields() {
  return (IMPORT.fieldMeta && IMPORT.fieldMeta[IMPORT.target] && IMPORT.fieldMeta[IMPORT.target].idKeys) || [];
}
function mappedFieldDefs() {
  return targetFields().filter((f) => IMPORT.mapping[f.field]);
}

function el(id) { return document.getElementById(id); }

async function openImportWizard() {
  if (!IMPORT.fieldMeta) {
    try { IMPORT.fieldMeta = await api("/api/import/fields"); }
    catch (err) { alert("Could not load import configuration: " + err.message); return; }
  }
  resetImportState();
  el("importOverlay").classList.remove("hidden");
  el("importModal").classList.remove("hidden");
  lockBodyScroll();
  renderImport();
}

function resetImportState() {
  IMPORT.step = 1;
  IMPORT.fileName = "";
  IMPORT.fileType = "";
  IMPORT.headers = [];
  IMPORT.rows = [];
  IMPORT.mapping = {};
  IMPORT.records = [];
  IMPORT.summary = null;
  IMPORT.decisions = {};
  IMPORT.result = null;
  IMPORT.historyView = false;
  IMPORT.error = "";
}

function closeImportWizard() {
  el("importOverlay").classList.add("hidden");
  el("importModal").classList.add("hidden");
  unlockBodyScroll();
}

function gotoImportStep(n) {
  IMPORT.step = n;
  IMPORT.error = "";
  renderImport();
}

function renderImport() {
  if (IMPORT.historyView) { renderImportHistory(); return; }
  el("importSteps").classList.remove("hidden");
  document.querySelector(".import-footer").classList.remove("hidden");
  renderImportSteps();
  renderImportBody();
  updateImportFooter();
}

function renderImportSteps() {
  el("importSteps").innerHTML = IMPORT_STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n === IMPORT.step ? "active" : n < IMPORT.step ? "done" : "";
    const badge = n < IMPORT.step ? "\u2713" : n;
    return `<li class="import-step ${cls}"><span class="import-step-num">${badge}</span>${escapeHtml(label)}</li>`;
  }).join("");
}

function updateImportFooter() {
  const back = el("importBackBtn");
  const next = el("importNextBtn");
  const info = el("importFooterInfo");
  const s = IMPORT.step;

  back.classList.toggle("hidden", s === 1);
  back.textContent = s === 9 ? "Start Another" : "Back";

  next.classList.remove("hidden");
  next.textContent = s === 9 ? "Close" : s === 3 ? "Analyze \u2192" : s === 8 ? "Perform Merge" : "Next \u2192";
  next.disabled = s === 1 && IMPORT.rows.length === 0;

  info.textContent = importFooterInfo();
}

function importFooterInfo() {
  if (IMPORT.step === 1) return IMPORT.fileName ? `${IMPORT.fileName} \u2014 ${IMPORT.rows.length} row(s)` : "Choose an .xlsx or .csv file to continue";
  if (IMPORT.step === 5 && IMPORT.summary) {
    const s = IMPORT.summary;
    return `${s.new} new \u00b7 ${s.update} to update \u00b7 ${s.duplicate} duplicate \u00b7 ${s.invalid} invalid`;
  }
  return "";
}

// ---- Step rendering ----

function renderImportBody() {
  const body = el("importBody");
  const errHtml = IMPORT.error ? `<div class="import-error-box">${escapeHtml(IMPORT.error)}</div>` : "";
  const renderers = {
    1: renderImportStep1, 2: renderImportStep2, 3: renderImportStep3,
    4: renderImportStep4, 5: renderImportStep5, 6: renderImportStep6,
    7: renderImportStep7, 8: renderImportStep8, 9: renderImportStep9,
  };
  body.innerHTML = errHtml + (renderers[IMPORT.step] ? renderers[IMPORT.step]() : "");
  wireImportStep();
}

function stepHeader(title, desc) {
  return `<div class="import-step-title">${escapeHtml(title)}</div><p class="import-step-desc">${escapeHtml(desc)}</p>`;
}

function renderImportStep1() {
  const targets = IMPORT.fieldMeta;
  const choices = Object.entries(targets).map(([key, def]) =>
    `<label class="${IMPORT.target === key ? "selected" : ""}">
      <input type="radio" name="importTarget" value="${key}" ${IMPORT.target === key ? "checked" : ""} />
      <span>${escapeHtml(def.label)}</span>
    </label>`).join("");

  const chip = IMPORT.fileName
    ? `<div class="import-file-chip">\uD83D\uDCC4 <strong>${escapeHtml(IMPORT.fileName)}</strong> \u2014 ${IMPORT.rows.length} row(s), ${IMPORT.headers.length} column(s)</div>`
    : "";

  return stepHeader("Upload a file", "Choose what you're importing, then select an Excel (.xlsx) or CSV file.") +
    `<div class="import-target-choice">${choices}</div>
     <div id="importDropzone" class="import-dropzone">
       <div class="import-dropzone-icon">\u2601</div>
       <div class="import-dropzone-main">Drop your file here or click to browse</div>
       <div class="import-dropzone-sub">Supported formats: .xlsx and .csv</div>
       <input type="file" id="importFileInput" accept=".xlsx,.csv,.txt" hidden />
     </div>
     ${chip}`;
}

function renderMappingTable(editable) {
  const sample = IMPORT.rows[0] || {};
  const keyFields = new Set(targetKeyFields().map((k) => k.field));
  const options = (selected) =>
    `<option value="">\u2014 not mapped \u2014</option>` +
    IMPORT.headers.map((h) => `<option value="${escapeHtml(h)}" ${h === selected ? "selected" : ""}>${escapeHtml(h)}</option>`).join("");

  const rows = targetFields().map((f) => {
    const mappedHeader = IMPORT.mapping[f.field] || "";
    const sampleVal = mappedHeader ? String(sample[mappedHeader] ?? "") : "";
    const keyBadge = keyFields.has(f.field) ? `<span class="import-map-key-badge">KEY</span>` : "";
    const reqMark = f.required ? ` <span class="req">*</span>` : "";
    const colCell = editable
      ? `<select data-map-field="${f.field}">${options(mappedHeader)}</select>`
      : (mappedHeader
          ? `<span class="import-map-status matched">\u2713 ${escapeHtml(mappedHeader)}</span>`
          : `<span class="import-map-status unmatched">\u2014 not detected</span>`);
    return `<tr>
      <td class="import-map-field">${escapeHtml(f.label)}${reqMark}${keyBadge}</td>
      <td>${colCell}</td>
      <td class="import-map-sample" title="${escapeHtml(sampleVal)}">${escapeHtml(sampleVal)}</td>
    </tr>`;
  }).join("");

  return `<div class="import-preview-wrap"><table class="import-map-table">
    <thead><tr><th>Target field</th><th>${editable ? "Mapped column" : "Detected column"}</th><th>Sample</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderImportStep2() {
  const matched = targetFields().filter((f) => IMPORT.mapping[f.field]).length;
  return stepHeader("Auto-detected columns",
    `We matched ${matched} of ${targetFields().length} fields from your file headers. Review below, then adjust on the next step if needed.`) +
    renderMappingTable(false);
}

function renderImportStep3() {
  return stepHeader("Map columns", "Adjust how uploaded columns map to fields. Key fields are used to match existing records; Title is required to insert new records.") +
    renderMappingTable(true);
}

function renderImportStep4() {
  const defs = mappedFieldDefs();
  if (!defs.length) return stepHeader("Preview records", "No columns are mapped yet.") + `<div class="import-empty">Go back and map at least one column.</div>`;
  const shown = IMPORT.rows.slice(0, 100);
  const head = defs.map((f) => `<th>${escapeHtml(f.label)}</th>`).join("");
  const bodyRows = shown.map((row) => {
    const cells = defs.map((f) => {
      const v = String(row[IMPORT.mapping[f.field]] ?? "");
      return `<td title="${escapeHtml(v)}">${escapeHtml(v)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  const more = IMPORT.rows.length > shown.length ? `<p class="import-step-desc">Showing first ${shown.length} of ${IMPORT.rows.length} rows.</p>` : "";
  return stepHeader("Preview records", `Review the ${IMPORT.rows.length} record(s) as they will be read from the file.`) +
    `<div class="import-preview-wrap"><table class="import-preview-table"><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>${more}`;
}

function summaryCards(cards) {
  return `<div class="import-summary-cards">` + cards.map((c) =>
    `<div class="import-summary-card ${c.cls}"><div class="num">${c.num}</div><div class="lbl">${escapeHtml(c.lbl)}</div></div>`).join("") + `</div>`;
}

function renderImportStep5() {
  const s = IMPORT.summary || { new: 0, update: 0, duplicate: 0, invalid: 0 };
  const cards = summaryCards([
    { cls: "new", num: s.new, lbl: "New records" },
    { cls: "update", num: s.update, lbl: "To update" },
    { cls: "dup", num: s.duplicate, lbl: "Duplicates" },
    { cls: "invalid", num: s.invalid, lbl: "Invalid" },
  ]);
  const rows = IMPORT.records.map((r) => `
    <tr>
      <td>${escapeHtml(r.key || "\u2014")}</td>
      <td class="import-map-sample" title="${escapeHtml(r.title || "")}">${escapeHtml(r.title || "")}</td>
      <td><span class="outcome-badge outcome-${r.outcome}">${outcomeLabel(r.outcome)}</span></td>
      <td>${r.matchedBy ? "matched by " + escapeHtml(r.matchedBy) : (r.errors && r.errors.length ? escapeHtml(r.errors.join(" ")) : "")}</td>
    </tr>`).join("");
  return stepHeader("Compare against existing data", "Each row is matched against existing records using the key fields.") +
    cards +
    `<div class="import-review-wrap"><table class="import-review-table">
      <thead><tr><th>Key</th><th>Title</th><th>Result</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function renderImportStep6() {
  const updates = IMPORT.records.filter((r) => r.outcome === "update");
  if (!updates.length) {
    return stepHeader("Differences", "No changes to existing records were detected.") +
      `<div class="import-empty">Nothing to compare \u2014 all matched rows are identical, or all rows are new.</div>`;
  }
  const cards = updates.map((r) => {
    const diffRows = r.diffs.map((d) => `
      <div class="import-diff-row">
        <span class="import-diff-label">${escapeHtml(d.label)}</span>
        <span class="import-diff-current">${d.current ? escapeHtml(d.current) : "<span class=\"import-diff-empty\">(empty)</span>"}</span>
        <span class="import-diff-arrow">\u2192</span>
        <span class="import-diff-uploaded">${d.uploaded ? escapeHtml(d.uploaded) : "<span class=\"import-diff-empty\">(empty)</span>"}</span>
      </div>`).join("");
    const newLk = r.newLookups && r.newLookups.length
      ? `<div class="import-newlookup-note">New lookup value(s) will be created: ${escapeHtml(r.newLookups.map((n) => n.name).join(", "))}</div>` : "";
    return `<div class="import-diff-card">
      <div class="import-diff-card-head">
        <span class="import-diff-card-key">${escapeHtml(r.key || "\u2014")}</span>
        <span class="import-diff-card-title">${escapeHtml(r.title || "")}</span>
        <span class="outcome-badge outcome-update">Update</span>
      </div>
      <div class="import-diff-rows">${diffRows}</div>${newLk}
    </div>`;
  }).join("");
  return stepHeader("Differences", `${updates.length} record(s) will change. Current value \u2192 uploaded value.`) + cards;
}

function decisionButtons(r) {
  const canInsert = r.outcome === "new";
  const canUpdate = !!r.entityId;
  const isInvalid = r.outcome === "invalid";
  const cur = IMPORT.decisions[r.rowIndex];
  const btn = (act, label, enabled) =>
    `<button data-decide="${act}" data-row="${r.rowIndex}" class="${cur === act ? "active" : ""}" ${enabled ? "" : "disabled"}>${label}</button>`;
  return `<div class="import-decision-actions">
    ${btn("insert", "Insert New", canInsert && !isInvalid)}
    ${btn("update", "Update", canUpdate && !isInvalid)}
    ${btn("skip", "Skip", true)}
  </div>`;
}

function renderImportStep7() {
  const rows = IMPORT.records.map((r) => `
    <tr class="import-decision-row">
      <td>${escapeHtml(r.key || "\u2014")}</td>
      <td class="import-map-sample" title="${escapeHtml(r.title || "")}">${escapeHtml(r.title || "")}</td>
      <td><span class="outcome-badge outcome-${r.outcome}">${outcomeLabel(r.outcome)}</span></td>
      <td>${decisionButtons(r)}</td>
    </tr>`).join("");
  return stepHeader("Decide what to do", "Choose an action per record. Defaults follow the comparison; adjust as needed.") +
    `<div class="import-bulk-bar">
      <span class="import-step-desc" style="margin:0">Bulk:</span>
      <button type="button" class="btn" data-bulk="suggested">Use suggested</button>
      <button type="button" class="btn" data-bulk="insert">Insert all new</button>
      <button type="button" class="btn" data-bulk="update">Update all matched</button>
      <button type="button" class="btn" data-bulk="skip">Skip all</button>
    </div>
    <div class="import-review-wrap"><table class="import-review-table">
      <thead><tr><th>Key</th><th>Title</th><th>Result</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function decisionCounts() {
  const c = { insert: 0, update: 0, skip: 0 };
  for (const r of IMPORT.records) {
    const a = IMPORT.decisions[r.rowIndex] || "skip";
    c[a] = (c[a] || 0) + 1;
  }
  return c;
}

function renderImportStep8() {
  const c = decisionCounts();
  const cards = summaryCards([
    { cls: "new", num: c.insert, lbl: "Will insert" },
    { cls: "update", num: c.update, lbl: "Will update" },
    { cls: "dup", num: c.skip, lbl: "Will skip" },
  ]);
  return stepHeader("Perform merge", "Review the plan below, then click \u201CPerform Merge\u201D to apply changes. Missing lookup values will be created automatically.") +
    cards +
    `<p class="import-step-desc">Importing into <strong>${escapeHtml(IMPORT.fieldMeta[IMPORT.target].label)}</strong> from <strong>${escapeHtml(IMPORT.fileName)}</strong>. This will be recorded in the import history.</p>`;
}

function renderImportStep9() {
  const r = IMPORT.result;
  if (!r) return `<div class="import-empty">No result.</div>`;
  const s = r.summary;
  const cards = summaryCards([
    { cls: "new", num: s.new, lbl: "New records" },
    { cls: "update", num: s.updated, lbl: "Updated" },
    { cls: "dup", num: s.duplicate, lbl: "Duplicates" },
    { cls: "dup", num: s.skipped, lbl: "Skipped" },
    { cls: "invalid", num: s.invalid, lbl: "Invalid" },
    { cls: "error", num: s.error, lbl: "Errors" },
  ]);
  let errorsHtml = "";
  if (r.errors && r.errors.length) {
    errorsHtml = `<div class="import-error-box"><strong>${r.errors.length} error(s):</strong><ul style="margin:6px 0 0;padding-left:18px">` +
      r.errors.map((e) => `<li>Row ${e.rowIndex + 1}${e.key ? " (" + escapeHtml(e.key) + ")" : ""}: ${escapeHtml(e.message)}</li>`).join("") +
      `</ul></div>`;
  }
  return stepHeader("Import complete", "Here's what happened. A full record has been saved to the import history.") +
    cards + errorsHtml +
    `<p class="import-step-desc">Batch #${r.batchId} \u00b7 ${s.total} row(s) processed.</p>`;
}

function outcomeLabel(o) {
  return { new: "New", update: "Update", duplicate: "Duplicate", invalid: "Invalid", error: "Error", skipped: "Skipped", updated: "Updated" }[o] || o;
}

// ---- Per-step wiring ----

function wireImportStep() {
  if (IMPORT.step === 1) wireImportStep1();
  else if (IMPORT.step === 3) wireImportStep3();
  else if (IMPORT.step === 7) wireImportStep7();
}

function wireImportStep1() {
  document.querySelectorAll('input[name="importTarget"]').forEach((radio) => {
    radio.addEventListener("change", async () => {
      IMPORT.target = radio.value;
      // Re-suggest mapping if a file is already loaded.
      if (IMPORT.headers.length) await reparseMapping();
      renderImportBody();
      updateImportFooter();
    });
  });
  const dz = el("importDropzone");
  const input = el("importFileInput");
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]);
  });
  input.addEventListener("change", () => { if (input.files[0]) handleImportFile(input.files[0]); });
}

function wireImportStep3() {
  document.querySelectorAll("[data-map-field]").forEach((sel) => {
    sel.addEventListener("change", () => {
      IMPORT.mapping[sel.dataset.mapField] = sel.value || null;
    });
  });
}

function wireImportStep7() {
  el("importBody").querySelectorAll("[data-decide]").forEach((btn) => {
    btn.addEventListener("click", () => {
      IMPORT.decisions[Number(btn.dataset.row)] = btn.dataset.decide;
      renderImportBody();
    });
  });
  el("importBody").querySelectorAll("[data-bulk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyBulkDecision(btn.dataset.bulk);
      renderImportBody();
    });
  });
}

function applyBulkDecision(kind) {
  for (const r of IMPORT.records) {
    if (kind === "suggested") IMPORT.decisions[r.rowIndex] = r.suggestedAction;
    else if (kind === "skip") IMPORT.decisions[r.rowIndex] = "skip";
    else if (kind === "insert") IMPORT.decisions[r.rowIndex] = r.outcome === "new" ? "insert" : "skip";
    else if (kind === "update") IMPORT.decisions[r.rowIndex] = r.entityId ? "update" : (r.suggestedAction);
  }
}

// ---- Async operations ----

async function handleImportFile(file) {
  IMPORT.fileName = file.name;
  IMPORT.error = "";
  setImportBusy("Reading file\u2026");
  try {
    const b64 = await readFileAsBase64(file);
    IMPORT.fileB64 = b64;
    const resp = await api("/api/import/parse", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentBase64: b64, target: IMPORT.target }),
    });
    IMPORT.fileType = resp.fileType;
    IMPORT.headers = resp.headers;
    IMPORT.rows = resp.rows;
    IMPORT.mapping = resp.suggestedMapping || {};
    if (!IMPORT.rows.length) IMPORT.error = "No data rows were found in the file.";
  } catch (err) {
    IMPORT.headers = []; IMPORT.rows = [];
    IMPORT.error = err.message;
  }
  renderImportBody();
  updateImportFooter();
}

async function reparseMapping() {
  // Re-derive the suggested mapping for the newly chosen target.
  if (!IMPORT.fileB64) return;
  try {
    const resp = await api("/api/import/parse", {
      method: "POST",
      body: JSON.stringify({ filename: IMPORT.fileName, contentBase64: IMPORT.fileB64, target: IMPORT.target }),
    });
    IMPORT.mapping = resp.suggestedMapping || {};
  } catch { /* keep existing mapping on failure */ }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(",") + 1)); };
    fr.onerror = () => reject(new Error("Could not read the file."));
    fr.readAsDataURL(file);
  });
}

function validateMapping() {
  const titleMapped = !!IMPORT.mapping.title;
  const keyMapped = targetKeyFields().some((k) => IMPORT.mapping[k.field]);
  if (!titleMapped && !keyMapped) {
    IMPORT.error = "Map at least the Title field (to insert) or a key field like " +
      targetKeyFields().map((k) => k.label).join(" / ") + " (to match existing records).";
    renderImportBody();
    return false;
  }
  return true;
}

async function runImportAnalyze() {
  setImportBusy("Analyzing records against existing data\u2026");
  const resp = await api("/api/import/analyze", {
    method: "POST",
    body: JSON.stringify({ target: IMPORT.target, mapping: IMPORT.mapping, rows: IMPORT.rows }),
  });
  IMPORT.records = resp.records;
  IMPORT.summary = resp.summary;
  IMPORT.decisions = {};
  for (const r of resp.records) IMPORT.decisions[r.rowIndex] = r.suggestedAction;
}

async function runImportCommit() {
  setImportBusy("Merging records\u2026");
  const resp = await api("/api/import/commit", {
    method: "POST",
    body: JSON.stringify({
      target: IMPORT.target,
      filename: IMPORT.fileName,
      fileType: IMPORT.fileType,
      mapping: IMPORT.mapping,
      rows: IMPORT.rows,
      decisions: IMPORT.decisions,
    }),
  });
  IMPORT.result = resp;
  await loadLookups();
  await loadData();
}

function setImportBusy(msg) {
  el("importBody").innerHTML = `<div class="import-busy">${escapeHtml(msg)}</div>`;
  el("importNextBtn").disabled = true;
  el("importBackBtn").disabled = true;
}

async function importNext() {
  const s = IMPORT.step;
  try {
    if (s === 1) { if (IMPORT.rows.length) gotoImportStep(2); }
    else if (s === 2) gotoImportStep(3);
    else if (s === 3) { if (!validateMapping()) return; await runImportAnalyze(); gotoImportStep(4); }
    else if (s === 4) gotoImportStep(5);
    else if (s === 5) gotoImportStep(6);
    else if (s === 6) gotoImportStep(7);
    else if (s === 7) gotoImportStep(8);
    else if (s === 8) { await runImportCommit(); gotoImportStep(9); }
    else if (s === 9) closeImportWizard();
  } catch (err) {
    IMPORT.error = err.message;
    renderImport();
  } finally {
    el("importNextBtn").disabled = false;
    el("importBackBtn").disabled = false;
  }
}

function importBack() {
  if (IMPORT.step === 9) { resetImportState(); renderImport(); return; }
  if (IMPORT.step > 1) gotoImportStep(IMPORT.step - 1);
}

// ---- Import history ----

async function showImportHistory() {
  IMPORT.historyView = true;
  IMPORT.historyDetail = null;
  el("importSteps").classList.add("hidden");
  document.querySelector(".import-footer").classList.add("hidden");
  el("importBody").innerHTML = `<div class="import-busy">Loading history\u2026</div>`;
  try {
    IMPORT.historyList = await api("/api/import/history");
  } catch (err) {
    el("importBody").innerHTML = `<div class="import-error-box">${escapeHtml(err.message)}</div>`;
    return;
  }
  renderImportHistory();
}

function renderImportHistory() {
  el("importSteps").classList.add("hidden");
  document.querySelector(".import-footer").classList.add("hidden");
  const body = el("importBody");

  if (IMPORT.historyDetail) { renderImportHistoryDetail(); return; }

  const list = IMPORT.historyList || [];
  const rows = list.map((b) => `
    <tr class="import-history-row" data-batch="${b.id}">
      <td>${escapeHtml(formatCommentDate(b.created_at))}</td>
      <td>${escapeHtml(b.filename || "\u2014")}</td>
      <td>${escapeHtml(b.target === "incidents" ? "Incidents" : "Business Requests")}</td>
      <td><div class="import-history-counts">
        <span class="outcome-badge outcome-new">${b.new_count} new</span>
        <span class="outcome-badge outcome-update">${b.updated_count} upd</span>
        <span class="outcome-badge outcome-duplicate">${b.duplicate_count} dup</span>
        <span class="outcome-badge outcome-invalid">${b.invalid_count} inv</span>
        <span class="outcome-badge outcome-error">${b.error_count} err</span>
      </div></td>
    </tr>`).join("");
  const table = list.length
    ? `<div class="import-review-wrap"><table class="import-history-table">
        <thead><tr><th>When</th><th>File</th><th>Target</th><th>Outcome</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : `<div class="import-empty">No imports yet.</div>`;

  body.innerHTML = stepHeader("Import history", "Every import is recorded here. Click a batch to see per-row details.") +
    `<button type="button" class="btn import-history-back" id="importHistExit">\u2190 Back to wizard</button>` + table;

  el("importHistExit").addEventListener("click", exitImportHistory);
  body.querySelectorAll(".import-history-row").forEach((tr) => {
    tr.addEventListener("click", () => openImportHistoryDetail(Number(tr.dataset.batch)));
  });
}

async function openImportHistoryDetail(id) {
  el("importBody").innerHTML = `<div class="import-busy">Loading batch\u2026</div>`;
  try {
    IMPORT.historyDetail = await api(`/api/import/history/${id}`);
  } catch (err) {
    el("importBody").innerHTML = `<div class="import-error-box">${escapeHtml(err.message)}</div>`;
    return;
  }
  renderImportHistoryDetail();
}

function renderImportHistoryDetail() {
  const d = IMPORT.historyDetail;
  const b = d.batch;
  const cards = summaryCards([
    { cls: "new", num: b.new_count, lbl: "New" },
    { cls: "update", num: b.updated_count, lbl: "Updated" },
    { cls: "dup", num: b.duplicate_count, lbl: "Duplicate" },
    { cls: "dup", num: b.skipped_count, lbl: "Skipped" },
    { cls: "invalid", num: b.invalid_count, lbl: "Invalid" },
    { cls: "error", num: b.error_count, lbl: "Errors" },
  ]);
  const rows = d.rows.map((row) => {
    let detail = "";
    if (row.message) detail = escapeHtml(row.message);
    else if (row.diff_json) {
      try { detail = JSON.parse(row.diff_json).map((x) => `${x.label}: ${x.current || "\u2205"} \u2192 ${x.uploaded || "\u2205"}`).join("; "); }
      catch { detail = ""; }
      detail = escapeHtml(detail);
    }
    return `<tr>
      <td>${row.row_index + 1}</td>
      <td>${escapeHtml(row.key_value || "\u2014")}</td>
      <td class="import-map-sample" title="${escapeHtml(row.title || "")}">${escapeHtml(row.title || "")}</td>
      <td><span class="outcome-badge outcome-${row.outcome}">${outcomeLabel(row.outcome)}</span></td>
      <td class="import-map-sample" title="${detail}">${detail}</td>
    </tr>`;
  }).join("");

  el("importBody").innerHTML =
    stepHeader(`Batch #${b.id}`, `${escapeHtml(b.filename || "")} \u00b7 ${escapeHtml(formatCommentDate(b.created_at))}`) +
    `<button type="button" class="btn import-history-back" id="importHistDetailBack">\u2190 Back to history</button>` +
    cards +
    `<div class="import-review-wrap"><table class="import-review-table">
      <thead><tr><th>#</th><th>Key</th><th>Title</th><th>Outcome</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;

  el("importHistDetailBack").addEventListener("click", () => { IMPORT.historyDetail = null; renderImportHistory(); });
}

function exitImportHistory() {
  IMPORT.historyView = false;
  IMPORT.historyDetail = null;
  renderImport();
}

function wireImportWizard() {
  el("importBtn").addEventListener("click", openImportWizard);
  el("closeImportBtn").addEventListener("click", closeImportWizard);
  el("importOverlay").addEventListener("click", closeImportWizard);
  el("importHistoryBtn").addEventListener("click", () => {
    if (IMPORT.historyView) exitImportHistory();
    else showImportHistory();
  });
  el("importNextBtn").addEventListener("click", importNext);
  el("importBackBtn").addEventListener("click", importBack);
}
