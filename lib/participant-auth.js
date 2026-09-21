import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { query, withTransaction } from "./db.js";

const COOKIE_NAME = "clt_participant_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .split(",")[0].trim();
}

function authRedisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  };
}

async function authRedis(command) {
  const cfg = authRedisConfig();
  if (!cfg.url || !cfg.token) return null;
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || "Participant auth Redis error");
  return data.result;
}

function participantRateKey(req, whatsapp) {
  const salt = authRedisConfig().token || "competition-link-tracker";
  return "ctl:auth:participant:" + sha256(clientIp(req) + "|" + String(whatsapp || "") + "|" + salt).slice(0, 32);
}


export async function allowParticipantRegistration(req, whatsapp) {
  const normalized = normalizeWhatsApp(whatsapp);
  const salt = authRedisConfig().token || "competition-link-tracker";
  const key = "ctl:auth:register:" + sha256(
    clientIp(req) + "|" + String(normalized || whatsapp || "") + "|" + salt
  ).slice(0, 32);

  try {
    const count = Number(await authRedis(["INCR", key]));
    if (count === 1) await authRedis(["EXPIRE", key, 3600]);
    return { ok: count <= 5, remaining: Math.max(0, 5 - count) };
  } catch {
    return { ok: true, remaining: null };
  }
}

export function normalizeWhatsApp(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (digits.length === 9 && digits.startsWith("6")) {
    digits = "237" + digits;
  }

  if (digits.length < 8 || digits.length > 15) return "";
  return "+" + digits;
}

export function generateAccessCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashAccessCode(code, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return scryptSync(String(code), salt, 64).toString("hex");
}

