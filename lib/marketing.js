import { randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { awardLedgerEvent } from "./scoring.js";

function id(prefix) {
  return prefix + "_" + randomBytes(12).toString("hex");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "campagne";
}

function validateImageData(value) {
  const data = String(value || "");
  if (!data) return null;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(data)) {
    throw new Error("Image invalide");
  }
  if (data.length > 3_500_000) {
    throw new Error("Image trop lourde");
  }
  return data;
}

export async function listCampaigns(competitionId, { admin = false } = {}) {
  const conditions = admin
    ? "competition_id = $1"
    : `competition_id = $1
       AND status = 'active'
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at > NOW())`;

  const result = await query(
    `SELECT id, competition_id, slug, name, product, description, short_text,
            commercial_text, image_data, destination_url, whatsapp_url, status,
            points_share, points_click, points_interest, points_lead,
            points_referral, points_retention, points_sale, multiplier,
            conversion_multiplier, daily_share_limit, click_daily_cap,
            featured, starts_at, ends_at, settings, created_at, updated_at
     FROM campaigns
     WHERE ${conditions}
     ORDER BY featured DESC, created_at DESC`,
    [competitionId]
  );

  return result.rows;
}

export async function getCampaignBySlug(competitionId, campaignSlug) {
  const result = await query(
    `SELECT *
     FROM campaigns
     WHERE competition_id = $1
       AND slug = $2
     LIMIT 1`,
    [competitionId, campaignSlug]
  );
  return result.rows[0] || null;
}

export async function createCampaign({
  competitionId,
  name,
  product = "",
  description = "",
  shortText = "",
  commercialText = "",
  imageData = "",
  destinationUrl = "",
  whatsappUrl = "",
  status = "draft",
  pointsShare = 0,
  pointsClick = 0,
  pointsInterest = 0,
  pointsLead = 0,
  pointsReferral = 0,
  pointsRetention = 0,
  pointsSale = 0,
  multiplier = 1,
  conversionMultiplier = 1,
  dailyShareLimit = 1,
  clickDailyCap = "",
  featured = false,
  startsAt = null,
  endsAt = null,
  adminId = "admin"
}) {
  const cleanName = String(name || "").trim().slice(0, 120);
  if (!cleanName) throw new Error("Nom de campagne requis");

  const allowedStatuses = new Set(["draft","scheduled","active","paused","ended"]);
  const safeStatus = allowedStatuses.has(String(status)) ? String(status) : "draft";
  const baseSlug = slugify(cleanName);
  const campaignId = id("camp");
  const image = validateImageData(imageData);

  return withTransaction(async (client) => {
    let slug = baseSlug;
    let n = 2;
    while (true) {
      const exists = await client.query(
        "SELECT 1 FROM campaigns WHERE competition_id = $1 AND slug = $2 LIMIT 1",
        [competitionId, slug]
      );
      if (!exists.rowCount) break;
      slug = baseSlug + "-" + n++;
    }

    await client.query(
      `INSERT INTO campaigns
        (id, competition_id, slug, name, product, description, short_text,
         commercial_text, image_data, destination_url, whatsapp_url, status,
         points_share, points_click, points_interest, points_lead,
         points_referral, points_retention, points_sale, multiplier,
         conversion_multiplier, daily_share_limit, click_daily_cap, featured,
         starts_at, ends_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [
        campaignId,
        competitionId,
        slug,
        cleanName,
        String(product || "").trim().slice(0, 120),
        String(description || "").trim().slice(0, 3000),
        String(shortText || "").trim().slice(0, 500),
        String(commercialText || "").trim().slice(0, 3000),
        image,
        String(destinationUrl || "").trim().slice(0, 1000) || null,
        String(whatsappUrl || "").trim().slice(0, 1000) || null,
        safeStatus,
        Number.parseInt(String(pointsShare), 10) || 0,
        Number.parseInt(String(pointsClick), 10) || 0,
        Number.parseInt(String(pointsInterest), 10) || 0,
        Number.parseInt(String(pointsLead), 10) || 0,
        Number.parseInt(String(pointsReferral), 10) || 0,
        Number.parseInt(String(pointsRetention), 10) || 0,
        Number.parseInt(String(pointsSale), 10) || 0,
        Math.max(0, Number(multiplier) || 1),
        Math.max(0, Number(conversionMultiplier) || 1),
        Math.max(1, Number.parseInt(String(dailyShareLimit), 10) || 1),
        String(clickDailyCap || "").trim() === "" ? null : Math.max(0, Number.parseInt(String(clickDailyCap), 10) || 0),
        Boolean(featured),
        startsAt || null,
        endsAt || null
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'campaign_created','campaign',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        campaignId,
        "Campagne créée",
        JSON.stringify({ competitionId, slug, status: safeStatus })
      ]
    );

    return { id: campaignId, slug };
  });
}

export async function updateCampaignStatus({
  competitionId,
  campaignId,
  status,
  featured = null,
  adminId = "admin"
}) {
  const allowed = new Set(["draft","scheduled","active","paused","ended"]);
  if (!allowed.has(String(status))) throw new Error("Statut invalide");

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE campaigns
       SET status = $3,
           featured = COALESCE($4, featured),
           updated_at = NOW()
       WHERE id = $1
         AND competition_id = $2`,
      [campaignId, competitionId, status, featured]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'campaign_status_changed','campaign',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        campaignId,
        "Statut de campagne modifié",
        JSON.stringify({ competitionId, status, featured })
      ]
    );
  });
}

