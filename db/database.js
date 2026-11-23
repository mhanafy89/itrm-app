const fs = require("fs");
const path = require("path");

// Optional .env support without an extra dependency (variables already set in the environment win).
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// SQL_TRUSTED_CONNECTION=true switches to Windows authentication, which needs the optional
// native `msnodesqlv8` package (npm install msnodesqlv8). SQL authentication is the default.
const useWindowsAuth = process.env.SQL_TRUSTED_CONNECTION === "true";
const sql = useWindowsAuth ? require("mssql/msnodesqlv8") : require("mssql");

const DB_NAME = process.env.SQL_DATABASE || "itrm_tracker";

function buildConfig(database) {
  // "HOST\INSTANCE" is accepted for named instances; an explicit SQL_PORT takes precedence.
  const [server, instanceName] = (process.env.SQL_SERVER || "localhost").split("\\");
  // With ODBC (Windows auth) an unspecified port lets the driver pick the protocol (e.g. shared memory).
  const defaultPort = instanceName || useWindowsAuth ? undefined : 1433;
  const port = process.env.SQL_PORT ? Number(process.env.SQL_PORT) : defaultPort;

  const config = {
    server,
    port,
    database,
    options: {
      encrypt: process.env.SQL_ENCRYPT !== "false",
      trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === "true",
      instanceName: port ? undefined : instanceName,
    },
    pool: { max: Number(process.env.SQL_POOL_MAX) || 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };

  if (useWindowsAuth) {
    config.options.trustedConnection = true;
    if (process.env.SQL_ODBC_DRIVER) config.driver = process.env.SQL_ODBC_DRIVER;
  } else {
    if (!process.env.SQL_USER || !process.env.SQL_PASSWORD) {
      throw new Error("SQL_USER and SQL_PASSWORD must be set (see .env.example).");
    }
    config.user = process.env.SQL_USER;
    config.password = process.env.SQL_PASSWORD;
  }
  return config;
}

// One shared connection pool for the whole process, created on first use.
let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(buildConfig(DB_NAME));
    pool.on("error", (err) => console.error("SQL Server pool error:", err.message));
    poolPromise = pool.connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

async function ensureDatabase() {
  if (process.env.SQL_CREATE_DATABASE !== "true") return;
  const master = new sql.ConnectionPool(buildConfig("master"));
  await master.connect();
  try {
    await master
      .request()
      .input("name", sql.NVarChar(128), DB_NAME)
      .query(
        "IF DB_ID(@name) IS NULL BEGIN DECLARE @stmt NVARCHAR(400) = N'CREATE DATABASE ' + QUOTENAME(@name); EXEC (@stmt); END"
      );
  } finally {
    await master.close();
  }
}

async function runScript(pool, file) {
  const script = fs.readFileSync(file, "utf8");
  for (const batch of script.split(/^\s*GO\s*$/gim)) {
    if (batch.trim()) await pool.request().batch(batch);
  }
}

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const migrationFiles = () =>
  fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
    : [];

// Versioned migrations (db/migrations/NNN_name.sql): each runs once and is recorded in dbo.schema_migrations.
// Scripts are idempotent too, so a half-applied run can simply be retried.
async function applyMigrations(pool) {
  await pool.request().batch(
    `IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
     CREATE TABLE dbo.schema_migrations (
       name       NVARCHAR(200) NOT NULL CONSTRAINT PK_schema_migrations PRIMARY KEY,
       applied_at DATETIME2(0)  NOT NULL CONSTRAINT DF_schema_migrations_at DEFAULT SYSUTCDATETIME()
     )`
  );
  const applied = new Set((await pool.request().query("SELECT name FROM dbo.schema_migrations")).recordset.map((r) => r.name));
  const ran = [];
  for (const file of migrationFiles()) {
    const name = file.replace(/\.sql$/, "");
    if (applied.has(name)) continue;
    await runScript(pool, path.join(MIGRATIONS_DIR, file));
    await pool.request().input("name", sql.NVarChar(200), name).query("INSERT INTO dbo.schema_migrations (name) VALUES (@name)");
    ran.push(name);
  }
  return ran;
}

// Runs db/migrations/rollback/<prefix>_*.down.sql and forgets the migration so it can be re-applied.
async function rollbackMigration(pool, prefix) {
  const dir = path.join(MIGRATIONS_DIR, "rollback");
  const file = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith(`${prefix}_`) && f.endsWith(".down.sql"));
  if (!file) throw new Error(`No rollback script found for migration "${prefix}".`);
  await runScript(pool, path.join(dir, file));
  await pool.request().input("name", sql.NVarChar(200), file.replace(/\.down\.sql$/, "")).query("DELETE FROM dbo.schema_migrations WHERE name = @name");
  return file;
}

