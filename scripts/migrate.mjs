import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseConfigured, query, withTransaction } from "../lib/db.js";

if (!databaseConfigured()) {
  console.error("PostgreSQL is not configured. Set DATABASE_URL or POSTGRES_URL first.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../db/migrations");

await query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const files = (await fs.readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();

for (const name of files) {
  const already = await query(
    "SELECT 1 FROM schema_migrations WHERE name = $1",
    [name]
  );

  if (already.rowCount) {
    console.log("skip", name);
    continue;
  }

  const sql = await fs.readFile(path.join(migrationsDir, name), "utf8");

  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1)",
      [name]
    );
  });

  console.log("applied", name);
}

console.log("Migrations complete.");
