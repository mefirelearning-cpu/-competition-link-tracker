import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { awardLedgerEvent } from "./scoring.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

export async function listCompetitionDays(competitionId) {
  const result = await query(
    `SELECT d.*, c.name AS featured_campaign_name, c.slug AS featured_campaign_slug
     FROM competition_days d
     LEFT JOIN campaigns c ON c.id = d.featured_campaign_id
     WHERE d.competition_id = $1
     ORDER BY d.day_number ASC`,
    [competitionId]
  );
  return result.rows;
}

export async function getActiveDay(competitionId) {
  const result = await query(
    `SELECT d.*, c.name AS featured_campaign_name, c.slug AS featured_campaign_slug,
            c.image_data AS featured_campaign_image,
            c.commercial_text AS featured_campaign_text
     FROM competition_days d
     LEFT JOIN campaigns c ON c.id = d.featured_campaign_id
     WHERE d.competition_id = $1
       AND d.status = 'active'
       AND (d.starts_at IS NULL OR d.starts_at <= NOW())
       AND (d.ends_at IS NULL OR d.ends_at > NOW())
     ORDER BY d.day_number ASC
     LIMIT 1`,
    [competitionId]
  );
  return result.rows[0] || null;
}

export async function listDayMissions(competitionId, dayId) {
  const result = await query(
    `SELECT m.*, c.name AS campaign_name, c.slug AS campaign_slug
     FROM missions m
     LEFT JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.competition_id = $1
       AND m.day_id = $2
       AND m.status IN ('active','scheduled')
     ORDER BY m.created_at ASC`,
    [competitionId, dayId]
  );
  return result.rows;
}