export async function deleteCampaign({
  competitionId,
  campaignId,
  adminId = "admin"
}) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      "SELECT * FROM campaigns WHERE id = $1 AND competition_id = $2 LIMIT 1",
      [campaignId, competitionId]
    );
    if (!existing.rowCount) return false;

    const linked = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM interests WHERE campaign_id = $1)::int AS interests,
         (SELECT COUNT(*) FROM campaign_share_events WHERE campaign_id = $1)::int AS shares`,
      [campaignId]
    );

    const counts = linked.rows[0] || { interests: 0, shares: 0 };
    if (Number(counts.interests) > 0 || Number(counts.shares) > 0) {
      await client.query(
        "UPDATE campaigns SET status = 'ended', updated_at = NOW() WHERE id = $1",
        [campaignId]
      );
    } else {
      await client.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
    }

    await client.query(
      `INSERT INTO admin_audit_logs
        (id, admin_id, action, entity_type, entity_id, description, metadata)
       VALUES ($1,$2,'campaign_removed','campaign',$3,$4,$5::jsonb)`,
      [
        id("audit"),
        adminId,
        campaignId,
        Number(counts.interests) > 0 || Number(counts.shares) > 0
          ? "Campagne archivée car elle possède un historique"
          : "Campagne supprimée",
        JSON.stringify({ competitionId, counts })
      ]
    );

    return true;
  });
}

export async function recordCampaignShare({
  competitionId,
  campaignId,
  participantId,
  channel = "generic"
}) {
  const campaignResult = await query(
    `SELECT id, points_share, multiplier, daily_share_limit
     FROM campaigns
     WHERE id = $1
       AND competition_id = $2
       AND status = 'active'
     LIMIT 1`,
    [campaignId, competitionId]
  );

  const campaign = campaignResult.rows[0];
  if (!campaign) return { ok: false, reason: "campaign_inactive" };

  const dayResult = await query(
    `SELECT c.timezone,
            to_char(NOW() AT TIME ZONE c.timezone, 'YYYY-MM-DD') AS day_key,
            (date_trunc('day', NOW() AT TIME ZONE c.timezone) AT TIME ZONE c.timezone) AS day_start,
            ((date_trunc('day', NOW() AT TIME ZONE c.timezone) + interval '1 day') AT TIME ZONE c.timezone) AS day_end
     FROM competitions c
     WHERE c.id = $1`,
    [competitionId]
  );
  const day = dayResult.rows[0];
  if (!day) return { ok: false, reason: "competition_not_found" };

  const countResult = await query(
    `SELECT COUNT(*)::int AS count
     FROM campaign_share_events
     WHERE competition_id = $1
       AND campaign_id = $2
       AND participant_id = $3
       AND created_at >= $4
       AND created_at < $5`,
    [competitionId, campaignId, participantId, day.day_start, day.day_end]
  );

  const count = Number(countResult.rows[0]?.count || 0);
  const eligible = count < Number(campaign.daily_share_limit || 1);
  const eventId = id("share");
  const idempotencyKey =
    "share:" + competitionId + ":" + campaignId + ":" + participantId + ":" +
    day.day_key + ":" + (count + 1);

  let award = { inserted: false, awarded: 0, totalPoints: null };

  if (eligible && Number(campaign.points_share || 0) !== 0) {
    award = await awardLedgerEvent({
      competitionId,
      participantId,
      campaignId,
      eventId,
      type: "share",
      basePoints: Number(campaign.points_share || 0),
      multiplier: Number(campaign.multiplier || 1),
      sourceId: eventId,
      idempotencyKey,
      description: "Partage initié",
      createdBy: "system",
      metadata: { channel, campaignId }
    });
  }

  await query(
    `INSERT INTO campaign_share_events
      (id, competition_id, campaign_id, participant_id, channel, rewarded,
       points_awarded, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      eventId,
      competitionId,
      campaignId,
      participantId,
      String(channel || "generic").slice(0, 32),
      Boolean(award.inserted),
      Number(award.awarded || 0),
      idempotencyKey,
      JSON.stringify({ shareInitiated: true })
    ]
  );

  return {
    ok: true,
    eligible,
    awarded: Number(award.awarded || 0),
    totalPoints: award.totalPoints
  };
}

