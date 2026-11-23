const { query } = require("../db/database");
const { sendJson } = require("../lib/http-helpers");

// Keywords that must never appear in console queries (anything that writes, executes code or reaches outside the DB).
const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|into|grant|revoke|deny|backup|restore|shutdown|kill|waitfor|openrowset|opendatasource|openquery|openjson|bulk|dbcc|use|declare|set)\b|\bxp_|\bsp_/i;

// Returns an error message, or null when the statement is acceptable.
function checkReadOnly(sql) {
  if (!/^(select|with)\b/i.test(sql)) return "Only SELECT queries are allowed.";
  // Drop string literals and quoted identifiers so their contents can't trigger (or hide) anything.
  const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\[[^\]]*\]|"[^"]*"/g, "[]");
  if (code.includes("--") || code.includes("/*")) return "Comments are not allowed in queries.";
  if (code.replace(/;\s*$/, "").includes(";")) return "Multiple statements are not allowed.";
  if (FORBIDDEN.test(code)) return "Only read-only SELECT queries are allowed.";
  return null;
}

function register(router) {
  // Execute a read-only SELECT query and return rows + column names.
  router.post("/api/query", async (req, res, _params, body) => {
    const sql = (body.sql || "").trim();
    if (!sql) return sendJson(res, 400, { error: "No query provided." });

    const problem = checkReadOnly(sql);
    if (problem) return sendJson(res, 400, { error: problem });

    try {
      const { rows } = await query(sql.replace(/;\s*$/, ""));
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return sendJson(res, 200, { columns, rows, rowCount: rows.length });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  });

  // Return the database schema (table names + columns) for the schema browser.
  router.get("/api/query/schema", async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
                c.CHARACTER_MAXIMUM_LENGTH AS max_length
         FROM INFORMATION_SCHEMA.COLUMNS c
         JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
         WHERE t.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_SCHEMA = 'dbo'
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
      );
      const byTable = new Map();
      for (const r of rows) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
        const size = r.max_length == null ? "" : `(${r.max_length === -1 ? "max" : r.max_length})`;
        byTable.get(r.table_name).push({ name: r.column_name, type: `${r.data_type}${size}` });
      }
      const tables = [...byTable].map(([name, columns]) => ({ name, columns }));
      return sendJson(res, 200, { tables });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });
}

module.exports = { register };
