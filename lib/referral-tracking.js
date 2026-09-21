import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { awardValidClick } from "./scoring.js";
import { getFraudSettings, createFraudFlag } from "./fraud.js";

const VISITOR_COOKIE = "clt_vid";
const ATTRIBUTION_SECONDS = 60 * 60 * 24 * 90;
const PREFIX = "ctl:v3";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function storageConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  };
}

async function redis(command) {
  const cfg = storageConfig();
  if (!cfg.url || !cfg.token) throw new Error("Tracking Redis unavailable");
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Tracking Redis error");
  return data.result;
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function appendSetCookie(res, value) {
  const current = res.getHeader?.("Set-Cookie");
  if (!current) return res.setHeader("Set-Cookie", value);
  const list = Array.isArray(current) ? current : [current];
  res.setHeader("Set-Cookie", [...list, value]);
}

function getOrCreateVisitorId(req, res) {
  const cookies = parseCookies(req);
  const existing = String(cookies[VISITOR_COOKIE] || "");
  if (/^[A-Za-z0-9_-]{20,120}$/.test(existing)) {
    return { visitorId: existing, created: false };
  }

  const visitorId = randomBytes(24).toString("base64url");
  appendSetCookie(
    res,
    VISITOR_COOKIE + "=" + encodeURIComponent(visitorId) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + ATTRIBUTION_SECONDS
  );
  return { visitorId, created: true };
}

export function getVisitorIdentity(req, res) {
  const { visitorId, created } = getOrCreateVisitorId(req, res);
  const cfg = storageConfig();
  const salt = cfg.token || "competition-link-tracker";
  return {
    created,
    visitorHash: sha256(visitorId + "|" + salt),
    ipHash: sha256(clientIp(req) + "|" + salt)
  };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .split(",")[0].trim();
}

function summarizeUserAgent(req) {
  return String(req.headers["user-agent"] || "").slice(0, 220);
}

function isObviousAutomatedTraffic(userAgent) {
  return /(?:bot|crawler|spider|facebookexternalhit|slackbot|telegrambot|discordbot|headless|preview)/i.test(
    String(userAgent || "")
  );
}

function parseHash(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return value;
  const out = {};
  for (let i = 0; i < value.length; i += 2) out[value[i]] = value[i + 1];
  return out;
}

function statsKey(competitionId, referralCode) {
  return "ctl:v2:stats:" + competitionId + ":" + referralCode;
}

async function currentStats(competitionId, referralCode) {
  const raw = parseHash(await redis(["HGETALL", statsKey(competitionId, referralCode)]));
  return {
    clicks: Number(raw.clicks || 0),
    unique: Number(raw.unique || 0),
    valid: Number(raw.valid || 0),
    points: Number(raw.points || 0)
  };
}

async function persistVisit({
  competitionId,
  referralCode,
  visitorHash,
  ipHash,
  userAgent,
  referrer,
  isUnique,
  isValid,
  invalidReason,
  attributedCode,
  campaignId = null
}) {
  try {
    const membership = await query(
      `SELECT participant_id
       FROM competition_participants
       WHERE competition_id = $1
         AND referral_code = $2
       LIMIT 1`,
      [competitionId, referralCode]
    );

    const sourceParticipantId = membership.rows[0]?.participant_id || null;
    const visitId = "v_" + randomBytes(12).toString("hex");

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO visits
          (id, competition_id, participant_id, campaign_id, visitor_id, referrer,
           user_agent_summary, ip_hash, is_unique, is_valid, fraud_score,
           invalid_reason, attribution_code, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
        [
          visitId,
          competitionId,
          sourceParticipantId,
          campaignId,
          visitorHash,
          referrer,
          userAgent,
          ipHash,
          isUnique,
          isValid,
          invalidReason === "bot" ? 1 : invalidReason ? 0.35 : 0,
          invalidReason || null,
          attributedCode || null,
          JSON.stringify({ source: campaignId ? "campaign_landing" : "referral_redirect" })
        ]
      );

      if (isUnique && sourceParticipantId) {
        await client.query(
          `INSERT INTO visitor_attributions
            (id, competition_id, visitor_id_hash, participant_id, referral_code,
             first_visit_id, visit_count, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb)
           ON CONFLICT (competition_id, visitor_id_hash)
           DO UPDATE SET
             visit_count = visitor_attributions.visit_count + 1,
             last_seen_at = NOW()`,
          [
            "va_" + randomBytes(12).toString("hex"),
            competitionId,
            visitorHash,
            sourceParticipantId,
            referralCode,
            visitId,
            JSON.stringify({ firstTouch: true })
          ]
        );
      } else {
        await client.query(
          `UPDATE visitor_attributions
           SET visit_count = visit_count + 1,
               last_seen_at = NOW()
           WHERE competition_id = $1
             AND visitor_id_hash = $2`,
          [competitionId, visitorHash]
        );
      }
    });

    return { visitId, participantId: sourceParticipantId };
  } catch (error) {
    console.error("visit-persist:", error);
    return { visitId: null, participantId: null };
  }
}