export async function createCompetitionDay({
  competitionId,
  dayNumber,
  title,
  description = "",
  status = "draft",
  startsAt = null,
  endsAt = null,
  rewardDailyPoints = 0,
  featuredCampaignId = null,
  marketingMessage = "",
  notificationText = "",
  adminId = "admin"
}) {
  const allowed = new Set(["draft","scheduled","active","finished"]);
  const safeStatus = allowed.has(String(status)) ? String(status) : "draft";
  const dayId = id("day");

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO competition_days
        (id, competition_id, day_number, title, description, status,
         starts_at, ends_at, reward_daily_points, featured_campaign_id,
         marketing_message, notification_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (competition_id, day_number)
       DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         reward_daily_points = EXCLUDED.reward_daily_points,
         featured_campaign_id = EXCLUDED.featured_campaign_id,
         marketing_message = EXCLUDED.marketing_message,
         notification_text = EXCLUDED.notification_text,
         updated_at = NOW()`,
      [
        dayId,
        competitionId,
        Math.max(1, Number.parseInt(String(dayNumber), 10) || 1),
        String(title || "Journée").trim().slice(0, 160),
        String(description || "").trim().slice(0, 4000),
        safeStatus,
        startsAt || null,
        endsAt || null,
        Number.parseInt(String(rewardDailyPoints), 10) || 0,
        featuredCampaignId || null,
        String(marketingMessage || "").trim().slice(0, 3000),
        String(notificationText || "").trim().slice(0, 1000)
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'competition_day_saved','competition_day',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        dayId,
        "Journée de compétition enregistrée",
        JSON.stringify({ competitionId, dayNumber, status: safeStatus })
      ]
    );
  });

  return dayId;
}

export async function createMission({
  competitionId,
  dayId,
  campaignId = null,
  title,
  description = "",
  pointsFixed = 0,
  multiplier = 1,
  validationMode = "manual",
  status = "active",
  startsAt = null,
  endsAt = null,
  adminId = "admin"
}) {
  const missionId = id("mission");
  const safeValidation = validationMode === "automatic" ? "automatic" : "manual";
  const safeStatus = new Set(["draft","scheduled","active","finished"]).has(String(status))
    ? String(status)
    : "draft";

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO missions
        (id, competition_id, day_id, campaign_id, title, description,
         points_fixed, multiplier, validation_mode, status, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        missionId,
        competitionId,
        dayId,
        campaignId || null,
        String(title || "Mission").trim().slice(0, 160),
        String(description || "").trim().slice(0, 3000),
        Number.parseInt(String(pointsFixed), 10) || 0,
        Math.max(0, Number(multiplier) || 1),
        safeValidation,
        safeStatus,
        startsAt || null,
        endsAt || null
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'mission_created','mission',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        missionId,
        "Mission créée",
        JSON.stringify({ competitionId, dayId })
      ]
    );
  });

  return missionId;
}

async function currentStreak(client, competitionId, participantId) {
  const result = await client.query(
    `SELECT claimed_at::date AS d
     FROM daily_claims
     WHERE competition_id = $1
       AND participant_id = $2
     ORDER BY claimed_at DESC
     LIMIT 60`,
    [competitionId, participantId]
  );

  if (!result.rows.length) return 0;

  const dates = [...new Set(result.rows.map(r => String(r.d)))].sort().reverse();
  let streak = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1] + "T00:00:00Z");
    const curr = new Date(dates[i] + "T00:00:00Z");
    const diff = Math.round((prev - curr) / 86400000);
    if (diff === 1) streak += 1;
    else break;
  }
  return streak;
}

export async function claimDailyReward({
  competitionId,
  dayId,
  participantId
}) {
  const dayResult = await query(
    `SELECT id, reward_daily_points, status, starts_at, ends_at
     FROM competition_days
     WHERE id = $1
       AND competition_id = $2
     LIMIT 1`,
    [dayId, competitionId]
  );
  const day = dayResult.rows[0];

  if (!day || day.status !== "active") {
    return { ok: false, reason: "day_inactive" };
  }

  if (day.starts_at && new Date(day.starts_at).getTime() > Date.now()) {
    return { ok: false, reason: "day_not_started" };
  }
  if (day.ends_at && new Date(day.ends_at).getTime() <= Date.now()) {
    return { ok: false, reason: "day_finished" };
  }

  const existing = await query(
    `SELECT id, points_awarded
     FROM daily_claims
     WHERE day_id = $1
       AND participant_id = $2
     LIMIT 1`,
    [dayId, participantId]
  );
  if (existing.rowCount) {
    return { ok: false, reason: "already_claimed", awarded: Number(existing.rows[0].points_awarded || 0) };
  }

  const claimId = id("claim");
  const award = await awardLedgerEvent({
    competitionId,
    participantId,
    eventId: dayId,
    type: "daily_checkin",
    basePoints: Number(day.reward_daily_points || 0),
    multiplier: 1,
    sourceId: dayId,
    idempotencyKey: "daily:" + dayId + ":" + participantId,
    description: "Récompense quotidienne",
    createdBy: "system",
    metadata: { dayId }
  });

  await query(
    `INSERT INTO daily_claims
      (id, competition_id, day_id, participant_id, points_awarded, point_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (day_id, participant_id) DO NOTHING`,
    [
      claimId,
      competitionId,
      dayId,
      participantId,
      Number(award.awarded || 0),
      null
    ]
  );

  let totalPoints = award.totalPoints;
  let streakAwarded = 0;

  await withTransaction(async (client) => {
    const streak = await currentStreak(client, competitionId, participantId);
    if (streak < 2) return;

    const rules = await client.query(
      `SELECT id, consecutive_days, bonus_points
       FROM streak_rules
       WHERE competition_id = $1
         AND enabled = TRUE
         AND consecutive_days <= $2
       ORDER BY consecutive_days ASC`,
      [competitionId, streak]
    );

    for (const rule of rules.rows) {
      const result = await awardLedgerEvent({
        competitionId,
        participantId,
        eventId: dayId,
        type: "streak_bonus",
        basePoints: Number(rule.bonus_points || 0),
        multiplier: 1,
        sourceId: rule.id,
        idempotencyKey: "streak:" + competitionId + ":" + participantId + ":" + rule.id + ":" + dayId,
        description: "Bonus de série " + rule.consecutive_days + " jours",
        createdBy: "system",
        metadata: { streak, ruleId: rule.id }
      });
      streakAwarded += Number(result.awarded || 0);
      totalPoints = result.totalPoints;
    }
  });

  return {
    ok: true,
    awarded: Number(award.awarded || 0),
    streakAwarded,
    totalPoints
  };
}

export async function addStreakRule({
  competitionId,
  consecutiveDays,
  bonusPoints
}) {
  await query(
    `INSERT INTO streak_rules
      (id, competition_id, consecutive_days, bonus_points, enabled)
     VALUES ($1,$2,$3,$4,TRUE)
     ON CONFLICT (competition_id, consecutive_days)
     DO UPDATE SET
       bonus_points = EXCLUDED.bonus_points,
       enabled = TRUE,
       updated_at = NOW()`,
    [
      id("streak"),
      competitionId,
      Math.max(2, Number.parseInt(String(consecutiveDays), 10) || 2),
      Number.parseInt(String(bonusPoints), 10) || 0
    ]
  );
}


export async function submitMissionCompletion({
  competitionId,
  missionId,
  participantId,
  proofData = ""
}) {
  const mission = await query(
    `SELECT id, status, validation_mode
     FROM missions
     WHERE id = $1
       AND competition_id = $2
       AND status = 'active'
     LIMIT 1`,
    [missionId, competitionId]
  );
  if (!mission.rowCount) return { ok:false, reason:"mission_inactive" };

  const completionId = id("mcomp");
  const automatic = mission.rows[0].validation_mode === "automatic";
  const inserted = await query(
    `INSERT INTO mission_completions
      (id, mission_id, competition_id, participant_id, status, proof_data,
       reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5='confirmed' THEN NOW() ELSE NULL END)
     ON CONFLICT (mission_id, participant_id) DO NOTHING
     RETURNING id`,
    [
      completionId,
      missionId,
      competitionId,
      participantId,
      automatic ? "confirmed" : "pending",
      String(proofData || "").slice(0, 5000),
      automatic ? "system" : null
    ]
  );

  if (!inserted.rowCount) {
    return {
      ok:true,
      duplicate:true,
      completionId:null,
      validationMode:mission.rows[0].validation_mode
    };
  }

  let award={awarded:0,totalPoints:null};
  if (automatic) {
    const ctx=await query(
      `SELECT points_fixed,multiplier,campaign_id,title
       FROM missions
       WHERE id=$1 LIMIT 1`,
      [missionId]
    );
    const m=ctx.rows[0];
    award=await awardLedgerEvent({
      competitionId,
      participantId,
      campaignId:m.campaign_id,
      eventId:missionId,
      type:"daily_mission",
      basePoints:Number(m.points_fixed||0),
      multiplier:Number(m.multiplier||1),
      sourceId:completionId,
      idempotencyKey:"mission:"+completionId,
      description:"Mission automatique : "+m.title,
      createdBy:"system",
      metadata:{completionId,missionId}
    });
  }

  return {
    ok:true,
    duplicate:false,
    completionId,
    validationMode:mission.rows[0].validation_mode,
    awarded:Number(award.awarded||0),
    totalPoints:award.totalPoints
  };
}

export async function listMissionCompletions(competitionId) {
  const r = await query(
    `SELECT mc.id, mc.status, mc.proof_data, mc.created_at,
            m.id AS mission_id, m.title AS mission_title, m.points_fixed, m.multiplier,
            p.id AS participant_id, p.pseudonym,
            cp.referral_code
     FROM mission_completions mc
     JOIN missions m ON m.id = mc.mission_id
     JOIN participants p ON p.id = mc.participant_id
     LEFT JOIN competition_participants cp
       ON cp.participant_id = p.id
      AND cp.competition_id = mc.competition_id
     WHERE mc.competition_id = $1
     ORDER BY
       CASE mc.status WHEN 'pending' THEN 0 ELSE 1 END,
       mc.created_at DESC`,
    [competitionId]
  );
  return r.rows;
}

export async function reviewMissionCompletion({
  completionId,
  action,
  adminId = "admin"
}) {
  if (!["confirmed","rejected"].includes(String(action))) {
    throw new Error("Action mission invalide");
  }

  const ctx = await query(
    `SELECT mc.*, m.title, m.points_fixed, m.multiplier, m.campaign_id
     FROM mission_completions mc
     JOIN missions m ON m.id = mc.mission_id
     WHERE mc.id = $1
     LIMIT 1`,
    [completionId]
  );
  const row = ctx.rows[0];
  if (!row) return {ok:false,reason:"not_found"};
  if (row.status !== "pending") return {ok:true,duplicate:true,participantId:row.participant_id,competitionId:row.competition_id};

  let award = {awarded:0,totalPoints:null};
  if (action === "confirmed") {
    award = await awardLedgerEvent({
      competitionId: row.competition_id,
      participantId: row.participant_id,
      campaignId: row.campaign_id,
      eventId: row.mission_id,
      type: "daily_mission",
      basePoints: Number(row.points_fixed || 0),
      multiplier: Number(row.multiplier || 1),
      sourceId: completionId,
      idempotencyKey: "mission:" + completionId,
      description: "Mission confirmée : " + row.title,
      createdBy: adminId,
      metadata: {completionId, missionId:row.mission_id}
    });
  }

  await withTransaction(async client=>{
    await client.query(
      `UPDATE mission_completions
       SET status=$2, reviewed_by=$3, reviewed_at=NOW()
       WHERE id=$1 AND status='pending'`,
      [completionId,action,adminId]
    );
    await client.query(
      `INSERT INTO admin_audit_logs
        (id,admin_id,action,entity_type,entity_id,description,metadata)
       VALUES ($1,$2,'mission_reviewed','mission_completion',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        completionId,
        action==="confirmed" ? "Mission confirmée" : "Mission rejetée",
        JSON.stringify({pointsAwarded:Number(award.awarded||0)})
      ]
    );
  });

  return {
    ok:true,
    action,
    awarded:Number(award.awarded||0),
    totalPoints:award.totalPoints,
    participantId:row.participant_id,
    competitionId:row.competition_id
  };
}
