import { databaseConfigured, query } from "../lib/db.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!databaseConfigured()) {
    return res.status(503).json({
      ok: false,
      postgresConfigured: false,
      message: "PostgreSQL is not connected yet."
    });
  }

  try {
    const result = await query("select current_timestamp as now");
    return res.status(200).json({
      ok: true,
      postgresConfigured: true,
      databaseReachable: true,
      now: result.rows[0]?.now ?? null
    });
  } catch (error) {
    console.error("db-health:", error);
    return res.status(503).json({
      ok: false,
      postgresConfigured: true,
      databaseReachable: false,
      message: "PostgreSQL connection failed."
    });
  }
}