// Creates any missing tables/indexes (schema.sql is idempotent, so this is safe on every start),
// then applies any pending versioned migrations.
async function init() {
  await ensureDatabase();
  const pool = await getPool();
  await runScript(pool, path.join(__dirname, "schema.sql"));
  // SKIP_MIGRATIONS=true: a DBA applies db/migrations/*.sql by hand (or the engine was rolled back deliberately).
  if (process.env.SKIP_MIGRATIONS !== "true") await applyMigrations(pool);
}

// Keep the API shape the frontend already relies on (SQLite returned these as strings / 0-1 integers):
// DATE -> 'YYYY-MM-DD', DATETIME2 -> 'YYYY-MM-DD HH:MM:SS' (UTC), BIT -> 0/1.
const T = sql.TYPES;
const toDate = (d) => d.toISOString().slice(0, 10);
const toDateTime = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const FORMATTERS = new Map([
  [T.Date, toDate],
  [T.DateTime, toDateTime],
  [T.DateTime2, toDateTime],
  [T.SmallDateTime, toDateTime],
  [T.Bit, (v) => (v ? 1 : 0)],
]);

function normalizeRows(recordset) {
  if (!recordset) return [];
  const fixes = Object.entries(recordset.columns || {})
    .filter(([, col]) => FORMATTERS.has(col.type))
    .map(([name, col]) => [name, FORMATTERS.get(col.type)]);
  const rows = Array.from(recordset);
  if (fixes.length) {
    for (const row of rows) {
      for (const [name, fn] of fixes) {
        if (row[name] != null && !Array.isArray(row[name])) row[name] = fn(row[name]);
      }
    }
  }
  return rows;
}

// `params` is a plain object; every key is bound as @key (always parameterized, never concatenated).
async function run(target, text, params = {}) {
  const request = target.request();
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value === undefined ? null : value);
  }
  const result = await request.query(text);
  return { rows: normalizeRows(result.recordset), rowsAffected: result.rowsAffected[0] || 0 };
}

function makeExecutor(target) {
  const query = (text, params) => run(target, text, params);
  const queryOne = async (text, params) => (await query(text, params)).rows[0];
  return { query, queryOne };
}

const pooled = {
  query: async (text, params) => run(await getPool(), text, params),
  queryOne: async (text, params) => (await pooled.query(text, params)).rows[0],
};

// Runs fn({ query, queryOne }) on a single connection inside a transaction; rolls back on error.
async function transaction(fn) {
  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  try {
    const result = await fn(makeExecutor(tx));
    await tx.commit();
    return result;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // already rolled back by the server
    }
    throw err;
  }
}

async function close() {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = null;
  await pool.close();
}

const isUniqueViolation = (err) => err && (err.number === 2627 || err.number === 2601);
const isReferenceViolation = (err) => err && err.number === 547;

module.exports = {
  sql,
  DB_NAME,
  buildConfig,
  init,
  applyMigrations,
  rollbackMigration,
  getPool,
  close,
  transaction,
  query: pooled.query,
  queryOne: pooled.queryOne,
  isUniqueViolation,
  isReferenceViolation,
};
