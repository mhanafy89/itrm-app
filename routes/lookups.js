const { query, queryOne, isUniqueViolation, isReferenceViolation } = require("../db/database");
const { sendJson, parseId } = require("../lib/http-helpers");

const LOOKUP_TABLES = {
  "business-units": "business_units",
  "business-categories": "business_categories",
  priorities: "priorities",
  stages: "stages",
  statuses: "statuses",
  "tech-owners": "tech_owners",
  "ba-owners": "ba_owners",
  regulators: "regulators",
  requesters: "requesters",
  rms: "rms",
  systems: "systems",
};

const HAS_SORT_ORDER = new Set(["priorities", "stages", "statuses"]);

async function list(req, res) {
  const entries = Object.entries(LOOKUP_TABLES);
  const results = await Promise.all(
    entries.map(([, table]) => {
      const orderBy = HAS_SORT_ORDER.has(table) ? "sort_order, name" : "name";
      return query(`SELECT id, name FROM ${table} ORDER BY ${orderBy}`);
    })
  );
  const out = {};
  entries.forEach(([urlKey], i) => (out[urlKey] = results[i].rows));
  sendJson(res, 200, out);
}

async function create(req, res, params, body) {
  const table = LOOKUP_TABLES[params.type];
  if (!table) return sendJson(res, 404, { error: "Unknown lookup type." });

  const name = (body.name || "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required." });

  try {
    const { id } = await queryOne(`INSERT INTO ${table} (name) OUTPUT INSERTED.id VALUES (@name)`, { name });
    sendJson(res, 201, { id, name });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return sendJson(res, 409, { error: `"${name}" already exists.` });
    }
    sendJson(res, 500, { error: "Could not add lookup value." });
  }
}

async function update(req, res, params, body) {
  const table = LOOKUP_TABLES[params.type];
  if (!table) return sendJson(res, 404, { error: "Unknown lookup type." });

  const name = (body.name || "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required." });

  const id = parseId(params.id);
  try {
    const { rowsAffected } = id ? await query(`UPDATE ${table} SET name = @name WHERE id = @id`, { name, id }) : { rowsAffected: 0 };
    if (rowsAffected === 0) return sendJson(res, 404, { error: "Not found." });
    sendJson(res, 200, { id, name });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return sendJson(res, 409, { error: `"${name}" already exists.` });
    }
    sendJson(res, 500, { error: "Could not update lookup value." });
  }
}

async function remove(req, res, params) {
  const table = LOOKUP_TABLES[params.type];
  if (!table) return sendJson(res, 404, { error: "Unknown lookup type." });

  const id = parseId(params.id);
  try {
    const { rowsAffected } = id ? await query(`DELETE FROM ${table} WHERE id = @id`, { id }) : { rowsAffected: 0 };
    if (rowsAffected === 0) return sendJson(res, 404, { error: "Not found." });
    res.writeHead(204).end();
  } catch (err) {
    if (isReferenceViolation(err)) {
      return sendJson(res, 409, { error: "This value is still used by existing records and can't be deleted." });
    }
    sendJson(res, 500, { error: "Could not delete lookup value." });
  }
}

function register(router) {
  router.get("/api/lookups", list);
  router.post("/api/lookups/:type", create);
  router.put("/api/lookups/:type/:id", update);
  router.delete("/api/lookups/:type/:id", remove);
}

module.exports = { register };
