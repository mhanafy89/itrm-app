// One-time data migration: SQLite file  ->  Microsoft SQL Server.
//
//   node db/migrate-from-sqlite.js [path/to/itrm_tracker.db] [--truncate] [--dry-run]
//
// - Source path defaults to $DB_PATH, then data/itrm_tracker.db.
// - Target is the SQL Server database from the SQL_* environment variables (see .env.example).
// - The schema is created first (db/schema.sql). Existing ids are preserved (IDENTITY_INSERT), and the
//   identity counters are moved past SQLite's AUTOINCREMENT high-water mark.
// - Everything is copied in ONE transaction and row counts + id sums are compared per table before
//   committing; any mismatch or error rolls the whole migration back.
// - --truncate  empties the target tables first (otherwise a non-empty target aborts the run).
// - --dry-run   runs the full copy + validation, then rolls back.
//
// Reading the SQLite file needs Node's built-in node:sqlite (Node >= 22.5; on 22.5-22.12 run with
// --experimental-sqlite). This script is the only place SQLite is still referenced.
const path = require("node:path");
const fs = require("node:fs");
const { init, getPool, close, sql, DB_NAME } = require("./database");

// Parents before children (foreign keys).
const TABLES = [
  "business_units",
  "business_categories",
  "priorities",
  "stages",
  "statuses",
  "tech_owners",
  "regulators",
  "requesters",
  "rms",
  "business_requests",
  "business_request_history",
  "request_comments",
  "incidents",
  "incident_history",
  "incident_comments",
  "import_batches",
  "import_batch_rows",
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const sqlitePath = path.resolve(positional[0] || process.env.DB_PATH || path.join(__dirname, "..", "data", "itrm_tracker.db"));

const warnings = [];
let warningCount = 0;
function warn(message) {
  warningCount++;
  if (warnings.length < 50) warnings.push(message);
}

// ---- Value conversion (SQLite is loosely typed; SQL Server is not) -----------------------------

function toDateParts(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

function toDateTime(value) {
  const s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) {
    const date = new Date(`${m[1]}T${m[2]}Z`); // SQLite datetime('now') is UTC
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return toDateParts(s);
}

function makeColumn(meta) {
  const base = { name: meta.name };
  const nullable = meta.nullable;
  const orDefault = (where, fallback) => {
    if (nullable) return null;
    warn(`${where}: NULL/invalid value in a NOT NULL column, using a default`);
    return fallback();
  };

  switch (meta.dataType) {
    case "int":
      return {
        ...base,
        type: sql.Int,
        convert: (v, where) => {
          if (v == null) return orDefault(where, () => 0);
          const n = Number(v);
          if (Number.isInteger(n)) return n;
          warn(`${where}: "${v}" is not an integer, stored as NULL`);
          return orDefault(where, () => 0);
        },
      };
    case "bit":
      return {
        ...base,
        type: sql.Bit,
        convert: (v, where) => (v == null ? orDefault(where, () => false) : [1, "1", "true", true].includes(v)),
      };
    case "date":
      return {
        ...base,
        type: sql.Date,
        convert: (v, where) => {
          if (v == null || String(v).trim() === "") return orDefault(where, () => new Date(0));
          const d = toDateParts(v);
          if (d) return d;
          warn(`${where}: "${v}" is not a valid date, stored as NULL`);
          return orDefault(where, () => new Date(0));
        },
      };
    case "datetime2":
      return {
        ...base,
        type: sql.DateTime2(0),
        convert: (v, where) => {
          if (v == null || String(v).trim() === "") return orDefault(where, () => new Date());
          const d = toDateTime(v);
          if (d) return d;
          warn(`${where}: "${v}" is not a valid timestamp, using current time`);
          return new Date();
        },
      };
    default:
      return { ...base, type: sql.NVarChar(sql.MAX), convert: (v) => (v == null ? null : String(v)) };
  }
}

// ---- Main --------------------------------------------------------------------------------------

function openSqlite() {
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("node:sqlite is not available. Use Node >= 22.5 (add --experimental-sqlite on 22.5-22.12).");
  }
  return new DatabaseSync(sqlitePath, { readOnly: true });
}

async function targetColumns(tx, table) {
  const result = await new sql.Request(tx)
    .input("t", sql.NVarChar(128), table)
    .query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION`
    );
  return result.recordset.map((r) => ({ name: r.name, dataType: r.dataType, nullable: r.nullable === "YES" }));
}

async function copyTable(tx, sqlite, table) {
  const sqliteCols = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  if (!sqliteCols.length) {
    console.log(`  ${table.padEnd(26)} not present in SQLite, skipped`);
    return { table, source: 0, target: 0, maxId: 0 };
  }

  const cols = (await targetColumns(tx, table)).filter((c) => sqliteCols.includes(c.name)).map(makeColumn);
  const dropped = sqliteCols.filter((c) => !cols.some((x) => x.name === c));
  if (dropped.length) console.log(`  ${table}: columns not in SQL Server schema (not copied): ${dropped.join(", ")}`);

  const select = cols.map((c) => `"${c.name}"`).join(", ");
  const rows = sqlite.prepare(`SELECT ${select} FROM "${table}" ORDER BY id`).all();
  const sourceSum = sqlite.prepare(`SELECT COALESCE(SUM(id), 0) AS s FROM "${table}"`).get().s;
  const colList = cols.map((c) => `[${c.name}]`).join(", ");
  const chunkSize = Math.max(1, Math.min(100, Math.floor(2000 / cols.length))); // stay under the 2100-parameter cap

  for (let start = 0; start < rows.length; start += chunkSize) {
    const request = new sql.Request(tx);
    const tuples = rows.slice(start, start + chunkSize).map((row, r) => {
      const names = cols.map((c, i) => {
        const name = `p${r}_${i}`;
        request.input(name, c.type, c.convert(row[c.name], `${table}.${c.name} (id=${row.id})`));
        return `@${name}`;
      });
      return `(${names.join(", ")})`;
    });
    try {
      // IDENTITY_INSERT is scoped to the batch, so it is switched on/off inside the same statement.
      await request.query(
        `SET IDENTITY_INSERT dbo.${table} ON; INSERT INTO dbo.${table} (${colList}) VALUES ${tuples.join(", ")}; SET IDENTITY_INSERT dbo.${table} OFF;`
      );
    } catch (err) {
      throw new Error(`${table}: insert failed for the batch starting at id=${rows[start].id}: ${err.message}`);
    }
  }

  const { recordset } = await new sql.Request(tx).query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(id AS BIGINT)), 0) AS s, COALESCE(MAX(id), 0) AS m FROM dbo.${table}`
  );
  const check = recordset[0];
  if (check.n !== rows.length) throw new Error(`${table}: row count mismatch (SQLite ${rows.length}, SQL Server ${check.n})`);
  if (Number(check.s) !== Number(sourceSum)) throw new Error(`${table}: id checksum mismatch (SQLite ${sourceSum}, SQL Server ${check.s})`);

  console.log(`  ${table.padEnd(26)} ${String(rows.length).padStart(6)} rows copied and verified`);
  return { table, source: rows.length, target: check.n, maxId: check.m };
}

