import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { awardLedgerEvent } from "./scoring.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

function referenceCode(product, referralCode) {
  const p = String(product || "OFFRE")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 5) || "OFFRE";
  const r = String(referralCode || "REF")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 8) || "REF";
  return p + "-" + r + "-" + randomBytes(2).toString("hex").toUpperCase();
}

export async function createInterest({
  competitionId,
  campaignId,
  referralCode,
  visitorHash
}) {
  const source = await query(
    `SELECT cp.participant_id, c.product, c.name, c.points_interest,
            c.multiplier, c.status, c.whatsapp_url, c.destination_url
     FROM competition_participants cp
     JOIN campaigns c ON c.competition_id = cp.competition_id
     WHERE cp.competition_id = $1
       AND cp.referral_code = $2
       AND c.id = $3
       AND cp.status = 'active'
     LIMIT 1`,
    [competitionId, referralCode, campaignId]
  );

  const row = source.rows[0];
  if (!row || row.status !== "active") {
    return { ok: false, reason: "campaign_or_participant_inactive" };
  }

  const existing = await query(
    `SELECT id, reference_code, status
     FROM interests
     WHERE campaign_id = $1
       AND visitor_id_hash = $2
     LIMIT 1`,
    [campaignId, visitorHash]
  );

  if (existing.rowCount) {
    return {
      ok: true,
      duplicate: true,
      interestId: existing.rows[0].id,
      referenceCode: existing.rows[0].reference_code,
      status: existing.rows[0].status,
      participantId: row.participant_id,
      campaignName: row.name,
      product: row.product,
      whatsappUrl: row.whatsapp_url,
      destinationUrl: row.destination_url
    };
  }

  const interestId = id("interest");
  const reference = referenceCode(row.product, referralCode);

  await query(
    `INSERT INTO interests
      (id, competition_id, campaign_id, source_participant_id,
       visitor_id_hash, reference_code, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,'interest',$7::jsonb)`,
    [
      interestId,
      competitionId,
      campaignId,
      row.participant_id,
      visitorHash,
      reference,
      JSON.stringify({ referralCode })
    ]
  );

  let award = { awarded: 0, totalPoints: null };

  if (Number(row.points_interest || 0) !== 0) {
    award = await awardLedgerEvent({
      competitionId,
      participantId: row.participant_id,
      campaignId,
      eventId: interestId,
      type: "interest",
      basePoints: Number(row.points_interest || 0),
      multiplier: Number(row.multiplier || 1),
      sourceId: interestId,
      idempotencyKey: "interest:" + interestId,
      description: "Intérêt campagne confirmé par clic",
      createdBy: "system",
      metadata: { referenceCode: reference }
    });
  }

  return {
    ok: true,
    duplicate: false,
    interestId,
    referenceCode: reference,
    participantId: row.participant_id,
    campaignName: row.name,
    product: row.product,
    whatsappUrl: row.whatsapp_url,
    destinationUrl: row.destination_url,
    awarded: Number(award.awarded || 0),
    totalPoints: award.totalPoints
  };
}

export async function listProspects(competitionId) {
  const result = await query(
    `SELECT i.id, i.reference_code, i.status, i.created_at, i.updated_at,
            c.id AS campaign_id, c.name AS campaign_name, c.product,
            c.points_lead, c.points_sale,
            p.id AS participant_id, p.pseudonym AS participant_name,
            cp.referral_code,
            l.id AS lead_id, l.confirmed_at AS lead_confirmed_at,
            s.id AS sale_id, s.amount AS sale_amount, s.currency AS sale_currency,
            s.confirmed_at AS sale_confirmed_at
     FROM interests i
     JOIN campaigns c ON c.id = i.campaign_id
     LEFT JOIN participants p ON p.id = i.source_participant_id
     LEFT JOIN competition_participants cp
       ON cp.participant_id = p.id
      AND cp.competition_id = i.competition_id
     LEFT JOIN leads l ON l.interest_id = i.id
     LEFT JOIN sales s ON s.interest_id = i.id
     WHERE i.competition_id = $1
     ORDER BY i.created_at DESC`,
    [competitionId]
  );
  return result.rows;
}

