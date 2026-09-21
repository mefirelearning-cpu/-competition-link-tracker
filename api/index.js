import { createHash, randomBytes } from "node:crypto";
import { shadowUpsertCompetition, shadowUpsertParticipant, shadowUpsertParticipants, shadowWithdrawParticipant, shadowSyncStats, shadowRecordAdminAdjustment, shadowSyncCompetitionSettings } from "../lib/shadow-store.js";
import { adminAuthConfigured, verifyAdminCredentials, createAdminSession, getAdminSession, destroyAdminSession, sameOriginRequest, loginNextPath } from "../lib/admin-auth.js";
import { normalizeWhatsApp, getJoinableCompetition, registerParticipantAccount, createParticipantSession, getParticipantSession, authenticateParticipant, destroyParticipantSession } from "../lib/participant-auth.js";
import { trackReferralVisit } from "../lib/referral-tracking.js";
import { getScoringConfig, updateValidClickRule, createBurstRule, deleteBurstRule } from "../lib/scoring.js";
import { getVisitorIdentity } from "../lib/referral-tracking.js";
import { query } from "../lib/db.js";
import { getCompetitionConfig, updateCompetitionConfig, resizeCompetitionDays, ensureCompetitionLifecycle } from "../lib/competition-config.js";
import { getFraudSettings, updateFraudSettings, listFraudFlags, resolveFraudFlag } from "../lib/fraud.js";
import { createAnnouncement, listParticipantNotifications, markNotificationRead } from "../lib/notifications.js";
import { listPrizes, addPrize, listRewardTiers, addRewardTier, freezeFinalRanking, selectPrize, generateRewardCoupons, participantRewards } from "../lib/rewards.js";
import { createInterest, listProspects, confirmLead, confirmSale, rejectInterest, participantConversionStats } from "../lib/conversions.js";
import { listCompetitionDays, getActiveDay, listDayMissions, createCompetitionDay, createMission, claimDailyReward, addStreakRule, submitMissionCompletion, listMissionCompletions, reviewMissionCompletion } from "../lib/competition-days.js";
import { listCampaigns, getCampaignBySlug, createCampaign, updateCampaignStatus, deleteCampaign, recordCampaignShare, getCampaignStats } from "../lib/marketing.js";

const WA_DEFAULT = "https://chat.whatsapp.com/GYyW35sRFnK48pLdCQGMdv?mode=gi_t";
const PREFIX = "ctl:v2";
const LEGACY_KEY = "competition:state";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function slugify(v) {
  return String(v || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "competition";
}

function storageConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  };
}

async function redis(command) {
  const cfg = storageConfig();
  if (!cfg.url || !cfg.token) throw new Error("Storage not configured");
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || ("Redis HTTP " + r.status));
  return data.result;
}