function verifyAccessCode(code, saltHex, expectedHex) {
  try {
    const actual = Buffer.from(hashAccessCode(code, saltHex), "hex");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function getJoinableCompetition(competitionId) {
  const result = await query(
    `SELECT id, slug, name, description, cover_url, status, starts_at, ends_at,
            timezone, registrations_open, max_participants, settings
     FROM competitions
     WHERE id = $1
     LIMIT 1`,
    [competitionId]
  );
  const comp = result.rows[0];
  if (!comp) return null;

  const count = await query(
    `SELECT COUNT(*)::int AS count
     FROM competition_participants
     WHERE competition_id = $1
       AND status = 'active'`,
    [competitionId]
  );

  return {
    ...comp,
    participant_count: Number(count.rows[0]?.count || 0)
  };
}

export async function registerParticipantAccount({
  competitionId,
  pseudonym,
  whatsapp,
  referralCode
}) {
  const normalized = normalizeWhatsApp(whatsapp);
  const cleanPseudo = String(pseudonym || "").trim().slice(0, 40);

  if (!cleanPseudo) return { ok: false, reason: "invalid_pseudonym" };
  if (!normalized) return { ok: false, reason: "invalid_whatsapp" };

  const accessCode = generateAccessCode();
  const salt = randomBytes(16).toString("hex");
  const codeHash = hashAccessCode(accessCode, salt);
  const participantId = "p_" + randomBytes(12).toString("hex");
  const membershipId = "cp_" + randomBytes(12).toString("hex");

  try {
    const result = await withTransaction(async (client) => {
      const competition = await client.query(
        `SELECT id, name, status, registrations_open, max_participants
         FROM competitions
         WHERE id = $1
         FOR UPDATE`,
        [competitionId]
      );

      const comp = competition.rows[0];
      if (!comp) return { ok: false, reason: "competition_not_found" };
      if (comp.status !== "active" || !comp.registrations_open) {
        return { ok: false, reason: "registrations_closed" };
      }

      if (comp.max_participants) {
        const current = await client.query(
          `SELECT COUNT(*)::int AS count
           FROM competition_participants
           WHERE competition_id = $1 AND status = 'active'`,
          [competitionId]
        );
        if (Number(current.rows[0]?.count || 0) >= Number(comp.max_participants)) {
          return { ok: false, reason: "competition_full" };
        }
      }

      const existing = await client.query(
        `SELECT p.id, pc.participant_id IS NOT NULL AS has_credentials
         FROM participants p
         LEFT JOIN participant_credentials pc ON pc.participant_id = p.id
         WHERE p.whatsapp_normalized = $1
         LIMIT 1`,
        [normalized]
      );

      if (existing.rowCount) {
        return { ok: false, reason: "account_exists" };
      }

      await client.query(
        `INSERT INTO participants
          (id, pseudonym, whatsapp_normalized, status, metadata)
         VALUES ($1,$2,$3,'active',$4::jsonb)`,
        [
          participantId,
          cleanPseudo,
          normalized,
          JSON.stringify({ selfRegistered: true })
        ]
      );

      await client.query(
        `INSERT INTO participant_credentials
          (participant_id, access_code_salt, access_code_hash)
         VALUES ($1,$2,$3)`,
        [participantId, salt, codeHash]
      );

      await client.query(
        `INSERT INTO competition_participants
          (id, competition_id, participant_id, referral_code, status, metadata)
         VALUES ($1,$2,$3,$4,'active',$5::jsonb)`,
        [
          membershipId,
          competitionId,
          participantId,
          referralCode,
          JSON.stringify({ selfRegistered: true })
        ]
      );

      return {
        ok: true,
        participantId,
        competitionId,
        competitionName: comp.name,
        pseudonym: cleanPseudo,
        whatsapp: normalized,
        referralCode,
        accessCode
      };
    });

    return result;
  } catch (error) {
    if (String(error?.code) === "23505") {
      return { ok: false, reason: "duplicate" };
    }
    throw error;
  }
}

export async function createParticipantSession(req, res, participantId, competitionId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);

  await query(
    `INSERT INTO participant_sessions
      (id, participant_id, competition_id, token_hash, expires_at, last_seen_at, metadata)
     VALUES ($1,$2,$3,$4,$5,NOW(),$6::jsonb)`,
    [
      id,
      participantId,
      competitionId,
      tokenHash,
      expiresAt.toISOString(),
      JSON.stringify({ ipHash: sha256(clientIp(req)).slice(0, 24) })
    ]
  );

  appendSetCookie(
    res,
    COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_SECONDS
  );

  return { id, expiresAt };
}

export async function getParticipantSession(req, expectedCompetitionId = "") {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;

  const result = await query(
    `SELECT ps.id AS session_id, ps.participant_id, ps.competition_id,
            p.pseudonym, p.whatsapp_normalized, p.status AS participant_status,
            cp.referral_code, cp.status AS membership_status,
            c.name AS competition_name, c.status AS competition_status,
            c.registrations_open, c.ends_at
     FROM participant_sessions ps
     JOIN participants p ON p.id = ps.participant_id
     LEFT JOIN competition_participants cp
       ON cp.participant_id = ps.participant_id
      AND cp.competition_id = ps.competition_id
     LEFT JOIN competitions c ON c.id = ps.competition_id
     WHERE ps.token_hash = $1
       AND ps.expires_at > NOW()
     LIMIT 1`,
    [sha256(token)]
  );

  const session = result.rows[0];
  if (!session) return null;
  if (expectedCompetitionId && session.competition_id !== expectedCompetitionId) return null;
  if (session.participant_status !== "active") return null;
  if (session.membership_status && session.membership_status !== "active") return null;

  query(
    "UPDATE participant_sessions SET last_seen_at = NOW() WHERE id = $1",
    [session.session_id]
  ).catch(() => {});

  return session;
}

async function noteFailedLogin(req, whatsapp) {
  try {
    const key = participantRateKey(req, whatsapp);
    const count = Number(await authRedis(["INCR", key]));
    if (count === 1) await authRedis(["EXPIRE", key, 900]);
    return count;
  } catch {
    return 0;
  }
}

async function clearFailedLogins(req, whatsapp) {
  try { await authRedis(["DEL", participantRateKey(req, whatsapp)]); } catch {}
}

export async function authenticateParticipant(req, whatsapp, code) {
  const normalized = normalizeWhatsApp(whatsapp);
  if (!normalized || !String(code || "").trim()) {
    return { ok: false, reason: "invalid" };
  }

  const key = participantRateKey(req, normalized);
  try {
    const attempts = Number((await authRedis(["GET", key])) || 0);
    if (attempts >= 8) return { ok: false, reason: "rate_limited" };
  } catch {}

  const result = await query(
    `SELECT p.id, p.pseudonym, pc.access_code_salt, pc.access_code_hash,
            cp.competition_id
     FROM participants p
     JOIN participant_credentials pc ON pc.participant_id = p.id
     JOIN competition_participants cp ON cp.participant_id = p.id
     WHERE p.whatsapp_normalized = $1
       AND p.status = 'active'
       AND cp.status = 'active'
     ORDER BY cp.joined_at DESC
     LIMIT 1`,
    [normalized]
  );

  const row = result.rows[0];
  if (!row || !verifyAccessCode(code, row.access_code_salt, row.access_code_hash)) {
    await noteFailedLogin(req, normalized);
    return { ok: false, reason: "invalid" };
  }

  await clearFailedLogins(req, normalized);
  await query("UPDATE participants SET last_login_at = NOW() WHERE id = $1", [row.id]);

  return {
    ok: true,
    participantId: row.id,
    pseudonym: row.pseudonym,
    competitionId: row.competition_id
  };
}

export async function destroyParticipantSession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    try {
      await query("DELETE FROM participant_sessions WHERE token_hash = $1", [sha256(token)]);
    } catch {}
  }

  appendSetCookie(
    res,
    COOKIE_NAME + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
}


