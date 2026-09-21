import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";

function txId() {
  return "ptx_" + randomBytes(12).toString("hex");
}

function auditId() {
  return "audit_" + randomBytes(12).toString("hex");
}

async function getCompetitionContext(client, competitionId) {
  const result = await client.query(
    `SELECT id, status, timezone
     FROM competitions
     WHERE id = $1
     LIMIT 1`,
    [competitionId]
  );
  return result.rows[0] || null;
}

async function getRule(client, competitionId, actionType) {
  const result = await client.query(
    `SELECT id, enabled, base_points, multiplier, daily_cap_points, settings
     FROM point_rules
     WHERE competition_id = $1
       AND action_type = $2
     LIMIT 1`,
    [competitionId, actionType]
  );
  return result.rows[0] || null;
}

async function localDayBounds(client, timezone) {
  const result = await client.query(
    `SELECT
       (date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1) AS day_start,
       ((date_trunc('day', NOW() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1) AS day_end,
       to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS day_key`,
    [timezone || "UTC"]
  );
  return result.rows[0];
}

async function sumToday(client, {
  competitionId,
  participantId,
  type,
  dayStart,
  dayEnd
}) {
  const result = await client.query(
    `SELECT COALESCE(SUM(final_points),0)::int AS total
     FROM point_transactions
     WHERE competition_id = $1
       AND participant_id = $2
       AND type = $3
       AND created_at >= $4
       AND created_at < $5`,
    [competitionId, participantId, type, dayStart, dayEnd]
  );
  return Number(result.rows[0]?.total || 0);
}

async function refreshPointCache(client, competitionId, participantId) {
  const totalResult = await client.query(
    `SELECT COALESCE(SUM(final_points),0)::int AS total
     FROM point_transactions
     WHERE competition_id = $1
       AND participant_id = $2`,
    [competitionId, participantId]
  );
  const total = Math.max(0, Number(totalResult.rows[0]?.total || 0));

  await client.query(
    `UPDATE competition_participants
     SET total_points_cache = $3
     WHERE competition_id = $1
       AND participant_id = $2`,
    [competitionId, participantId, total]
  );

  return total;
}

async function insertPointTransaction(client, {
  competitionId,
  participantId,
  campaignId = null,
  eventId = null,
  type,
  basePoints,
  multiplier = 1,
  finalPoints,
  sourceId = null,
  idempotencyKey,
  description = "",
  createdBy = "system",
  metadata = {}
}) {
  const result = await client.query(
    `INSERT INTO point_transactions
      (id, competition_id, participant_id, campaign_id, event_id, type,
       base_points, multiplier, final_points, source_id, idempotency_key,
       description, created_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, final_points`,
    [
      txId(),
      competitionId,
      participantId,
      campaignId,
      eventId,
      type,
      Number(basePoints || 0),
      Number(multiplier || 1),
      Number(finalPoints || 0),
      sourceId,
      idempotencyKey,
      description,
      createdBy,
      JSON.stringify(metadata || {})
    ]
  );
  return result.rows[0] || null;
}

