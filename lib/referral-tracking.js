import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction } from "./db.js";

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
  attributedCode
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
          (id, competition_id, participant_id, visitor_id, referrer,
           user_agent_summary, ip_hash, is_unique, is_valid, fraud_score,
           invalid_reason, attribution_code, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          visitId,
          competitionId,
          sourceParticipantId,
          visitorHash,
          referrer,
          userAgent,
          ipHash,
          isUnique,
          isValid,
          invalidReason === "bot" ? 1 : invalidReason ? 0.35 : 0,
          invalidReason || null,
          attributedCode || null,
          JSON.stringify({ source: "referral_redirect" })
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
  } catch (error) {
    console.error("visit-persist:", error);
  }
}

export async function trackReferralVisit({
  req,
  res,
  competitionId,
  referralCode,
  isAdmin = false,
  isSelf = false
}) {
  await redis(["HINCRBY", statsKey(competitionId, referralCode), "clicks", 1]);

  const { visitorId } = getOrCreateVisitorId(req, res);
  const cfg = storageConfig();
  const salt = cfg.token || "competition-link-tracker";
  const visitorHash = sha256(visitorId + "|" + salt);
  const ipHash = sha256(clientIp(req) + "|" + salt);
  const userAgent = summarizeUserAgent(req);
  const referrer = String(req.headers.referer || req.headers.referrer || "").slice(0, 500);
  const bot = isObviousAutomatedTraffic(userAgent);

  let invalidReason = "";
  if (isAdmin) invalidReason = "admin_test";
  else if (isSelf) invalidReason = "self_click";
  else if (bot) invalidReason = "bot";

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
      ATTRIBUTION_SECONDS,
      "NX"
    ]);

    if (first === "OK") {
      isUnique = true;
      isValid = true;
      attributedCode = referralCode;
      await redis(["HINCRBY", statsKey(competitionId, referralCode), "unique", 1]);
      await redis(["HINCRBY", statsKey(competitionId, referralCode), "valid", 1]);
    } else {
      attributedCode = String((await redis(["GET", attrKey])) || "");
      invalidReason = attributedCode === referralCode
        ? "repeat_visitor"
        : "attributed_elsewhere";
    }
  }

  const stats = await currentStats(competitionId, referralCode);

  await persistVisit({
    competitionId,
    referralCode,
    visitorHash,
    ipHash,
    userAgent,
    referrer,
    isUnique,
    isValid,
    invalidReason,
    attributedCode
  });

  return {
    raw: true,
    isUnique,
    isValid,
    invalidReason,
    attributedCode,
    stats
  };
}
