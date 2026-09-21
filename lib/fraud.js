import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

export async function getFraudSettings(competitionId) {
  const r = await query(
    `SELECT fs.*, c.timezone
     FROM fraud_settings fs
     JOIN competitions c ON c.id = fs.competition_id
     WHERE fs.competition_id = $1
     LIMIT 1`,
    [competitionId]
  );
  return r.rows[0] || null;
}

export async function updateFraudSettings({
  competitionId,
  uniqueClickWindowHours,
  dailyClickCap = "",
  burstDetectionWindowMinutes,
  maxClicksPerVisitor,
  suspiciousThreshold,
  blockObviousBots,
  adminId = "admin"
}) {
  const values = {
    uniqueClickWindowHours: Math.max(1, Number.parseInt(String(uniqueClickWindowHours), 10) || 2160),
    dailyClickCap: String(dailyClickCap ?? "").trim() === "" ? null : Math.max(1, Number.parseInt(String(dailyClickCap), 10) || 1),
    burstDetectionWindowMinutes: Math.max(1, Number.parseInt(String(burstDetectionWindowMinutes), 10) || 5),
    maxClicksPerVisitor: Math.max(1, Number.parseInt(String(maxClicksPerVisitor), 10) || 8),
    suspiciousThreshold: Math.max(1, Number.parseInt(String(suspiciousThreshold), 10) || 20),
    blockObviousBots: Boolean(blockObviousBots)
  };

  await withTransaction(async (client) => {
    const before = await client.query(
      "SELECT * FROM fraud_settings WHERE competition_id = $1 LIMIT 1",
      [competitionId]
    );

    await client.query(
      `INSERT INTO fraud_settings
        (competition_id, unique_click_window_hours, daily_click_cap,
         burst_detection_window_minutes, max_clicks_per_visitor,
         suspicious_threshold, block_obvious_bots, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (competition_id)
       DO UPDATE SET
         unique_click_window_hours = EXCLUDED.unique_click_window_hours,
         daily_click_cap = EXCLUDED.daily_click_cap,
         burst_detection_window_minutes = EXCLUDED.burst_detection_window_minutes,
         max_clicks_per_visitor = EXCLUDED.max_clicks_per_visitor,
         suspicious_threshold = EXCLUDED.suspicious_threshold,
         block_obvious_bots = EXCLUDED.block_obvious_bots,
         updated_at = NOW()`,
      [
        competitionId,
        values.uniqueClickWindowHours,
        values.dailyClickCap,
        values.burstDetectionWindowMinutes,
        values.maxClicksPerVisitor,
        values.suspiciousThreshold,
        values.blockObviousBots
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'fraud_settings_updated','competition',$3,'Paramètres anti-fraude modifiés',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        competitionId,
        JSON.stringify({ before: before.rows[0] || null, after: values })
      ]
    );
  });

  return values;
}

export async function listFraudFlags(competitionId, limit = 200) {
  const r = await query(
    `SELECT f.*, p.pseudonym, cp.referral_code
     FROM fraud_flags f
     LEFT JOIN participants p ON p.id = f.participant_id
     LEFT JOIN competition_participants cp
       ON cp.participant_id = f.participant_id
      AND cp.competition_id = f.competition_id
     WHERE f.competition_id = $1
     ORDER BY
       CASE f.status WHEN 'open' THEN 0 ELSE 1 END,
       f.risk_score DESC,
       f.created_at DESC
     LIMIT $2`,
    [competitionId, Math.max(1, Math.min(500, Number(limit) || 200))]
  );
  return r.rows;
}