async function main() {
  const sqlite = openSqlite();
  console.log(`Source : ${sqlitePath}`);
  console.log(`Target : ${process.env.SQL_SERVER || "localhost"} / ${DB_NAME}${flags.has("--dry-run") ? "   (dry run - will roll back)" : ""}`);

  await init();
  const pool = await getPool();

  const tx = new sql.Transaction(pool);
  await tx.begin();
  const results = [];
  try {
    const existing = [];
    for (const table of TABLES) {
      const { recordset } = await new sql.Request(tx).query(`SELECT COUNT(*) AS n FROM dbo.${table}`);
      if (recordset[0].n > 0) existing.push(`${table} (${recordset[0].n})`);
    }
    if (existing.length && !flags.has("--truncate")) {
      throw new Error(`Target tables are not empty: ${existing.join(", ")}. Re-run with --truncate to replace them.`);
    }
    if (existing.length) {
      console.log("Emptying target tables (--truncate)...");
      for (const table of [...TABLES].reverse()) await new sql.Request(tx).query(`DELETE FROM dbo.${table}`);
    }

    console.log("Copying data...");
    for (const table of TABLES) results.push(await copyTable(tx, sqlite, table));

    if (flags.has("--dry-run")) {
      await tx.rollback();
      console.log("Dry run complete - nothing was written.");
    } else {
      await tx.commit();
    }
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // already rolled back
    }
    throw err;
  }

  if (!flags.has("--dry-run")) {
    // Continue ids after SQLite's AUTOINCREMENT high-water mark (it can be higher than MAX(id) after deletes).
    const sequences = new Map(sqlite.prepare("SELECT name, seq FROM sqlite_sequence").all().map((r) => [r.name, r.seq]));
    for (const { table, maxId } of results) {
      const seq = sequences.get(table);
      if (maxId > 0 && seq > maxId) {
        await pool.request().batch(`DBCC CHECKIDENT ('dbo.${table}', RESEED, ${Number(seq)}) WITH NO_INFOMSGS`);
        console.log(`  ${table}: next id continues after ${seq}`);
      }
    }
  }

  const total = results.reduce((n, r) => n + r.target, 0);
  console.log(`\nDone: ${total} rows across ${results.length} tables. All counts and id checksums match.`);
  if (warningCount) {
    console.log(`\n${warningCount} value warning(s):`);
    warnings.forEach((w) => console.log(`  - ${w}`));
    if (warningCount > warnings.length) console.log(`  ... and ${warningCount - warnings.length} more`);
  }
  sqlite.close();
}

main()
  .catch((err) => {
    console.error(`\nMigration failed (nothing was committed): ${err.message}`);
    process.exitCode = 1;
  })
  .finally(close);
