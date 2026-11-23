// Server-side validation, mirroring the rules built into the original Excel tracker.
// Never trust the browser alone -- this is the authoritative check.

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DATE = "2020-01-01";
const MAX_DATE = "2035-12-31";

function isValidDateString(s) {
  if (!s || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}

/**
 * Validate the pipeline date fields against BOTH neighbors (the stage before
 * and after), the same two-sided rule as the spreadsheet's data validation.
 * A neighbor that is blank is skipped, so fields can be filled out of order.
 * Returns an array of human-readable error strings (empty = valid).
 */
function validatePipelineDates(body, fields = PIPELINE_FIELDS) {
  const errors = [];

  for (const { key, label } of fields) {
    const value = body[key];
    if (value === undefined || value === null || value === "") continue;

    if (!isValidDateString(value)) {
      errors.push(`${label} must be a valid date (YYYY-MM-DD).`);
      continue;
    }
    if (value < MIN_DATE || value > MAX_DATE) {
      errors.push(`${label} must be between ${MIN_DATE} and ${MAX_DATE}.`);
    }
  }

  for (let i = 0; i < fields.length; i++) {
    const { key, label } = fields[i];
    const value = body[key];
    if (!isValidDateString(value)) continue;

    if (i > 0) {
      const prev = fields[i - 1];
      const prevValue = body[prev.key];
      if (isValidDateString(prevValue) && value < prevValue) {
        errors.push(`${label} must be on or after ${prev.label}.`);
      }
    }
    if (i < fields.length - 1) {
      const next = fields[i + 1];
      const nextValue = body[next.key];
      if (isValidDateString(nextValue) && value > nextValue) {
        errors.push(`${label} must be on or before ${next.label}.`);
      }
    }
  }

  return errors;
}

function validateSimpleDate(body, key, label) {
  const value = body[key];
  if (value === undefined || value === null || value === "") return [];
  if (!isValidDateString(value)) return [`${label} must be a valid date (YYYY-MM-DD).`];
  if (value < MIN_DATE || value > MAX_DATE) {
    return [`${label} must be between ${MIN_DATE} and ${MAX_DATE}.`];
  }
  return [];
}

function validateRegulatoryDeadline(body) {
  return validateSimpleDate(body, "regulatory_deadline", "Regulatory Deadline");
}

function validateClosedDate(body) {
  return validateSimpleDate(body, "closed_date", "Closed Date");
}

function validateBusinessRequest(body) {
  const errors = [];
  if (!body.title || !String(body.title).trim()) {
    errors.push("Title is required.");
  }
  errors.push(...validateSimpleDate(body, "submission_date", "Submission Date"));
  errors.push(...validateRegulatoryDeadline(body));
  errors.push(...validateClosedDate(body));
  errors.push(...validatePipelineDates(body));
  return errors;
}

const INCIDENT_PIPELINE_FIELDS = PIPELINE_FIELDS.filter(
  (f) => f.key !== "analysis_planned_start_date" && f.key !== "analysis_planned_end_date"
);

function validateIncident(body) {
  const errors = [];
  if (!body.title || !String(body.title).trim()) {
    errors.push("Title is required.");
  }
  errors.push(...validateClosedDate(body));
  errors.push(...validatePipelineDates(body, INCIDENT_PIPELINE_FIELDS));
  return errors;
}

module.exports = { validateBusinessRequest, validateIncident, isValidDateString, PIPELINE_FIELDS, INCIDENT_PIPELINE_FIELDS };