async function awardBurstBonuses(client, {
  competitionId,
  participantId,
  dayKey,
  dayStart,
  dayEnd
}) {
  const rules = await client.query(
    `SELECT id, name, threshold, window_minutes, bonus_points, daily_limit
     FROM burst_rules
     WHERE competition_id = $1
       AND enabled = TRUE
     ORDER BY threshold ASC`,
    [competitionId]
  );

  let awarded = 0;

  for (const rule of rules.rows) {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM visits
       WHERE competition_id = $1
         AND participant_id = $2
         AND is_valid = TRUE
         AND created_at >= GREATEST(
           $3::timestamptz,
           NOW() - ($4::text || ' minutes')::interval
         )
         AND created_at < $5::timestamptz`,
      [
        competitionId,
        participantId,
        dayStart,
        Number(rule.window_minutes),
        dayEnd
      ]
    );

    const validCount = Number(countResult.rows[0]?.count || 0);
    if (validCount < Number(rule.threshold)) continue;

    const eligibleBuckets = Math.min(
      Number(rule.daily_limit || 1),
      Math.floor(validCount / Number(rule.threshold))
    );

    for (let bucket = 1; bucket <= eligibleBuckets; bucket++) {
      const inserted = await insertPointTransaction(client, {
        competitionId,
        participantId,
        type: "burst_bonus",
        basePoints: Number(rule.bonus_points),
        multiplier: 1,
        finalPoints: Number(rule.bonus_points),
        sourceId: rule.id,
        idempotencyKey:
          "burst:" + competitionId + ":" + participantId + ":" +
          rule.id + ":" + dayKey + ":" + bucket,
        description: rule.name,
        createdBy: "system",
        metadata: {
          ruleId: rule.id,
          threshold: Number(rule.threshold),
          windowMinutes: Number(rule.window_minutes),
          bucket,
          observedValidClicks: validCount
        }
      });

      if (inserted) awarded += Number(inserted.final_points || 0);
    }
  }

  return awarded;
}

export async function awardValidClick({
  competitionId,
  participantId,
  visitId,
  visitorHash
}) {
  return withTransaction(async (client) => {
    const competition = await getCompetitionContext(client, competitionId);
    if (!competition) {
      return { awarded: 0, burstAwarded: 0, totalPoints: 0, reason: "competition_not_found" };
    }

    if (competition.status !== "active") {
      const totalPoints = await refreshPointCache(client, competitionId, participantId);
      return { awarded: 0, burstAwarded: 0, totalPoints, reason: "competition_not_active" };
    }

    const rule = await getRule(client, competitionId, "valid_click");
    if (!rule || !rule.enabled) {
      const totalPoints = await refreshPointCache(client, competitionId, participantId);
      return { awarded: 0, burstAwarded: 0, totalPoints, reason: "rule_disabled" };
    }

    const bounds = await localDayBounds(client, competition.timezone || "UTC");
    const rawPoints = Math.round(
      Number(rule.base_points || 0) * Number(rule.multiplier || 1)
    );

    let finalPoints = rawPoints;

    if (rule.daily_cap_points !== null && rule.daily_cap_points !== undefined) {
      const todayTotal = await sumToday(client, {
        competitionId,
        participantId,
        type: "valid_click",
        dayStart: bounds.day_start,
        dayEnd: bounds.day_end
      });

      const remaining = Math.max(0, Number(rule.daily_cap_points) - todayTotal);
      finalPoints = Math.max(0, Math.min(finalPoints, remaining));
    }

    let awarded = 0;

    if (finalPoints > 0) {
      const inserted = await insertPointTransaction(client, {
        competitionId,
        participantId,
        type: "valid_click",
        basePoints: Number(rule.base_points || 0),
        multiplier: Number(rule.multiplier || 1),
        finalPoints,
        sourceId: visitId,
        idempotencyKey: "valid_click:" + competitionId + ":" + visitorHash,
        description: "Clic valide",
        createdBy: "system",
        metadata: { visitId, visitorHash }
      });

      if (inserted) awarded = Number(inserted.final_points || 0);
    }

    const burstAwarded = await awardBurstBonuses(client, {
      competitionId,
      participantId,
      dayKey: bounds.day_key,
      dayStart: bounds.day_start,
      dayEnd: bounds.day_end
    });

    const totalPoints = await refreshPointCache(client, competitionId, participantId);

    return {
      awarded,
      burstAwarded,
      totalPoints,
      reason: finalPoints <= 0 ? "daily_cap_reached" : "ok"
    };
  });
}

export async function getScoringConfig(competitionId) {
  const rules = await query(
    `SELECT id, action_type, enabled, base_points, multiplier, daily_cap_points, settings
     FROM point_rules
     WHERE competition_id = $1
     ORDER BY action_type`,
    [competitionId]
  );

  const bursts = await query(
    `SELECT id, name, threshold, window_minutes, bonus_points, daily_limit, enabled, settings
     FROM burst_rules
     WHERE competition_id = $1
     ORDER BY threshold ASC, created_at ASC`,
    [competitionId]
  );

  return { rules: rules.rows, bursts: bursts.rows };
}

export async function updateValidClickRule({
  competitionId,
  enabled,
  basePoints,
  multiplier,
  dailyCapPoints,
  adminId = "admin"
}) {
  const safeBase = Math.max(0, Number.parseInt(String(basePoints), 10) || 0);
  const safeMultiplier = Math.max(0, Number(multiplier) || 1);
  const capRaw = String(dailyCapPoints ?? "").trim();
  const safeCap = capRaw === "" ? null : Math.max(0, Number.parseInt(capRaw, 10) || 0);

  return withTransaction(async (client) => {
    const before = await client.query(
      `SELECT *
       FROM point_rules
       WHERE competition_id = $1
         AND action_type = 'valid_click'
       LIMIT 1`,
      [competitionId]
    );

    await client.query(
      `INSERT INTO point_rules
        (id, competition_id, action_type, enabled, base_points, multiplier, daily_cap_points)
       VALUES ($1,$2,'valid_click',$3,$4,$5,$6)
       ON CONFLICT (competition_id, action_type)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         base_points = EXCLUDED.base_points,
         multiplier = EXCLUDED.multiplier,
         daily_cap_points = EXCLUDED.daily_cap_points,
         updated_at = NOW()`,
      [
        "rule_" + randomBytes(10).toString("hex"),
        competitionId,
        Boolean(enabled),
        safeBase,
        safeMultiplier,
        safeCap
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'scoring_rule_updated','competition',$3,$4,$5::jsonb)`,
      [
        auditId(),
        adminId,
        competitionId,
        "Barème des clics valides modifié",
        JSON.stringify({
          before: before.rows[0] || null,
          after: {
            enabled: Boolean(enabled),
            basePoints: safeBase,
            multiplier: safeMultiplier,
            dailyCapPoints: safeCap
          }
        })
      ]
    );
  });
}

