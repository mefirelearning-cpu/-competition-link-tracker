import { randomBytes } from "node:crypto";
import { query } from "./db.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

export async function createNotification({
  competitionId = null,
  participantId = null,
  kind = "info",
  title,
  body,
  actionUrl = null,
  expiresAt = null,
  idempotencyKey = null,
  metadata = {}
}) {
  const notificationId = id("notif");
  const result=await query(
    `INSERT INTO notifications
      (id, competition_id, participant_id, kind, title, body, action_url, expires_at,
       idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (idempotency_key)
     WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      notificationId,
      competitionId,
      participantId,
      String(kind || "info").slice(0, 40),
      String(title || "Notification").trim().slice(0, 160),
      String(body || "").trim().slice(0, 2000),
      actionUrl ? String(actionUrl).slice(0, 1000) : null,
      expiresAt || null,
      idempotencyKey ? String(idempotencyKey).slice(0,300) : null,
      JSON.stringify(metadata || {})
    ]
  );
  return result.rows[0]?.id || null;
}

export async function createAnnouncement({
  competitionId,
  title,
  body,
  kind = "announcement",
  actionUrl = null,
  expiresAt = null
}) {
  return createNotification({
    competitionId,
    participantId: null,
    kind,
    title,
    body,
    actionUrl,
    expiresAt
  });
}

export async function listParticipantNotifications(competitionId, participantId, limit = 20) {
  const result = await query(
    `SELECT *
     FROM notifications
     WHERE (competition_id = $1 OR competition_id IS NULL)
       AND (participant_id = $2 OR participant_id IS NULL)
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT $3`,
    [competitionId, participantId, Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  return result.rows;
}

export async function markNotificationRead(notificationId, participantId) {
  await query(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1
       AND (participant_id = $2 OR participant_id IS NULL)`,
    [notificationId, participantId]
  );
}
