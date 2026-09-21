import { createHash, randomBytes } from "node:crypto";
import { databaseConfigured, query, withTransaction } from "./db.js";

function stableId(prefix, value) {
  return prefix + "_" + createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function normalizeCompetitionStatus(status) {
  const map = {
    draft: "draft",
    scheduled: "scheduled",
    active: "active",
    paused: "paused",
    ended: "completed",
    completed: "completed",
    archived: "archived"
  };
  return map[String(status || "draft")] || "draft";
}

async function safely(label, work) {
  if (!databaseConfigured()) return { ok: false, skipped: true };
  try {
    const value = await work();
    return { ok: true, value };
  } catch (error) {
    console.error("postgres-shadow:" + label + ":", error);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function ensureCompetition(client, comp) {
  await client.query(
    `INSERT INTO competitions
      (id, slug, name, status, ends_at, settings, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::timestamptz,NOW()),NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       ends_at = COALESCE(EXCLUDED.ends_at, competitions.ends_at),
       settings = competitions.settings || EXCLUDED.settings,
       updated_at = NOW()`,
    [
      comp.id,
      comp.id,
      comp.name || comp.id,
      normalizeCompetitionStatus(comp.status),
      comp.endsAt || null,
      JSON.stringify({
        shadowSynced: true,
        legacyTheme: comp.theme || "blue",
        legacyPrize: comp.prize || "",
        legacyDestination: comp.destination || ""
      }),
      comp.createdAt || null
    ]
  );
}

async function ensureParticipant(client, comp, participant) {
  await ensureCompetition(client, comp);

  const existing = await client.query(
    `SELECT participant_id
       FROM competition_participants
       WHERE competition_id = $1 AND referral_code = $2
       LIMIT 1`,
    [comp.id, participant.code]
  );

  const participantId =
    existing.rows[0]?.participant_id ||
    stableId("p", comp.id + ":" + participant.code);

  await client.query(
    `INSERT INTO participants
      (id, pseudonym, status, metadata, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,COALESCE($5::timestamptz,NOW()),NOW())
     ON CONFLICT (id) DO UPDATE SET
       pseudonym = EXCLUDED.pseudonym,
       status = EXCLUDED.status,
       metadata = participants.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      participantId,
      participant.name || participant.code,
      participant.active === false ? "suspended" : "active",
      JSON.stringify({ legacyCode: participant.code, shadowSynced: true }),
      participant.createdAt || null
    ]
  );

  await client.query(
    `INSERT INTO competition_participants
      (id, competition_id, participant_id, referral_code, status, joined_at, metadata)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),$7::jsonb)
     ON CONFLICT (competition_id, participant_id) DO UPDATE SET
       referral_code = EXCLUDED.referral_code,
       status = EXCLUDED.status,
       metadata = competition_participants.metadata || EXCLUDED.metadata`,
    [
      stableId("cp", comp.id + ":" + participant.code),
      comp.id,
      participantId,
      participant.code,
      participant.active === false ? "suspended" : "active",
      participant.createdAt || null,
      JSON.stringify({ shadowSynced: true })
    ]
  );

  return participantId;
}

export async function shadowUpsertCompetition(comp) {
  return safely("competition-upsert", async () => {
    await withTransaction((client) => ensureCompetition(client, comp));
  });
}

export async function shadowUpsertParticipant(comp, participant) {
  return safely("participant-upsert", async () => {
    await withTransaction((client) => ensureParticipant(client, comp, participant));
  });
}

export async function shadowUpsertParticipants(comp, participants) {
  return safely("participants-bulk-upsert", async () => {
    await withTransaction(async (client) => {
      for (const participant of participants) {
        await ensureParticipant(client, comp, participant);
      }
    });
  });
}

export async function shadowWithdrawParticipant(competitionId, referralCode) {
  return safely("participant-withdraw", async () => {
    await query(
      `UPDATE competition_participants
       SET status = 'withdrawn'
       WHERE competition_id = $1 AND referral_code = $2`,
      [competitionId, referralCode]
    );
  });
}

export async function shadowSyncStats(competitionId, referralCode, stats) {
  return safely("stats-sync", async () => {
    await query(
      `UPDATE competition_participants
       SET raw_clicks_cache = $3,
           unique_clicks_cache = $4,
           valid_clicks_cache = GREATEST(valid_clicks_cache, $4),
           total_points_cache = $5
       WHERE competition_id = $1 AND referral_code = $2`,
      [
        competitionId,
        referralCode,
        Number(stats.clicks || 0),
        Number(stats.unique || 0),
        Math.max(0, Number(stats.points || 0))
      ]
    );
  });
}

export async function shadowRecordAdminAdjustment({
  competitionId,
  referralCode,
  amount,
  reason,
  totalAfter
}) {
  return safely("admin-adjustment", async () => {
    const adjustmentId = randomBytes(12).toString("hex");
    await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT cp.participant_id
         FROM competition_participants cp
         WHERE cp.competition_id = $1 AND cp.referral_code = $2
         LIMIT 1`,
        [competitionId, referralCode]
      );
      const participantId = found.rows[0]?.participant_id;
      if (!participantId) throw new Error("Participant shadow record not found");

      const txId = "ptx_" + adjustmentId;
      const idempotencyKey = "admin_adjustment:" + adjustmentId;

      await client.query(
        `INSERT INTO point_transactions
          (id, competition_id, participant_id, type, base_points, multiplier,
           final_points, source_id, idempotency_key, description, created_by, metadata)
         VALUES ($1,$2,$3,'admin_adjustment',$4,1,$4,$5,$6,$7,'admin',$8::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          txId,
          competitionId,
          participantId,
          amount,
          referralCode,
          idempotencyKey,
          reason || "Ajustement manuel",
          JSON.stringify({ shadowWrite: true })
        ]
      );

      await client.query(
        `UPDATE competition_participants
         SET total_points_cache = $3
         WHERE competition_id = $1 AND referral_code = $2`,
        [competitionId, referralCode, Math.max(0, Number(totalAfter || 0))]
      );

      await client.query(
        `INSERT INTO admin_audit_logs
          (id, admin_id, action, entity_type, entity_id, description, metadata)
         VALUES ($1,'admin','points_adjusted','participant',$2,$3,$4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          "audit_" + adjustmentId,
          participantId,
          reason || "Ajustement manuel",
          JSON.stringify({
            competitionId,
            referralCode,
            amount,
            totalAfter: Math.max(0, Number(totalAfter || 0)),
            shadowWrite: true
          })
        ]
      );
    });
  });
}

export async function shadowSyncCompetitionSettings(comp) {
  return shadowUpsertCompetition(comp);
}