export async function trackReferralVisit({
  req,
  res,
  competitionId,
  referralCode,
  isAdmin = false,
  isSelf = false,
  campaignId = null
}) {
  const legacyStats = parseHash(await redis(["HGETALL", statsKey(competitionId, referralCode)]));
  if (legacyStats.valid === undefined || legacyStats.valid === null) {
    await redis([
      "HSET",
      statsKey(competitionId, referralCode),
      "valid",
      String(Number(legacyStats.unique || 0))
    ]);
  }

  await redis(["HINCRBY", statsKey(competitionId, referralCode), "clicks", 1]);

  const { visitorId } = getOrCreateVisitorId(req, res);
  const cfg = storageConfig();
  const salt = cfg.token || "competition-link-tracker";
  const visitorHash = sha256(visitorId + "|" + salt);
  const ipHash = sha256(clientIp(req) + "|" + salt);
  const userAgent = summarizeUserAgent(req);
  const referrer = String(req.headers.referer || req.headers.referrer || "").slice(0, 500);
  const bot = isObviousAutomatedTraffic(userAgent);
  const fraud = await getFraudSettings(competitionId).catch(() => null);
  const uniqueWindowSeconds = Math.max(
    3600,
    Number(fraud?.unique_click_window_hours || 2160) * 3600
  );
  const burstWindowSeconds = Math.max(
    60,
    Number(fraud?.burst_detection_window_minutes || 5) * 60
  );

  let invalidReason = "";
  if (isAdmin) invalidReason = "admin_test";
  else if (isSelf) invalidReason = "self_click";
  else if (bot && (fraud?.block_obvious_bots ?? true)) invalidReason = "bot";

  const rapidKey = PREFIX + ":rapid:" + competitionId + ":" + visitorHash;
  const visitorHitsKey = PREFIX + ":visitor-hits:" + competitionId + ":" + visitorHash;
  let rapidCount = 0;
  let visitorHits = 0;
  try {
    rapidCount = Number(await redis(["INCR", rapidKey]));
    if (rapidCount === 1) await redis(["EXPIRE", rapidKey, burstWindowSeconds]);

    visitorHits = Number(await redis(["INCR", visitorHitsKey]));
    if (visitorHits === 1) await redis(["EXPIRE", visitorHitsKey, uniqueWindowSeconds]);
  } catch {}

  const maxClicksPerVisitor = Math.max(1, Number(fraud?.max_clicks_per_visitor || 8));
  const suspiciousThreshold = Math.max(1, Number(fraud?.suspicious_threshold || 20));

  if (visitorHits > maxClicksPerVisitor && !invalidReason) {
    invalidReason = "visitor_click_limit";
  }

  if (rapidCount >= suspiciousThreshold || visitorHits > maxClicksPerVisitor) {
    createFraudFlag({
      competitionId,
      participantId: null,
      visitorId: visitorHash,
      riskScore: Math.min(
        1,
        Math.max(
          rapidCount / suspiciousThreshold,
          visitorHits / maxClicksPerVisitor
        )
      ),
      reason: visitorHits > maxClicksPerVisitor
        ? "Nombre de clics anormal pour un même visiteur"
        : "Rechargements rapides répétés",
      metadata: { rapidCount, visitorHits, burstWindowSeconds, maxClicksPerVisitor, referralCode }
    }).catch(() => {});
  }

  let isUnique = false;
  let isValid = false;
  let attributedCode = "";

  if (!invalidReason) {
    const attrKey = PREFIX + ":attribution:" + competitionId + ":" + visitorHash;
    const first = await redis([
      "SET",
      attrKey,
      referralCode,
      "EX",
      uniqueWindowSeconds,
      "NX"
    ]);

    if (first === "OK") {
      isUnique = true;
      attributedCode = referralCode;
      await redis(["HINCRBY", statsKey(competitionId, referralCode), "unique", 1]);

      const dailyCap = fraud?.daily_click_cap === null || fraud?.daily_click_cap === undefined
        ? null
        : Number(fraud.daily_click_cap);

      let capReached = false;
      if (dailyCap !== null && Number.isFinite(dailyCap)) {
        const timezone = fraud?.timezone || "UTC";
        const dayKey = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(new Date());
        const validKey = PREFIX + ":valid-day:" + competitionId + ":" + referralCode + ":" + dayKey;
        const current = Number((await redis(["GET", validKey])) || 0);
        capReached = current >= dailyCap;
        if (!capReached) {
          const next = Number(await redis(["INCR", validKey]));
          if (next === 1) await redis(["EXPIRE", validKey, 172800]);
        }
      }

      if (capReached) {
        invalidReason = "daily_click_cap";
      } else {
        isValid = true;
        await redis(["HINCRBY", statsKey(competitionId, referralCode), "valid", 1]);
      }
    } else {
      attributedCode = String((await redis(["GET", attrKey])) || "");
      invalidReason = attributedCode === referralCode
        ? "repeat_visitor"
        : "attributed_elsewhere";
    }
  }

  const stats = await currentStats(competitionId, referralCode);

  const persisted = await persistVisit({
    competitionId,
    referralCode,
    visitorHash,
    ipHash,
    userAgent,
    referrer,
    isUnique,
    isValid,
    invalidReason,
    attributedCode,
    campaignId
  });

  let scoring = null;

  if (isValid && persisted.participantId && persisted.visitId) {
    try {
      scoring = await awardValidClick({
        competitionId,
        participantId: persisted.participantId,
        visitId: persisted.visitId,
        visitorHash,
        campaignId
      });

      if (Number.isFinite(Number(scoring?.totalPoints))) {
        await redis([
          "HSET",
          statsKey(competitionId, referralCode),
          "points",
          String(Math.max(0, Number(scoring.totalPoints)))
        ]);
        stats.points = Math.max(0, Number(scoring.totalPoints));
      }
    } catch (error) {
      console.error("valid-click-scoring:", error);
    }
  }

  return {
    raw: true,
    isUnique,
    isValid,
    invalidReason,
    attributedCode,
    stats,
    scoring
  };
}
