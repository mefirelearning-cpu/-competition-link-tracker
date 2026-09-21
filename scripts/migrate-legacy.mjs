import { createHash } from "node:crypto";
import { databaseConfigured, withTransaction } from "../lib/db.js";

const PREFIX = "ctl:v2";

function stableId(prefix, value) {
  return prefix + "_" + createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "competition";
}

function redisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  };
}

async function redis(command) {
  const cfg = redisConfig();
  if (!cfg.url || !cfg.token) throw new Error("Upstash Redis is not configured");
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Redis error");
  return data.result;
}

async function getJSON(key, fallback) {
  const raw = await redis(["GET", key]);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function parseHash(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return value;
  const out = {};
  for (let i = 0; i < value.length; i += 2) out[value[i]] = value[i + 1];
  return out;
}

if (process.env.MIGRATE_LEGACY_CONFIRM !== "YES") {
  console.error("Set MIGRATE_LEGACY_CONFIRM=YES to run the legacy import.");
  process.exit(1);
}

if (!databaseConfigured()) {
  console.error("PostgreSQL is not configured.");
  process.exit(1);
}

const competitions = await getJSON(PREFIX + ":competitions", []);
if (!Array.isArray(competitions)) throw new Error("Legacy competitions payload is invalid");

let migratedCompetitions = 0;
let migratedParticipants = 0;
let migratedPoints = 0;

for (const legacyCompetition of competitions) {
  const competitionId = String(legacyCompetition.id || slugify(legacyCompetition.name));
  const participants = await getJSON(PREFIX + ":participants:" + competitionId, []);

  await withTransaction(async (client) => {
    const statusMap = {
      draft: "draft",
      active: "active",
      paused: "paused",
      ended: "completed",
      completed: "completed",
      archived: "archived",
      scheduled: "scheduled"
    };
    const status = statusMap[String(legacyCompetition.status || "draft")] || "draft";

    await client.query(
      `INSERT INTO competitions
        (id, slug, name, description, status, ends_at, settings, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,COALESCE($8::timestamptz,NOW()),NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         ends_at = COALESCE(EXCLUDED.ends_at, competitions.ends_at),
         settings = competitions.settings || EXCLUDED.settings,
         updated_at = NOW()`,
      [
        competitionId,
        slugify(legacyCompetition.id || legacyCompetition.name),
        String(legacyCompetition.name || "Compétition"),
        "",
        status,
        legacyCompetition.endsAt || null,
        JSON.stringify({
          legacy: true,
          legacyTheme: legacyCompetition.theme || "blue",
          legacyPrize: legacyCompetition.prize || "",
          legacyDestination: legacyCompetition.destination || ""
        }),
        legacyCompetition.createdAt || null
      ]
    );

    migratedCompetitions++;

    for (const legacyParticipant of Array.isArray(participants) ? participants : []) {
      const code = String(legacyParticipant.code || "").trim();
      if (!code) continue;

      const participantId = stableId("p", competitionId + ":" + code);
      const competitionParticipantId = stableId("cp", competitionId + ":" + code);

      await client.query(
        `INSERT INTO participants
          (id, pseudonym, status, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,COALESCE($5::timestamptz,NOW()),NOW())
         ON CONFLICT (id) DO UPDATE SET
           pseudonym = EXCLUDED.pseudonym,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          participantId,
          String(legacyParticipant.name || code),
          legacyParticipant.active === false ? "suspended" : "active",
          JSON.stringify({ legacy: true, legacyCode: code }),
          legacyParticipant.createdAt || null
        ]
      );

      const stats = parseHash(await redis(["HGETALL", PREFIX + ":stats:" + competitionId + ":" + code]));
      const clicks = Number(stats.clicks || 0);
      const uniqueClicks = Number(stats.unique || 0);
      const points = Number(stats.points || 0);

      await client.query(
        `INSERT INTO competition_participants
          (id, competition_id, participant_id, referral_code, status, joined_at,
           total_points_cache, raw_clicks_cache, unique_clicks_cache, valid_clicks_cache, metadata)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (competition_id, participant_id) DO UPDATE SET
           referral_code = EXCLUDED.referral_code,
           status = EXCLUDED.status,
           total_points_cache = EXCLUDED.total_points_cache,
           raw_clicks_cache = EXCLUDED.raw_clicks_cache,
           unique_clicks_cache = EXCLUDED.unique_clicks_cache,
           valid_clicks_cache = EXCLUDED.valid_clicks_cache,
           metadata = competition_participants.metadata || EXCLUDED.metadata`,
        [
          competitionParticipantId,
          competitionId,
          participantId,
          code,
          legacyParticipant.active === false ? "suspended" : "active",
          legacyParticipant.createdAt || null,
          points,
          clicks,
          uniqueClicks,
          uniqueClicks,
          JSON.stringify({ legacy: true })
        ]
      );

      if (points !== 0) {
        const txId = stableId("ptx", competitionId + ":" + code + ":initial-balance");
        const idempotencyKey = "legacy:" + competitionId + ":" + code + ":initial-points";
        const inserted = await client.query(
          `INSERT INTO point_transactions
            (id, competition_id, participant_id, type, base_points, multiplier, final_points,
             source_id, idempotency_key, description, created_by, metadata)
           VALUES ($1,$2,$3,'migration_initial_balance',$4,1,$4,$5,$6,$7,'migration',$8::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            txId,
            competitionId,
            participantId,
            points,
            competitionParticipantId,
            idempotencyKey,
            "Solde de points importé depuis la version Redis",
            JSON.stringify({ legacy: true })
          ]
        );
        migratedPoints += inserted.rowCount;
      }

      migratedParticipants++;
    }
  });
}

console.log(JSON.stringify({
  ok: true,
  migratedCompetitions,
  migratedParticipants,
  migratedPointTransactions: migratedPoints,
  legacyRedisPreserved: true
}, null, 2));
