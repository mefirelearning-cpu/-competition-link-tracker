import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

function couponCode(pseudonym, value) {
  const base = String(pseudonym || "USER")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 10) || "USER";
  return base + "-" + String(value).replace(/[^0-9A-Z]+/gi, "") + "-" + randomBytes(2).toString("hex").toUpperCase();
}

export async function listPrizes(competitionId) {
  const r = await query(
    `SELECT p.*, part.pseudonym AS chosen_by_name
     FROM prizes p
     LEFT JOIN participants part ON part.id = p.chosen_by_participant_id
     WHERE p.competition_id = $1
     ORDER BY p.sort_order ASC, p.created_at ASC`,
    [competitionId]
  );
  return r.rows;
}

export async function addPrize({
  competitionId,
  name,
  description = "",
  durationText = "",
  sortOrder = 0,
  adminId = "admin"
}) {
  const prizeId = id("prize");
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO prizes
        (id, competition_id, name, description, duration_text, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        prizeId,
        competitionId,
        String(name || "Lot").trim().slice(0, 160),
        String(description || "").trim().slice(0, 1000),
        String(durationText || "").trim().slice(0, 120),
        Number.parseInt(String(sortOrder), 10) || 0
      ]
    );
    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'prize_created','prize',$3,'Lot créé',$4::jsonb)`,
      [id("audit"), adminId, prizeId, JSON.stringify({ competitionId })]
    );
  });
  return prizeId;
}

export async function listRewardTiers(competitionId) {
  const r = await query(
    `SELECT *
     FROM reward_tiers
     WHERE competition_id = $1
     ORDER BY sort_order ASC, min_points ASC`,
    [competitionId]
  );
  return r.rows;
}

export async function addRewardTier({
  competitionId,
  minPoints,
  maxPoints = "",
  rewardType = "discount",
  rewardValue,
  validityDays = "",
  eligibleServices = [],
  conditions = "",
  sortOrder = 0,
  adminId = "admin"
}) {
  const tierId = id("tier");
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO reward_tiers
        (id, competition_id, min_points, max_points, reward_type, reward_value,
         validity_days, eligible_services, conditions, sort_order, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,TRUE)`,
      [
        tierId,
        competitionId,
        Math.max(0, Number.parseInt(String(minPoints), 10) || 0),
        String(maxPoints || "").trim() === "" ? null : Math.max(0, Number.parseInt(String(maxPoints), 10) || 0),
        String(rewardType || "discount").slice(0, 40),
        Number(rewardValue) || 0,
        String(validityDays || "").trim() === "" ? null : Math.max(1, Number.parseInt(String(validityDays), 10) || 1),
        JSON.stringify(Array.isArray(eligibleServices) ? eligibleServices : []),
        String(conditions || "").trim().slice(0, 1000),
        Number.parseInt(String(sortOrder), 10) || 0
      ]
    );
    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'reward_tier_created','reward_tier',$3,'Palier créé',$4::jsonb)`,
      [id("audit"), adminId, tierId, JSON.stringify({ competitionId })]
    );
  });
  return tierId;
}

async function rankedParticipants(client, competitionId) {
  const r = await client.query(
    `SELECT cp.participant_id, cp.total_points_cache, cp.unique_clicks_cache,
            cp.valid_clicks_cache, cp.raw_clicks_cache, p.pseudonym,
            ROW_NUMBER() OVER (
              ORDER BY cp.total_points_cache DESC,
                       cp.valid_clicks_cache DESC,
                       cp.unique_clicks_cache DESC,
                       cp.raw_clicks_cache DESC,
                       cp.joined_at ASC
            )::int AS rank
     FROM competition_participants cp
     JOIN participants p ON p.id = cp.participant_id
     WHERE cp.competition_id = $1
       AND cp.status = 'active'
     ORDER BY rank ASC`,
    [competitionId]
  );
  return r.rows;
}

export async function freezeFinalRanking(competitionId, adminId = "system") {
  return withTransaction(async (client) => {
    const compResult = await client.query(
      "SELECT * FROM competitions WHERE id = $1 FOR UPDATE",
      [competitionId]
    );
    const comp = compResult.rows[0];
    if (!comp) return { ok: false, reason: "not_found" };

    const ranked = await rankedParticipants(client, competitionId);
    for (const row of ranked) {
      await client.query(
        `UPDATE competition_participants
         SET rank_cache = $3
         WHERE competition_id = $1 AND participant_id = $2`,
        [competitionId, row.participant_id, row.rank]
      );
    }

    await client.query(
      `UPDATE competitions
       SET status = 'completed',
           leaderboard_frozen = TRUE,
           updated_at = NOW()
       WHERE id = $1`,
      [competitionId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'competition_finalized','competition',$3,'Classement final figé',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        competitionId,
        JSON.stringify({ participantCount: ranked.length })
      ]
    );

    return { ok: true, ranked };
  });
}

export async function selectPrize({
  competitionId,
  participantId,
  prizeId,
  selectedBy = "participant"
}) {
  return withTransaction(async (client) => {
    const compResult = await client.query(
      "SELECT status, winner_count FROM competitions WHERE id = $1 FOR UPDATE",
      [competitionId]
    );
    const comp = compResult.rows[0];
    if (!comp || comp.status !== "completed") {
      return { ok: false, reason: "competition_not_completed" };
    }

    const participantResult = await client.query(
      `SELECT rank_cache
       FROM competition_participants
       WHERE competition_id = $1
         AND participant_id = $2
         AND status = 'active'
       FOR UPDATE`,
      [competitionId, participantId]
    );
    const membership = participantResult.rows[0];
    if (!membership?.rank_cache || Number(membership.rank_cache) > Number(comp.winner_count)) {
      return { ok: false, reason: "not_winner" };
    }

    const rank = Number(membership.rank_cache);

    if (rank > 1 && selectedBy !== "admin") {
      const previous = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM prize_selections
         WHERE competition_id = $1
           AND winner_rank < $2`,
        [competitionId, rank]
      );
      if (Number(previous.rows[0]?.count || 0) < rank - 1) {
        return { ok: false, reason: "wait_previous_winners" };
      }
    }

    const prize = await client.query(
      `SELECT id, name, status
       FROM prizes
       WHERE id = $1
         AND competition_id = $2
       FOR UPDATE`,
      [prizeId, competitionId]
    );
    if (!prize.rows[0] || prize.rows[0].status !== "available") {
      return { ok: false, reason: "prize_unavailable" };
    }

    const already = await client.query(
      `SELECT id FROM prize_selections
       WHERE competition_id = $1
         AND participant_id = $2
       LIMIT 1`,
      [competitionId, participantId]
    );
    if (already.rowCount) return { ok: false, reason: "already_selected" };

    const selectionId = id("selection");
    await client.query(
      `INSERT INTO prize_selections
        (id, competition_id, participant_id, prize_id, winner_rank, selected_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [selectionId, competitionId, participantId, prizeId, rank, selectedBy]
    );

    await client.query(
      `UPDATE prizes
       SET status = 'chosen',
           chosen_by_participant_id = $2,
           chosen_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [prizeId, participantId]
    );

    return { ok: true, selectionId, rank, prizeName: prize.rows[0].name };
  });
}

