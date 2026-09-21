import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { databaseConfigured, query } from "./db.js";

const COOKIE_NAME = "clt_admin_session";
const SESSION_SECONDS = 60 * 60 * 12;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(sha256(a), "hex");
  const bb = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(aa, bb);
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
  if (!r.ok || data.error) throw new Error(data.error || "Auth Redis error");
  return data.result;
}

function ipKey(req) {
  const cfg = authRedisConfig();
  const salt = cfg.token || "competition-link-tracker";
  return "ctl:auth:login:" + sha256(clientIp(req) + "|" + salt).slice(0, 32);
}

export function adminAuthConfigured() {
  return Boolean(
    databaseConfigured() &&
    process.env.ADMIN_USERNAME &&
    process.env.ADMIN_CODE
  );
}

export async function loginRateStatus(req) {
  try {
    const key = ipKey(req);
    const count = Number((await authRedis(["GET", key])) || 0);
    return { blocked: count >= 8, attempts: count };
  } catch {
    return { blocked: false, attempts: 0 };
  }
}

async function noteFailedLogin(req) {
  try {
    const key = ipKey(req);
    const count = Number(await authRedis(["INCR", key]));
    if (count === 1) await authRedis(["EXPIRE", key, 900]);
    return count;
  } catch {
    return 0;
  }
}

async function clearFailedLogins(req) {
  try { await authRedis(["DEL", ipKey(req)]); } catch {}
}

export async function verifyAdminCredentials(req, username, code) {
  if (!adminAuthConfigured()) {
    return { ok: false, reason: "not_configured" };
  }

  const rate = await loginRateStatus(req);
  if (rate.blocked) {
    return { ok: false, reason: "rate_limited" };
  }

  const userOk = safeEqual(
    String(username || "").trim(),
    String(process.env.ADMIN_USERNAME || "")
  );
  const codeOk = safeEqual(
    String(code || ""),
    String(process.env.ADMIN_CODE || "")
  );

  if (!userOk || !codeOk) {
    await noteFailedLogin(req);
    return { ok: false, reason: "invalid" };
  }

  await clearFailedLogins(req);
  return { ok: true };
}

export async function createAdminSession(req, res) {
  if (!databaseConfigured()) throw new Error("PostgreSQL unavailable");

  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);

  await query(
    `INSERT INTO admin_sessions
      (id, token_hash, expires_at, last_seen_at, metadata)
     VALUES ($1,$2,$3,NOW(),$4::jsonb)`,
    [
      id,
      tokenHash,
      expiresAt.toISOString(),
      JSON.stringify({
        username: process.env.ADMIN_USERNAME || "admin",
        ipHash: sha256(clientIp(req)).slice(0, 24)
      })
    ]
  );

  appendSetCookie(
    res,
    COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_SECONDS
  );

  return { id, expiresAt };
}

export async function getAdminSession(req) {
  if (!adminAuthConfigured()) return null;
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;

  const tokenHash = sha256(token);
  const result = await query(
    `SELECT id, expires_at, metadata
     FROM admin_sessions
     WHERE token_hash = $1
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  const session = result.rows[0];
  if (!session) return null;

  query(
    "UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1",
    [session.id]
  ).catch(() => {});

  return session;
}

export async function destroyAdminSession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token && databaseConfigured()) {
    try {
      await query("DELETE FROM admin_sessions WHERE token_hash = $1", [sha256(token)]);
    } catch {}
  }
  appendSetCookie(
    res,
    COOKIE_NAME + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
}

export function sameOriginRequest(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  const host = String(req.headers.host || "");
  return origin === "https://" + host || origin === "http://" + host;
}

export function loginNextPath(value) {
  const next = String(value || "");
  if (!next.startsWith("/")) return "/admin";
  if (next.startsWith("//")) return "/admin";
  return next.slice(0, 300);
}
