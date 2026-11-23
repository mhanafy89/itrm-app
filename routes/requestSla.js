// Stage-driven SLA endpoints. Request ids are the business_requests ids used everywhere else; the
// /api/business-requests/:id/... aliases keep the naming of the existing routes available.
//
//   GET  /api/requests/:id/sla              live SLA status (current stage headline + request roll-up + every stage)
//   POST /api/requests/:id/stage-status     { stage, status, plannedEffort?, actualEffortDays?, note? }
//   GET  /api/requests/:id/sla/history      audit trail: status changes, stage moves, hold periods
//   GET  /api/sla/dashboard                 stage- and request-level metrics (?priority=&stage=&health=)
//
// POST needs read/write access: server.js already requires it for every non-GET /api/ call.
const { sendJson, parseId } = require("../lib/http-helpers");
const { resolveChangedBy } = require("../lib/current-user");
const { SlaError, getDefaultService } = require("../lib/sla-service");

// Maps service errors to { errors: [...] } responses (same shape as the other validation failures).
function guard(handler) {
  return async (req, res, params, body) => {
    try {
      await handler(req, res, params, body);
    } catch (err) {
      if (err instanceof SlaError) return sendJson(res, err.statusCode, { errors: err.errors });
      throw err;
    }
  };
}

function createHandlers(getService) {
  const requestId = (params) => {
    const id = parseId(params.id);
    if (!id) throw new SlaError(404, ["Request not found."]);
    return id;
  };

  return {
    getSla: guard(async (req, res, params) => {
      sendJson(res, 200, await getService().getRequestSla(requestId(params)));
    }),

    updateStageStatus: guard(async (req, res, params, body) => {
      const id = requestId(params);
      const user = resolveChangedBy(req, body && body.changed_by);
      sendJson(res, 200, await getService().updateStageStatus(id, body, user));
    }),

    history: guard(async (req, res, params) => {
      sendJson(res, 200, await getService().getHistory(requestId(params)));
    }),

    dashboard: guard(async (req, res) => {
      const q = new URL(req.url, "http://localhost").searchParams;
      sendJson(res, 200, await getService().getDashboard({
        priority: q.get("priority") || undefined,
        stage: q.get("stage") || undefined,
        health: q.get("health") || undefined,
      }));
    }),
  };
}

// `getService` is injectable so integration tests can run the real routes against an in-memory repository.
function register(router, getService = getDefaultService) {
  const h = createHandlers(getService);
  for (const base of ["/api/requests", "/api/business-requests"]) {
    router.get(`${base}/:id/sla`, h.getSla);
    router.post(`${base}/:id/stage-status`, h.updateStageStatus);
    router.get(`${base}/:id/sla/history`, h.history);
  }
  router.get("/api/sla/dashboard", h.dashboard);
}

module.exports = { register, createHandlers };
