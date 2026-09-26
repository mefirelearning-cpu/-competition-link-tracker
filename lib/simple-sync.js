import { query } from "./db.js";
import { snapshotCompetitionRanks } from "./rank-snapshots.js";

function storageConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  };
}

async function redis(command) {
  const cfg = storageConfig();
  if (!cfg.url || !cfg.token) return null;
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || "Redis HTTP " + response.status);
  return data.result;
}

function statsKey(competitionId, referralCode) {
  return "ctl:v2:stats:" + competitionId + ":" + referralCode;
}

export async function syncTrackingCache(competitionId, referralCode) {
  if (!competitionId || !referralCode) return false;
  try {
    const result = await query(
      `SELECT total_points_cache,raw_clicks_cache,unique_clicks_cache,valid_clicks_cache
       FROM competition_participants
       WHERE competition_id=$1 AND referral_code=$2
       LIMIT 1`,
      [competitionId, referralCode]
    );
    const row = result.rows[0];
    if (!row) return false;
    const cfg = storageConfig();
    if (!cfg.url || !cfg.token) return false;
    await redis([
      "HSET",
      statsKey(competitionId, referralCode),
      "points", String(Math.max(0, Number(row.total_points_cache) || 0)),
      "clicks", String(Math.max(0, Number(row.raw_clicks_cache) || 0)),
      "unique", String(Math.max(0, Number(row.unique_clicks_cache) || 0)),
      "valid", String(Math.max(0, Number(row.valid_clicks_cache) || 0))
    ]);
    return true;
  } catch (error) {
    console.error("simple-cache-sync:", error);
    return false;
  }
}

export async function captureCompetitionRank(competitionId) {
  if (!competitionId) return null;
  try {
    return await snapshotCompetitionRanks(competitionId);
  } catch (error) {
    console.error("simple-rank-snapshot:", error);
    return null;
  }
}
