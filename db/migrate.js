// Migration helper for the SLA engine (and any later db/migrations/*.sql).
//
//   node db/migrate.js up                  apply pending migrations (the app also does this on start)
//   node db/migrate.js backfill            create per-stage SLA tracking for requests that have none
//   node db/migrate.js down 001            run db/migrations/rollback/001_*.down.sql (drops the SLA tracking tables)
//   node db/migrate.js status              list applied migrations
const db = require("./database");

async function main() {
  const [command = "up", arg] = process.argv.slice(2);
  await db.init(); // schema.sql + pending migrations; every step is idempotent
  const pool = await db.getPool();

  if (command === "up") {
    console.log("Database is up to date.");
  } else if (command === "status") {
    const { recordset } = await pool.request().query("SELECT name, applied_at FROM dbo.schema_migrations ORDER BY name");
    console.table(recordset);
  } else if (command === "backfill") {
    const { getDefaultService } = require("../lib/sla-service");
    const result = await getDefaultService().backfillMissing();
    console.log(`SLA tracking created for ${result.created} of ${result.total} requests without it.`);
  } else if (command === "down") {
    if (!arg) throw new Error("Usage: node db/migrate.js down <migration number, e.g. 001>");
    const file = await db.rollbackMigration(pool, arg);
    console.log(`Rolled back with ${file}. Deploy the previous app release (or set SKIP_MIGRATIONS=true) before restarting, otherwise startup re-applies it.`);
  } else {
    throw new Error(`Unknown command "${command}". Use up | status | backfill | down <NNN>.`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
