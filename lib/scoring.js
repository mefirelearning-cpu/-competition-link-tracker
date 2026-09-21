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
    `SELECT id, status, timezone, starts_at, ends_at
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
  dayEnd,
  campaignId = null
}) {
  const result = await client.query(
    `SELECT COALESCE(SUM(final_points),0)::int AS total
     FROM point_transactions
     WHERE competition_id = $1
       AND participant_id = $2
       AND type = $3
       AND created_at >= $4
       AND created_at < $5
       AND ($6::text IS NULL OR campaign_id = $6)`,
    [competitionId, participantId, type, dayStart, dayEnd, campaignId]
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

  const inserted=result.rows[0]||null;
  if(inserted && Number(inserted.final_points)!==0 && type!=="valid_click"){
    await client.query(
      `INSERT INTO notifications
       (id,competition_id,participant_id,kind,title,body,action_url)
       VALUES ($1,$2,$3,'points','Points gagnés',$4,$5)`,
      [
        "notif_"+randomBytes(12).toString("hex"),
        competitionId,
        participantId,
        (Number(inserted.final_points)>0?"+":"")+Number(inserted.final_points)+" pts · "+String(description||type),
        "/me/"+encodeURIComponent(competitionId)
      ]
    ).catch(()=>{});
  }
  return inserted;
}

async function awardBurstBonuses(client, {
  competitionId,
  participantId,
  dayKey,
  dayStart,
  dayEnd,
  dailyClickPointCap = null
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
      let bonusFinal = Number(rule.bonus_points || 0);

      if (dailyClickPointCap !== null && dailyClickPointCap !== undefined) {
        const usedResult = await client.query(
          `SELECT COALESCE(SUM(final_points),0)::int AS total
           FROM point_transactions
           WHERE competition_id=$1
             AND participant_id=$2
             AND type IN ('valid_click','burst_bonus')
             AND created_at >= $3
             AND created_at < $4`,
          [competitionId,participantId,dayStart,dayEnd]
        );
        const remaining=Math.max(
          0,
          Number(dailyClickPointCap)-Number(usedResult.rows[0]?.total||0)
        );
        bonusFinal=Math.max(0,Math.min(bonusFinal,remaining));
      }

      if (bonusFinal <= 0) return awarded;

      const inserted = await insertPointTransaction(client, {
        competitionId,
        participantId,
        type: "burst_bonus",
        basePoints: Number(rule.bonus_points),
        multiplier: 1,
        finalPoints: bonusFinal,
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
  visitorHash,
  campaignId = null
}) {
  return withTransaction(async (client) => {
    const competition = await getCompetitionContext(client, competitionId);
    if (!competition) {
      return { awarded: 0, burstAwarded: 0, totalPoints: 0, reason: "competition_not_found" };
    }

    const now = Date.now();
    const notStarted = competition.starts_at && new Date(competition.starts_at).getTime() > now;
    const ended = competition.ends_at && new Date(competition.ends_at).getTime() <= now;
    if (competition.status !== "active" || notStarted || ended) {
      const totalPoints = await refreshPointCache(client, competitionId, participantId);
      return { awarded: 0, burstAwarded: 0, totalPoints, reason: ended ? "competition_ended" : "competition_not_active" };
    }

    const rule = await getRule(client, competitionId, "valid_click");
    if (!rule || !rule.enabled) {
      const totalPoints = await refreshPointCache(client, competitionId, participantId);
      return { awarded: 0, burstAwarded: 0, totalPoints, reason: "rule_disabled" };
    }

    let basePoints = Number(rule.base_points || 0);
    let multiplier = Number(rule.multiplier || 1);
    const globalDailyCap = rule.daily_cap_points;
    let campaignDailyCap = null;

    if (campaignId) {
      const campaignResult = await client.query(
        `SELECT points_click, multiplier, click_daily_cap, status
         FROM campaigns
         WHERE id = $1
           AND competition_id = $2
         LIMIT 1`,
        [campaignId, competitionId]
      );
      const campaign = campaignResult.rows[0];
      if (campaign && campaign.status === "active") {
        basePoints = Number(campaign.points_click || 0);
        multiplier = Number(campaign.multiplier || 1);
        campaignDailyCap = campaign.click_daily_cap;
      }
    }

    const bounds = await localDayBounds(client, competition.timezone || "UTC");
    const rawPoints = Math.round(basePoints * multiplier);
    let finalPoints = rawPoints;

    if (globalDailyCap !== null && globalDailyCap !== undefined) {
      const globalUsed = await client.query(
        `SELECT COALESCE(SUM(final_points),0)::int AS total
         FROM point_transactions
         WHERE competition_id=$1
           AND participant_id=$2
           AND type IN ('valid_click','burst_bonus')
           AND created_at >= $3
           AND created_at < $4`,
        [competitionId,participantId,bounds.day_start,bounds.day_end]
      );
      const globalRemaining=Math.max(
        0,
        Number(globalDailyCap)-Number(globalUsed.rows[0]?.total||0)
      );
      finalPoints=Math.max(0,Math.min(finalPoints,globalRemaining));
    }

    if (campaignId && campaignDailyCap !== null && campaignDailyCap !== undefined) {
      const campaignUsed = await sumToday(client, {
        competitionId,
        participantId,
        type: "valid_click",
        dayStart: bounds.day_start,
        dayEnd: bounds.day_end,
        campaignId
      });
      const campaignRemaining=Math.max(
        0,
        Number(campaignDailyCap)-campaignUsed
      );
      finalPoints=Math.max(0,Math.min(finalPoints,campaignRemaining));
    }

    let awarded = 0;

    if (finalPoints > 0) {
      const inserted = await insertPointTransaction(client, {
        competitionId,
        participantId,
        campaignId,
        type: "valid_click",
        basePoints,
        multiplier,
        finalPoints,
        sourceId: visitId,
        idempotencyKey: "valid_click:" + competitionId + ":" + visitorHash,
        description: "Clic valide",
        createdBy: "system",
        metadata: { visitId, visitorHash, campaignId }
      });

      if (inserted) awarded = Number(inserted.final_points || 0);
    }

    const burstAwarded = await awardBurstBonuses(client, {
      competitionId,
      participantId,
      dayKey: bounds.day_key,
      dayStart: bounds.day_start,
      dayEnd: bounds.day_end,
      dailyClickPointCap: globalDailyCap
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


export async function awardLedgerEvent({
  competitionId,
  participantId,
  campaignId = null,
  eventId = null,
  type,
  basePoints,
  multiplier = 1,
  sourceId = null,
  idempotencyKey,
  description = "",
  createdBy = "system",
  metadata = {}
}) {
  return withTransaction(async (client) => {
    const competition = await getCompetitionContext(client, competitionId);
    if (!competition) {
      return { inserted: false, totalPoints: 0, reason: "competition_not_found" };
    }

    const now = Date.now();
    const notStarted = competition.starts_at && new Date(competition.starts_at).getTime() > now;
    const ended = competition.ends_at && new Date(competition.ends_at).getTime() <= now;
    const explicitAdminOverride = String(createdBy || "system") !== "system";
    if ((competition.status !== "active" || notStarted || ended) && !explicitAdminOverride) {
      const totalPoints = await refreshPointCache(client, competitionId, participantId);
      return { inserted: false, totalPoints, reason: ended ? "competition_ended" : "competition_not_active" };
    }

    const finalPoints = Math.round(Number(basePoints || 0) * Number(multiplier || 1));
    const inserted = await insertPointTransaction(client, {
      competitionId,
      participantId,
      campaignId,
      eventId,
      type,
      basePoints: Number(basePoints || 0),
      multiplier: Number(multiplier || 1),
      finalPoints,
      sourceId,
      idempotencyKey,
      description,
      createdBy,
      metadata: {
        ...(metadata || {}),
        adminOverride: explicitAdminOverride && (competition.status !== "active" || notStarted || ended)
      }
    });

    let existingTransaction=null;
    if(!inserted && idempotencyKey){
      const existingResult=await client.query(
        `SELECT id,final_points
         FROM point_transactions
         WHERE idempotency_key=$1
         LIMIT 1`,
        [idempotencyKey]
      );
      existingTransaction=existingResult.rows[0]||null;
    }

    const totalPoints = await refreshPointCache(client, competitionId, participantId);
    const transactionPoints=Number(
      inserted?.final_points ?? existingTransaction?.final_points ?? 0
    );

    return {
      inserted: Boolean(inserted),
      transactionId: inserted?.id || existingTransaction?.id || null,
      transactionPoints,
      awarded: inserted ? transactionPoints : 0,
      totalPoints,
      reason: inserted ? "ok" : "duplicate"
    };
  });
}


export async function recalculatePointTransactions({
  competitionId,
  type,
  campaignId = null,
  basePoints,
  multiplier = 1,
  dailyCapPoints = null,
  adminId = "admin"
}) {
  const safeType = String(type || "");
  const allowed = new Set([
    "valid_click","share","interest","lead","sale","daily_checkin",
    "daily_mission","streak_bonus","campaign_bonus","special_event"
  ]);
  if (!allowed.has(safeType)) throw new Error("Type de points non recalculable");

  return withTransaction(async client => {
    const comp = await client.query(
      "SELECT timezone FROM competitions WHERE id=$1 LIMIT 1",
      [competitionId]
    );
    if (!comp.rowCount) return {ok:false,reason:"competition_not_found"};

    const rows = await client.query(
      `SELECT id, campaign_id, created_at, final_points
       FROM point_transactions
       WHERE competition_id=$1
         AND type=$2
         AND (
           ($3::text IS NULL AND campaign_id IS NULL)
           OR campaign_id=$3
         )
       ORDER BY created_at ASC, id ASC
       FOR UPDATE`,
      [competitionId, safeType, campaignId]
    );

    const tz = comp.rows[0].timezone || "UTC";
    const cap = dailyCapPoints === null || dailyCapPoints === undefined || String(dailyCapPoints)===""
      ? null
      : Math.max(0, Number.parseInt(String(dailyCapPoints),10)||0);
    const base = Number(basePoints||0);
    const mult = Number(multiplier||1);
    const raw = Math.round(base * mult);
    const dayTotals = new Map();
    let changed = 0;
    let beforeTotal = 0;
    let afterTotal = 0;

    for (const row of rows.rows) {
      beforeTotal += Number(row.final_points||0);
      let next = raw;

      if (cap !== null) {
        const dayResult = await client.query(
          "SELECT to_char($1::timestamptz AT TIME ZONE $2,'YYYY-MM-DD') AS day_key",
          [row.created_at,tz]
        );
        const dayKey = dayResult.rows[0].day_key;
        const used = Number(dayTotals.get(dayKey)||0);
        const remaining = Math.max(0,cap-used);
        next = Math.max(0,Math.min(raw,remaining));
        dayTotals.set(dayKey,used+next);
      }

      afterTotal += next;
      if (next !== Number(row.final_points||0)) {
        await client.query(
          `UPDATE point_transactions
           SET base_points=$2,
               multiplier=$3,
               final_points=$4,
               metadata = metadata || $5::jsonb
           WHERE id=$1`,
          [
            row.id,
            base,
            mult,
            next,
            JSON.stringify({
              recalculatedAt:new Date().toISOString(),
              recalculatedBy:adminId
            })
          ]
        );
        changed++;
      }
    }

    const affectedParticipants = await client.query(
      `SELECT DISTINCT participant_id
       FROM point_transactions
       WHERE competition_id=$1
         AND type=$2
         AND (
           ($3::text IS NULL AND campaign_id IS NULL)
           OR campaign_id=$3
         )`,
      [competitionId,safeType,campaignId]
    );

    for (const p of affectedParticipants.rows) {
      await refreshPointCache(client,competitionId,p.participant_id);
    }

    await client.query(
      `INSERT INTO admin_audit_logs
       (id,admin_id,action,entity_type,entity_id,description,metadata)
       VALUES ($1,$2,'points_recalculated','competition',$3,'Anciennes transactions recalculées',$4::jsonb)`,
      [
        auditId(),
        adminId,
        competitionId,
        JSON.stringify({
          type:safeType,
          campaignId,
          basePoints:base,
          multiplier:mult,
          dailyCapPoints:cap,
          transactionCount:rows.rowCount,
          changed,
          beforeTotal,
          afterTotal
        })
      ]
    );

    return {
      ok:true,
      transactionCount:rows.rowCount,
      changed,
      beforeTotal,
      afterTotal,
      participants:affectedParticipants.rowCount
    };
  });
}


export async function adminAdjustPoints({
  competitionId,
  participantId,
  amount,
  reason,
  adminId = "admin"
}) {
  const requested = Number.parseInt(String(amount),10);
  if (!Number.isInteger(requested) || requested === 0) {
    return {ok:false,reason:"invalid_amount"};
  }
  const cleanReason = String(reason || "").trim().slice(0,500);
  if (!cleanReason) return {ok:false,reason:"reason_required"};

  return withTransaction(async client => {
    const member = await client.query(
      `SELECT cp.participant_id,cp.referral_code,p.pseudonym
       FROM competition_participants cp
       JOIN participants p ON p.id=cp.participant_id
       WHERE cp.competition_id=$1
         AND cp.participant_id=$2
       FOR UPDATE`,
      [competitionId,participantId]
    );
    if(!member.rowCount) return {ok:false,reason:"participant_not_found"};

    const totalResult = await client.query(
      `SELECT COALESCE(SUM(final_points),0)::int AS total
       FROM point_transactions
       WHERE competition_id=$1 AND participant_id=$2`,
      [competitionId,participantId]
    );
    const currentTotal=Math.max(0,Number(totalResult.rows[0]?.total||0));
    const applied=requested<0 ? Math.max(requested,-currentTotal) : requested;
    if(applied===0) {
      return {ok:false,reason:"no_points_to_remove",totalPoints:currentTotal};
    }

    const transactionId=txId();
    const idempotencyKey="admin_adjustment:"+transactionId;
    await client.query(
      `INSERT INTO point_transactions
       (id,competition_id,participant_id,type,base_points,multiplier,final_points,
        source_id,idempotency_key,description,created_by,metadata)
       VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        transactionId,
        competitionId,
        participantId,
        applied,
        member.rows[0].referral_code,
        idempotencyKey,
        cleanReason,
        adminId,
        JSON.stringify({
          requestedAmount:requested,
          appliedAmount:applied,
          previousTotal:currentTotal
        })
      ]
    );

    const totalPoints=Math.max(0,currentTotal+applied);
    await client.query(
      `UPDATE competition_participants
       SET total_points_cache=$3
       WHERE competition_id=$1 AND participant_id=$2`,
      [competitionId,participantId,totalPoints]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
       (id,admin_id,action,entity_type,entity_id,description,metadata)
       VALUES ($1,$2,'points_adjusted','participant',$3,$4,$5::jsonb)`,
      [
        auditId(),
        adminId,
        participantId,
        cleanReason,
        JSON.stringify({
          competitionId,
          referralCode:member.rows[0].referral_code,
          requestedAmount:requested,
          appliedAmount:applied,
          previousTotal:currentTotal,
          totalAfter:totalPoints
        })
      ]
    );

    return {
      ok:true,
      participantId,
      referralCode:member.rows[0].referral_code,
      appliedAmount:applied,
      totalPoints,
      transactionId
    };
  });
}