async function getJSON(key, fallback) {
  const value = await redis(["GET", key]);
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function setJSON(key, value) {
  return redis(["SET", key, JSON.stringify(value)]);
}

function parseHash(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return value;
  const out = {};
  for (let i = 0; i < value.length; i += 2) out[value[i]] = value[i + 1];
  return out;
}

function competitionsKey() { return PREFIX + ":competitions"; }
function participantsKey(id) { return PREFIX + ":participants:" + id; }
function statsKey(id, code) { return PREFIX + ":stats:" + id + ":" + code; }
function profileKey(id) { return PREFIX + ":profile:" + id; }
async function getProfile(id) { return String((await redis(["GET", profileKey(id)])) || ""); }
async function saveProfile(id, data) { if (data) await redis(["SET", profileKey(id), data]); else await redis(["DEL", profileKey(id)]); }

async function syncRedisPointCacheByParticipantId(competitionId, participantId, totalPoints) {
  if (!participantId || totalPoints === null || totalPoints === undefined) return;
  try {
    const result = await query(
      `SELECT referral_code
       FROM competition_participants
       WHERE competition_id = $1
         AND participant_id = $2
       LIMIT 1`,
      [competitionId, participantId]
    );
    const code = result.rows[0]?.referral_code;
    if (code) {
      await redis(["HSET", statsKey(competitionId, code), "points", String(Math.max(0, Number(totalPoints) || 0))]);
    }
  } catch (error) {
    console.error("redis-point-cache-sync:", error);
  }
}


async function getCompetitions() {
  return await getJSON(competitionsKey(), []);
}

async function saveCompetitions(items) {
  await setJSON(competitionsKey(), items);
}

async function getParticipants(id) {
  return await getJSON(participantsKey(id), []);
}

async function saveParticipants(id, items) {
  await setJSON(participantsKey(id), items);
}

async function getStats(id, code) {
  const raw = parseHash(await redis(["HGETALL", statsKey(id, code)]));
  const unique = Number(raw.unique || 0);
  return {
    clicks: Number(raw.clicks || 0),
    unique,
    valid: raw.valid === undefined || raw.valid === null ? unique : Number(raw.valid || 0),
    points: Number(raw.points || 0)
  };
}

async function getRankedParticipants(comp) {
  const participants = await getParticipants(comp.id);
  const rows = await Promise.all(participants.map(async (p) => {
    const s = await getStats(comp.id, p.code);
    return {
      name: p.name,
      code: p.code,
      active: p.active !== false,
      createdAt: p.createdAt,
      clicks: s.clicks,
      unique: s.unique,
      valid: s.valid,
      points: s.points,
      link: "/r/" + comp.id + "/" + p.code
    };
  }));
  rows.sort((a,b) => b.points - a.points || b.valid - a.valid || b.unique - a.unique || b.clicks - a.clicks || a.name.localeCompare(b.name));
  return rows.map((r,i) => ({...r, rank:i+1}));
}

async function ensureLegacyMigration() {
  const marker = PREFIX + ":legacy-migrated";
  if (await redis(["GET", marker])) return;

  const existing = await getCompetitions();
  if (existing.length > 0) {
    await redis(["SET", marker, "1"]);
    return;
  }

  const legacy = await getJSON(LEGACY_KEY, []);
  if (!Array.isArray(legacy) || legacy.length === 0) {
    await redis(["SET", marker, "1"]);
    return;
  }

  const comp = {
    id: "whatsapp-competition",
    name: "Compétition WhatsApp",
    prize: "",
    destination: legacy[0]?.destination || WA_DEFAULT,
    status: "active",
    theme: "blue",
    createdAt: new Date().toISOString(),
    endsAt: ""
  };
  await saveCompetitions([comp]);

  const participants = legacy.map((p, i) => ({
    name: String(p.name || ("Participant " + (i + 1))),
    code: slugify(p.code || p.name || ("p" + (i + 1))),
    active: p.active !== false,
    createdAt: new Date().toISOString()
  }));
  await saveParticipants(comp.id, participants);

  for (let i = 0; i < legacy.length; i++) {
    const code = participants[i].code;
    await redis(["HSET", statsKey(comp.id, code),
      "clicks", String(Number(legacy[i].clicks || 0)),
      "unique", String(Number(legacy[i].unique || 0)),
      "points", String(Number(legacy[i].points || 0))
    ]);
  }

  await redis(["SET", marker, "1"]);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return Object.fromEntries(new URLSearchParams(req.body).entries());
  return {};
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function redirect(res, location, status = 302) {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}

function pageShell(title, body, extraScript = "") {
  return "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">" +
    "<meta name=\"theme-color\" content=\"#0b0b0b\">" +
    "<title>" + esc(title) + "</title>" +
    "<style>" +
    ":root{--bg:#f3f3f0;--card:#fff;--text:#0a0a0a;--muted:#707070;--line:#e3e3de;--soft:#f8f8f5;--ok:#2e7d32;--danger:#b42318;--accent:#2f5fe3;--accent-soft:#eef3ff;--accent-glow:rgba(47,95,227,.22)}.theme-blue{--accent:#2f5fe3;--accent-soft:#eef3ff;--accent-glow:rgba(47,95,227,.22)}.theme-amber{--accent:#d28a19;--accent-soft:#fff5e3;--accent-glow:rgba(210,138,25,.22)}.theme-red{--accent:#a61f18;--accent-soft:#fff0ee;--accent-glow:rgba(166,31,24,.22)}.theme-mono{--accent:#111;--accent-soft:#f0f0ed;--accent-glow:rgba(255,255,255,.10)}" +
    "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}" +
    "a{color:inherit;text-decoration:none}.wrap{width:calc(100% - 24px);max-width:none;margin:0 auto;padding:18px 0 52px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}" +
    ".brand{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:850}.mark{width:34px;height:34px;border-radius:11px;background:#0b0b0b;color:#fff;display:grid;place-items:center;font-size:15px}.nav{display:flex;gap:8px;flex-wrap:wrap}" +
    ".btn,.btn2,.danger{border:0;border-radius:12px;padding:11px 15px;font:inherit;font-weight:760;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap}" +
    ".btn{background:#0b0b0b;color:#fff}.btn2{background:#fff;color:#0b0b0b;border:1px solid var(--line)}.danger{background:#fff;color:var(--danger);border:1px solid #f0d3cf}" +
    ".hero{background:#0b0b0b;color:#fff;border-radius:24px;padding:28px;margin-bottom:18px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:11px;font-weight:800;color:#bdbdbd}.hero h1{font-size:clamp(30px,7vw,58px);line-height:.98;margin:10px 0 12px;letter-spacing:-.045em}.hero p{max-width:720px;color:#c9c9c9;margin:0;font-size:15px;line-height:1.55}" +
    ".grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px}.span12{grid-column:span 12}.span8{grid-column:span 8}.span7{grid-column:span 7}.span6{grid-column:span 6}.span5{grid-column:span 5}.span4{grid-column:span 4}.span3{grid-column:span 3}" +
    ".stat .label{font-size:12px;color:var(--muted);font-weight:700}.stat .num{font-size:30px;font-weight:900;letter-spacing:-.04em;margin-top:5px}.muted{color:var(--muted)}.small{font-size:12px}.section-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}.section-title h2{font-size:18px;margin:0;letter-spacing:-.02em}" +
    "label{display:block;font-size:12px;font-weight:800;margin:0 0 6px}input,select,textarea{width:100%;border:1px solid var(--line);background:#fff;color:#111;border-radius:12px;padding:12px 13px;font:inherit;outline:none}input:focus,select:focus,textarea:focus{border-color:#111;box-shadow:0 0 0 3px #0000000c}textarea{min-height:110px;resize:vertical}.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.full{grid-column:1/-1}" +
    ".status{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;border:1px solid var(--line);border-radius:999px;padding:7px 10px;background:#fff}.dot{width:8px;height:8px;border-radius:99px;background:#111}.dot.active{background:#2e7d32}.dot.paused{background:#a16207}.dot.ended{background:#777}" +
    ".comp-list{display:grid;gap:10px}.comp{display:flex;justify-content:space-between;gap:14px;align-items:center;border:1px solid var(--line);border-radius:15px;padding:15px}.comp h3{margin:0 0 4px;font-size:16px}.comp-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
    ".table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:12px 13px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:#fafafa}tr:last-child td{border-bottom:0}.rank{font-weight:900;font-size:16px}.rank.one{font-size:20px}.person{font-weight:800}.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#666}.actions{display:flex;gap:7px;align-items:center}.iconbtn{border:1px solid var(--line);background:#fff;border-radius:9px;padding:7px 9px;font:inherit;cursor:pointer;font-size:12px}" +
    ".live{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}.pulse{width:8px;height:8px;border-radius:99px;background:#2e7d32;box-shadow:0 0 0 0 #2e7d3266;animation:pulse 1.8s infinite}@keyframes pulse{70%{box-shadow:0 0 0 8px #2e7d3200}100%{box-shadow:0 0 0 0 #2e7d3200}}" +
    ".chart{display:grid;gap:12px}.bar-row{display:grid;grid-template-columns:minmax(90px,150px) 1fr 44px;gap:10px;align-items:center}.bar-name{font-size:12px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:28px;border-radius:9px;background:#f1f1ee;overflow:hidden;position:relative}.fill{height:100%;min-width:2px;background:#0b0b0b;border-radius:9px;transition:width .6s ease}.bar-value{text-align:right;font-size:12px;font-weight:900}.delta{font-size:11px;margin-left:5px}.up{color:#2e7d32}.down{color:#b42318}" +
    ".empty{padding:28px;text-align:center;color:var(--muted)}.notice{padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:#fafafa;font-size:12px;line-height:1.5}.ok{color:var(--ok)}.dangerText{color:var(--danger)}" +
    ".footer-note{margin-top:14px;font-size:11px;color:#777;line-height:1.5}" +
    ".top{position:sticky;top:0;z-index:40;background:#f4f4f2e8;backdrop-filter:blur(18px);padding:10px 0;margin-bottom:14px}.brand span:last-child{letter-spacing:-.02em}.hero{background:linear-gradient(135deg,#050505 0%,#171717 100%);box-shadow:0 18px 40px #00000018}.card{box-shadow:0 8px 28px #00000008}.quickbar{display:flex;gap:8px;overflow-x:auto;padding:2px 0 14px;scrollbar-width:none}.quickbar::-webkit-scrollbar{display:none}.pill{border:1px solid var(--line);background:#fff;padding:9px 12px;border-radius:999px;font-size:12px;font-weight:800;white-space:nowrap}.pill.primary{background:#0b0b0b;color:#fff;border-color:#0b0b0b}.success{display:flex;justify-content:space-between;gap:14px;align-items:center;background:#0b0b0b;color:#fff;border-radius:18px;padding:16px 18px;margin-bottom:14px}.success .muted{color:#cfcfcf}.links-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.link-card{border:1px solid var(--line);background:linear-gradient(180deg,#fff,#fbfbfa);border-radius:16px;padding:15px;min-width:0}.link-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}.link-name{font-size:15px;font-weight:900;letter-spacing:-.02em}.link-rank{width:28px;height:28px;border-radius:9px;background:#0b0b0b;color:#fff;display:grid;place-items:center;font-size:12px;font-weight:900}.link-url{display:block;width:100%;padding:10px 11px;border-radius:10px;background:#f2f2ef;border:1px solid #ecece8;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:10px}.link-actions{display:flex;gap:7px;flex-wrap:wrap}.link-actions .btn,.link-actions .btn2{padding:9px 11px;font-size:12px}.subnav-note{font-size:12px;color:var(--muted)}.section-anchor{scroll-margin-top:80px}.searchbox{max-width:260px}.hero-row{display:flex;justify-content:space-between;align-items:flex-end;gap:18px}.hero-side{min-width:180px;border:1px solid #ffffff22;background:#ffffff0a;border-radius:16px;padding:14px}.hero-side strong{display:block;font-size:24px;margin-top:4px}.mobile-tip{display:none}.theme{min-height:100vh}.hero{position:relative;overflow:hidden;border:1px solid #ffffff12}.hero:before{content:'';position:absolute;right:-90px;top:-120px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,var(--accent-glow),transparent 68%);pointer-events:none}.hero:after{content:attr(data-ghost);position:absolute;right:-12px;bottom:-34px;font-size:clamp(74px,15vw,180px);font-weight:950;letter-spacing:-.08em;color:#ffffff08;line-height:.78;pointer-events:none;white-space:nowrap}.hero-row,.hero h1,.hero p,.eyebrow{position:relative;z-index:1}.eyebrow{color:#d0d0d0}.eyebrow:before{content:'';display:inline-block;width:26px;height:2px;background:var(--accent);vertical-align:middle;margin-right:9px}.hero-side{position:relative;z-index:2}.hero-side:before{content:'';display:block;width:34px;height:4px;border-radius:20px;background:var(--accent);margin-bottom:10px}.stat{position:relative;overflow:hidden;transition:transform .18s ease,box-shadow .18s ease}.stat:after{content:'';position:absolute;left:0;top:0;width:100%;height:3px;background:linear-gradient(90deg,var(--accent),transparent 72%)}.stat:hover,.link-card:hover,.comp:hover{transform:translateY(-2px);box-shadow:0 16px 38px #0000000c}.stat .num{font-variant-numeric:tabular-nums}.link-card{position:relative;overflow:hidden;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}.link-card:before{content:'';position:absolute;left:0;top:0;width:4px;height:100%;background:var(--accent);opacity:.88}.link-card:hover{border-color:color-mix(in srgb,var(--accent) 25%,var(--line))}.link-rank{background:var(--accent)}.link-url{background:#f5f5f2}.copy.btn{background:#0a0a0a}.copy.btn:hover{background:var(--accent)}.podium{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}.podium-card{position:relative;border:1px solid var(--line);border-radius:15px;padding:14px;background:linear-gradient(180deg,#fff,#fafaf8);overflow:hidden}.podium-card:after{content:'';position:absolute;inset:auto 0 0 0;height:3px;background:#cfcfca}.podium-card.first:after{background:var(--accent)}.podium-rank{font-size:11px;color:var(--muted);font-weight:850;text-transform:uppercase;letter-spacing:.09em}.podium-name{font-weight:900;font-size:17px;margin-top:4px;letter-spacing:-.02em}.podium-score{font-size:12px;color:var(--muted);margin-top:4px}.podium-card.first{background:linear-gradient(135deg,var(--accent-soft),#fff 62%)}.accent-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid #ffffff22;border-radius:999px;padding:7px 10px;color:#d9d9d9;font-size:11px;font-weight:800;margin-top:10px}.accent-chip i{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 16px var(--accent)}.theme-swatch{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}.comp{transition:transform .18s ease,box-shadow .18s ease}.comp.theme{min-height:unset}.comp h3{letter-spacing:-.025em}.comp .btn{background:#0a0a0a}.table-wrap tbody tr:first-child td{background:var(--accent-soft)}.table-wrap tbody tr:first-child .rank{color:var(--accent)}.bar-row:first-child .fill{background:var(--accent)}.fill{background:#161616}.section-title h2{font-size:20px}.section-title h2:after{content:'';display:block;width:28px;height:2px;background:var(--accent);margin-top:7px}.pill.primary{background:#0a0a0a}.pill:hover{border-color:var(--accent)}.status .theme-swatch{margin-right:2px}.editorial-note{font-size:clamp(36px,7vw,80px);font-weight:950;letter-spacing:-.065em;line-height:.82;color:#0a0a0a;margin:0 0 16px}.editorial-note span{color:var(--accent)}.theme-select-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.success{background:linear-gradient(135deg,#050505,#151515);border:1px solid #ffffff10;box-shadow:0 18px 40px #00000016}.success:before{content:'';width:5px;align-self:stretch;background:var(--accent);border-radius:99px}" +
    ".app-shell{display:grid;grid-template-columns:245px minmax(0,1fr);gap:18px;align-items:start}.app-main{min-width:0}.side{position:sticky;top:78px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:14px;box-shadow:0 8px 28px #00000008}.side-profile{display:flex;gap:12px;align-items:center;padding:7px 6px 15px;border-bottom:1px solid var(--line);margin-bottom:10px}.profile-img,.profile-fallback{width:52px;height:52px;border-radius:16px;object-fit:cover;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),#111);color:#fff;font-weight:950;font-size:20px;flex:0 0 auto}.profile-img.hero-avatar,.profile-fallback.hero-avatar{width:72px;height:72px;border-radius:20px;border:1px solid #ffffff2a}.side-name{font-weight:900;font-size:14px;letter-spacing:-.02em}.side-meta{font-size:11px;color:var(--muted);margin-top:3px}.side-nav{display:grid;gap:5px}.side-link{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:11px;font-size:13px;font-weight:780;color:#4f4f4f}.side-link:hover{background:#f5f5f2;color:#111}.side-link.active{background:#0a0a0a;color:#fff}.side-link .nav-dot{width:8px;height:8px;border-radius:99px;background:#c8c8c3}.side-link.active .nav-dot{background:var(--accent);box-shadow:0 0 12px var(--accent)}.side-public{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}.page-title{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:2px 0 14px}.page-title h2{font-size:28px;letter-spacing:-.04em;margin:0}.page-title p{margin:5px 0 0;color:var(--muted);font-size:13px}.page-actions{display:flex;gap:8px;flex-wrap:wrap}.overview-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:14px}.profile-settings{display:grid;grid-template-columns:220px 1fr;gap:18px;align-items:start}.profile-preview{width:180px;height:180px;border-radius:30px;object-fit:cover;background:linear-gradient(135deg,var(--accent),#111);color:#fff;display:grid;place-items:center;font-size:58px;font-weight:950;border:1px solid var(--line)}.upload-zone{border:1px dashed #cfcfca;border-radius:16px;padding:16px;background:#fafaf8}.participant-table{min-width:620px}.quick-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.quick-card{border:1px solid var(--line);border-radius:14px;padding:14px;background:#fff;transition:transform .18s ease,box-shadow .18s ease}.quick-card:hover{transform:translateY(-2px);box-shadow:0 12px 28px #0000000b}.quick-card b{display:block;font-size:14px}.quick-card span{display:block;color:var(--muted);font-size:11px;margin-top:4px}.avatar-sm,.avatar-sm-fallback{width:38px;height:38px;border-radius:12px;object-fit:cover;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),#111);color:#fff;font-weight:900}.comp-with-avatar{display:flex;gap:12px;align-items:center}.content-card{min-height:220px}.view-fade{animation:viewIn .28s ease}@keyframes viewIn{from{opacity:.45;transform:translateY(5px)}to{opacity:1;transform:none}}" +
    ".metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-bottom:14px}.point-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.point-card{border:1px solid var(--line);border-radius:16px;padding:15px;background:#fff}.point-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.point-value{font-size:26px;font-weight:950;letter-spacing:-.05em;color:var(--accent)}.quick-points{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.quick-points button{border:1px solid var(--line);background:#f8f8f5;border-radius:9px;padding:7px 10px;font-weight:850;cursor:pointer}.quick-points button:hover{border-color:var(--accent);color:var(--accent)}.point-custom{display:grid;grid-template-columns:85px 1fr auto;gap:7px}.point-custom input{padding:9px 10px}.score-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:5px 9px;background:var(--accent-soft);color:var(--accent);font-weight:900;font-size:12px}.public-board{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(360px,.75fr);gap:14px;align-items:start}.public-header{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#0a0a0a;color:#fff;border-radius:22px;padding:18px 20px;margin-bottom:12px;position:relative;overflow:hidden}.public-header:after{content:'';position:absolute;right:-60px;top:-100px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,var(--accent-glow),transparent 68%)}.public-brand{display:flex;gap:14px;align-items:center;position:relative;z-index:1}.public-brand h1{font-size:clamp(25px,3.2vw,48px);line-height:.95;letter-spacing:-.05em;margin:0}.public-brand p{margin:6px 0 0;color:#bdbdbd;font-size:12px}.public-prize{position:relative;z-index:1;text-align:right;max-width:280px}.public-prize b{display:block;font-size:13px}.public-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}.public-kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 12px}.public-kpi span{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:800}.public-kpi b{display:block;font-size:22px;margin-top:3px;letter-spacing:-.04em}.public-table{min-width:0}.public-table th,.public-table td{padding:8px 10px;font-size:12px}.public-table th{font-size:9px}.public-table .rank{font-size:15px}.public-table .person{font-size:12px}.public-side{display:grid;gap:12px}.public-panel{background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px}.public-panel h3{margin:0 0 10px;font-size:14px}.public-board .podium{margin-bottom:0}.public-board .podium-card{padding:10px}.public-board .podium-name{font-size:14px}.public-board .bar-row{grid-template-columns:80px 1fr 42px;gap:7px}.public-board .track{height:22px}.capture-note{font-size:10px;color:var(--muted);margin-top:8px}.points-col{font-weight:950;color:var(--accent)}" +
    "@media(max-width:850px){.span8,.span7,.span6,.span5,.span4,.span3{grid-column:span 12}.form-grid{grid-template-columns:1fr}.top{align-items:center}.brand span:last-child{font-size:15px}.hero{padding:22px}.hero-row{display:block}.hero-side{margin-top:18px}.comp{align-items:flex-start;flex-direction:column}.bar-row{grid-template-columns:84px 1fr 34px}.wrap{padding:8px 12px 52px}.links-grid{grid-template-columns:1fr}.success{align-items:flex-start;flex-direction:column}.searchbox{max-width:none;width:100%}.mobile-tip{display:block}.table-wrap{border-radius:12px}.card{padding:15px;border-radius:16px}.hero{border-radius:20px}.quickbar{margin-right:-12px;padding-right:12px}.podium{grid-template-columns:repeat(3,minmax(170px,1fr));overflow-x:auto;margin-right:-12px;padding-right:12px}.editorial-note{font-size:44px}.theme-select-row{grid-template-columns:1fr}.hero:after{right:-5px;bottom:-18px;font-size:88px}.app-shell{grid-template-columns:1fr}.side{position:static;padding:10px}.side-profile{margin-bottom:8px}.side-nav{display:flex;overflow-x:auto;gap:6px;padding-bottom:2px;scrollbar-width:none}.side-nav::-webkit-scrollbar{display:none}.side-link{white-space:nowrap;border:1px solid var(--line);background:#fff}.side-link.active{border-color:#0a0a0a}.side-public{display:none}.page-title{align-items:flex-start;flex-direction:column}.page-title h2{font-size:24px}.overview-grid{grid-template-columns:1fr}.profile-settings{grid-template-columns:1fr}.profile-preview{width:132px;height:132px;border-radius:24px}.quick-actions{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(2,1fr)}.point-grid{grid-template-columns:1fr}.point-custom{grid-template-columns:80px 1fr}.point-custom button{grid-column:1/-1}.public-board{grid-template-columns:1fr}.public-kpis{grid-template-columns:repeat(2,1fr)}.public-header{align-items:flex-start;flex-direction:column}.public-prize{text-align:left}.wrap{width:calc(100% - 18px);padding-left:0;padding-right:0}}" +
    "</style></head><body><div class=\"wrap\">" + body + "</div>" +
    "<script>" + extraScript + "</script></body></html>";
}

function topNav() {
  const auth = adminAuthConfigured();
  return "<div class=\"top\"><a class=\"brand\" href=\"/admin\"><span class=\"mark\">CL</span><span>Competition Link Tracker</span></a>" +
    "<div class=\"nav\"><a class=\"btn2\" href=\"/admin\">Dashboard</a>" +
    (auth
      ? "<form method=\"post\" action=\"/admin/logout\" style=\"margin:0\"><button class=\"btn2\" type=\"submit\">Déconnexion</button></form>"
      : "<span class=\"status dangerText\">Admin non protégé</span>") +
    "</div></div>";
}

function loginPage(message = "", next = "/admin") {
  const body =
    "<div style=\"min-height:78vh;display:grid;place-items:center;padding:18px\">" +
      "<div class=\"card\" style=\"width:min(440px,100%);padding:26px;box-shadow:none\">" +
        "<div class=\"brand\" style=\"margin-bottom:22px\"><span class=\"mark\">CL</span><span>Competition Link Tracker</span></div>" +
        "<div class=\"eyebrow\" style=\"color:#666\">Accès administrateur</div>" +
        "<h1 style=\"font-size:32px;letter-spacing:-.04em;margin:8px 0 10px\">Connexion</h1>" +
        "<p class=\"muted\" style=\"margin:0 0 18px;line-height:1.5\">Entre ton nom d’utilisateur et ton code administrateur.</p>" +
        (message ? "<div class=\"notice dangerText\" style=\"margin-bottom:14px\">" + esc(message) + "</div>" : "") +
        "<form method=\"post\" action=\"/admin/login\">" +
          "<input type=\"hidden\" name=\"next\" value=\"" + esc(next) + "\">" +
          "<div style=\"display:grid;gap:12px\">" +
            "<div><label>Nom d’utilisateur</label><input name=\"username\" autocomplete=\"username\" required></div>" +
            "<div><label>Code administrateur</label><input name=\"code\" type=\"password\" autocomplete=\"current-password\" required></div>" +
            "<button class=\"btn\" type=\"submit\" style=\"width:100%;margin-top:2px\">Se connecter</button>" +
          "</div>" +
        "</form>" +
      "</div>" +
    "</div>";
  return pageShell("Connexion administrateur", body);
}

async function ensureAdminAccess(req, res, nextPath) {
  if (!adminAuthConfigured()) return true;
  const session = await getAdminSession(req);
  if (session) return true;
  redirect(res, "/admin/login?next=" + encodeURIComponent(loginNextPath(nextPath)), 303);
  return false;
}


function participantShell(title, body, extraScript = "") {
  return "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">" +
    "<meta name=\"theme-color\" content=\"#111111\"><title>" + esc(title) + "</title>" +
    "<style>" +
    ":root{--p-bg:#f5f5f2;--p-card:#fff;--p-text:#101010;--p-muted:#6d6d6d;--p-line:#deded8;--p-accent:#111;--p-ok:#157347}" +
    "*{box-sizing:border-box}body{margin:0;background:var(--p-bg);color:var(--p-text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
    "a{text-decoration:none;color:inherit}.p-wrap{width:min(1180px,calc(100% - 24px));margin:0 auto;padding:18px 0 90px}.p-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0 18px}.p-brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:-.02em}.p-mark{width:32px;height:32px;border-radius:10px;background:#111;color:#fff;display:grid;place-items:center;font-size:13px}.p-nav{display:flex;gap:8px;align-items:center}.p-btn,.p-btn2{border:0;border-radius:11px;padding:11px 14px;font:inherit;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}.p-btn{background:#111;color:#fff}.p-btn2{background:#fff;color:#111;border:1px solid var(--p-line)}.p-card{background:#fff;border:1px solid var(--p-line);border-radius:16px;padding:18px}.p-hero{background:#111;color:#fff;border-radius:20px;padding:24px;margin-bottom:14px}.p-hero h1{font-size:clamp(30px,6vw,54px);line-height:.98;letter-spacing:-.05em;margin:8px 0 10px}.p-hero p{color:#c9c9c9;margin:0;max-width:720px;line-height:1.5}.p-kicker{font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:900;color:#a8a8a8}.p-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.p-span12{grid-column:span 12}.p-span8{grid-column:span 8}.p-span6{grid-column:span 6}.p-span4{grid-column:span 4}.p-stat b{display:block;font-size:28px;letter-spacing:-.04em;margin-top:4px}.p-stat span{font-size:11px;color:var(--p-muted);font-weight:800;text-transform:uppercase;letter-spacing:.06em}.p-link{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f6f3;border:1px solid var(--p-line);border-radius:10px;padding:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.p-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.p-title{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.p-title h2{margin:0;font-size:18px;letter-spacing:-.02em}.p-muted{color:var(--p-muted)}.p-small{font-size:12px}.p-form{display:grid;gap:12px}.p-form label{display:block;font-size:12px;font-weight:800;margin-bottom:6px}.p-form input{width:100%;border:1px solid var(--p-line);background:#fff;border-radius:11px;padding:12px 13px;font:inherit;outline:none}.p-form input:focus{border-color:#111;box-shadow:0 0 0 3px #0000000c}.p-notice{border:1px solid var(--p-line);background:#fafaf8;border-radius:12px;padding:12px 14px;font-size:12px;line-height:1.5}.p-success{border-color:#b9d8c7;background:#f3fbf6}.p-error{border-color:#efc7c2;background:#fff7f6}.p-code{font:900 34px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.p-bottom{display:none}.p-rank{font-size:60px;font-weight:950;letter-spacing:-.07em;line-height:.9}" +
    "@media(max-width:760px){.p-wrap{width:calc(100% - 18px);padding-bottom:96px}.p-top .p-nav{display:none}.p-grid{grid-template-columns:repeat(2,1fr)}.p-span12,.p-span8,.p-span6,.p-span4{grid-column:1/-1}.p-card{padding:15px}.p-hero{padding:20px}.p-hero h1{font-size:38px}.p-stat{grid-column:span 1}.p-stat b{font-size:24px}.p-bottom{position:fixed;display:grid;grid-template-columns:repeat(5,1fr);left:9px;right:9px;bottom:9px;background:#111;color:#fff;border-radius:16px;padding:6px;z-index:50}.p-bottom a{padding:10px 6px;text-align:center;font-size:11px;font-weight:800;border-radius:10px}.p-bottom a.active{background:#fff;color:#111}.p-actions .p-btn,.p-actions .p-btn2{flex:1 1 auto}.p-code{font-size:28px}}" +
    "</style></head><body><div class=\"p-wrap\">" + body + "</div>" +
    (extraScript ? "<script>" + extraScript + "</script>" : "") +
    "</body></html>";
}

function participantTop(session = null) {
  return "<div class=\"p-top\"><a class=\"p-brand\" href=\"" + (session ? "/me/" + encodeURIComponent(session.competition_id) : "/participant/login") + "\"><span class=\"p-mark\">CL</span><span>Competition Link Tracker</span></a>" +
    "<div class=\"p-nav\">" +
      (session ? "<a class=\"p-btn2\" href=\"/leaderboard/" + encodeURIComponent(session.competition_id) + "\">Classement</a><form method=\"post\" action=\"/participant/logout\" style=\"margin:0\"><button class=\"p-btn2\" type=\"submit\">Déconnexion</button></form>" : "<a class=\"p-btn2\" href=\"/participant/login\">Se connecter</a>") +
    "</div></div>";
}

function participantBottom(session, active = "home") {
  if (!session) return "";
  const id = encodeURIComponent(session.competition_id);
  const item = (key,label,href) => "<a class=\"" + (active===key?"active":"") + "\" href=\"" + href + "\">" + label + "</a>";
  return "<nav class=\"p-bottom\">" +
    item("home","Accueil","/me/" + id) +
    item("campaigns","Campagnes","/me/" + id + "/campaigns") +
    item("ranking","Classement","/leaderboard/" + id) +
    item("rewards","Récompenses","/me/" + id + "/rewards") +
    item("rules","Règlement","/me/" + id + "/rules") +
  "</nav>";
}

function joinPage(comp, message = "", values = {}) {
  const body = participantTop(null) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Inscription ouverte</div><h1>" + esc(comp.name) + "</h1><p>Crée ton accès en quelques secondes et reçois immédiatement ton lien personnel de participation.</p></section>" +
    "<div class=\"p-grid\"><div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Participer</h2><span class=\"p-small p-muted\">" + Number(comp.participant_count || 0) + " participant(s)</span></div>" +
      (message ? "<div class=\"p-notice p-error\" style=\"margin-bottom:12px\">" + esc(message) + "</div>" : "") +
      "<form class=\"p-form\" method=\"post\" action=\"/join/" + encodeURIComponent(comp.id) + "\">" +
        "<div><label>Pseudo</label><input name=\"pseudonym\" maxlength=\"40\" value=\"" + esc(values.pseudonym || "") + "\" placeholder=\"Ex. TONNY92\" required></div>" +
        "<div><label>Numéro WhatsApp</label><input name=\"whatsapp\" inputmode=\"tel\" autocomplete=\"tel\" value=\"" + esc(values.whatsapp || "") + "\" placeholder=\"Ex. +237 6XX XXX XXX\" required></div>" +
        "<button class=\"p-btn\" type=\"submit\">Participer maintenant</button>" +
      "</form><div class=\"p-small p-muted\" style=\"margin-top:12px\">Ton numéro WhatsApp reste privé et n’apparaît jamais dans le classement public.</div></div>" +
      "<div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Comment ça marche</h2></div><div class=\"p-notice\">Après ton inscription, la plateforme crée ton lien personnel. Tu peux le partager à tes contacts et suivre ton rang, tes points et l’activité générée depuis ton espace.</div><div class=\"p-actions\"><a class=\"p-btn2\" href=\"/leaderboard/" + encodeURIComponent(comp.id) + "\">Voir le classement</a><a class=\"p-btn2\" href=\"/participant/login\">J’ai déjà un compte</a></div></div></div>";
  return participantShell("Participer — " + comp.name, body);
}

function joinSuccessPage(result, origin) {
  const link = origin + "/r/" + result.competitionId + "/" + result.referralCode;
  const body = participantTop({competition_id:result.competitionId,referral_code:result.referralCode}) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Inscription confirmée</div><h1>Bienvenue, " + esc(result.pseudonym) + ".</h1><p>Ton accès et ton lien personnel sont prêts.</p></section>" +
    "<div class=\"p-grid\"><div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Ton code privé</h2></div><div class=\"p-code\">" + esc(result.accessCode) + "</div><div class=\"p-notice p-success\" style=\"margin-top:12px\">Conserve ce code. Il te permettra de te reconnecter avec ton numéro WhatsApp.</div></div>" +
      "<div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Ton lien personnel</h2></div><div class=\"p-link\">" + esc(link) + "</div><div class=\"p-actions\"><button class=\"p-btn copy-participant-link\" type=\"button\" data-link=\"" + esc(link) + "\">Copier le lien</button><a class=\"p-btn2\" href=\"/me/" + encodeURIComponent(result.competitionId) + "\">Ouvrir mon espace</a></div></div></div>";
  const script = "document.addEventListener('click',async e=>{const b=e.target.closest('.copy-participant-link');if(!b)return;try{await navigator.clipboard.writeText(b.dataset.link);b.textContent='Copié ✓'}catch{prompt('Copie ce lien :',b.dataset.link)}});";
  return participantShell("Inscription confirmée", body, script);
}

function participantLoginPage(message = "") {
  const body = participantTop(null) +
    "<div style=\"min-height:68vh;display:grid;place-items:center\"><div class=\"p-card\" style=\"width:min(440px,100%)\"><div class=\"p-kicker\" style=\"color:#666\">Espace participant</div><h1 style=\"font-size:32px;letter-spacing:-.04em;margin:8px 0 10px\">Connexion</h1><p class=\"p-muted\" style=\"margin:0 0 16px\">Utilise ton numéro WhatsApp et le code privé reçu lors de ton inscription.</p>" +
    (message ? "<div class=\"p-notice p-error\" style=\"margin-bottom:12px\">" + esc(message) + "</div>" : "") +
    "<form class=\"p-form\" method=\"post\" action=\"/participant/login\"><div><label>Numéro WhatsApp</label><input name=\"whatsapp\" inputmode=\"tel\" autocomplete=\"tel\" required></div><div><label>Code privé</label><input name=\"code\" inputmode=\"numeric\" maxlength=\"6\" autocomplete=\"one-time-code\" required></div><button class=\"p-btn\" type=\"submit\">Se connecter</button></form></div></div>";
  return participantShell("Connexion participant", body);
}

async function participantDashboardPage(origin, session) {
  const comp = await findCompetition(session.competition_id);
  if (!comp) return participantShell("Compétition introuvable", participantTop(session) + "<div class=\"p-card\">Compétition introuvable.</div>");

  await ensureCompetitionLifecycle(comp.id).catch(()=>null);

  const rows = await getRankedParticipants(comp);
  const row = rows.find(r => r.code === session.referral_code);
  const rank = row?.rank || "—";
  const points = row?.points || 0;
  const clicks = row?.clicks || 0;
  const unique = row?.unique || 0;
  const valid = row?.valid || 0;
  const link = origin + "/r/" + comp.id + "/" + session.referral_code;

  const [day, conversions, rewards, notifications, config] = await Promise.all([
    getActiveDay(comp.id).catch(()=>null),
    participantConversionStats(comp.id, session.participant_id).catch(()=>({interests:0,leads:0,sales:0})),
    participantRewards(comp.id, session.participant_id).catch(()=>null),
    listParticipantNotifications(comp.id, session.participant_id, 8).catch(()=>[]),
    getCompetitionConfig(comp.id).catch(()=>null)
  ]);

  const missions = day ? await listDayMissions(comp.id, day.id).catch(()=>[]) : [];
  const claimed = day ? await query(
    "SELECT 1 FROM daily_claims WHERE day_id = $1 AND participant_id = $2 LIMIT 1",
    [day.id, session.participant_id]
  ).then(r=>r.rowCount>0).catch(()=>false) : false;

  const ahead = typeof rank === "number" && rank > 1 ? rows[rank - 2] : null;
  const gapAhead = ahead ? Math.max(0, Number(ahead.points||0) - Number(points||0) + 1) : 0;
  const winnerCount = Number(config?.winner_count || 1);
  const topTarget = rows[winnerCount - 1];
  const gapTop = typeof rank === "number" && rank > winnerCount && topTarget
    ? Math.max(0, Number(topTarget.points||0) - Number(points||0) + 1)
    : 0;

  const endsAt = config?.ends_at ? new Date(config.ends_at).getTime() : null;
  const remainingMs = endsAt ? Math.max(0, endsAt - Date.now()) : null;
  const remainingText = remainingMs === null
    ? "Non défini"
    : Math.floor(remainingMs/86400000) + "j " + Math.floor((remainingMs%86400000)/3600000) + "h";

  const missionHtml = day
    ? "<div class=\"p-card p-span6\"><div class=\"p-kicker\" style=\"color:#666\">Événement du jour</div><h2 style=\"font-size:25px;margin:7px 0 8px\">" + esc(day.title) + "</h2><p class=\"p-muted\" style=\"margin:0 0 12px\">" + esc(day.description||day.marketing_message||"Consulte la mission et partage la campagne vedette.") + "</p>" +
      (missions.length ? missions.map(m=>"<div class=\"p-notice\" style=\"margin-top:8px\"><b>" + esc(m.title) + "</b><br>" + esc(m.description||"") + (Number(m.points_fixed||0) ? "<br><span class=\"p-small\">+" + Number(m.points_fixed) + " pts</span>" : "") + "<form method=\"post\" action=\"/api/me/" + encodeURIComponent(comp.id) + "/mission-submit\" style=\"margin-top:9px\"><input type=\"hidden\" name=\"missionId\" value=\"" + esc(m.id) + "\"><button class=\"p-btn2\" type=\"submit\">J’ai terminé</button></form></div>").join("") : "") +
      (day.featured_campaign_slug ? "<div class=\"p-actions\"><a class=\"p-btn2\" href=\"/me/" + encodeURIComponent(comp.id) + "/campaigns\">Voir l’affiche vedette</a></div>" : "") +
      "</div>"
    : "<div class=\"p-card p-span6\"><div class=\"p-kicker\" style=\"color:#666\">Événement du jour</div><h2 style=\"margin:7px 0\">Aucune journée active</h2><p class=\"p-muted\">L’administrateur n’a pas encore publié l’événement du jour.</p></div>";

  const claimHtml = day
    ? "<div class=\"p-card p-span6\"><div class=\"p-kicker\" style=\"color:#666\">Récompense quotidienne</div><div style=\"font-size:42px;font-weight:950;letter-spacing:-.06em;margin:7px 0\">+" + Number(day.reward_daily_points||0) + " pts</div>" +
      (claimed
        ? "<div class=\"p-notice p-success\">Récompense déjà récupérée aujourd’hui.</div>"
        : "<form method=\"post\" action=\"/api/me/" + encodeURIComponent(comp.id) + "/daily-claim\"><input type=\"hidden\" name=\"dayId\" value=\"" + esc(day.id) + "\"><button class=\"p-btn\" type=\"submit\">Récupérer</button></form>") +
      "</div>"
    : "<div class=\"p-card p-span6\"><div class=\"p-kicker\" style=\"color:#666\">Récompense quotidienne</div><h2 style=\"margin:7px 0\">Indisponible</h2><p class=\"p-muted\">Reviens lorsqu’une journée sera active.</p></div>";

  const motivation = [
    ahead ? "Encore " + gapAhead + " point(s) pour dépasser #" + (Number(rank)-1) + "." : "Tu occupes actuellement la première position.",
    gapTop > 0 ? "Encore " + gapTop + " point(s) pour entrer dans le Top " + winnerCount + "." : "Tu es actuellement dans la zone Top " + winnerCount + ".",
    rewards?.nextTier ? "Encore " + Math.max(0,Number(rewards.nextTier.min_points)-Number(points)) + " point(s) avant ton prochain palier." : ""
  ].filter(Boolean);

  const notifHtml = notifications.length
    ? notifications.map(n=>"<div class=\"p-notice\" style=\"margin-top:8px\"><b>" + esc(n.title) + "</b><br>" + esc(n.body) + (n.action_url ? "<br><a href=\"" + esc(n.action_url) + "\" style=\"font-weight:800\">Ouvrir</a>" : "") + "</div>").join("")
    : "<div class=\"p-muted p-small\">Aucune notification récente.</div>";

  const body = participantTop(session) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Mon espace · " + esc(comp.name) + "</div><h1>" + esc(session.pseudonym) + "</h1><p>Ta compétition en un coup d’œil. Temps restant : " + esc(remainingText) + ".</p></section>" +
    "<div class=\"p-grid\">" +
      "<div class=\"p-card p-span4\"><div class=\"p-stat\"><span>Position</span><div class=\"p-rank\">#" + esc(rank) + "</div></div></div>" +
      "<div class=\"p-card p-span4 p-stat\"><span>Points</span><b>" + points + "</b></div>" +
      "<div class=\"p-card p-span4 p-stat\"><span>Clics valides</span><b>" + valid + "</b></div>" +
      claimHtml + missionHtml +
      "<div class=\"p-card p-span12\"><div class=\"p-title\"><h2>Ton lien personnel</h2><span class=\"p-small p-muted\">" + unique + " personne(s) distincte(s) · " + clicks + " ouverture(s)</span></div><div class=\"p-link\">" + esc(link) + "</div><div class=\"p-actions\"><button class=\"p-btn copy-participant-link\" type=\"button\" data-link=\"" + esc(link) + "\">Copier</button><button class=\"p-btn2 share-participant-link\" type=\"button\" data-link=\"" + esc(link) + "\">Partager</button><a class=\"p-btn2\" href=\"/me/" + encodeURIComponent(comp.id) + "/campaigns\">Voir les affiches</a></div></div>" +
      "<div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Progression</h2></div>" + motivation.map(x=>"<div class=\"p-notice\" style=\"margin-top:8px\">" + esc(x) + "</div>").join("") + "</div>" +
      "<div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Conversions</h2></div><div class=\"p-grid\"><div class=\"p-stat p-span4\"><span>Intérêts</span><b>" + Number(conversions.interests||0) + "</b></div><div class=\"p-stat p-span4\"><span>Prospects</span><b>" + Number(conversions.leads||0) + "</b></div><div class=\"p-stat p-span4\"><span>Ventes</span><b>" + Number(conversions.sales||0) + "</b></div></div></div>" +
      "<div class=\"p-card p-span12\"><div class=\"p-title\"><h2>Notifications</h2></div>" + notifHtml + "</div>" +
    "</div>" + participantBottom(session,"home");

  const script = "document.addEventListener('click',async e=>{const c=e.target.closest('.copy-participant-link');if(c){try{await navigator.clipboard.writeText(c.dataset.link);c.textContent='Copié ✓'}catch{prompt('Copie ce lien :',c.dataset.link)}return}const s=e.target.closest('.share-participant-link');if(s){if(navigator.share){try{await navigator.share({title:'Mon lien de compétition',url:s.dataset.link})}catch{}}else{try{await navigator.clipboard.writeText(s.dataset.link);alert('Lien copié')}catch{prompt('Copie ce lien :',s.dataset.link)}}}});";
  return participantShell("Mon espace — " + comp.name, body, script);
}

async function participantCampaignsPage(origin, session) {
  const comp = await findCompetition(session.competition_id);
  if (!comp) return participantShell("Compétition introuvable", participantTop(session));
  const campaigns = await listCampaigns(comp.id);
  const cards = campaigns.length ? campaigns.map(camp => {
    const offer = origin + "/offer/" + comp.id + "/" + camp.slug + "/" + session.referral_code;
    const text = (camp.commercial_text || camp.short_text || camp.description || camp.name) + "\\n" + offer;
    return "<article class=\"p-card p-span6 campaign-card\" data-campaign=\"" + esc(camp.id) + "\">" +
      (camp.image_data ? "<img class=\"campaign-image\" src=\"" + esc(camp.image_data) + "\" alt=\"" + esc(camp.name) + "\" style=\"width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:13px;border:1px solid var(--p-line);margin-bottom:12px\">" : "") +
      "<div class=\"p-title\"><div><div class=\"p-kicker\" style=\"color:#666\">" + esc(camp.product||"Campagne") + "</div><h2 style=\"font-size:23px;margin:5px 0 0\">" + esc(camp.name) + "</h2></div>" + (camp.featured ? "<span class=\"p-notice\" style=\"padding:6px 9px\">Vedette</span>" : "") + "</div>" +
      "<p class=\"p-muted\">" + esc(camp.description||"") + "</p>" +
      "<div class=\"p-notice\">Partage +" + Number(camp.points_share||0) + " · Intérêt +" + Number(camp.points_interest||0) + " · Lead +" + Number(camp.points_lead||0) + " · Vente +" + Number(camp.points_sale||0) + "</div>" +
      "<div class=\"p-link\" style=\"margin-top:10px\">" + esc(offer) + "</div>" +
      "<div class=\"p-actions\">" +
        "<button class=\"p-btn campaign-share\" type=\"button\" data-campaign=\"" + esc(camp.id) + "\" data-link=\"" + esc(offer) + "\" data-text=\"" + esc(text) + "\">Partager</button>" +
        "<button class=\"p-btn2 campaign-copy\" type=\"button\" data-campaign=\"" + esc(camp.id) + "\" data-value=\"" + esc(offer) + "\">Copier le lien</button>" +
        "<button class=\"p-btn2 campaign-copy\" type=\"button\" data-campaign=\"" + esc(camp.id) + "\" data-value=\"" + esc(text) + "\">Copier le texte</button>" +
        (camp.image_data ? "<a class=\"p-btn2 campaign-download\" data-campaign=\"" + esc(camp.id) + "\" href=\"" + esc(camp.image_data) + "\" download=\"" + esc(camp.slug) + ".jpg\">Télécharger l’affiche</a>" : "") +
        "<a class=\"p-btn2 campaign-social\" data-campaign=\"" + esc(camp.id) + "\" href=\"https://wa.me/?text=" + encodeURIComponent(text) + "\" target=\"_blank\">WhatsApp</a>" +
        "<a class=\"p-btn2 campaign-social\" data-campaign=\"" + esc(camp.id) + "\" href=\"https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(offer) + "\" target=\"_blank\">Facebook</a>" +
        "<button class=\"p-btn2 campaign-tiktok\" type=\"button\" data-campaign=\"" + esc(camp.id) + "\" data-text=\"" + esc(text) + "\">TikTok</button>" +
      "</div></article>";
  }).join("") : "<div class=\"p-card p-span12\"><h2 style=\"margin-top:0\">Aucune campagne active</h2><p class=\"p-muted\">Les prochaines affiches apparaîtront ici dès leur publication.</p></div>";

  const body = participantTop(session) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Campagnes</div><h1>Choisis. Partage. Mesure.</h1><p>Chaque affiche utilise automatiquement ton lien personnel.</p></section>" +
    "<div class=\"p-grid\">" + cards + "</div>" + participantBottom(session,"campaigns");

  const compId = JSON.stringify(comp.id);
  const script =
    "async function markShare(campaign,channel){try{await fetch('/api/me/'+encodeURIComponent(" + compId + " )+'/campaign/'+encodeURIComponent(campaign)+'/share',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'channel='+encodeURIComponent(channel)})}catch{}}" +
    "document.addEventListener('click',async e=>{const share=e.target.closest('.campaign-share');if(share){await markShare(share.dataset.campaign,'native');if(navigator.share){try{await navigator.share({title:'Offre',text:share.dataset.text,url:share.dataset.link})}catch{}}else{try{await navigator.clipboard.writeText(share.dataset.text);alert('Texte et lien copiés')}catch{}}return}const copy=e.target.closest('.campaign-copy');if(copy){await markShare(copy.dataset.campaign,'copy');try{await navigator.clipboard.writeText(copy.dataset.value);copy.textContent='Copié ✓'}catch{prompt('Copie :',copy.dataset.value)}return}const social=e.target.closest('.campaign-social');if(social){markShare(social.dataset.campaign,'social');return}const dl=e.target.closest('.campaign-download');if(dl){markShare(dl.dataset.campaign,'download');return}const tt=e.target.closest('.campaign-tiktok');if(tt){await markShare(tt.dataset.campaign,'tiktok');try{await navigator.clipboard.writeText(tt.dataset.text)}catch{}window.open('https://www.tiktok.com/','_blank')}});";

  return participantShell("Campagnes — " + comp.name, body, script);
}

async function participantRewardsPage(origin, session) {
  const comp = await findCompetition(session.competition_id);
  if (!comp) return participantShell("Compétition introuvable", participantTop(session));
  const data = await participantRewards(comp.id, session.participant_id);
  const m = data.membership || {};
  const points = Number(m.total_points_cache||0);
  const rank = m.rank_cache || "—";
  const current = data.currentTier;
  const next = data.nextTier;

  let winnerBlock = "";
  if (m.status === "completed" && Number(rank) <= Number(m.winner_count||0)) {
    if (data.selection) {
      winnerBlock = "<div class=\"p-notice p-success\"><b>Lot choisi :</b> " + esc(data.selection.prize_name) + " " + esc(data.selection.duration_text||"") + "</div>";
    } else {
      const available = data.prizes.filter(p=>p.status==="available");
      winnerBlock = "<div class=\"p-card p-span12\"><div class=\"p-title\"><h2>Choisis ton lot</h2><span class=\"p-small p-muted\">Rang #" + esc(rank) + "</span></div><div class=\"p-grid\">" +
        available.map(p=>"<form class=\"p-card p-span4\" method=\"post\" action=\"/api/me/" + encodeURIComponent(comp.id) + "/prize-select\"><input type=\"hidden\" name=\"prizeId\" value=\"" + esc(p.id) + "\"><b>" + esc(p.name) + "</b><div class=\"p-small p-muted\" style=\"margin:6px 0\">" + esc(p.duration_text||"") + "</div><button class=\"p-btn2\" type=\"submit\">Choisir</button></form>").join("") +
      "</div></div>";
    }
  }

  const body = participantTop(session) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Récompenses</div><h1>" + points + " points.</h1><p>Ton palier et tes éventuels lots apparaissent ici.</p></section>" +
    "<div class=\"p-grid\">" +
      "<div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Palier actuel</h2></div>" + (current ? "<div style=\"font-size:38px;font-weight:950\">" + Number(current.reward_value) + (current.reward_type==="discount"?" %":"") + "</div><p class=\"p-muted\">" + esc(current.reward_type) + "</p>" : "<p class=\"p-muted\">Aucun palier débloqué.</p>") + "</div>" +
      "<div class=\"p-card p-span6\"><div class=\"p-title\"><h2>Prochain palier</h2></div>" + (next ? "<div style=\"font-size:30px;font-weight:950\">" + Number(next.min_points) + " pts</div><p class=\"p-muted\">Encore " + Math.max(0,Number(next.min_points)-points) + " point(s).</p>" : "<p class=\"p-muted\">Tu as atteint le dernier palier configuré.</p>") + "</div>" +
      (data.coupon ? "<div class=\"p-card p-span12\"><div class=\"p-title\"><h2>Ton bon</h2><span class=\"p-small p-muted\">" + esc(data.coupon.status) + "</span></div><div class=\"p-code\">" + esc(data.coupon.code) + "</div></div>" : "") +
      winnerBlock +
    "</div>" + participantBottom(session,"rewards");
  return participantShell("Récompenses — " + comp.name, body);
}

async function participantRulesPage(session) {
  const comp = await getCompetitionConfig(session.competition_id);
  const body = participantTop(session) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Règlement</div><h1>" + esc(comp?.name||"Compétition") + "</h1><p>Règles publiques de participation et d’attribution des points.</p></section>" +
    "<div class=\"p-card\"><div style=\"white-space:pre-wrap;line-height:1.7\">" + esc(comp?.rules || "Le règlement détaillé sera publié par l’administrateur. Les activités réelles générées par les liens personnels contribuent au score. Les clics artificiels, répétitifs ou frauduleux peuvent être ignorés.") + "</div></div>" +
    participantBottom(session,"rules");
  return participantShell("Règlement", body);
}


async function campaignOfferPage(origin, req, res, competitionId, campaignSlug, referralCode) {
  const comp = await findCompetition(competitionId);
  if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");
  const campaign = await getCampaignBySlug(competitionId, campaignSlug);
  if (!campaign || campaign.status !== "active") {
    return send(res, 404, "Campagne indisponible", "text/plain; charset=utf-8");
  }
  const participant = (await getParticipants(competitionId)).find(p=>p.code===referralCode && p.active!==false);
  if (!participant) return send(res, 404, "Lien participant inconnu", "text/plain; charset=utf-8");

  const adminSession = await getAdminSession(req).catch(()=>null);
  const participantSession = await getParticipantSession(req, competitionId).catch(()=>null);
  await trackReferralVisit({
    req,
    res,
    competitionId,
    referralCode,
    campaignId: campaign.id,
    isAdmin: Boolean(adminSession),
    isSelf: participantSession?.referral_code === referralCode
  });

  const body =
    "<div style=\"max-width:920px;margin:0 auto;padding:18px 12px 60px\">" +
      "<div class=\"p-top\"><a class=\"p-brand\" href=\"/\"><span class=\"p-mark\">CL</span><span>" + esc(comp.name) + "</span></a></div>" +
      "<section class=\"p-hero\"><div class=\"p-kicker\">" + esc(campaign.product||"Offre") + "</div><h1>" + esc(campaign.name) + "</h1><p>" + esc(campaign.short_text||campaign.description||"Découvre cette offre.") + "</p></section>" +
      "<div class=\"p-card\">" +
        (campaign.image_data ? "<img src=\"" + esc(campaign.image_data) + "\" alt=\"" + esc(campaign.name) + "\" style=\"display:block;width:100%;max-height:620px;object-fit:contain;border-radius:14px;background:#f4f4f1;margin-bottom:16px\">" : "") +
        "<div class=\"p-title\"><div><h2>" + esc(campaign.name) + "</h2><div class=\"p-small p-muted\">Recommandé par " + esc(participant.name) + "</div></div></div>" +
        "<p style=\"line-height:1.65\">" + esc(campaign.description||campaign.commercial_text||"") + "</p>" +
        "<form method=\"post\" action=\"/interest/" + encodeURIComponent(competitionId) + "/" + encodeURIComponent(campaign.slug) + "/" + encodeURIComponent(referralCode) + "\"><button class=\"p-btn\" style=\"width:100%;padding:14px\" type=\"submit\">Je suis intéressé</button></form>" +
        "<div class=\"p-small p-muted\" style=\"margin-top:10px\">Cette action enregistre uniquement ton intérêt avant d’ouvrir WhatsApp. Elle ne confirme pas automatiquement une vente.</div>" +
      "</div>" +
    "</div>";
  return send(res, 200, participantShell(campaign.name, body));
}

function whatsappInterestUrl(campaign, referenceCode) {
  const message = "Bonjour, je suis intéressé par l’offre " + (campaign.product || campaign.name) + ".\\n\\nRéférence : " + referenceCode;
  const base = String(campaign.whatsapp_url || "").trim();
  if (base && /wa\\.me|api\\.whatsapp\\.com/i.test(base)) {
    return base + (base.includes("?") ? "&" : "?") + "text=" + encodeURIComponent(message);
  }
  return "https://wa.me/?text=" + encodeURIComponent(message);
}

async function publicLandingPage() {
  const legacyComps = await getCompetitions();
  const rows = (await Promise.all(legacyComps.map(async (comp) => {
    try {
      const db = await getJoinableCompetition(comp.id);
      return db ? {...comp, db} : null;
    } catch {
      return {...comp, db:null};
    }
  }))).filter(Boolean).filter(x => ["active","scheduled"].includes(String(x.status || x.db?.status || "")));

  const cards = rows.length ? rows.map(({db, ...comp}) => {
    const open = db ? (db.status === "active" && db.registrations_open) : comp.status === "active";
    const count = db?.participant_count ?? 0;
    return "<article class=\"p-card p-span6\"><div class=\"p-title\"><div><div class=\"p-kicker\" style=\"color:#666\">" + esc(String(comp.status || db?.status || "").toUpperCase()) + "</div><h2 style=\"font-size:23px;margin-top:6px\">" + esc(comp.name) + "</h2></div><span class=\"p-small p-muted\">" + count + " participant(s)</span></div>" +
      (comp.prize ? "<div class=\"p-notice\" style=\"margin-bottom:12px\"><b>Récompense :</b> " + esc(comp.prize) + "</div>" : "") +
      "<div class=\"p-actions\">" +
        (open ? "<a class=\"p-btn\" href=\"/join/" + encodeURIComponent(comp.id) + "\">Participer</a>" : "") +
        "<a class=\"p-btn2\" href=\"/leaderboard/" + encodeURIComponent(comp.id) + "\">Classement</a>" +
      "</div></article>";
  }).join("") : "<div class=\"p-card p-span12\"><div class=\"p-muted\">Aucune compétition publique pour le moment.</div></div>";

  const body = participantTop(null) +
    "<section class=\"p-hero\"><div class=\"p-kicker\">Plateforme de compétition</div><h1>Partage. Progresse. Classe-toi.</h1><p>Choisis une compétition active, crée ton accès et récupère immédiatement ton lien personnel.</p></section>" +
    "<div class=\"p-title\" style=\"margin:20px 0 12px\"><h2>Compétitions disponibles</h2><a class=\"p-btn2\" href=\"/participant/login\">Mon espace</a></div>" +
    "<div class=\"p-grid\">" + cards + "</div>";

  return participantShell("Compétitions", body);
}


function podiumHtml(rows) {
  const top = rows.slice(0, 3);
  if (!top.length) return "";
  return "<div class=\"podium\">" + top.map((r, i) =>
    "<div class=\"podium-card " + (i === 0 ? "first" : "") + "\">" +
      "<div class=\"podium-rank\">Position #" + (i + 1) + "</div>" +
      "<div class=\"podium-name\">" + esc(r.name) + "</div>" +
      "<div class=\"podium-score\"><b>" + r.points + " pts</b> · " + r.unique + " uniques · " + r.clicks + " clics</div>" +
    "</div>"
  ).join("") + "</div>";
}

function participantLinksHtml(rows, origin) {
  if (!rows.length) return "<div class=\"empty\">Ajoute un participant et son lien personnel apparaîtra immédiatement ici.</div>";
  return rows.map((r) => {
    const link = origin + r.link;
    return "<article class=\"link-card participant-link-card\" data-search=\"" + esc((r.name + " " + r.code).toLowerCase()) + "\">" +
      "<div class=\"link-head\"><div><div class=\"link-name\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div><div style=\"margin-top:7px\"><span class=\"score-badge\">" + r.points + " pts</span></div></div><div class=\"link-rank\">#" + r.rank + "</div></div>" +
      "<div class=\"link-url\" title=\"" + esc(link) + "\">" + esc(link) + "</div>" +
      "<div class=\"link-actions\"><button class=\"btn copy\" type=\"button\" data-link=\"" + esc(link) + "\">Copier le lien</button>" +
      "<button class=\"btn2 share\" type=\"button\" data-link=\"" + esc(link) + "\" data-name=\"" + esc(r.name) + "\">Partager</button>" +
      "<a class=\"btn2\" href=\"" + esc(link) + "\" target=\"_blank\">Tester</a></div></article>";
  }).join("");
}

async function dashboardPage(origin) {
  await ensureLegacyMigration();
  const comps = await getCompetitions();
  const summaries = await Promise.all(comps.map(async (c) => {
    const rows = await getRankedParticipants(c);
    return {
      ...c,
      participants: rows.length,
      clicks: rows.reduce((s,r) => s + r.clicks, 0),
      unique: rows.reduce((s,r) => s + r.unique, 0)
    };
  }));
  const totals = summaries.reduce((a,c) => ({
    participants: a.participants + c.participants,
    clicks: a.clicks + c.clicks,
    unique: a.unique + c.unique
  }), {participants:0,clicks:0,unique:0});

  const cards = summaries.length ? summaries.map((c) =>
    "<div class=\"comp theme theme-" + esc(c.theme || "blue") + "\"><div><div class=\"comp-meta\"><span class=\"status\"><span class=\"theme-swatch\"></span>" + esc(c.status) + "</span><span class=\"small muted\">" + c.participants + " participants</span></div>" +
    "<h3>" + esc(c.name) + "</h3><div class=\"small muted\">" + c.unique + " uniques · " + c.clicks + " clics" + (c.endsAt ? " · fin " + esc(c.endsAt) : "") + "</div></div>" +
    "<div class=\"actions\"><a class=\"btn2\" href=\"/leaderboard/" + encodeURIComponent(c.id) + "\">Classement public</a><a class=\"btn\" href=\"/c/" + encodeURIComponent(c.id) + "\">Gérer</a></div></div>"
  ).join("") : "<div class=\"empty\">Aucune compétition pour le moment.</div>";

  const body = "<div class=\"theme theme-blue\">" + topNav() +
    "<section class=\"hero\" data-ghost=\"TRACKER\"><div class=\"eyebrow\">Dashboard live</div><h1>Suivez.<br>Comparez. Gagnez.</h1><p>Une interface éditoriale, sobre et rapide pour gérer tes compétitions, distribuer les liens personnels et suivre les performances presque en temps réel.</p></section>" +
    "<div class=\"grid\">" +
      "<div class=\"card span3 stat\"><div class=\"label\">Compétitions</div><div class=\"num\">" + summaries.length + "</div></div>" +
      "<div class=\"card span3 stat\"><div class=\"label\">Participants</div><div class=\"num\">" + totals.participants + "</div></div>" +
      "<div class=\"card span3 stat\"><div class=\"label\">Clics totaux</div><div class=\"num\">" + totals.clicks + "</div></div>" +
      "<div class=\"card span3 stat\"><div class=\"label\">Visiteurs uniques</div><div class=\"num\">" + totals.unique + "</div></div>" +
      "<div class=\"card span7\"><div class=\"section-title\"><h2>Mes compétitions</h2><span class=\"small muted\">Historique conservé</span></div><div class=\"comp-list\">" + cards + "</div></div>" +
      "<div class=\"card span5\"><div class=\"section-title\"><h2>Nouvelle compétition</h2><span class=\"status\"><span class=\"dot active\"></span>Prête à lancer</span></div>" +
        "<form method=\"post\" action=\"/api/competition/create\"><div class=\"form-grid\">" +
          "<div class=\"full\"><label>Nom</label><input name=\"name\" placeholder=\"Ex. Battle des Ambassadeurs\" required></div>" +
          "<div class=\"full\"><label>Lot / récompense</label><input name=\"prize\" placeholder=\"Ex. Spotify Premium 3 mois\"></div>" +
          "<div class=\"full\"><label>Lien de destination</label><input name=\"destination\" value=\"" + esc(WA_DEFAULT) + "\" required></div>" +
          "<div><label>Date de fin</label><input name=\"endsAt\" type=\"datetime-local\"></div>" +
          "<div><label>Statut</label><select name=\"status\"><option value=\"active\">Active</option><option value=\"draft\">Brouillon</option><option value=\"paused\">En pause</option></select></div>" +
          "<div class=\"full\"><label>Palette d’accent</label><select name=\"theme\"><option value=\"blue\">Bleu premium</option><option value=\"amber\">Ambre premium</option><option value=\"red\">Rouge profond</option><option value=\"mono\">Monochrome</option></select></div>" +
          "<div class=\"full\"><button class=\"btn\" type=\"submit\" style=\"width:100%\">Créer la compétition</button></div>" +
        "</div></form>" +
        "<div class=\"footer-note\">Les clics et visiteurs uniques indiquent l’activité des liens. Ils ne prouvent pas à eux seuls qu’une personne a effectivement rejoint le groupe WhatsApp.</div>" +
      "</div>" +
    "</div></div>";
  return pageShell("Competition Link Tracker", body);
}

function leaderboardRowsHtml(rows, origin, comp, publicMode) {
  if (!rows.length) return "<tr><td colspan=\"" + (publicMode ? "5" : "8") + "\" class=\"empty\">Aucun participant.</td></tr>";
  return rows.map((r) => {
    const link = origin + r.link;
    if (publicMode) {
      return "<tr data-code=\"" + esc(r.code) + "\">" +
        "<td class=\"rank " + (r.rank === 1 ? "one" : "") + "\">" + r.rank + "</td>" +
        "<td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
        "<td class=\"points-col\">" + r.points + " pts</td><td>" + r.valid + "</td><td><b>" + r.unique + "</b></td></tr>";
    }
    return "<tr data-code=\"" + esc(r.code) + "\">" +
      "<td class=\"rank " + (r.rank === 1 ? "one" : "") + "\">" + r.rank + "</td>" +
      "<td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
      "<td class=\"points-col\">" + r.points + "</td><td>" + r.clicks + "</td><td><b>" + r.unique + "</b></td><td>" + r.valid + "</td>" +
      "<td><div class=\"actions\"><button type=\"button\" class=\"iconbtn copy\" data-link=\"" + esc(link) + "\">Copier</button><a class=\"iconbtn\" href=\"" + esc(link) + "\" target=\"_blank\">Ouvrir</a></div></td>" +
      "<td><form method=\"post\" action=\"/api/competition/" + encodeURIComponent(comp.id) + "/delete-participant\"><input type=\"hidden\" name=\"code\" value=\"" + esc(r.code) + "\"><button class=\"danger\" type=\"submit\">Supprimer</button></form></td></tr>";
  }).join("");
}

function chartHtml(rows) {
  const max = Math.max(1, ...rows.map(r => r.points));
  return rows.map(r => {
    const pct = Math.max(2, Math.round((r.points / max) * 100));
    return "<div class=\"bar-row\" data-code=\"" + esc(r.code) + "\" title=\"" + esc(r.name) + " · " + r.points + " points\">" +
      "<div class=\"bar-name\">" + esc(r.name) + "</div>" +
      "<div class=\"track\"><div class=\"fill\" style=\"width:" + pct + "%\"></div></div>" +
      "<div class=\"bar-value\">" + r.points + " pts</div></div>";
  }).join("") || "<div class=\"empty\">Le graphique apparaîtra dès l’attribution des premiers points.</div>";
}


function profileAvatarHtml(profile, name, cls = "") {
  const initial = esc(String(name || "C").trim().charAt(0).toUpperCase() || "C");
  if (profile && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(profile)) {
    return "<img class=\"profile-img " + esc(cls) + "\" src=\"" + esc(profile) + "\" alt=\"Photo de la compétition\">";
  }
  return "<div class=\"profile-fallback " + esc(cls) + "\">" + initial + "</div>";
}

function competitionSidebar(comp, view, profile) {
  const id = encodeURIComponent(comp.id);
  const items = [
    ["overview","Vue d’ensemble","/c/" + id],
    ["links","Liens participants","/c/" + id + "/links"],
    ["ranking","Classement","/c/" + id + "/ranking"],
    ["live","Graphique live","/c/" + id + "/live"],
    ["participants","Participants","/c/" + id + "/participants"],
    ["campaigns","Affiches & campagnes","/c/" + id + "/campaigns"],
    ["days","Journées & événements","/c/" + id + "/days"],
    ["prospects","Prospects & ventes","/c/" + id + "/prospects"],
    ["scoring","Points & bonus","/c/" + id + "/scoring"],
    ["rewards","Récompenses","/c/" + id + "/rewards"],
    ["fraud","Anti-fraude","/c/" + id + "/fraud"],
    ["notifications","Notifications","/c/" + id + "/notifications"],
    ["settings","Paramètres","/c/" + id + "/settings"]
  ];
  return "<aside class=\"side\">" +
    "<div class=\"side-profile\">" + profileAvatarHtml(profile, comp.name) +
      "<div><div class=\"side-name\">" + esc(comp.name) + "</div><div class=\"side-meta\">" + esc(comp.status) + "</div></div></div>" +
    "<nav class=\"side-nav\">" +
      items.map(([key,label,href]) => "<a class=\"side-link " + (view === key ? "active" : "") + "\" href=\"" + href + "\"><span class=\"nav-dot\"></span>" + label + "</a>").join("") +
    "</nav>" +
    "<div class=\"side-public\"><a class=\"side-link\" target=\"_blank\" href=\"/leaderboard/" + id + "\"><span class=\"nav-dot\"></span>Classement public</a></div>" +
  "</aside>";
}

function pageTitleHtml(title, subtitle, actions = "") {
  return "<div class=\"page-title\"><div><h2>" + esc(title) + "</h2><p>" + esc(subtitle) + "</p></div>" +
    (actions ? "<div class=\"page-actions\">" + actions + "</div>" : "") + "</div>";
}

function participantAdminRows(rows, comp) {
  if (!rows.length) return "<tr><td colspan=\"8\" class=\"empty\">Aucun participant.</td></tr>";
  return rows.map(r =>
    "<tr><td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
    "<td>#" + r.rank + "</td><td class=\"points-col\">" + r.points + "</td><td>" + r.clicks + "</td><td>" + r.unique + "</td><td>" + r.valid + "</td>" +
    "<td><button class=\"iconbtn copy\" type=\"button\" data-link=\"/r/" + esc(comp.id) + "/" + esc(r.code) + "\">Copier lien</button></td>" +
    "<td><form method=\"post\" action=\"/api/competition/" + encodeURIComponent(comp.id) + "/delete-participant\"><input type=\"hidden\" name=\"code\" value=\"" + esc(r.code) + "\"><button class=\"danger\" type=\"submit\">Supprimer</button></form></td></tr>"
  ).join("");
}

function pointsCardsHtml(rows, comp) {
  if (!rows.length) return "<div class=\"empty\">Ajoute d’abord des participants.</div>";
  const id = encodeURIComponent(comp.id);
  return "<div class=\"point-grid\">" + rows.map(r =>
    "<article class=\"point-card\"><div class=\"point-head\"><div><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + " · rang #" + r.rank + "</div></div><div class=\"point-value\">" + r.points + " pts</div></div>" +
    "<form method=\"post\" action=\"/api/competition/" + id + "/points\">" +
      "<input type=\"hidden\" name=\"code\" value=\"" + esc(r.code) + "\">" +
      "<div class=\"quick-points\"><button name=\"quickAmount\" value=\"5\" type=\"submit\">+5</button><button name=\"quickAmount\" value=\"10\" type=\"submit\">+10</button><button name=\"quickAmount\" value=\"20\" type=\"submit\">+20</button><button name=\"quickAmount\" value=\"50\" type=\"submit\">+50</button></div>" +
      "<div class=\"point-custom\"><input name=\"amount\" type=\"number\" step=\"1\" min=\"-10000\" max=\"10000\" placeholder=\"± pts\"><input name=\"reason\" maxlength=\"80\" placeholder=\"Motif : abonnement, bonus…\"><button class=\"btn\" type=\"submit\">Valider</button></div>" +
    "</form></article>"
  ).join("") + "</div>";
}


async function adminCampaignsContent(comp) {
  const id = encodeURIComponent(comp.id);
  const campaigns = await listCampaigns(comp.id, {admin:true});
  const stats = await getCampaignStats(comp.id);
  const statsById = new Map(stats.map(x => [x.id, x]));
  const cards = campaigns.length ? campaigns.map(camp => {
    const s = statsById.get(camp.id) || {};
    return "<article class=\"card span6\">" +
      (camp.image_data ? "<img src=\"" + esc(camp.image_data) + "\" alt=\"\" style=\"width:100%;aspect-ratio:16/8;object-fit:cover;border-radius:13px;border:1px solid var(--line);margin-bottom:12px\">" : "") +
      "<div class=\"section-title\"><div><h2>" + esc(camp.name) + "</h2><div class=\"subnav-note\">" + esc(camp.product || camp.slug) + "</div></div><span class=\"status\">" + esc(camp.status) + "</span></div>" +
      "<div class=\"metric-grid\" style=\"grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:12px\">" +
        "<div class=\"stat\"><div class=\"label\">Partages</div><div class=\"num\" style=\"font-size:22px\">" + Number(s.shares||0) + "</div></div>" +
        "<div class=\"stat\"><div class=\"label\">Intérêts</div><div class=\"num\" style=\"font-size:22px\">" + Number(s.interests||0) + "</div></div>" +
        "<div class=\"stat\"><div class=\"label\">Leads</div><div class=\"num\" style=\"font-size:22px\">" + Number(s.leads||0) + "</div></div>" +
        "<div class=\"stat\"><div class=\"label\">Ventes</div><div class=\"num\" style=\"font-size:22px\">" + Number(s.sales||0) + "</div></div>" +
      "</div>" +
      "<div class=\"small muted\">Partage +" + Number(camp.points_share||0) + " · Intérêt +" + Number(camp.points_interest||0) + " · Lead +" + Number(camp.points_lead||0) + " · Vente +" + Number(camp.points_sale||0) + "</div>" +
      "<div class=\"actions\" style=\"margin-top:12px\">" +
        "<form method=\"post\" action=\"/api/competition/" + id + "/campaign-status\" style=\"display:flex;gap:7px;flex-wrap:wrap\"><input type=\"hidden\" name=\"campaignId\" value=\"" + esc(camp.id) + "\"><select name=\"status\" style=\"width:auto\"><option value=\"draft\"" + (camp.status==="draft"?" selected":"") + ">Brouillon</option><option value=\"scheduled\"" + (camp.status==="scheduled"?" selected":"") + ">Programmé</option><option value=\"active\"" + (camp.status==="active"?" selected":"") + ">Active</option><option value=\"paused\"" + (camp.status==="paused"?" selected":"") + ">Pause</option><option value=\"ended\"" + (camp.status==="ended"?" selected":"") + ">Terminée</option></select><button class=\"btn2\" type=\"submit\">Enregistrer</button></form>" +
        "<form method=\"post\" action=\"/api/competition/" + id + "/campaign-delete\"><input type=\"hidden\" name=\"campaignId\" value=\"" + esc(camp.id) + "\"><button class=\"danger\" type=\"submit\">Retirer</button></form>" +
      "</div></article>";
  }).join("") : "<div class=\"card span12 empty\">Aucune campagne. Crée la première ci-dessous.</div>";

  return pageTitleHtml("Affiches & campagnes","Chaque affiche devient une campagne traçable avec son propre barème.") +
    "<div class=\"grid\" style=\"margin-bottom:14px\">" + cards + "</div>" +
    "<div class=\"card\"><div class=\"section-title\"><div><h2>Nouvelle campagne</h2><div class=\"subnav-note\">Tous les points et limites restent modifiables depuis l’administration.</div></div></div>" +
      "<form method=\"post\" action=\"/api/competition/" + id + "/campaign-create\" id=\"campaignCreateForm\"><div class=\"form-grid\">" +
        "<div><label>Nom</label><input name=\"name\" required placeholder=\"Gemini Pro Promo\"></div>" +
        "<div><label>Produit</label><input name=\"product\" placeholder=\"Gemini Pro\"></div>" +
        "<div class=\"full\"><label>Description</label><textarea name=\"description\" placeholder=\"Description de l’offre\"></textarea></div>" +
        "<div class=\"full\"><label>Texte commercial à copier</label><textarea name=\"commercialText\" placeholder=\"Texte que les participants partageront\"></textarea></div>" +
        "<div class=\"full\"><label>Affiche</label><input id=\"campaignImageFile\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"><input type=\"hidden\" id=\"campaignImageData\" name=\"imageData\"><div class=\"footer-note\">L’image est compressée dans le navigateur avant envoi.</div></div>" +
        "<div><label>URL destination</label><input name=\"destinationUrl\" placeholder=\"https://...\"></div>" +
        "<div><label>URL WhatsApp éventuelle</label><input name=\"whatsappUrl\" placeholder=\"https://wa.me/...\"></div>" +
        "<div><label>Points partage</label><input name=\"pointsShare\" type=\"number\" value=\"0\"></div>" +
        "<div><label>Points intérêt</label><input name=\"pointsInterest\" type=\"number\" value=\"0\"></div>" +
        "<div><label>Points lead</label><input name=\"pointsLead\" type=\"number\" value=\"0\"></div>" +
        "<div><label>Points vente</label><input name=\"pointsSale\" type=\"number\" value=\"0\"></div>" +
        "<div><label>Multiplicateur trafic</label><input name=\"multiplier\" type=\"number\" min=\"0\" step=\"0.1\" value=\"1\"></div>" +
        "<div><label>Multiplicateur conversion</label><input name=\"conversionMultiplier\" type=\"number\" min=\"0\" step=\"0.1\" value=\"1\"></div>" +
        "<div><label>Bonus partage max/jour</label><input name=\"dailyShareLimit\" type=\"number\" min=\"1\" value=\"1\"></div>" +
        "<div><label>Statut</label><select name=\"status\"><option value=\"draft\">Brouillon</option><option value=\"scheduled\">Programmé</option><option value=\"active\">Active</option></select></div>" +
        "<div class=\"full\"><label><input type=\"checkbox\" name=\"featured\" value=\"1\" style=\"width:auto;margin-right:7px\"> Campagne vedette</label></div>" +
        "<div class=\"full\"><button class=\"btn\" type=\"submit\">Créer la campagne</button></div>" +
      "</div></form></div>";
}

async function adminDaysContent(comp) {
  const id = encodeURIComponent(comp.id);
  const [days,campaigns,config,completions] = await Promise.all([
    listCompetitionDays(comp.id),
    listCampaigns(comp.id,{admin:true}),
    getCompetitionConfig(comp.id),
    listMissionCompletions(comp.id)
  ]);
  const campaignOptions = "<option value=\"\">Aucune</option>" + campaigns.map(x=>"<option value=\"" + esc(x.id) + "\">" + esc(x.name) + "</option>").join("");
  const dayCards = days.length ? days.map(day =>
    "<article class=\"card span6\"><div class=\"section-title\"><div><h2>Jour " + day.day_number + " · " + esc(day.title) + "</h2><div class=\"subnav-note\">" + esc(day.status) + (day.featured_campaign_name ? " · " + esc(day.featured_campaign_name) : "") + "</div></div><span class=\"score-badge\">+" + Number(day.reward_daily_points||0) + " pts</span></div>" +
      "<p class=\"muted\" style=\"margin-top:0\">" + esc(day.description || "Aucune description.") + "</p>" +
      "<form method=\"post\" action=\"/api/competition/" + id + "/mission-create\"><input type=\"hidden\" name=\"dayId\" value=\"" + esc(day.id) + "\"><div class=\"form-grid\"><div><label>Mission</label><input name=\"title\" placeholder=\"STATUS TAKEOVER\" required></div><div><label>Points</label><input name=\"pointsFixed\" type=\"number\" value=\"0\"></div><div class=\"full\"><label>Description</label><input name=\"description\" placeholder=\"Action marketing à réaliser\"></div><div><label>Validation</label><select name=\"validationMode\"><option value=\"manual\">Manuelle</option><option value=\"automatic\">Automatique</option></select></div><div><label>Campagne associée</label><select name=\"campaignId\">" + campaignOptions + "</select></div><div class=\"full\"><button class=\"btn2\" type=\"submit\">Ajouter une mission</button></div></div></form></article>"
  ).join("") : "<div class=\"card span12 empty\">Aucune journée configurée.</div>";

  return pageTitleHtml("Journées & événements","Configure une durée libre, les récompenses quotidiennes et les événements marketing.") +
    "<div class=\"grid\" style=\"margin-bottom:14px\"><div class=\"card span6\"><div class=\"section-title\"><h2>Durée</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/days-resize\"><label>Nombre de jours</label><div class=\"actions\"><input name=\"dayCount\" type=\"number\" min=\"1\" max=\"365\" value=\"" + Math.max(1,days.length||1) + "\" style=\"max-width:160px\"><button class=\"btn\" type=\"submit\">Appliquer</button></div><div class=\"footer-note\">Si des journées à supprimer contiennent déjà des missions, la suppression est bloquée jusqu’à confirmation.</div></form></div>" +
      "<div class=\"card span6\"><div class=\"section-title\"><h2>Nouvelle / mise à jour journée</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/day-save\"><div class=\"form-grid\"><div><label>N° jour</label><input name=\"dayNumber\" type=\"number\" min=\"1\" required></div><div><label>Titre</label><input name=\"title\" required placeholder=\"GEMINI TAKEOVER\"></div><div><label>Récompense quotidienne</label><input name=\"rewardDailyPoints\" type=\"number\" value=\"0\"></div><div><label>Statut</label><select name=\"status\"><option value=\"draft\">Brouillon</option><option value=\"scheduled\">Programmé</option><option value=\"active\">Actif</option><option value=\"finished\">Terminé</option></select></div><div class=\"full\"><label>Campagne vedette</label><select name=\"featuredCampaignId\">" + campaignOptions + "</select></div><div class=\"full\"><label>Description</label><textarea name=\"description\"></textarea></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Enregistrer la journée</button></div></div></form></div></div>" +
    "<div class=\"grid\">" + dayCards + "</div>" +
    "<div class=\"card\" style=\"margin-top:14px\"><div class=\"section-title\"><h2>Validations de missions</h2><span class=\"small muted\">" + completions.filter(x=>x.status===\"pending\").length + " en attente</span></div><div class=\"table-wrap\"><table><thead><tr><th>Participant</th><th>Mission</th><th>Statut</th><th>Points</th><th>Action</th></tr></thead><tbody>" +
      (completions.length ? completions.map(x=>"<tr><td>" + esc(x.pseudonym) + "<div class=\"code\">" + esc(x.referral_code||"") + "</div></td><td>" + esc(x.mission_title) + "</td><td>" + esc(x.status) + "</td><td>" + Number(x.points_fixed||0) + "</td><td>" + (x.status===\"pending\" ? "<form method=\"post\" action=\"/api/competition/" + id + "/mission-review\" class=\"actions\"><input type=\"hidden\" name=\"completionId\" value=\"" + esc(x.id) + "\"><button class=\"btn2\" name=\"action\" value=\"confirmed\" type=\"submit\">Confirmer</button><button class=\"danger\" name=\"action\" value=\"rejected\" type=\"submit\">Rejeter</button></form>" : "—") + "</td></tr>").join("") : "<tr><td colspan=\"5\" class=\"empty\">Aucune soumission.</td></tr>") +
      "</tbody></table></div></div>";
}

async function adminProspectsContent(comp) {
  const id = encodeURIComponent(comp.id);
  const prospects = await listProspects(comp.id);
  const rows = prospects.length ? prospects.map(p =>
    "<tr><td><div class=\"person\">" + esc(p.reference_code) + "</div><div class=\"code\">" + esc(p.created_at) + "</div></td><td>" + esc(p.campaign_name) + "</td><td>" + esc(p.participant_name || "—") + "</td><td><span class=\"status\">" + esc(p.status) + "</span></td><td>" +
      (p.lead_id ? "<span class=\"small muted\">Lead confirmé</span>" : "<form method=\"post\" action=\"/api/competition/" + id + "/lead-confirm\"><input type=\"hidden\" name=\"interestId\" value=\"" + esc(p.id) + "\"><button class=\"btn2\" type=\"submit\">Confirmer lead</button></form>") +
      "</td><td>" +
      (p.sale_id ? "<span class=\"small muted\">Vente confirmée</span>" : (p.lead_id ? "<form method=\"post\" action=\"/api/competition/" + id + "/sale-confirm\"><input type=\"hidden\" name=\"interestId\" value=\"" + esc(p.id) + "\"><input name=\"amount\" type=\"number\" min=\"0\" step=\"1\" placeholder=\"Montant\" style=\"width:110px\"><button class=\"btn\" type=\"submit\">Confirmer vente</button></form>" : "—")) +
      "</td><td>" + (p.status==="interest" ? "<form method=\"post\" action=\"/api/competition/" + id + "/interest-reject\"><input type=\"hidden\" name=\"interestId\" value=\"" + esc(p.id) + "\"><button class=\"danger\" type=\"submit\">Rejeter</button></form>" : "") + "</td></tr>"
  ).join("") : "<tr><td colspan=\"7\" class=\"empty\">Aucun prospect pour le moment.</td></tr>";
  return pageTitleHtml("Prospects & ventes","Valide les résultats réels. Les intérêts, leads et ventes restent séparés.") +
    "<div class=\"card\"><div class=\"table-wrap\"><table><thead><tr><th>Référence</th><th>Campagne</th><th>Source</th><th>Statut</th><th>Lead</th><th>Vente</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table></div></div>";
}

async function adminRewardsContent(comp) {
  const id = encodeURIComponent(comp.id);
  const [prizes,tiers,config] = await Promise.all([listPrizes(comp.id),listRewardTiers(comp.id),getCompetitionConfig(comp.id)]);
  const prizeRows = prizes.length ? prizes.map(p=>"<tr><td>" + esc(p.name) + "</td><td>" + esc(p.duration_text||"") + "</td><td>" + esc(p.status) + "</td><td>" + esc(p.chosen_by_name||"—") + "</td></tr>").join("") : "<tr><td colspan=\"4\" class=\"empty\">Aucun lot.</td></tr>";
  const tierRows = tiers.length ? tiers.map(t=>"<tr><td>" + Number(t.min_points) + "</td><td>" + (t.max_points===null?"∞":Number(t.max_points)) + "</td><td>" + esc(t.reward_type) + "</td><td>" + Number(t.reward_value) + "</td><td>" + (t.validity_days||"—") + "</td></tr>").join("") : "<tr><td colspan=\"5\" class=\"empty\">Aucun palier.</td></tr>";
  return pageTitleHtml("Récompenses","Gère les lots des gagnants et les paliers des autres participants.") +
    "<div class=\"grid\"><div class=\"card span6\"><div class=\"section-title\"><h2>Nouveau lot</h2><span class=\"small muted\">Top " + Number(config?.winner_count||1) + "</span></div><form method=\"post\" action=\"/api/competition/" + id + "/prize-add\"><div class=\"form-grid\"><div><label>Lot</label><input name=\"name\" required></div><div><label>Durée</label><input name=\"durationText\" placeholder=\"1 mois\"></div><div class=\"full\"><label>Description</label><input name=\"description\"></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Ajouter le lot</button></div></div></form></div>" +
      "<div class=\"card span6\"><div class=\"section-title\"><h2>Nouveau palier</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/tier-add\"><div class=\"form-grid\"><div><label>Minimum points</label><input name=\"minPoints\" type=\"number\" min=\"0\" required></div><div><label>Maximum</label><input name=\"maxPoints\" type=\"number\" min=\"0\" placeholder=\"Vide = infini\"></div><div><label>Type</label><select name=\"rewardType\"><option value=\"discount\">Réduction %</option><option value=\"credit\">Crédit</option><option value=\"custom\">Personnalisé</option></select></div><div><label>Valeur</label><input name=\"rewardValue\" type=\"number\" step=\"0.01\" required></div><div><label>Validité (jours)</label><input name=\"validityDays\" type=\"number\" min=\"1\"></div><div><label>Ordre</label><input name=\"sortOrder\" type=\"number\" value=\"0\"></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Ajouter le palier</button></div></div></form></div>" +
      "<div class=\"card span6\"><div class=\"section-title\"><h2>Lots</h2></div><div class=\"table-wrap\"><table><thead><tr><th>Lot</th><th>Durée</th><th>Statut</th><th>Choisi par</th></tr></thead><tbody>" + prizeRows + "</tbody></table></div></div>" +
      "<div class=\"card span6\"><div class=\"section-title\"><h2>Paliers</h2></div><div class=\"table-wrap\"><table><thead><tr><th>Min</th><th>Max</th><th>Type</th><th>Valeur</th><th>Jours</th></tr></thead><tbody>" + tierRows + "</tbody></table></div></div>" +
      "<div class=\"card span12\"><div class=\"section-title\"><div><h2>Fin de compétition</h2><div class=\"subnav-note\">Fige le classement final puis génère les coupons selon les paliers.</div></div></div><div class=\"actions\"><form method=\"post\" action=\"/api/competition/" + id + "/finalize\"><button class=\"btn\" type=\"submit\">Figer le classement final</button></form><form method=\"post\" action=\"/api/competition/" + id + "/generate-coupons\"><button class=\"btn2\" type=\"submit\">Générer les coupons</button></form></div></div></div>";
}

async function adminFraudContent(comp) {
  const id = encodeURIComponent(comp.id);
  const [settings,flags] = await Promise.all([getFraudSettings(comp.id),listFraudFlags(comp.id)]);
  const f = settings || {};
  const rows = flags.length ? flags.map(flag =>
    "<tr><td>" + esc(flag.pseudonym||"Visiteur") + "<div class=\"code\">" + esc(flag.referral_code||"") + "</div></td><td>" + Number(flag.risk_score||0).toFixed(2) + "</td><td>" + esc(flag.reason) + "</td><td>" + esc(flag.status) + "</td><td><form method=\"post\" action=\"/api/competition/" + id + "/fraud-resolve\" class=\"actions\"><input type=\"hidden\" name=\"flagId\" value=\"" + esc(flag.id) + "\"><button class=\"btn2\" name=\"action\" value=\"ignored\" type=\"submit\">Ignorer</button><button class=\"btn2\" name=\"action\" value=\"invalidated\" type=\"submit\">Invalider</button><button class=\"danger\" name=\"action\" value=\"suspended\" type=\"submit\">Suspendre</button></form></td></tr>"
  ).join("") : "<tr><td colspan=\"5\" class=\"empty\">Aucune activité suspecte ouverte.</td></tr>";
  return pageTitleHtml("Anti-fraude","Déduplication raisonnable, plafonds et revue manuelle des signaux suspects.") +
    "<div class=\"grid\"><div class=\"card span5\"><div class=\"section-title\"><h2>Réglages</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/fraud-settings\"><div class=\"form-grid\"><div><label>Fenêtre unique (heures)</label><input name=\"uniqueClickWindowHours\" type=\"number\" min=\"1\" value=\"" + Number(f.unique_click_window_hours||2160) + "\"></div><div><label>Cap clics valides/jour</label><input name=\"dailyClickCap\" type=\"number\" min=\"1\" value=\"" + (f.daily_click_cap??"") + "\"></div><div><label>Fenêtre burst (min)</label><input name=\"burstDetectionWindowMinutes\" type=\"number\" min=\"1\" value=\"" + Number(f.burst_detection_window_minutes||5) + "\"></div><div><label>Max clics/visiteur</label><input name=\"maxClicksPerVisitor\" type=\"number\" min=\"1\" value=\"" + Number(f.max_clicks_per_visitor||8) + "\"></div><div><label>Seuil suspect</label><input name=\"suspiciousThreshold\" type=\"number\" min=\"1\" value=\"" + Number(f.suspicious_threshold||20) + "\"></div><div><label>Bots évidents</label><select name=\"blockObviousBots\"><option value=\"1\"" + (f.block_obvious_bots!==false?" selected":"") + ">Ignorer</option><option value=\"0\"" + (f.block_obvious_bots===false?" selected":"") + ">Autoriser</option></select></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Enregistrer</button></div></div></form></div>" +
      "<div class=\"card span7\"><div class=\"section-title\"><h2>Activité suspecte</h2><span class=\"small muted\">" + flags.length + " signal(aux)</span></div><div class=\"table-wrap\"><table><thead><tr><th>Source</th><th>Risque</th><th>Raison</th><th>Statut</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table></div></div></div>";
}

async function adminNotificationsContent(comp) {
  const id = encodeURIComponent(comp.id);
  return pageTitleHtml("Notifications","Crée une annonce globale visible dans l’espace participant.") +
    "<div class=\"card\" style=\"max-width:760px\"><form method=\"post\" action=\"/api/competition/" + id + "/announcement\"><div class=\"form-grid\"><div class=\"full\"><label>Titre</label><input name=\"title\" required placeholder=\"Prime Video rapporte x2 aujourd’hui\"></div><div class=\"full\"><label>Message</label><textarea name=\"body\" required></textarea></div><div><label>Type</label><select name=\"kind\"><option value=\"announcement\">Annonce</option><option value=\"boost\">Boost</option><option value=\"warning\">Alerte</option><option value=\"reward\">Récompense</option></select></div><div><label>Lien optionnel</label><input name=\"actionUrl\" placeholder=\"/me/...\"></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Publier l’annonce</button></div></div></form></div>";
}

async function competitionPage(origin, comp, view = "overview", publicMode = false, newCode = "") {
  const rows = await getRankedParticipants(comp);
  const profile = await getProfile(comp.id);
  const totals = {
    participants: rows.length,
    points: rows.reduce((s,r) => s + r.points, 0),
    clicks: rows.reduce((s,r) => s + r.clicks, 0),
    unique: rows.reduce((s,r) => s + r.unique, 0),
    valid: rows.reduce((s,r) => s + r.valid, 0)
  };
  const leader = rows[0];
  const theme = ["blue","amber","red","mono"].includes(comp.theme) ? comp.theme : "blue";
  const endpoint = "/api/competition/" + encodeURIComponent(comp.id) + "/stats";
  const id = encodeURIComponent(comp.id);

  const statsHtml =
    "<div class=\"metric-grid\">" +
      "<div class=\"card stat\"><div class=\"label\">Participants</div><div class=\"num\" id=\"statParticipants\">" + totals.participants + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Points attribués</div><div class=\"num\" id=\"statPoints\">" + totals.points + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Clics bruts</div><div class=\"num\" id=\"statClicks\">" + totals.clicks + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Personnes distinctes</div><div class=\"num\" id=\"statUnique\">" + totals.unique + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Clics valides</div><div class=\"num\" id=\"statValid\">" + totals.valid + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">En tête</div><div class=\"num\" id=\"statLeader\" style=\"font-size:20px\">" + esc(leader ? leader.name : "—") + "</div></div>" +
    "</div>";

  const hero =
    "<section class=\"hero\" data-ghost=\"LIVE\"><div class=\"hero-row\"><div style=\"display:flex;gap:16px;align-items:center;min-width:0\">" +
      profileAvatarHtml(profile, comp.name, "hero-avatar") +
      "<div style=\"min-width:0\"><div class=\"eyebrow\">" + (publicMode ? "Classement public" : "Gestion de compétition") + "</div><h1 style=\"margin-top:8px\">" + esc(comp.name) + "</h1><p>" +
      (comp.prize ? "Récompense : " + esc(comp.prize) + ". " : "") +
      "Suivi des performances et des positions en temps réel.</p></div></div>" +
      "<div class=\"hero-side\"><div class=\"small\" style=\"color:#aaa\">Statut</div><strong>" + esc(comp.status) + "</strong><div class=\"small\" style=\"color:#aaa;margin-top:8px\">" + rows.length + " participants</div><div class=\"accent-chip\"><i></i>" + esc(theme) + "</div></div></div></section>";

  const fresh = newCode ? rows.find(r => r.code === newCode) : null;
  const success = fresh ?
    "<div class=\"success\"><div><b>Participant ajouté : " + esc(fresh.name) + "</b><div class=\"small muted\">Son lien personnel est prêt à être envoyé.</div></div><div class=\"link-actions\"><button class=\"btn2 copy\" type=\"button\" data-link=\"" + esc(origin + fresh.link) + "\">Copier maintenant</button><button class=\"btn2 share\" type=\"button\" data-link=\"" + esc(origin + fresh.link) + "\" data-name=\"" + esc(fresh.name) + "\">Partager</button></div></div>" : "";

  let content = "";

  if (publicMode) {
    const publicHeader =
      "<div class=\"public-header\"><div class=\"public-brand\">" + profileAvatarHtml(profile, comp.name, "hero-avatar") +
        "<div><div class=\"eyebrow\">CLASSEMENT PUBLIC · LIVE</div><h1>" + esc(comp.name) + "</h1><p>Classement principal basé sur les points attribués.</p></div></div>" +
        "<div class=\"public-prize\"><span class=\"status\" style=\"background:#ffffff12;color:#fff;border-color:#ffffff20\"><span class=\"dot active\"></span>" + esc(comp.status) + "</span>" +
        (comp.prize ? "<b style=\"margin-top:8px\">Récompense : " + esc(comp.prize) + "</b>" : "") +
        (comp.status === "active" ? "<div style=\"margin-top:10px\"><a class=\"btn2\" href=\"/join/" + encodeURIComponent(comp.id) + "\">Participer</a></div>" : "") + "</div></div>";
    const publicKpis =
      "<div class=\"public-kpis\"><div class=\"public-kpi\"><span>Participants</span><b id=\"statParticipants\">" + totals.participants + "</b></div>" +
      "<div class=\"public-kpi\"><span>Points</span><b id=\"statPoints\">" + totals.points + "</b></div>" +
      "<div class=\"public-kpi\"><span>Clics valides</span><b id=\"statValid\">" + totals.valid + "</b></div>" +
      "<div class=\"public-kpi\"><span>Personnes distinctes</span><b id=\"statUnique\">" + totals.unique + "</b></div></div>";
    content = publicHeader + publicKpis +
      "<div class=\"public-board\"><div class=\"public-panel\"><div class=\"section-title\"><div><h2>Classement général</h2><div class=\"subnav-note\">Du premier au dernier · priorité aux points</div></div><div class=\"live\"><span class=\"pulse\"></span><span id=\"updatedAt\">live</span></div></div>" +
        "<div class=\"table-wrap\"><table class=\"public-table\"><thead><tr><th>#</th><th>Participant</th><th>Points</th><th>Valides</th><th>Personnes</th></tr></thead><tbody id=\"leaderboardBody\">" + leaderboardRowsHtml(rows, origin, comp, true) + "</tbody></table></div>" +
        "<div class=\"capture-note\">Une même personne ne compte qu’une fois comme visiteur distinct. Les rechargements, auto-tests et trafics automatisés ne deviennent pas des clics valides.</div></div>" +
      "<div class=\"public-side\"><div class=\"public-panel\"><h3>Podium</h3>" + podiumHtml(rows) + "</div><div class=\"public-panel\"><div class=\"section-title\"><h2>Écart de points</h2></div><div class=\"chart\" id=\"liveChart\">" + chartHtml(rows) + "</div></div></div></div>";
  } else if (view === "overview") {
    const quick =
      "<div class=\"quick-actions\">" +
        "<a class=\"quick-card\" href=\"/c/" + id + "/links\"><b>Liens participants</b><span>Copier et partager les liens personnels.</span></a>" +
        "<a class=\"quick-card\" href=\"/c/" + id + "/ranking\"><b>Classement</b><span>Voir le classement complet du premier au dernier.</span></a>" +
        "<a class=\"quick-card\" href=\"/c/" + id + "/live\"><b>Graphique live</b><span>Suivre la position des participants.</span></a>" +
        "<a class=\"quick-card\" href=\"/c/" + id + "/participants\"><b>Participants</b><span>Ajouter, gérer ou supprimer des participants.</span></a>" +
      "</div>";
    content = hero + statsHtml +
      "<div class=\"overview-grid\">" +
        "<div class=\"card content-card\"><div class=\"section-title\"><div><h2>Podium actuel</h2><div class=\"subnav-note\">Vue rapide des meilleurs participants.</div></div><a class=\"btn2\" href=\"/c/" + id + "/ranking\">Voir tout</a></div>" + podiumHtml(rows) + "</div>" +
        "<div class=\"card content-card\"><div class=\"section-title\"><h2>Accès rapides</h2></div>" + quick + "</div>" +
      "</div>";
  } else if (view === "links") {
    content = pageTitleHtml("Liens participants","Chaque participant dispose d’un lien individuel à lui envoyer.", "<a class=\"btn\" href=\"/c/" + id + "/participants\">+ Ajouter un participant</a>") +
      success +
      "<div class=\"card\"><div class=\"section-title\"><div><h2>Liens personnels</h2><div class=\"subnav-note\">Copie, partage ou teste un lien sans chercher dans le tableau.</div></div><input class=\"searchbox\" id=\"participantSearch\" placeholder=\"Rechercher un participant…\"></div><div class=\"links-grid\" id=\"participantLinks\">" + participantLinksHtml(rows, origin) + "</div></div>";
  } else if (view === "ranking") {
    content = pageTitleHtml("Classement","Classement complet, du premier au dernier.", "<a class=\"btn2\" target=\"_blank\" href=\"/leaderboard/" + id + "\">Ouvrir la page publique</a>") +
      "<div class=\"card\" style=\"margin-bottom:14px\"><div class=\"section-title\"><h2>Podium actuel</h2><div class=\"live\"><span class=\"pulse\"></span>live</div></div>" + podiumHtml(rows) + "</div>" +
      "<div class=\"card\"><div class=\"section-title\"><h2>Classement détaillé</h2><span class=\"small muted\">priorité aux points · puis clics valides et personnes distinctes</span></div><div class=\"table-wrap\"><table><thead><tr><th>#</th><th>Participant</th><th>Points</th><th>Bruts</th><th>Personnes</th><th>Valides</th><th>Lien</th><th>Action</th></tr></thead><tbody id=\"leaderboardBody\">" + leaderboardRowsHtml(rows, origin, comp, false) + "</tbody></table></div></div>";
  } else if (view === "live") {
    content = pageTitleHtml("Graphique live","Visualise la position actuelle de tous les participants.") +
      statsHtml +
      "<div class=\"card\"><div class=\"section-title\"><h2>Position en temps réel</h2><div class=\"live\"><span class=\"pulse\"></span><span>actualisation toutes les 5 s</span><span id=\"updatedAt\"></span></div></div><div class=\"chart\" id=\"liveChart\">" + chartHtml(rows) + "</div></div>";
  } else if (view === "campaigns") {
    content = await adminCampaignsContent(comp);
  } else if (view === "days") {
    content = await adminDaysContent(comp);
  } else if (view === "prospects") {
    content = await adminProspectsContent(comp);
  } else if (view === "rewards") {
    content = await adminRewardsContent(comp);
  } else if (view === "fraud") {
    content = await adminFraudContent(comp);
  } else if (view === "notifications") {
    content = await adminNotificationsContent(comp);
  } else if (view === "scoring") {
    const scoring = await getScoringConfig(comp.id);
    const clickRule = scoring.rules.find(r => r.action_type === "valid_click") || {
      enabled: true,
      base_points: 1,
      multiplier: 1,
      daily_cap_points: 60
    };
    const burstRows = scoring.bursts.length
      ? scoring.bursts.map(rule =>
          "<tr><td><div class=\"person\">" + esc(rule.name) + "</div></td>" +
          "<td>" + rule.threshold + " valides</td><td>" + rule.window_minutes + " min</td>" +
          "<td class=\"points-col\">+" + rule.bonus_points + "</td><td>" + rule.daily_limit + "/jour</td>" +
          "<td>" + (rule.enabled ? "Actif" : "Inactif") + "</td>" +
          "<td><form method=\"post\" action=\"/api/competition/" + id + "/burst-delete\"><input type=\"hidden\" name=\"ruleId\" value=\"" + esc(rule.id) + "\"><button class=\"danger\" type=\"submit\">Supprimer</button></form></td></tr>"
        ).join("")
      : "<tr><td colspan=\"7\" class=\"empty\">Aucun bonus burst configuré.</td></tr>";

    content = pageTitleHtml("Points & bonus","Configure le scoring des clics valides et les bonus de trafic sans modifier le code.") +
      "<div class=\"grid\">" +
        "<div class=\"card span6\"><div class=\"section-title\"><div><h2>Clic valide</h2><div class=\"subnav-note\">Appliqué uniquement aux visiteurs acceptés par l’anti-fraude.</div></div></div>" +
          "<form method=\"post\" action=\"/api/competition/" + id + "/scoring-rule\"><div class=\"form-grid\">" +
            "<div><label>Points par clic valide</label><input name=\"basePoints\" type=\"number\" min=\"0\" value=\"" + Number(clickRule.base_points || 0) + "\"></div>" +
            "<div><label>Multiplicateur</label><input name=\"multiplier\" type=\"number\" min=\"0\" step=\"0.1\" value=\"" + Number(clickRule.multiplier || 1) + "\"></div>" +
            "<div><label>Plafond quotidien (points)</label><input name=\"dailyCapPoints\" type=\"number\" min=\"0\" value=\"" + (clickRule.daily_cap_points ?? "") + "\" placeholder=\"Vide = sans plafond\"></div>" +
            "<div><label>État</label><select name=\"enabled\"><option value=\"1\"" + (clickRule.enabled ? " selected" : "") + ">Actif</option><option value=\"0\"" + (!clickRule.enabled ? " selected" : "") + ">Désactivé</option></select></div>" +
            "<div class=\"full\"><button class=\"btn\" type=\"submit\">Enregistrer le barème</button></div>" +
          "</div></form><div class=\"notice\" style=\"margin-top:14px\">Les modifications s’appliquent aux nouvelles actions. Les anciennes transactions du ledger restent inchangées.</div></div>" +
        "<div class=\"card span6\"><div class=\"section-title\"><div><h2>Nouveau bonus burst</h2><div class=\"subnav-note\">Récompense une activité réelle concentrée dans une fenêtre courte.</div></div></div>" +
          "<form method=\"post\" action=\"/api/competition/" + id + "/burst-add\"><div class=\"form-grid\">" +
            "<div class=\"full\"><label>Nom</label><input name=\"name\" maxlength=\"80\" placeholder=\"Ex. Boost 10 visiteurs\" required></div>" +
            "<div><label>Seuil de clics valides</label><input name=\"threshold\" type=\"number\" min=\"1\" required></div>" +
            "<div><label>Fenêtre (minutes)</label><input name=\"windowMinutes\" type=\"number\" min=\"1\" required></div>" +
            "<div><label>Bonus points</label><input name=\"bonusPoints\" type=\"number\" required></div>" +
            "<div><label>Maximum / jour</label><input name=\"dailyLimit\" type=\"number\" min=\"1\" value=\"1\" required></div>" +
            "<div class=\"full\"><button class=\"btn\" type=\"submit\">Ajouter la règle</button></div>" +
          "</div></form></div>" +
        "<div class=\"card span12\"><div class=\"section-title\"><h2>Bonus burst configurés</h2><span class=\"small muted\">" + scoring.bursts.length + " règle(s)</span></div><div class=\"table-wrap\"><table><thead><tr><th>Nom</th><th>Seuil</th><th>Fenêtre</th><th>Bonus</th><th>Limite</th><th>État</th><th>Action</th></tr></thead><tbody>" + burstRows + "</tbody></table></div></div>" +
      "</div>";
  } else if (view === "participants") {
    content = pageTitleHtml("Participants","Ajoute les participants individuellement ou en masse.") +
      success +
      "<div class=\"grid\" style=\"margin-bottom:14px\">" +
        "<div class=\"card span6\"><div class=\"section-title\"><h2>Ajouter un participant</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/add\"><div class=\"form-grid\"><div><label>Nom</label><input name=\"name\" placeholder=\"Nom du participant\" required></div><div><label>Code (facultatif)</label><input name=\"code\" placeholder=\"Généré automatiquement\"></div><div class=\"full\"><button class=\"btn\" style=\"width:100%\" type=\"submit\">Ajouter le participant</button></div></div></form></div>" +
        "<div class=\"card span6\"><div class=\"section-title\"><h2>Ajout multiple</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/bulk\"><label>Un nom par ligne</label><textarea name=\"names\" placeholder=\"Aron&#10;Tony&#10;Marc&#10;Sarah\"></textarea><button class=\"btn2\" style=\"width:100%;margin-top:9px\" type=\"submit\">Ajouter toute la liste</button></form></div>" +
      "</div>" +
      "<div class=\"card\" style=\"margin-bottom:14px\"><div class=\"section-title\"><div><h2>Attribuer des points</h2><div class=\"subnav-note\">+5, +10, +20, +50 ou une valeur personnalisée. Une valeur négative permet de corriger une erreur.</div></div></div>" + pointsCardsHtml(rows, comp) + "</div>" +
      "<div class=\"card\"><div class=\"section-title\"><h2>Liste des participants</h2><span class=\"small muted\">" + rows.length + " au total</span></div><div class=\"table-wrap\"><table class=\"participant-table\"><thead><tr><th>Participant</th><th>Rang</th><th>Points</th><th>Bruts</th><th>Personnes</th><th>Valides</th><th>Lien</th><th>Action</th></tr></thead><tbody>" + participantAdminRows(rows, comp) + "</tbody></table></div></div>";
  } else if (view === "settings") {
    const currentProfile = profileAvatarHtml(profile, comp.name);
    const dbConfig = await getCompetitionConfig(comp.id);
    const startLocal = dbConfig?.starts_at ? new Date(dbConfig.starts_at).toISOString().slice(0,16) : "";
    const endLocal = dbConfig?.ends_at ? new Date(dbConfig.ends_at).toISOString().slice(0,16) : "";
    content = pageTitleHtml("Paramètres","Identité, photo, palette et statut de cette compétition.") +
      "<div class=\"grid\">" +
        "<div class=\"card span5\"><div class=\"section-title\"><h2>Photo de la compétition</h2></div><div class=\"profile-settings\"><div id=\"profilePreviewWrap\">" +
          (profile ? "<img class=\"profile-preview\" src=\"" + esc(profile) + "\" alt=\"Photo actuelle\">" : "<div class=\"profile-preview\">" + esc(comp.name.charAt(0).toUpperCase()) + "</div>") +
          "</div><div><div class=\"upload-zone\"><label>Choisir une image</label><input id=\"profileFile\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"><div class=\"footer-note\">L’image sera automatiquement recadrée et compressée en carré.</div></div><form id=\"profileForm\" method=\"post\" action=\"/api/competition/" + id + "/profile\" style=\"margin-top:10px\"><input id=\"profileData\" type=\"hidden\" name=\"profileData\"><button class=\"btn\" type=\"submit\">Enregistrer la photo</button></form>" +
          (profile ? "<form method=\"post\" action=\"/api/competition/" + id + "/profile\" style=\"margin-top:8px\"><input type=\"hidden\" name=\"remove\" value=\"1\"><button class=\"danger\" type=\"submit\">Retirer la photo</button></form>" : "") +
        "</div></div></div>" +
        "<div class=\"card span7\"><div class=\"section-title\"><h2>Configuration</h2><span class=\"status\"><span class=\"theme-swatch\"></span>" + esc(comp.status) + "</span></div><form method=\"post\" action=\"/api/competition/" + id + "/status\"><div class=\"form-grid\"><div><label>Statut</label><select name=\"status\"><option value=\"active\"" + (comp.status==="active"?" selected":"") + ">Active</option><option value=\"paused\"" + (comp.status==="paused"?" selected":"") + ">En pause</option><option value=\"ended\"" + (comp.status==="ended"?" selected":"") + ">Terminée</option><option value=\"draft\"" + (comp.status==="draft"?" selected":"") + ">Brouillon</option></select></div><div><label>Palette</label><select name=\"theme\"><option value=\"blue\"" + (theme==="blue"?" selected":"") + ">Bleu premium</option><option value=\"amber\"" + (theme==="amber"?" selected":"") + ">Ambre premium</option><option value=\"red\"" + (theme==="red"?" selected":"") + ">Rouge profond</option><option value=\"mono\"" + (theme==="mono"?" selected":"") + ">Monochrome</option></select></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Enregistrer</button></div></div></form><hr style=\"border:0;border-top:1px solid var(--line);margin:18px 0\"><div class=\"notice\"><b>Lien public du classement</b><br><span class=\"muted\">" + esc(origin + "/leaderboard/" + comp.id) + "</span><div class=\"actions\" style=\"margin-top:10px\"><button class=\"btn2 copy\" type=\"button\" data-link=\"" + esc(origin + "/leaderboard/" + comp.id) + "\">Copier</button><a class=\"btn2\" target=\"_blank\" href=\"/leaderboard/" + id + "\">Ouvrir</a><a class=\"btn2\" href=\"/api/competition/" + id + "/export.csv\">Exporter CSV</a></div></div></div>" +
        "<div class=\"card span12\"><div class=\"section-title\"><div><h2>Règles centrales</h2><div class=\"subnav-note\">Durée, inscriptions, classement, gagnants et règlement public.</div></div></div><form method=\"post\" action=\"/api/competition/" + id + "/config-update\"><div class=\"form-grid\"><div><label>Début</label><input name=\"startsAt\" type=\"datetime-local\" value=\"" + esc(startLocal) + "\"></div><div><label>Fin</label><input name=\"endsAt\" type=\"datetime-local\" value=\"" + esc(endLocal) + "\"></div><div><label>Fuseau horaire</label><input name=\"timezone\" value=\"" + esc(dbConfig?.timezone||"Africa/Douala") + "\"></div><div><label>Nombre de gagnants</label><input name=\"winnerCount\" type=\"number\" min=\"1\" value=\"" + Number(dbConfig?.winner_count||1) + "\"></div><div><label>Maximum participants</label><input name=\"maxParticipants\" type=\"number\" min=\"1\" value=\"" + (dbConfig?.max_participants??"") + "\" placeholder=\"Vide = illimité\"></div><div><label>Inscriptions</label><select name=\"registrationsOpen\"><option value=\"1\"" + (dbConfig?.registrations_open!==false?" selected":"") + ">Ouvertes</option><option value=\"0\"" + (dbConfig?.registrations_open===false?" selected":"") + ">Fermées</option></select></div><div><label>Classement public</label><select name=\"leaderboardVisible\"><option value=\"1\"" + (dbConfig?.leaderboard_visible!==false?" selected":"") + ">Visible</option><option value=\"0\"" + (dbConfig?.leaderboard_visible===false?" selected":"") + ">Masqué</option></select></div><div><label>Gel visuel</label><select name=\"leaderboardFrozen\"><option value=\"0\"" + (!dbConfig?.leaderboard_frozen?" selected":"") + ">Temps réel</option><option value=\"1\"" + (dbConfig?.leaderboard_frozen?" selected":"") + ">Gelé</option></select></div><div class=\"full\"><label>Règlement public</label><textarea name=\"rules\" style=\"min-height:180px\">" + esc(dbConfig?.rules||"") + "</textarea></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Enregistrer la configuration centrale</button></div></div></form></div>" +
      "</div>";
  } else {
    content = pageTitleHtml("Page introuvable","Cette rubrique n’existe pas.");
  }

  const body = publicMode
    ? "<div class=\"theme theme-" + theme + " public-shell\"><div class=\"view-fade\">" + content + "</div></div>"
    : "<div class=\"theme theme-" + theme + "\">" + topNav() + "<div class=\"app-shell\">" + competitionSidebar(comp, view, profile) + "<main class=\"app-main view-fade\">" + content + "</main></div></div>";

  const script =
    "const endpoint=" + JSON.stringify(endpoint) + ";const origin=" + JSON.stringify(origin) + ";const publicMode=" + JSON.stringify(publicMode) + ";" +
    "document.addEventListener('click',async e=>{const copy=e.target.closest('.copy');if(copy){let v=copy.dataset.link||'';if(v.startsWith('/'))v=origin+v;try{await navigator.clipboard.writeText(v);const old=copy.textContent;copy.textContent='Copié ✓';setTimeout(()=>copy.textContent=old,1200)}catch{prompt('Copie ce lien :',v)}return}const share=e.target.closest('.share');if(share){let v=share.dataset.link||'';if(v.startsWith('/'))v=origin+v;const name=share.dataset.name||'participant';if(navigator.share){try{await navigator.share({title:'Lien de '+name,text:'Voici ton lien personnel pour la compétition :',url:v})}catch{}}else{try{await navigator.clipboard.writeText(v);alert('Lien copié')}catch{prompt('Copie ce lien :',v)}}}});" +
    "const search=document.getElementById('participantSearch');if(search){search.addEventListener('input',()=>{const q=search.value.toLowerCase().trim();document.querySelectorAll('.participant-link-card').forEach(x=>x.style.display=x.dataset.search.includes(q)?'':'none')})}" +
    "function el(t,c,txt){const x=document.createElement(t);if(c)x.className=c;if(txt!==undefined)x.textContent=txt;return x}" +
    "function render(data){const rows=data.participants||[];const a=document.getElementById('statParticipants'),p=document.getElementById('statPoints'),b=document.getElementById('statClicks'),u=document.getElementById('statUnique'),v=document.getElementById('statValid'),l=document.getElementById('statLeader');if(a)a.textContent=rows.length;if(p)p.textContent=data.totals.points||0;if(b)b.textContent=data.totals.clicks;if(u)u.textContent=data.totals.unique;if(v)v.textContent=data.totals.valid||0;if(l)l.textContent=rows[0]?rows[0].name:'—';" +
      "const body=document.getElementById('leaderboardBody');if(body){body.textContent='';rows.forEach(r=>{const tr=document.createElement('tr');tr.appendChild(el('td','rank'+(r.rank===1?' one':''),String(r.rank)));const tdP=el('td');tdP.append(el('div','person',r.name),el('div','code',r.code));tr.appendChild(tdP);tr.appendChild(el('td','points-col',String(r.points)+' pts'));tr.appendChild(el('td','',String(publicMode?r.valid:r.clicks)));const tdU=el('td');tdU.appendChild(el('b','',String(r.unique)));tr.appendChild(tdU);if(!publicMode){tr.appendChild(el('td','',String(r.valid)));const tdL=el('td');const ac=el('div','actions');const cp=el('button','iconbtn copy','Copier');cp.type='button';cp.dataset.link=origin+r.link;const op=el('a','iconbtn','Ouvrir');op.href=origin+r.link;op.target='_blank';ac.append(cp,op);tdL.appendChild(ac);tr.appendChild(tdL);const td=el('td');const fm=document.createElement('form');fm.method='post';fm.action='/api/competition/'+encodeURIComponent(data.competition.id)+'/delete-participant';const input=document.createElement('input');input.type='hidden';input.name='code';input.value=r.code;const bt=el('button','danger','Supprimer');bt.type='submit';fm.append(input,bt);td.appendChild(fm);tr.appendChild(td)}body.appendChild(tr)})}" +
      "const chart=document.getElementById('liveChart');if(chart){chart.textContent='';const max=Math.max(1,...rows.map(r=>r.points||0));if(!rows.length){chart.appendChild(el('div','empty','Le graphique apparaîtra dès l’attribution des premiers points.'))}else rows.forEach(r=>{const row=el('div','bar-row');row.appendChild(el('div','bar-name',r.name));const track=el('div','track');const fill=el('div','fill');fill.style.width=Math.max(2,Math.round((r.points||0)/max*100))+'%';track.appendChild(fill);row.append(track,el('div','bar-value',String(r.points||0)+' pts'));chart.appendChild(row)})}const t=document.getElementById('updatedAt');if(t)t.textContent='· '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}" +
    "async function refresh(){try{const r=await fetch(endpoint,{cache:'no-store'});if(r.ok)render(await r.json())}catch{}}if(document.getElementById('liveChart')||document.getElementById('leaderboardBody')){setInterval(refresh,5000);setTimeout(refresh,900)}" +
    "const pf=document.getElementById('profileFile');if(pf){pf.addEventListener('change',()=>{const file=pf.files&&pf.files[0];if(!file)return;if(file.size>8000000){alert('Image trop lourde. Choisis une image de moins de 8 Mo.');pf.value='';return}const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const size=320;const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;const ctx=canvas.getContext('2d');const s=Math.min(img.width,img.height);const sx=(img.width-s)/2,sy=(img.height-s)/2;ctx.drawImage(img,sx,sy,s,s,0,0,size,size);const data=canvas.toDataURL('image/jpeg',0.78);document.getElementById('profileData').value=data;const wrap=document.getElementById('profilePreviewWrap');wrap.textContent='';const im=document.createElement('img');im.className='profile-preview';im.src=data;wrap.appendChild(im)};img.src=reader.result};reader.readAsDataURL(file)})}" +
    "const cf=document.getElementById('campaignImageFile');if(cf){cf.addEventListener('change',()=>{const file=cf.files&&cf.files[0];if(!file)return;if(file.size>12000000){alert('Image trop lourde. Choisis une image de moins de 12 Mo.');cf.value='';return}const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const max=1400;const ratio=Math.min(1,max/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*ratio));canvas.height=Math.max(1,Math.round(img.height*ratio));const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',0.82);document.getElementById('campaignImageData').value=data};img.src=reader.result};reader.readAsDataURL(file)})}" ;

  return pageShell(comp.name + " — " + (publicMode ? "Classement" : view), body, script);
}

async function findCompetition(id) {
  return (await getCompetitions()).find(c => c.id === id);
}

async function uniqueCompetitionId(name) {
  const comps = await getCompetitions();
  const base = slugify(name);
  let id = base;
  while (comps.some(c => c.id === id)) id = base + "-" + randomBytes(2).toString("hex");
  return id;
}

async function uniqueParticipantCode(compId, preferred) {
  const participants = await getParticipants(compId);
  const base = slugify(preferred).slice(0,28) || "participant";
  let code = base;
  let i = 2;
  while (participants.some(p => p.code === code)) code = base + "-" + i++;
  return code;
}

async function registerClick(comp, participant, req, res) {
  const adminSession = await getAdminSession(req).catch(() => null);
  const participantSession = await getParticipantSession(req, comp.id).catch(() => null);

  const tracked = await trackReferralVisit({
    req,
    res,
    competitionId: comp.id,
    referralCode: participant.code,
    isAdmin: Boolean(adminSession),
    isSelf: participantSession?.referral_code === participant.code
  });

  await shadowSyncStats(comp.id, participant.code, tracked.stats);
  return tracked;
}

async function apiStats(res, comp) {
  const participants = await getRankedParticipants(comp);
  return send(res, 200, JSON.stringify({
    competition: {id:comp.id,name:comp.name,status:comp.status},
    totals: {
      participants: participants.length,
      points: participants.reduce((s,r)=>s+r.points,0),
      clicks: participants.reduce((s,r)=>s+r.clicks,0),
      unique: participants.reduce((s,r)=>s+r.unique,0),
      valid: participants.reduce((s,r)=>s+r.valid,0)
    },
    participants
  }), "application/json; charset=utf-8");
}

export default async function handler(req, res) {
  try {
    const cfg = storageConfig();
    if (!cfg.url || !cfg.token) return send(res, 503, "Stockage Upstash non configuré.", "text/plain; charset=utf-8");

    const rawPath = req.query && req.query.path;
    const path = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");
    const origin = "https://" + req.headers.host;
    await ensureLegacyMigration();

    if (path === "") {
      return send(res, 200, await publicLandingPage());
    }

    if (path === "admin/login") {
      const next = loginNextPath(req.query?.next || parseBody(req).next || "/admin");

      if (req.method === "GET") {
        if (adminAuthConfigured() && await getAdminSession(req)) {
          return redirect(res, next, 302);
        }
        const message = adminAuthConfigured()
          ? ""
          : "La protection administrateur n’est pas encore configurée dans Vercel.";
        return send(res, adminAuthConfigured() ? 200 : 503, loginPage(message, next));
      }

      if (req.method === "POST") {
        if (!sameOriginRequest(req)) {
          return send(res, 403, loginPage("Requête refusée.", next));
        }
        const b = parseBody(req);
        const checked = await verifyAdminCredentials(req, b.username, b.code);
        if (!checked.ok) {
          const msg = checked.reason === "rate_limited"
            ? "Trop de tentatives. Réessaie dans quelques minutes."
            : checked.reason === "not_configured"
              ? "La protection administrateur n’est pas encore configurée."
              : "Nom d’utilisateur ou code incorrect.";
          return send(res, checked.reason === "rate_limited" ? 429 : 401, loginPage(msg, next));
        }
        await createAdminSession(req, res);
        return redirect(res, next, 303);
      }

      return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
    }

    if (path === "admin/logout") {
      if (req.method !== "POST") return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
      if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
      await destroyAdminSession(req, res);
      return redirect(res, "/admin/login", 303);
    }

    if (path.startsWith("join/")) {
      const competitionId = decodeURIComponent(path.slice("join/".length));
      const dbComp = await getJoinableCompetition(competitionId);
      if (!dbComp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");

      if (req.method === "GET") {
        if (dbComp.status !== "active" || !dbComp.registrations_open) {
          return send(res, 403, participantShell("Inscriptions fermées", participantTop(null) + "<div class=\"p-card\"><h2 style=\"margin-top:0\">Inscriptions fermées</h2><p class=\"p-muted\">Cette compétition n’accepte pas actuellement de nouvelles inscriptions.</p><a class=\"p-btn2\" href=\"/leaderboard/" + encodeURIComponent(competitionId) + "\">Voir le classement</a></div>"));
        }
        if (dbComp.max_participants && Number(dbComp.participant_count) >= Number(dbComp.max_participants)) {
          return send(res, 403, participantShell("Compétition complète", participantTop(null) + "<div class=\"p-card\"><h2 style=\"margin-top:0\">Compétition complète</h2><p class=\"p-muted\">Le nombre maximum de participants a été atteint.</p></div>"));
        }
        return send(res, 200, joinPage(dbComp));
      }

      if (req.method === "POST") {
        if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
        const b = parseBody(req);
        const pseudonym = String(b.pseudonym || "").trim();
        const whatsapp = String(b.whatsapp || "").trim();
        const referralCode = await uniqueParticipantCode(competitionId, "p-" + randomBytes(4).toString("hex"));

        const result = await registerParticipantAccount({
          competitionId,
          pseudonym,
          whatsapp,
          referralCode
        });

        if (!result.ok) {
          const messages = {
            invalid_pseudonym: "Choisis un pseudo valide.",
            invalid_whatsapp: "Entre un numéro WhatsApp valide avec l’indicatif pays.",
            competition_not_found: "Compétition introuvable.",
            registrations_closed: "Les inscriptions sont actuellement fermées.",
            competition_full: "Le nombre maximum de participants a été atteint.",
            account_exists: "Un compte existe déjà avec ce numéro WhatsApp. Utilise la page de connexion.",
            duplicate: "Cette inscription existe déjà. Essaie de te connecter."
          };
          return send(res, 400, joinPage(dbComp, messages[result.reason] || "Impossible de créer le compte.", {pseudonym, whatsapp}));
        }

        const participants = await getParticipants(competitionId);
        participants.push({
          name: result.pseudonym,
          code: result.referralCode,
          active: true,
          createdAt: new Date().toISOString(),
          selfRegistered: true
        });
        await saveParticipants(competitionId, participants);
        await createParticipantSession(req, res, result.participantId, competitionId);
        return send(res, 201, joinSuccessPage(result, origin));
      }

      return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
    }

    if (path === "participant/login") {
      if (req.method === "GET") {
        const existing = await getParticipantSession(req);
        if (existing?.competition_id) return redirect(res, "/me/" + encodeURIComponent(existing.competition_id), 302);
        return send(res, 200, participantLoginPage());
      }

      if (req.method === "POST") {
        if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
        const b = parseBody(req);
        const checked = await authenticateParticipant(req, b.whatsapp, b.code);
        if (!checked.ok) {
          const msg = checked.reason === "rate_limited"
            ? "Trop de tentatives. Réessaie dans quelques minutes."
            : "Numéro WhatsApp ou code privé incorrect.";
          return send(res, checked.reason === "rate_limited" ? 429 : 401, participantLoginPage(msg));
        }
        await createParticipantSession(req, res, checked.participantId, checked.competitionId);
        return redirect(res, "/me/" + encodeURIComponent(checked.competitionId), 303);
      }

      return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
    }

    if (path === "participant/logout") {
      if (req.method !== "POST") return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
      if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
      await destroyParticipantSession(req, res);
      return redirect(res, "/participant/login", 303);
    }

    if (path === "me") {
      const session = await getParticipantSession(req);
      if (!session) return redirect(res, "/participant/login", 303);
      return redirect(res, "/me/" + encodeURIComponent(session.competition_id), 302);
    }

    if (path.startsWith("offer/")) {
      const parts = path.split("/").map(decodeURIComponent);
      if (parts.length < 4) return send(res, 404, "Lien incomplet", "text/plain; charset=utf-8");
      return campaignOfferPage(origin, req, res, parts[1], parts[2], parts[3]);
    }

    if (path.startsWith("interest/")) {
      if (req.method !== "POST") return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
      if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
      const parts = path.split("/").map(decodeURIComponent);
      if (parts.length < 4) return send(res, 404, "Lien incomplet", "text/plain; charset=utf-8");
      const competitionId = parts[1], campaignSlug = parts[2], referralCode = parts[3];
      const campaign = await getCampaignBySlug(competitionId, campaignSlug);
      if (!campaign || campaign.status !== "active") return send(res, 404, "Campagne indisponible", "text/plain; charset=utf-8");
      const identity = getVisitorIdentity(req, res);
      const result = await createInterest({
        competitionId,
        campaignId: campaign.id,
        referralCode,
        visitorHash: identity.visitorHash
      });
      if (!result.ok) return send(res, 400, "Impossible d’enregistrer cet intérêt.", "text/plain; charset=utf-8");
      if (result.participantId && result.totalPoints !== null && result.totalPoints !== undefined) {
        await syncRedisPointCacheByParticipantId(competitionId, result.participantId, result.totalPoints);
      }
      return redirect(res, whatsappInterestUrl(campaign, result.referenceCode), 303);
    }

    if (path.startsWith("api/me/")) {
      const parts = path.split("/").map(decodeURIComponent);
      const competitionId = parts[2] || "";
      const session = await getParticipantSession(req, competitionId);
      if (!session) return send(res, 401, "Session participant requise", "text/plain; charset=utf-8");
      if (req.method !== "POST") return send(res, 405, "Méthode non autorisée", "text/plain; charset=utf-8");
      if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");

      if (parts[3] === "daily-claim") {
        const b = parseBody(req);
        const result = await claimDailyReward({
          competitionId,
          dayId: String(b.dayId || ""),
          participantId: session.participant_id
        });
        if (result.ok && result.totalPoints !== null && result.totalPoints !== undefined) {
          await syncRedisPointCacheByParticipantId(competitionId, session.participant_id, result.totalPoints);
        }
        return redirect(res, "/me/" + encodeURIComponent(competitionId), 303);
      }

      if (parts[3] === "campaign" && parts[5] === "share") {
        const campaignId = parts[4] || "";
        const b = parseBody(req);
        const result = await recordCampaignShare({
          competitionId,
          campaignId,
          participantId: session.participant_id,
          channel: b.channel || "generic"
        });
        if (result.ok && result.totalPoints !== null && result.totalPoints !== undefined) {
          await syncRedisPointCacheByParticipantId(competitionId, session.participant_id, result.totalPoints);
        }
        return send(res, 200, JSON.stringify(result), "application/json; charset=utf-8");
      }

      if (parts[3] === "mission-submit") {
        const b = parseBody(req);
        await submitMissionCompletion({
          competitionId,
          missionId: String(b.missionId || ""),
          participantId: session.participant_id,
          proofData: String(b.proofData || "")
        });
        return redirect(res, "/me/" + encodeURIComponent(competitionId), 303);
      }

      if (parts[3] === "prize-select") {
        const b = parseBody(req);
        const result = await selectPrize({
          competitionId,
          participantId: session.participant_id,
          prizeId: String(b.prizeId || ""),
          selectedBy: "participant"
        });
        if (!result.ok) {
          const msg = result.reason === "wait_previous_winners"
            ? "Les gagnants mieux classés doivent choisir leur lot avant toi."
            : "Ce lot n’est pas disponible pour le moment.";
          return send(res, 409, participantShell("Choix indisponible", participantTop(session) + "<div class=\"p-card\"><h2>" + esc(msg) + "</h2><a class=\"p-btn2\" href=\"/me/" + encodeURIComponent(competitionId) + "/rewards\">Retour</a></div>" + participantBottom(session,"rewards")));
        }
        return redirect(res, "/me/" + encodeURIComponent(competitionId) + "/rewards", 303);
      }

      return send(res, 404, "Action inconnue", "text/plain; charset=utf-8");
    }

    if (path.startsWith("me/")) {
      const parts = path.split("/").map(decodeURIComponent);
      const competitionId = parts[1] || "";
      const view = parts[2] || "home";
      const session = await getParticipantSession(req, competitionId);
      if (!session) return redirect(res, "/participant/login", 303);
      if (view === "home") return send(res, 200, await participantDashboardPage(origin, session));
      if (view === "campaigns") return send(res, 200, await participantCampaignsPage(origin, session));
      if (view === "rewards") return send(res, 200, await participantRewardsPage(origin, session));
      if (view === "rules") return send(res, 200, await participantRulesPage(session));
      return send(res, 404, "Rubrique introuvable", "text/plain; charset=utf-8");
    }

    if (path === "admin") {
      if (!await ensureAdminAccess(req, res, "/admin")) return;
      return send(res, 200, await dashboardPage(origin));
    }

    if (path.startsWith("c/")) {
      if (!await ensureAdminAccess(req, res, "/" + path)) return;
      const parts = path.split("/").map(decodeURIComponent);
      const id = parts[1] || "";
      const view = parts[2] || "overview";
      const allowedViews = ["overview","links","ranking","live","participants","campaigns","days","prospects","scoring","rewards","fraud","notifications","settings"];
      const comp = await findCompetition(id);
      if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");
      if (!allowedViews.includes(view)) return send(res, 404, "Rubrique introuvable", "text/plain; charset=utf-8");
      return send(res, 200, await competitionPage(origin, comp, view, false, String(req.query?.new || "")));
    }

    if (path.startsWith("leaderboard/")) {
      const id = decodeURIComponent(path.slice("leaderboard/".length));
      const comp = await findCompetition(id);
      if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");
      return send(res, 200, await competitionPage(origin, comp, "ranking", true));
    }

    if (path.startsWith("r/")) {
      const parts = path.split("/").map(decodeURIComponent);
      let comp, participant;

      if (parts.length >= 3) {
        comp = await findCompetition(parts[1]);
        if (comp) participant = (await getParticipants(comp.id)).find(p => p.code === parts[2] && p.active !== false);
      } else if (parts.length === 2) {
        const comps = await getCompetitions();
        for (const c of comps) {
          const p = (await getParticipants(c.id)).find(x => x.code === parts[1] && x.active !== false);
          if (p) { comp = c; participant = p; break; }
        }
      }

      if (!comp || !participant) return send(res, 404, "Lien inconnu", "text/plain; charset=utf-8");
      if (comp.status === "paused" || comp.status === "ended" || comp.status === "draft") {
        return send(res, 410, "Cette compétition n’accepte actuellement plus de participations.", "text/plain; charset=utf-8");
      }
      await registerClick(comp, participant, req, res);
      return redirect(res, comp.destination || WA_DEFAULT);
    }

    if (path === "api/competition/create" && req.method === "POST") {
      if (!await ensureAdminAccess(req, res, "/admin")) return;
      if (!sameOriginRequest(req)) return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
      const b = parseBody(req);
      const name = String(b.name || "").trim();
      if (!name) return send(res, 400, "Nom requis", "text/plain; charset=utf-8");
      const id = await uniqueCompetitionId(name);
      const comps = await getCompetitions();
      const comp = {
        id,
        name,
        prize: String(b.prize || "").trim(),
        destination: String(b.destination || WA_DEFAULT).trim(),
        status: ["active","draft","paused"].includes(String(b.status)) ? String(b.status) : "active",
        theme: ["blue","amber","red","mono"].includes(String(b.theme)) ? String(b.theme) : "blue",
        endsAt: String(b.endsAt || "").trim(),
        createdAt: new Date().toISOString()
      };
      comps.unshift(comp);
      await saveCompetitions(comps);
      await saveParticipants(id, []);
      await shadowUpsertCompetition(comp);
      return redirect(res, "/c/" + encodeURIComponent(id), 303);
    }

    const match = path.match(/^api\/competition\/([^/]+)\/(.+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      const comp = await findCompetition(id);
      if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");

      if (action === "stats" && req.method === "GET") return apiStats(res, comp);

      if (!await ensureAdminAccess(req, res, "/c/" + encodeURIComponent(id))) return;
      if (req.method === "POST" && !sameOriginRequest(req)) {
        return send(res, 403, "Requête refusée", "text/plain; charset=utf-8");
      }

      if (action === "mission-review" && req.method === "POST") {
        const b = parseBody(req);
        const result = await reviewMissionCompletion({
          completionId: String(b.completionId || ""),
          action: String(b.action || "rejected"),
          adminId: "admin"
        });
        if (result.ok && result.participantId && result.totalPoints !== null && result.totalPoints !== undefined) {
          await syncRedisPointCacheByParticipantId(result.competitionId || id, result.participantId, result.totalPoints);
        }
        return redirect(res, "/c/" + encodeURIComponent(id) + "/days", 303);
      }

      if (action === "config-update" && req.method === "POST") {
        const b = parseBody(req);
        const result = await updateCompetitionConfig({
          competitionId:id,
          startsAt:b.startsAt || null,
          endsAt:b.endsAt || null,
          timezone:b.timezone || "Africa/Douala",
          registrationsOpen:String(b.registrationsOpen||"")==="1",
          leaderboardVisible:String(b.leaderboardVisible||"")==="1",
          leaderboardFrozen:String(b.leaderboardFrozen||"")==="1",
          winnerCount:b.winnerCount,
          maxParticipants:b.maxParticipants,
          rules:b.rules,
          adminId:"admin"
        });
        if (!result.ok && result.reason === "invalid_dates") {
          return send(res, 400, "La date de fin doit être postérieure à la date de début.", "text/plain; charset=utf-8");
        }
        return redirect(res, "/c/" + encodeURIComponent(id) + "/settings", 303);
      }

      if (action === "campaign-create" && req.method === "POST") {
        const b = parseBody(req);
        await createCampaign({
          competitionId: id,
          name: b.name,
          product: b.product,
          description: b.description,
          commercialText: b.commercialText,
          imageData: b.imageData,
          destinationUrl: b.destinationUrl,
          whatsappUrl: b.whatsappUrl,
          status: b.status,
          pointsShare: b.pointsShare,
          pointsInterest: b.pointsInterest,
          pointsLead: b.pointsLead,
          pointsSale: b.pointsSale,
          multiplier: b.multiplier,
          conversionMultiplier: b.conversionMultiplier,
          dailyShareLimit: b.dailyShareLimit,
          featured: String(b.featured || "") === "1",
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/campaigns", 303);
      }

      if (action === "campaign-status" && req.method === "POST") {
        const b = parseBody(req);
        await updateCampaignStatus({
          competitionId: id,
          campaignId: String(b.campaignId || ""),
          status: String(b.status || "draft"),
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/campaigns", 303);
      }

      if (action === "campaign-delete" && req.method === "POST") {
        const b = parseBody(req);
        await deleteCampaign({
          competitionId: id,
          campaignId: String(b.campaignId || ""),
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/campaigns", 303);
      }

      if (action === "day-save" && req.method === "POST") {
        const b = parseBody(req);
        await createCompetitionDay({
          competitionId: id,
          dayNumber: b.dayNumber,
          title: b.title,
          description: b.description,
          status: b.status,
          startsAt: b.startsAt || null,
          endsAt: b.endsAt || null,
          rewardDailyPoints: b.rewardDailyPoints,
          featuredCampaignId: b.featuredCampaignId || null,
          marketingMessage: b.marketingMessage,
          notificationText: b.notificationText,
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/days", 303);
      }

      if (action === "days-resize" && req.method === "POST") {
        const b = parseBody(req);
        const result = await resizeCompetitionDays({
          competitionId: id,
          dayCount: b.dayCount,
          force: String(b.force || "") === "1",
          adminId: "admin"
        });
        if (!result.ok && result.reason === "shrink_requires_confirmation") {
          const risky = (result.riskyDays || []).map(x => "Jour " + x.day_number + " — " + x.title + " (" + x.mission_count + " mission(s))").join("<br>");
          return send(res, 409,
            pageShell("Confirmation requise",
              topNav() + "<div class=\"card\" style=\"max-width:760px;margin:auto\"><h2>Des journées configurées seraient supprimées</h2><p class=\"muted\">" + risky + "</p><form method=\"post\" action=\"/api/competition/" + encodeURIComponent(id) + "/days-resize\"><input type=\"hidden\" name=\"dayCount\" value=\"" + esc(b.dayCount) + "\"><input type=\"hidden\" name=\"force\" value=\"1\"><div class=\"actions\"><a class=\"btn2\" href=\"/c/" + encodeURIComponent(id) + "/days\">Annuler</a><button class=\"danger\" type=\"submit\">Confirmer la réduction</button></div></form></div>"
            )
          );
        }
        return redirect(res, "/c/" + encodeURIComponent(id) + "/days", 303);
      }

      if (action === "mission-create" && req.method === "POST") {
        const b = parseBody(req);
        await createMission({
          competitionId: id,
          dayId: String(b.dayId || ""),
          campaignId: b.campaignId || null,
          title: b.title,
          description: b.description,
          pointsFixed: b.pointsFixed,
          multiplier: b.multiplier || 1,
          validationMode: b.validationMode,
          status: "active",
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/days", 303);
      }

      if (action === "lead-confirm" && req.method === "POST") {
        const b = parseBody(req);
        const result = await confirmLead({
          interestId: String(b.interestId || ""),
          adminId: "admin"
        });
        if (result.ok && result.participantId) {
          await syncRedisPointCacheByParticipantId(result.competitionId || id, result.participantId, result.totalPoints);
        }
        return redirect(res, "/c/" + encodeURIComponent(id) + "/prospects", 303);
      }

      if (action === "sale-confirm" && req.method === "POST") {
        const b = parseBody(req);
        const result = await confirmSale({
          interestId: String(b.interestId || ""),
          amount: b.amount,
          currency: b.currency || "XAF",
          adminId: "admin"
        });
        if (!result.ok && result.reason === "lead_required") {
          return send(res, 409, "Confirme d’abord le prospect avant la vente.", "text/plain; charset=utf-8");
        }
        if (result.ok && result.participantId) {
          await syncRedisPointCacheByParticipantId(result.competitionId || id, result.participantId, result.totalPoints);
        }
        return redirect(res, "/c/" + encodeURIComponent(id) + "/prospects", 303);
      }

      if (action === "interest-reject" && req.method === "POST") {
        const b = parseBody(req);
        await rejectInterest({interestId:String(b.interestId || ""),adminId:"admin"});
        return redirect(res, "/c/" + encodeURIComponent(id) + "/prospects", 303);
      }

      if (action === "prize-add" && req.method === "POST") {
        const b = parseBody(req);
        await addPrize({
          competitionId:id,
          name:b.name,
          description:b.description,
          durationText:b.durationText,
          sortOrder:b.sortOrder,
          adminId:"admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/rewards", 303);
      }

      if (action === "tier-add" && req.method === "POST") {
        const b = parseBody(req);
        await addRewardTier({
          competitionId:id,
          minPoints:b.minPoints,
          maxPoints:b.maxPoints,
          rewardType:b.rewardType,
          rewardValue:b.rewardValue,
          validityDays:b.validityDays,
          conditions:b.conditions,
          sortOrder:b.sortOrder,
          adminId:"admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/rewards", 303);
      }

      if (action === "finalize" && req.method === "POST") {
        await freezeFinalRanking(id, "admin");
        await generateRewardCoupons(id, "admin");
        return redirect(res, "/c/" + encodeURIComponent(id) + "/rewards", 303);
      }

      if (action === "generate-coupons" && req.method === "POST") {
        await generateRewardCoupons(id, "admin");
        return redirect(res, "/c/" + encodeURIComponent(id) + "/rewards", 303);
      }

      if (action === "fraud-settings" && req.method === "POST") {
        const b = parseBody(req);
        await updateFraudSettings({
          competitionId:id,
          uniqueClickWindowHours:b.uniqueClickWindowHours,
          dailyClickCap:b.dailyClickCap,
          burstDetectionWindowMinutes:b.burstDetectionWindowMinutes,
          maxClicksPerVisitor:b.maxClicksPerVisitor,
          suspiciousThreshold:b.suspiciousThreshold,
          blockObviousBots:String(b.blockObviousBots||"")==="1",
          adminId:"admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/fraud", 303);
      }

      if (action === "fraud-resolve" && req.method === "POST") {
        const b = parseBody(req);
        await resolveFraudFlag({
          competitionId:id,
          flagId:String(b.flagId||""),
          action:String(b.action||"ignored"),
          adminId:"admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/fraud", 303);
      }

      if (action === "announcement" && req.method === "POST") {
        const b = parseBody(req);
        await createAnnouncement({
          competitionId:id,
          title:b.title,
          body:b.body,
          kind:b.kind,
          actionUrl:b.actionUrl||null
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/notifications", 303);
      }

      if (action === "add" && req.method === "POST") {
        const b = parseBody(req);
        const name = String(b.name || "").trim();
        if (!name) return send(res, 400, "Nom requis", "text/plain; charset=utf-8");
        const code = await uniqueParticipantCode(id, String(b.code || name));
        const participants = await getParticipants(id);
        const participant = {name,code,active:true,createdAt:new Date().toISOString()};
        participants.push(participant);
        await saveParticipants(id, participants);
        await shadowUpsertParticipant(comp, participant);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/links?new=" + encodeURIComponent(code), 303);
      }

      if (action === "bulk" && req.method === "POST") {
        const b = parseBody(req);
        const names = String(b.names || "").split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,200);
        const participants = await getParticipants(id);
        const added = [];
        for (const name of names) {
          let base = slugify(name).slice(0,28) || "participant";
          let code = base, n = 2;
          while (participants.some(p=>p.code===code)) code = base + "-" + n++;
          const participant = {name,code,active:true,createdAt:new Date().toISOString()};
          participants.push(participant);
          added.push(participant);
        }
        await saveParticipants(id, participants);
        await shadowUpsertParticipants(comp, added);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/links", 303);
      }

      if (action === "delete-participant" && req.method === "POST") {
        const b = parseBody(req);
        const code = String(b.code || "");
        const participants = (await getParticipants(id)).filter(p=>p.code!==code);
        await saveParticipants(id, participants);
        await redis(["DEL", statsKey(id, code)]);
        await shadowWithdrawParticipant(id, code);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/participants", 303);
      }

      if (action === "scoring-rule" && req.method === "POST") {
        const b = parseBody(req);
        await updateValidClickRule({
          competitionId: id,
          enabled: String(b.enabled || "") === "1",
          basePoints: b.basePoints,
          multiplier: b.multiplier,
          dailyCapPoints: b.dailyCapPoints,
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/scoring", 303);
      }

      if (action === "burst-add" && req.method === "POST") {
        const b = parseBody(req);
        await createBurstRule({
          competitionId: id,
          name: b.name,
          threshold: b.threshold,
          windowMinutes: b.windowMinutes,
          bonusPoints: b.bonusPoints,
          dailyLimit: b.dailyLimit,
          enabled: true,
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/scoring", 303);
      }

      if (action === "burst-delete" && req.method === "POST") {
        const b = parseBody(req);
        await deleteBurstRule({
          competitionId: id,
          ruleId: String(b.ruleId || ""),
          adminId: "admin"
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/scoring", 303);
      }

      if (action === "points" && req.method === "POST") {
        const b = parseBody(req);
        const code = String(b.code || "").trim();
        const amount = Number.parseInt(String(b.quickAmount || b.amount || ""), 10);
        const reason = String(b.reason || "").trim().slice(0, 80);
        if (!code || !Number.isInteger(amount) || amount === 0 || amount < -10000 || amount > 10000) {
          return send(res, 400, "Valeur de points invalide", "text/plain; charset=utf-8");
        }
        const participants = await getParticipants(id);
        if (!participants.some(p => p.code === code)) {
          return send(res, 404, "Participant introuvable", "text/plain; charset=utf-8");
        }
        const newTotal = Number(await redis(["HINCRBY", statsKey(id, code), "points", amount]));
        const effectiveTotal = Math.max(0, newTotal);
        if (newTotal < 0) await redis(["HSET", statsKey(id, code), "points", "0"]);
        await redis(["HSET", statsKey(id, code), "lastReason", reason || "Ajustement manuel", "updatedAt", new Date().toISOString()]);
        await shadowRecordAdminAdjustment({
          competitionId: id,
          referralCode: code,
          amount,
          reason: reason || "Ajustement manuel",
          totalAfter: effectiveTotal
        });
        return redirect(res, "/c/" + encodeURIComponent(id) + "/participants", 303);
      }

      if (action === "status" && req.method === "POST") {
        const b = parseBody(req);
        const status = String(b.status || "");
        const theme = String(b.theme || comp.theme || "blue");
        const allowed = ["active","paused","ended","draft"];
        const themes = ["blue","amber","red","mono"];
        if (!allowed.includes(status)) return send(res, 400, "Statut invalide", "text/plain; charset=utf-8");
        const comps = await getCompetitions();
        const i = comps.findIndex(c=>c.id===id);
        comps[i].status = status;
        comps[i].theme = themes.includes(theme) ? theme : "blue";
        await saveCompetitions(comps);
        await shadowSyncCompetitionSettings(comps[i]);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/settings", 303);
      }

      if (action === "profile" && req.method === "POST") {
        const b = parseBody(req);
        if (String(b.remove || "") === "1") {
          await saveProfile(id, "");
          return redirect(res, "/c/" + encodeURIComponent(id) + "/settings", 303);
        }
        const data = String(b.profileData || "");
        if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(data)) {
          return send(res, 400, "Image invalide", "text/plain; charset=utf-8");
        }
        if (data.length > 260000) {
          return send(res, 413, "Image trop lourde après compression", "text/plain; charset=utf-8");
        }
        await saveProfile(id, data);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/settings", 303);
      }

      if (action === "export.csv" && req.method === "GET") {
        const rows = await getRankedParticipants(comp);
        const csv = [
          ["Rang","Participant","Code","Points","Clics bruts","Visiteurs uniques","Clics valides","Lien"],
          ...rows.map(r=>[r.rank,r.name,r.code,r.points,r.clicks,r.unique,r.valid,origin+r.link])
        ].map(row=>row.map(v=>"\"" + String(v).replace(/"/g,'""') + "\"").join(",")).join("\n");
        res.setHeader("Content-Disposition","attachment; filename=\"" + slugify(comp.name) + "-classement.csv\"");
        return send(res,200,csv,"text/csv; charset=utf-8");
      }
    }

    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    console.error("handler:", error);
    return send(res, 500, "Erreur interne : " + error.message, "text/plain; charset=utf-8");
  }
}
