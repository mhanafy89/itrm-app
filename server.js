const http = require("http");
const path = require("path");
const url = require("url");

const { init, query } = require("./db/database");
const Router = require("./lib/router");
const { sendJson, readJsonBody, serveStatic } = require("./lib/http-helpers");
const { getSessionUser } = require("./lib/auth");
const { getDefaultService } = require("./lib/sla-service");

const router = new Router();
require("./routes/auth").register(router);
require("./routes/businessRequests").register(router);
require("./routes/incidents").register(router);
require("./routes/lookups").register(router);
require("./routes/sla").register(router);
require("./routes/requestSla").register(router);
require("./routes/query").register(router);
require("./routes/import").register(router);
router.get("/healthz", async (req, res) => {
  try {
    await query("SELECT 1 AS ok");
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 503, { ok: false, error: err.message });
  }
});

const PUBLIC_DIR = path.join(__dirname, "public");

// Routes any logged-in user (even read-only) may call despite being POST/PUT/DELETE:
// logging out, running a read-only SQL query, the preview-only import steps
// (the actual write happens in /api/import/commit), and changing your own password.
const WRITE_EXEMPT_ROUTES = new Set([
  "POST /api/auth/logout",
  "PUT /api/auth/me/password",
  "POST /api/query",
  "POST /api/import/parse",
  "POST /api/import/analyze",
]);
// Prefixes that require read/write access on every method (e.g. GET included) because they manage accounts.
const WRITE_ONLY_PREFIXES = ["/api/auth/users"];
// Following/unfollowing is a per-user bookmark, not a change to the shared record, so it's
// allowed for read-only users too even though it's a POST/DELETE.
const FOLLOW_ROUTE_RE = /\/follow$/;
// Posting a comment is explicitly allowed for read-only users too (deleting one is not).
const ADD_COMMENT_RE = /\/comments$/;

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (pathname.startsWith("/api/") && !(req.method === "POST" && pathname === "/api/auth/login")) {
    const user = await getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Authentication required." });
    req.user = user;

    const mutating = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
    const forceWrite = WRITE_ONLY_PREFIXES.some((p) => pathname.startsWith(p));
    const isFollowToggle = FOLLOW_ROUTE_RE.test(pathname) && (req.method === "POST" || req.method === "DELETE");
    const isAddComment = req.method === "POST" && ADD_COMMENT_RE.test(pathname);
    const needsWrite =
      !isFollowToggle && !isAddComment && (forceWrite || (mutating && !WRITE_EXEMPT_ROUTES.has(`${req.method} ${pathname}`)));
    if (needsWrite && user.role !== "read_write") {
      return sendJson(res, 403, { error: "Read-only access: write operations are not permitted." });
    }
  }

  const match = router.match(req.method, pathname);
  if (match) {
    try {
      let body = {};
      if (req.method === "POST" || req.method === "PUT") {
        // Import uploads carry base64 file payloads, so allow a larger body.
        const maxBytes = pathname.startsWith("/api/import") ? 30 * 1024 * 1024 : undefined;
        body = await readJsonBody(req, maxBytes);
      }
      await match.handler(req, res, match.params, body);
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message || "Internal server error." });
    }
    return;
  }

  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    return serveStatic(PUBLIC_DIR, pathname, res);
  }

  sendJson(res, 404, { error: "Not found." });
});

const PORT = process.env.PORT || 3000;

// Create tables if they don't exist yet (safe on every start), then accept traffic.
init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`ITRM Tracker app listening on http://localhost:${PORT}`);
    });
    // Existing requests get their per-stage SLA tracking created once (idempotent; skipped when none are missing).
    if (process.env.SLA_BACKFILL_ON_START !== "false") {
      getDefaultService()
        .backfillMissing()
        .then(({ total, created }) => total && console.log(`SLA tracking created for ${created}/${total} existing requests.`))
        .catch((err) => console.error("SLA backfill failed:", err.message));
    }
  })
  .catch((err) => {
    console.error("Could not initialize the SQL Server database:", err.message);
    process.exit(1);
  });
