import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

export async function listAdminParticipants(competitionId) {
  const r = await query(
    `SELECT p.id AS participant_id, p.pseudonym AS name, p.status AS participant_status,
            p.whatsapp_normalized, cp.referral_code AS code,
            cp.status AS membership_status, cp.joined_at,
            cp.total_points_cache AS points, cp.raw_clicks_cache AS clicks,
            cp.unique_clicks_cache AS unique_clicks,
            cp.valid_clicks_cache AS valid_clicks, cp.rank_cache
     FROM competition_participants cp
     JOIN participants p ON p.id = cp.participant_id
     WHERE cp.competition_id = $1
     ORDER BY
       CASE cp.status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,
       cp.total_points_cache DESC,
       cp.joined_at ASC`,
    [competitionId]
  );

  return r.rows.map((row, index) => ({
    participantId: row.participant_id,
    name: row.name,
    code: row.code,
    participantStatus: row.participant_status,
    membershipStatus: row.membership_status,
    whatsapp: row.whatsapp_normalized,
    createdAt: row.joined_at,
    points: Number(row.points || 0),
    clicks: Number(row.clicks || 0),
    unique: Number(row.unique_clicks || 0),
    valid: Number(row.valid_clicks || 0),
    rank: row.membership_status === "active" ? index + 1 : null
  }));
}

export async function setParticipantCompetitionStatus({
  competitionId,
  participantId,
  action,
  adminId = "admin",
  reason = ""
}) {
  const allowed = new Set(["active","suspended","disqualified","withdrawn"]);
  if (!allowed.has(String(action))) throw new Error("Statut participant invalide");

  return withTransaction(async client => {
    const before = await client.query(
      `SELECT cp.status AS membership_status, p.status AS participant_status, p.pseudonym
       FROM competition_participants cp
       JOIN participants p ON p.id = cp.participant_id
       WHERE cp.competition_id = $1
         AND cp.participant_id = $2
       FOR UPDATE`,
      [competitionId, participantId]
    );
    if (!before.rowCount) return {ok:false,reason:"not_found"};

    const globalStatus = action === "active"
      ? "active"
      : action === "suspended"
        ? "suspended"
        : before.rows[0].participant_status;

    await client.query(
      `UPDATE competition_participants
       SET status = $3
       WHERE competition_id = $1
         AND participant_id = $2`,
      [competitionId, participantId, action]
    );

    if (action === "active" || action === "suspended") {
      await client.query(
        "UPDATE participants SET status=$2, updated_at=NOW() WHERE id=$1",
        [participantId, globalStatus]
      );
    }

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'participant_status_changed','participant',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        participantId,
        action === "active" ? "Participant réactivé" : "Statut participant modifié",
        JSON.stringify({
          competitionId,
          previous: before.rows[0],
          next: action,
          reason: String(reason || "").slice(0,500)
        })
      ]
    );

    return {ok:true,action};
  });
}

export async function listAuditLogs(competitionId, limit = 250) {
  const r = await query(
    `SELECT id, admin_id, action, entity_type, entity_id, description, metadata, created_at
     FROM admin_audit_logs
     WHERE
       entity_id = $1
       OR metadata ->> 'competitionId' = $1
       OR metadata ->> 'competition_id' = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [competitionId, Math.max(1, Math.min(1000, Number(limit) || 250))]
  );
  return r.rows;
}