export async function createBurstRule({
  competitionId,
  name,
  threshold,
  windowMinutes,
  bonusPoints,
  dailyLimit = 1,
  enabled = true,
  adminId = "admin"
}) {
  const id = "burst_" + randomBytes(10).toString("hex");

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO burst_rules
        (id, competition_id, name, threshold, window_minutes, bonus_points, daily_limit, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        competitionId,
        String(name || "Bonus trafic").trim().slice(0, 80),
        Math.max(1, Number.parseInt(String(threshold), 10) || 1),
        Math.max(1, Number.parseInt(String(windowMinutes), 10) || 30),
        Number.parseInt(String(bonusPoints), 10) || 0,
        Math.max(1, Number.parseInt(String(dailyLimit), 10) || 1),
        Boolean(enabled)
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'burst_rule_created','burst_rule',$3,$4,$5::jsonb)`,
      [
        auditId(),
        adminId,
        id,
        "Règle de burst créée",
        JSON.stringify({ competitionId })
      ]
    );
  });

  return id;
}

export async function deleteBurstRule({
  competitionId,
  ruleId,
  adminId = "admin"
}) {
  return withTransaction(async (client) => {
    const deleted = await client.query(
      `DELETE FROM burst_rules
       WHERE id = $1
         AND competition_id = $2
       RETURNING *`,
      [ruleId, competitionId]
    );

    if (!deleted.rowCount) return false;

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'burst_rule_deleted','burst_rule',$3,$4,$5::jsonb)`,
      [
        auditId(),
        adminId,
        ruleId,
        "Règle de burst supprimée",
        JSON.stringify({ competitionId, deleted: deleted.rows[0] })
      ]
    );

    return true;
  });
}