export async function createFraudFlag({
  competitionId,
  participantId = null,
  visitorId = null,
  riskScore = 0,
  reason,
  metadata = {}
}) {
  const existing = await query(
    `SELECT id
     FROM fraud_flags
     WHERE competition_id = $1
       AND COALESCE(participant_id,'') = COALESCE($2,'')
       AND COALESCE(visitor_id,'') = COALESCE($3,'')
       AND reason = $4
       AND status = 'open'
       AND created_at > NOW() - interval '1 hour'
     LIMIT 1`,
    [competitionId, participantId, visitorId, String(reason || "suspicious")]
  );
  if (existing.rowCount) return existing.rows[0].id;

  const flagId = id("fraud");
  await query(
    `INSERT INTO fraud_flags
      (id, competition_id, participant_id, visitor_id, risk_score, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      flagId,
      competitionId,
      participantId,
      visitorId,
      Number(riskScore || 0),
      String(reason || "Activité suspecte").slice(0, 500),
      JSON.stringify(metadata || {})
    ]
  );
  return flagId;
}

export async function resolveFraudFlag({
  competitionId,
  flagId,
  action,
  adminId = "admin"
}) {
  const allowed = new Set(["ignored","invalidated","suspended","blocked"]);
  if (!allowed.has(String(action))) throw new Error("Action anti-fraude invalide");

  return withTransaction(async (client) => {
    const flagResult = await client.query(
      `SELECT *
       FROM fraud_flags
       WHERE id = $1
         AND competition_id = $2
       FOR UPDATE`,
      [flagId, competitionId]
    );
    const flag = flagResult.rows[0];
    if (!flag) return {ok:false,reason:"not_found"};

    let participantId = flag.participant_id || null;
    const referralCode = flag?.metadata?.referralCode || null;

    if (!participantId && referralCode) {
      const membership = await client.query(
        `SELECT participant_id
         FROM competition_participants
         WHERE competition_id=$1 AND referral_code=$2
         LIMIT 1`,
        [competitionId,referralCode]
      );
      participantId = membership.rows[0]?.participant_id || null;
    }

    let reversedPoints = 0;
    const affected = new Set();

    if (action === "invalidated" && flag.visitor_id) {
      const visits = await client.query(
        `SELECT id,participant_id
         FROM visits
         WHERE competition_id=$1
           AND visitor_id=$2
           AND is_valid=TRUE
         FOR UPDATE`,
        [competitionId,flag.visitor_id]
      );

      for (const visit of visits.rows) {
        if (visit.participant_id) affected.add(visit.participant_id);
        const txs = await client.query(
          `SELECT id,participant_id,final_points
           FROM point_transactions
           WHERE competition_id=$1
             AND type='valid_click'
             AND source_id=$2`,
          [competitionId,visit.id]
        );

        for (const tx of txs.rows) {
          const reversalKey="fraud_reversal:"+tx.id;
          const reversalId=id("ptx");
          const inserted=await client.query(
            `INSERT INTO point_transactions
             (id,competition_id,participant_id,type,base_points,multiplier,final_points,
              source_id,idempotency_key,description,created_by,metadata)
             VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,$7,$8,$9::jsonb)
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING final_points`,
            [
              reversalId,
              competitionId,
              tx.participant_id,
              -Math.abs(Number(tx.final_points||0)),
              tx.id,
              reversalKey,
              "Annulation anti-fraude",
              adminId,
              JSON.stringify({flagId,originalTransactionId:tx.id,visitorId:flag.visitor_id})
            ]
          );
          if(inserted.rowCount){
            reversedPoints += Math.abs(Number(tx.final_points||0));
            affected.add(tx.participant_id);
          }
        }
      }

      await client.query(
        `UPDATE visits
         SET is_valid = FALSE,
             invalid_reason = 'admin_invalidated'
         WHERE competition_id = $1
           AND visitor_id = $2`,
        [competitionId, flag.visitor_id]
      );

      for (const pid of affected) {
        const totals=await client.query(
          `SELECT
             COALESCE((SELECT SUM(final_points) FROM point_transactions
                       WHERE competition_id=$1 AND participant_id=$2),0)::int AS points,
             COALESCE((SELECT COUNT(*) FROM visits
                       WHERE competition_id=$1 AND participant_id=$2),0)::int AS raw_clicks,
             COALESCE((SELECT COUNT(*) FROM visits
                       WHERE competition_id=$1 AND participant_id=$2 AND is_unique=TRUE),0)::int AS unique_clicks,
             COALESCE((SELECT COUNT(*) FROM visits
                       WHERE competition_id=$1 AND participant_id=$2 AND is_valid=TRUE),0)::int AS valid_clicks`,
          [competitionId,pid]
        );
        const t=totals.rows[0]||{};
        await client.query(
          `UPDATE competition_participants
           SET total_points_cache=$3,
               raw_clicks_cache=$4,
               unique_clicks_cache=$5,
               valid_clicks_cache=$6
           WHERE competition_id=$1 AND participant_id=$2`,
          [
            competitionId,pid,
            Math.max(0,Number(t.points||0)),
            Number(t.raw_clicks||0),
            Number(t.unique_clicks||0),
            Number(t.valid_clicks||0)
          ]
        );
      }
    }

    if (participantId && (action === "suspended" || action === "blocked")) {
      await client.query(
        "UPDATE participants SET status = $2, updated_at = NOW() WHERE id = $1",
        [participantId, action === "blocked" ? "blocked" : "suspended"]
      );
      await client.query(
        `UPDATE competition_participants
         SET status = 'suspended'
         WHERE competition_id = $1
           AND participant_id = $2`,
        [competitionId, participantId]
      );
    }

    await client.query(
      `UPDATE fraud_flags
       SET status = $3,
           participant_id = COALESCE(participant_id,$4),
           resolved_at = NOW()
       WHERE id = $1
         AND competition_id = $2`,
      [flagId, competitionId, action, participantId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'fraud_flag_resolved','fraud_flag',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        flagId,
        "Signal anti-fraude traité",
        JSON.stringify({
          competitionId,
          action,
          participantId,
          referralCode,
          reversedPoints,
          affectedParticipants:[...affected]
        })
      ]
    );

    return {
      ok:true,
      action,
      participantId,
      referralCode,
      reversedPoints,
      affectedParticipants:[...affected]
    };
  });
}) {
  const allowed = new Set(["ignored","invalidated","suspended","blocked"]);
  if (!allowed.has(String(action))) throw new Error("Action anti-fraude invalide");

  return withTransaction(async (client) => {
    const flagResult = await client.query(
      `SELECT *
       FROM fraud_flags
       WHERE id = $1
         AND competition_id = $2
       FOR UPDATE`,
      [flagId, competitionId]
    );
    const flag = flagResult.rows[0];
    if (!flag) return false;

    await client.query(
      `UPDATE fraud_flags
       SET status = $3,
           resolved_at = NOW()
       WHERE id = $1
         AND competition_id = $2`,
      [flagId, competitionId, action]
    );

    if (flag.participant_id && (action === "suspended" || action === "blocked")) {
      await client.query(
        "UPDATE participants SET status = $2, updated_at = NOW() WHERE id = $1",
        [flag.participant_id, action === "blocked" ? "blocked" : "suspended"]
      );
      await client.query(
        `UPDATE competition_participants
         SET status = 'suspended'
         WHERE competition_id = $1
           AND participant_id = $2`,
        [competitionId, flag.participant_id]
      );
    }

    if (action === "invalidated" && flag.visitor_id) {
      await client.query(
        `UPDATE visits
         SET is_valid = FALSE,
             invalid_reason = 'admin_invalidated'
         WHERE competition_id = $1
           AND visitor_id = $2`,
        [competitionId, flag.visitor_id]
      );
    }

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'fraud_flag_resolved','fraud_flag',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        flagId,
        "Signal anti-fraude traité",
        JSON.stringify({ competitionId, action, participantId: flag.participant_id })
      ]
    );

    return true;
  });
}