export async function getCampaignStats(competitionId) {
  const result = await query(
    `SELECT c.id,c.name,c.product,c.status,c.featured,
            (SELECT COUNT(*) FROM campaign_share_events s WHERE s.campaign_id=c.id)::int AS shares,
            (SELECT COUNT(*) FROM interests i WHERE i.campaign_id=c.id)::int AS interests,
            (SELECT COUNT(*) FROM leads l WHERE l.campaign_id=c.id AND l.status='confirmed')::int AS leads,
            (SELECT COUNT(*) FROM sales sa WHERE sa.campaign_id=c.id AND sa.status='confirmed')::int AS sales,
            COALESCE((SELECT SUM(sa.amount) FROM sales sa WHERE sa.campaign_id=c.id AND sa.status='confirmed'),0) AS attributed_revenue
     FROM campaigns c
     WHERE c.competition_id=$1
     ORDER BY c.featured DESC,c.created_at DESC`,
    [competitionId]
  );
  return result.rows;
}


export async function updateCampaign({
  competitionId,
  campaignId,
  name,
  product = "",
  description = "",
  commercialText = "",
  imageData = "",
  destinationUrl = "",
  whatsappUrl = "",
  status = "draft",
  pointsShare = 0,
  pointsClick = 0,
  pointsInterest = 0,
  pointsLead = 0,
  pointsReferral = 0,
  pointsRetention = 0,
  pointsSale = 0,
  multiplier = 1,
  conversionMultiplier = 1,
  dailyShareLimit = 1,
  clickDailyCap = "",
  featured = false,
  startsAt = null,
  endsAt = null,
  adminId = "admin"
}) {
  const allowedStatuses = new Set(["draft","scheduled","active","paused","ended"]);
  const safeStatus = allowedStatuses.has(String(status)) ? String(status) : "draft";
  const cleanName = String(name || "").trim().slice(0,120);
  if (!cleanName) throw new Error("Nom de campagne requis");

  const newImage = String(imageData || "").trim() ? validateImageData(imageData) : null;

  return withTransaction(async client => {
    const before = await client.query(
      "SELECT * FROM campaigns WHERE id=$1 AND competition_id=$2 FOR UPDATE",
      [campaignId, competitionId]
    );
    if (!before.rowCount) return {ok:false,reason:"not_found"};

    await client.query(
      `UPDATE campaigns
       SET name=$3,
           product=$4,
           description=$5,
           commercial_text=$6,
           image_data=COALESCE($7,image_data),
           destination_url=$8,
           whatsapp_url=$9,
           status=$10,
           points_share=$11,
           points_click=$12,
           points_interest=$13,
           points_lead=$14,
           points_referral=$15,
           points_retention=$16,
           points_sale=$17,
           multiplier=$18,
           conversion_multiplier=$19,
           daily_share_limit=$20,
           click_daily_cap=$21,
           featured=$22,
           starts_at=$23,
           ends_at=$24,
           updated_at=NOW()
       WHERE id=$1 AND competition_id=$2`,
      [
        campaignId,
        competitionId,
        cleanName,
        String(product||"").trim().slice(0,120),
        String(description||"").trim().slice(0,3000),
        String(commercialText||"").trim().slice(0,3000),
        newImage,
        String(destinationUrl||"").trim().slice(0,1000) || null,
        String(whatsappUrl||"").trim().slice(0,1000) || null,
        safeStatus,
        Number.parseInt(String(pointsShare),10)||0,
        Number.parseInt(String(pointsClick),10)||0,
        Number.parseInt(String(pointsInterest),10)||0,
        Number.parseInt(String(pointsLead),10)||0,
        Number.parseInt(String(pointsReferral),10)||0,
        Number.parseInt(String(pointsRetention),10)||0,
        Number.parseInt(String(pointsSale),10)||0,
        Math.max(0,Number(multiplier)||1),
        Math.max(0,Number(conversionMultiplier)||1),
        Math.max(1,Number.parseInt(String(dailyShareLimit),10)||1),
        String(clickDailyCap||"").trim()==="" ? null : Math.max(0,Number.parseInt(String(clickDailyCap),10)||0),
        Boolean(featured),
        startsAt || null,
        endsAt || null
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
       (id,admin_id,action,entity_type,entity_id,description,metadata)
       VALUES ($1,$2,'campaign_updated','campaign',$3,'Campagne modifiée',$4::jsonb)`,
      [
        id("audit"),
        adminId,
        campaignId,
        JSON.stringify({competitionId,before:before.rows[0]})
      ]
    );

    return {ok:true};
  });
}