export async function generateRewardCoupons(competitionId, adminId = "system") {
  return withTransaction(async (client) => {
    const compResult = await client.query(
      "SELECT status, winner_count FROM competitions WHERE id = $1 FOR UPDATE",
      [competitionId]
    );
    const comp = compResult.rows[0];
    if (!comp || comp.status !== "completed") {
      return { ok: false, reason: "competition_not_completed", created: 0 };
    }

    const members = await client.query(
      `SELECT cp.participant_id, cp.rank_cache, cp.total_points_cache, p.pseudonym
       FROM competition_participants cp
       JOIN participants p ON p.id = cp.participant_id
       WHERE cp.competition_id = $1
         AND cp.status = 'active'
         AND (cp.rank_cache IS NULL OR cp.rank_cache > $2)
       ORDER BY cp.total_points_cache DESC`,
      [competitionId, Number(comp.winner_count)]
    );

    const tiers = await client.query(
      `SELECT *
       FROM reward_tiers
       WHERE competition_id = $1
         AND enabled = TRUE
       ORDER BY min_points DESC`,
      [competitionId]
    );

    let created = 0;

    for (const member of members.rows) {
      const existing = await client.query(
        `SELECT 1
         FROM coupons
         WHERE competition_id = $1
           AND participant_id = $2
         LIMIT 1`,
        [competitionId, member.participant_id]
      );
      if (existing.rowCount) continue;

      const tier = tiers.rows.find(t => {
        const points = Number(member.total_points_cache || 0);
        const min = Number(t.min_points || 0);
        const max = t.max_points === null ? Infinity : Number(t.max_points);
        return points >= min && points <= max;
      });
      if (!tier) continue;

      const code = couponCode(member.pseudonym, tier.reward_value);
      await client.query(
        `INSERT INTO coupons
          (id, competition_id, participant_id, reward_tier_id, code,
           reward_type, reward_value, expires_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
           CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() + ($8::text || ' days')::interval END,
           $9::jsonb)`,
        [
          id("coupon"),
          competitionId,
          member.participant_id,
          tier.id,
          code,
          tier.reward_type,
          tier.reward_value,
          tier.validity_days,
          JSON.stringify({
            pointsAtIssue: Number(member.total_points_cache || 0),
            eligibleServices: tier.eligible_services,
            conditions: tier.conditions
          })
        ]
      );
      created++;
    }

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'reward_coupons_generated','competition',$3,'Coupons générés',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        competitionId,
        JSON.stringify({ created })
      ]
    );

    return { ok: true, created };
  });
}

