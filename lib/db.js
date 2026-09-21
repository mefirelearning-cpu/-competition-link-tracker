import pg from "pg";

const { Pool } = pg;

export function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.NEON_DATABASE_URL ||
    ""
  );
}

export function databaseConfigured() {
  return Boolean(getDatabaseUrl());
}

function createPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("PostgreSQL is not configured");
  }

  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true
  });
}

export function getPool() {
  if (!globalThis.__competitionPgPool) {
    globalThis.__competitionPgPool = createPool();
  }
  return globalThis.__competitionPgPool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
