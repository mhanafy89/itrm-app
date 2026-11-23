// Multi-select "System" lookup shared by business requests and incidents.

// Returns null when the body doesn't mention systems at all, so partial updates leave them untouched.
function parseSystemIds(body) {
  const raw = body.system_ids;
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

async function setSystems(tx, table, key, id, systemIds) {
  if (systemIds === null) return;
  await tx.query(`DELETE FROM ${table} WHERE ${key} = @id`, { id });
  for (const systemId of systemIds) {
    await tx.query(`INSERT INTO ${table} (${key}, system_id) VALUES (@id, @systemId)`, { id, systemId });
  }
}

module.exports = { parseSystemIds, setSystems };