export async function confirmLead({
  interestId,
  adminId = "admin"
}) {
  const existing = await query(
    "SELECT id FROM leads WHERE interest_id = $1 LIMIT 1",
    [interestId]
  );
  if (existing.rowCount) {
    return { ok: true, duplicate: true, leadId: existing.rows[0].id };
  }

  const context = await query(
    `SELECT i.id, i.competition_id, i.campaign_id, i.source_participant_id,
            i.status, i.reference_code,
            c.points_lead, c.conversion_multiplier
     FROM interests i
     JOIN campaigns c ON c.id = i.campaign_id
     WHERE i.id = $1
     LIMIT 1`,
    [interestId]
  );
  const row = context.rows[0];
  if (!row || row.status === "rejected") return { ok: false, reason: "interest_invalid" };

  const leadId = id("lead");
  let award = { awarded: 0, totalPoints: null };

  if (row.source_participant_id && Number(row.points_lead || 0) !== 0) {
    award = await awardLedgerEvent({
      competitionId: row.competition_id,
      participantId: row.source_participant_id,
      campaignId: row.campaign_id,
      eventId: leadId,
      type: "lead",
      basePoints: Number(row.points_lead || 0),
      multiplier: Number(row.conversion_multiplier || 1),
      sourceId: interestId,
      idempotencyKey: "lead:" + interestId,
      description: "Prospect confirmé",
      createdBy: adminId,
      metadata: { interestId, referenceCode: row.reference_code }
    });
  }

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO leads
        (id, competition_id, campaign_id, participant_id, interest_id,
         status, confirmed_by, metadata)
       VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7::jsonb)
       ON CONFLICT (interest_id) DO NOTHING`,
      [
        leadId,
        row.competition_id,
        row.campaign_id,
        row.source_participant_id,
        interestId,
        adminId,
        JSON.stringify({ referenceCode: row.reference_code })
      ]
    );

    await client.query(
      "UPDATE interests SET status = 'lead_confirmed', updated_at = NOW() WHERE id = $1 AND status <> 'sale_confirmed'",
      [interestId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'lead_confirmed','interest',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        interestId,
        "Prospect confirmé",
        JSON.stringify({ leadId, pointsAwarded: Number(award.awarded || 0) })
      ]
    );
  });

  return {
    ok: true,
    duplicate: false,
    leadId,
    awarded: Number(award.awarded || 0),
    totalPoints: award.totalPoints,
    participantId: row.source_participant_id,
    competitionId: row.competition_id
  };
}

export async function confirmSale({
  interestId,
  amount = null,
  currency = "XAF",
  adminId = "admin"
}) {
  const existing = await query(
    "SELECT id FROM sales WHERE interest_id = $1 LIMIT 1",
    [interestId]
  );
  if (existing.rowCount) {
    return { ok: true, duplicate: true, saleId: existing.rows[0].id };
  }

  const context = await query(
    `SELECT i.id, i.competition_id, i.campaign_id, i.source_participant_id,
            i.status, i.reference_code,
            c.points_sale, c.conversion_multiplier,
            l.id AS lead_id
     FROM interests i
     JOIN campaigns c ON c.id = i.campaign_id
     LEFT JOIN leads l ON l.interest_id = i.id AND l.status = 'confirmed'
     WHERE i.id = $1
     LIMIT 1`,
    [interestId]
  );
  const row = context.rows[0];
  if (!row || row.status === "rejected") return { ok: false, reason: "interest_invalid" };
  if (!row.lead_id) return { ok: false, reason: "lead_required" };

  const saleId = id("sale");
  let award = { awarded: 0, totalPoints: null };

  if (row.source_participant_id && Number(row.points_sale || 0) !== 0) {
    award = await awardLedgerEvent({
      competitionId: row.competition_id,
      participantId: row.source_participant_id,
      campaignId: row.campaign_id,
      eventId: saleId,
      type: "sale",
      basePoints: Number(row.points_sale || 0),
      multiplier: Number(row.conversion_multiplier || 1),
      sourceId: interestId,
      idempotencyKey: "sale:" + interestId,
      description: "Vente confirmée",
      createdBy: adminId,
      metadata: { interestId, referenceCode: row.reference_code, amount, currency }
    });
  }

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO sales
        (id, competition_id, campaign_id, participant_id, interest_id,
         lead_id, amount, currency, status, confirmed_by, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10::jsonb)
       ON CONFLICT (interest_id) DO NOTHING`,
      [
        saleId,
        row.competition_id,
        row.campaign_id,
        row.source_participant_id,
        interestId,
        row.lead_id,
        amount === null || amount === "" ? null : Number(amount),
        String(currency || "XAF").slice(0, 8),
        adminId,
        JSON.stringify({ referenceCode: row.reference_code })
      ]
    );

    await client.query(
      "UPDATE interests SET status = 'sale_confirmed', updated_at = NOW() WHERE id = $1",
      [interestId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'sale_confirmed','interest',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        interestId,
        "Vente confirmée",
        JSON.stringify({ saleId, amount, currency, pointsAwarded: Number(award.awarded || 0) })
      ]
    );
  });

  return {
    ok: true,
    duplicate: false,
    saleId,
    awarded: Number(award.awarded || 0),
    totalPoints: award.totalPoints,
    participantId: row.source_participant_id,
    competitionId: row.competition_id
  };
}

export async function rejectInterest({
  interestId,
  adminId = "admin"
}) {
  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE interests
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1
         AND status = 'interest'
       RETURNING id, competition_id`,
      [interestId]
    );

    if (!updated.rowCount) return;

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'interest_rejected','interest',$3,'Prospect rejeté',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        interestId,
        JSON.stringify({ competitionId: updated.rows[0].competition_id })
      ]
    );
  });
}

export async function participantConversionStats(competitionId, participantId) {
  const result = await query(
    `SELECT
       (SELECT COUNT(*) FROM interests WHERE competition_id = $1 AND source_participant_id = $2)::int AS interests,
       (SELECT COUNT(*) FROM leads WHERE competition_id = $1 AND participant_id = $2 AND status = 'confirmed')::int AS leads,
       (SELECT COUNT(*) FROM sales WHERE competition_id = $1 AND participant_id = $2 AND status = 'confirmed')::int AS sales`,
    [competitionId, participantId]
  );
  return result.rows[0] || { interests: 0, leads: 0, sales: 0 };
}
