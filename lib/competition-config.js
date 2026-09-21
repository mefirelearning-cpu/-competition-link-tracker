import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { freezeFinalRanking, generateRewardCoupons } from "./rewards.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

export async function getCompetitionConfig(competitionId) {
  const r = await query(
    `SELECT *
     FROM competitions
     WHERE id = $1
     LIMIT 1`,
    [competitionId]
  );
  return r.rows[0] || null;
}

export async function updateCompetitionConfig({
  competitionId,
  startsAt = null,
  endsAt = null,
  timezone = "Africa/Douala",
  registrationsOpen = true,
  leaderboardVisible = true,
  leaderboardFrozen = false,
  winnerCount = 1,
  maxParticipants = null,
  rules = "",
  adminId = "admin"
}) {
  return withTransaction(async (client) => {
    const before = await client.query(
      "SELECT * FROM competitions WHERE id = $1 FOR UPDATE",
      [competitionId]
    );
    if (!before.rowCount) return { ok: false, reason: "not_found" };

    const start = startsAt || null;
    const end = endsAt || null;
    if (start && end && new Date(end) <= new Date(start)) {
      return { ok: false, reason: "invalid_dates" };
    }

    await client.query(
      `UPDATE competitions
       SET starts_at = $2,
           ends_at = $3,
           timezone = $4,
           registrations_open = $5,
           leaderboard_visible = $6,
           leaderboard_frozen = $7,
           winner_count = $8,
           max_participants = $9,
           rules = $10,
           updated_at = NOW()
       WHERE id = $1`,
      [
        competitionId,
        start,
        end,
        String(timezone || "Africa/Douala").slice(0, 80),
        Boolean(registrationsOpen),
        Boolean(leaderboardVisible),
        Boolean(leaderboardFrozen),
        Math.max(1, Number.parseInt(String(winnerCount), 10) || 1),
        maxParticipants === null || String(maxParticipants).trim() === ""
          ? null
          : Math.max(1, Number.parseInt(String(maxParticipants), 10) || 1),
        String(rules || "").slice(0, 12000)
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'competition_config_updated','competition',$3,'Configuration de compétition modifiée',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        competitionId,
        JSON.stringify({ before: before.rows[0] })
      ]
    );

    return { ok: true };
  });
}

export async function resizeCompetitionDays({
  competitionId,
  dayCount,
  force = false,
  adminId = "admin"
}) {
  const target = Math.max(1, Math.min(365, Number.parseInt(String(dayCount), 10) || 1));

  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT d.id, d.day_number, d.title, d.status,
              (SELECT COUNT(*) FROM missions m WHERE m.day_id = d.id)::int AS mission_count
       FROM competition_days d
       WHERE d.competition_id = $1
       ORDER BY d.day_number ASC
       FOR UPDATE`,
      [competitionId]
    );

    const current = existing.rows.length;

    if (target < current) {
      const risky = existing.rows.filter(r =>
        Number(r.day_number) > target &&
        (Number(r.mission_count) > 0 || r.status !== "draft")
      );

      if (risky.length && !force) {
        return {
          ok: false,
          reason: "shrink_requires_confirmation",
          riskyDays: risky
        };
      }

      await client.query(
        `DELETE FROM competition_days
         WHERE competition_id = $1
           AND day_number > $2`,
        [competitionId, target]
      );
    }

    if (target > current) {
      for (let n = current + 1; n <= target; n++) {
        await client.query(
          `INSERT INTO competition_days
            (id, competition_id, day_number, title, status, reward_daily_points)
           VALUES ($1,$2,$3,$4,'draft',0)
           ON CONFLICT (competition_id, day_number) DO NOTHING`,
          [id("day"), competitionId, n, "Jour " + n]
        );
      }
    }

    await client.query(
      `UPDATE competitions
       SET settings = settings || $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [competitionId, JSON.stringify({ configuredDayCount: target })]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'competition_days_resized','competition',$3,'Durée en journées modifiée',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        competitionId,
        JSON.stringify({ previousDayCount: current, newDayCount: target, force })
      ]
    );

    return { ok: true, previousDayCount: current, newDayCount: target };
  });
}

export async function ensureCompetitionLifecycle(competitionId) {
  const comp = await getCompetitionConfig(competitionId);
  if (!comp) return null;

  const now = Date.now();
  const start = comp.starts_at ? new Date(comp.starts_at).getTime() : null;
  const end = comp.ends_at ? new Date(comp.ends_at).getTime() : null;

  if (comp.status === "scheduled" && start !== null && start <= now) {
    await query(
      `UPDATE competitions
       SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND status = 'scheduled'`,
      [competitionId]
    );
    comp.status = "active";
  }

  if (comp.status === "active" && end !== null && end <= now) {
    await freezeFinalRanking(competitionId, "system");
    await generateRewardCoupons(competitionId, "system");
    comp.status = "completed";
    comp.leaderboard_frozen = true;
  }

  return comp;
}
