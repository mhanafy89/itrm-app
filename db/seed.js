// Seeds the lookup tables with the same values as the original Excel "Lookups" sheet.
// Safe to run multiple times -- it only inserts values that aren't already present,
// so it won't duplicate rows or wipe out anything you've added/edited since.
const { init, query, transaction, close } = require("./database");
const { hashPassword } = require("../lib/auth");

// NOTE: a couple of these preserve the original spelling from the source
// spreadsheet ("Prioirty" -> "Critcal", "Compeleted") rather than "fixing" it,
// since other systems your org already has (the linked master tracker) use the
// same spelling. Edit the rows in these tables (or via /api/lookups) if you'd
// rather standardize the spelling going forward.
const SEED = {
  priorities: ["Critical", "High", "Medium", "Low", "Very Low"],
  business_units: [
    "Customer Experience",
    "Customer Care",
    "Collection",
    "Product Development Retail",
    "Product Development SME",
    "Digital Channels",
  ],
  stages: ["Draft", "Demand", "Development", "QA", "UAT", "CAB", "Deployment"],
  statuses: ["Not Started", "On Hold", "In Progress", "Pending for Approval", "Completed", "Cancelled"],
  tech_owners: ["Murad", "Sameenullah", "Noushad", "Raiyan"],
  regulators: [], // empty in the source sheet -- add your regulators via the app once it's running
};

const HAS_SORT_ORDER = new Set(["priorities", "stages", "statuses"]);

async function seedTable(tx, table, values) {
  for (const [idx, name] of values.entries()) {
    const columns = HAS_SORT_ORDER.has(table) ? "(name, sort_order)" : "(name)";
    const row = HAS_SORT_ORDER.has(table) ? "(@name, @idx)" : "(@name)";
    await tx.query(
      `IF NOT EXISTS (SELECT 1 FROM ${table} WHERE name = @name) INSERT INTO ${table} ${columns} VALUES ${row}`,
      { name, idx }
    );
  }
}

// Only runs while the users table is empty, so it never resets a password you've already changed.
async function seedDefaultAdmin() {
  const { rows } = await query("SELECT COUNT(*) AS count FROM dbo.users");
  if (rows[0].count > 0) return;

  const username = process.env.SEED_ADMIN_USERNAME || "admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "admin123";
  await query(
    "INSERT INTO dbo.users (username, password_hash, name, role) VALUES (@username, @passwordHash, @name, 'read_write')",
    { username, passwordHash: hashPassword(password), name: "Administrator" }
  );
  console.log(`Created default admin user "${username}" (password "${password}") -- change this after first login.`);
}

async function main() {
  await init();

  await transaction(async (tx) => {
    for (const [table, values] of Object.entries(SEED)) {
      await seedTable(tx, table, values);
    }
  });
  await seedDefaultAdmin();

  console.log("Seed complete. Current lookup counts:");
  for (const table of Object.keys(SEED)) {
    const { rows } = await query(`SELECT COUNT(*) AS count FROM ${table}`);
    console.log(`  ${table}: ${rows[0].count}`);
  }
}

main()
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(close);