export async function participantRewards(competitionId, participantId) {
  const [membership, prizes, selection, coupon, tiers] = await Promise.all([
    query(
      `SELECT cp.rank_cache, cp.total_points_cache, c.status, c.winner_count
       FROM competition_participants cp
       JOIN competitions c ON c.id = cp.competition_id
       WHERE cp.competition_id = $1 AND cp.participant_id = $2
       LIMIT 1`,
      [competitionId, participantId]
    ),
    listPrizes(competitionId),
    query(
      `SELECT ps.*, p.name AS prize_name, p.duration_text
       FROM prize_selections ps
       JOIN prizes p ON p.id = ps.prize_id
       WHERE ps.competition_id = $1 AND ps.participant_id = $2
       LIMIT 1`,
      [competitionId, participantId]
    ),
    query(
      `SELECT *
       FROM coupons
       WHERE competition_id = $1
         AND participant_id = $2
       ORDER BY issued_at DESC
       LIMIT 1`,
      [competitionId, participantId]
    ),
    listRewardTiers(competitionId)
  ]);

  const m = membership.rows[0] || null;
  const points = Number(m?.total_points_cache || 0);
  const nextTier = tiers
    .filter(t => Number(t.min_points) > points)
    .sort((a,b) => Number(a.min_points) - Number(b.min_points))[0] || null;
  const currentTier = tiers
    .filter(t => points >= Number(t.min_points) && (t.max_points === null || points <= Number(t.max_points)))
    .sort((a,b) => Number(b.min_points) - Number(a.min_points))[0] || null;

  return {
    membership: m,
    prizes,
    selection: selection.rows[0] || null,
    coupon: coupon.rows[0] || null,
    currentTier,
    nextTier
  };
}


export async function listCompetitionCoupons(competitionId) {
  const r=await query(
    `SELECT c.*,p.pseudonym
     FROM coupons c
     JOIN participants p ON p.id=c.participant_id
     WHERE c.competition_id=$1
     ORDER BY c.issued_at DESC`,
    [competitionId]
  );
  return r.rows;
}

export async function markCouponUsed({
  competitionId,
  couponId,
  adminId="admin"
}) {
  return withTransaction(async client=>{
    const updated=await client.query(
      `UPDATE coupons
       SET status='used',used_at=NOW()
       WHERE id=$1
         AND competition_id=$2
         AND status='active'
         AND (expires_at IS NULL OR expires_at>NOW())
       RETURNING *`,
      [couponId,competitionId]
    );
    if(!updated.rowCount) return {ok:false,reason:"unavailable"};

    await client.query(
      `INSERT INTO admin_audit_logs
       (id,admin_id,action,entity_type,entity_id,description,metadata)
       VALUES ($1,$2,'coupon_used','coupon',$3,'Coupon marqué comme utilisé',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        couponId,
        JSON.stringify({competitionId})
      ]
    );
    return {ok:true};
  });
}