export async function joinExistingParticipantAccount({
  req,
  competitionId,
  whatsapp,
  code,
  referralCode
}) {
  const normalized=normalizeWhatsApp(whatsapp);
  if(!normalized || !String(code||"").trim()) return {ok:false,reason:"invalid"};

  const rateKey=participantRateKey(req,normalized);
  try{
    const attempts=Number((await authRedis(["GET",rateKey]))||0);
    if(attempts>=8) return {ok:false,reason:"rate_limited"};
  }catch{}

  return withTransaction(async client=>{
    const competition=await client.query(
      `SELECT id,name,status,registrations_open,max_participants
       FROM competitions
       WHERE id=$1
       FOR UPDATE`,
      [competitionId]
    );
    const comp=competition.rows[0];
    if(!comp) return {ok:false,reason:"competition_not_found"};
    if(comp.status!=="active" || !comp.registrations_open) return {ok:false,reason:"registrations_closed"};

    const account=await client.query(
      `SELECT p.id,p.pseudonym,p.status,pc.access_code_salt,pc.access_code_hash
       FROM participants p
       JOIN participant_credentials pc ON pc.participant_id=p.id
       WHERE p.whatsapp_normalized=$1
       LIMIT 1`,
      [normalized]
    );
    const row=account.rows[0];
    if(!row || row.status!=="active" || !verifyAccessCode(code,row.access_code_salt,row.access_code_hash)){
      await noteFailedLogin(req,normalized);
      return {ok:false,reason:"invalid"};
    }

    const existing=await client.query(
      `SELECT referral_code,status
       FROM competition_participants
       WHERE competition_id=$1 AND participant_id=$2
       LIMIT 1`,
      [competitionId,row.id]
    );
    if(existing.rowCount){
      await clearFailedLogins(req,normalized);
      return {
        ok:true,
        alreadyJoined:true,
        participantId:row.id,
        competitionId,
        competitionName:comp.name,
        pseudonym:row.pseudonym,
        whatsapp:normalized,
        referralCode:existing.rows[0].referral_code
      };
    }

    if(comp.max_participants){
      const current=await client.query(
        `SELECT COUNT(*)::int AS count
         FROM competition_participants
         WHERE competition_id=$1 AND status='active'`,
        [competitionId]
      );
      if(Number(current.rows[0]?.count||0)>=Number(comp.max_participants)){
        return {ok:false,reason:"competition_full"};
      }
    }

    await client.query(
      `INSERT INTO competition_participants
       (id,competition_id,participant_id,referral_code,status,metadata)
       VALUES ($1,$2,$3,$4,'active',$5::jsonb)`,
      [
        "cp_"+randomBytes(12).toString("hex"),
        competitionId,
        row.id,
        referralCode,
        JSON.stringify({joinedExistingAccount:true})
      ]
    );

    await clearFailedLogins(req,normalized);
    await client.query("UPDATE participants SET last_login_at=NOW() WHERE id=$1",[row.id]);

    return {
      ok:true,
      alreadyJoined:false,
      participantId:row.id,
      competitionId,
      competitionName:comp.name,
      pseudonym:row.pseudonym,
      whatsapp:normalized,
      referralCode
    };
  });
}
