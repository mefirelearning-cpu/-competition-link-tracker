function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function hasDatabaseUrl() {
  return Boolean(
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.NEON_DATABASE_URL
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  if (!hasDatabaseUrl()) {
    return sendJson(res, 503, {
      ok: false,
      postgresConfigured: false,
      message: "PostgreSQL is not connected yet."
    });
  }

  try {
    const { query } = await import("../lib/db.js");
    const result = await query("select current_timestamp as now");
    return sendJson(res, 200, {
      ok: true,
      postgresConfigured: true,
      databaseReachable: true,
      now: result.rows[0]?.now ?? null
    });
  } catch (error) {
    console.error("db-health:", error);
    return sendJson(res, 503, {
      ok: false,
      postgresConfigured: true,
      databaseReachable: false,
      message: "PostgreSQL connection failed."
    });
  }
}
