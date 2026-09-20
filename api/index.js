import { createHash, randomBytes } from "node:crypto";

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
  return {
    clicks: Number(raw.clicks || 0),
    unique: Number(raw.unique || 0),
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
      points: s.points,
      link: "/r/" + comp.id + "/" + p.code
    };
  }));
  rows.sort((a,b) => b.points - a.points || b.unique - a.unique || b.clicks - a.clicks || a.name.localeCompare(b.name));
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
    ".metric-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:14px}.point-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.point-card{border:1px solid var(--line);border-radius:16px;padding:15px;background:#fff}.point-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.point-value{font-size:26px;font-weight:950;letter-spacing:-.05em;color:var(--accent)}.quick-points{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.quick-points button{border:1px solid var(--line);background:#f8f8f5;border-radius:9px;padding:7px 10px;font-weight:850;cursor:pointer}.quick-points button:hover{border-color:var(--accent);color:var(--accent)}.point-custom{display:grid;grid-template-columns:85px 1fr auto;gap:7px}.point-custom input{padding:9px 10px}.score-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:5px 9px;background:var(--accent-soft);color:var(--accent);font-weight:900;font-size:12px}.public-board{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(360px,.75fr);gap:14px;align-items:start}.public-header{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#0a0a0a;color:#fff;border-radius:22px;padding:18px 20px;margin-bottom:12px;position:relative;overflow:hidden}.public-header:after{content:'';position:absolute;right:-60px;top:-100px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,var(--accent-glow),transparent 68%)}.public-brand{display:flex;gap:14px;align-items:center;position:relative;z-index:1}.public-brand h1{font-size:clamp(25px,3.2vw,48px);line-height:.95;letter-spacing:-.05em;margin:0}.public-brand p{margin:6px 0 0;color:#bdbdbd;font-size:12px}.public-prize{position:relative;z-index:1;text-align:right;max-width:280px}.public-prize b{display:block;font-size:13px}.public-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}.public-kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 12px}.public-kpi span{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:800}.public-kpi b{display:block;font-size:22px;margin-top:3px;letter-spacing:-.04em}.public-table{min-width:0}.public-table th,.public-table td{padding:8px 10px;font-size:12px}.public-table th{font-size:9px}.public-table .rank{font-size:15px}.public-table .person{font-size:12px}.public-side{display:grid;gap:12px}.public-panel{background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px}.public-panel h3{margin:0 0 10px;font-size:14px}.public-board .podium{margin-bottom:0}.public-board .podium-card{padding:10px}.public-board .podium-name{font-size:14px}.public-board .bar-row{grid-template-columns:80px 1fr 42px;gap:7px}.public-board .track{height:22px}.capture-note{font-size:10px;color:var(--muted);margin-top:8px}.points-col{font-weight:950;color:var(--accent)}" +
    "@media(max-width:850px){.span8,.span7,.span6,.span5,.span4,.span3{grid-column:span 12}.form-grid{grid-template-columns:1fr}.top{align-items:center}.brand span:last-child{font-size:15px}.hero{padding:22px}.hero-row{display:block}.hero-side{margin-top:18px}.comp{align-items:flex-start;flex-direction:column}.bar-row{grid-template-columns:84px 1fr 34px}.wrap{padding:8px 12px 52px}.links-grid{grid-template-columns:1fr}.success{align-items:flex-start;flex-direction:column}.searchbox{max-width:none;width:100%}.mobile-tip{display:block}.table-wrap{border-radius:12px}.card{padding:15px;border-radius:16px}.hero{border-radius:20px}.quickbar{margin-right:-12px;padding-right:12px}.podium{grid-template-columns:repeat(3,minmax(170px,1fr));overflow-x:auto;margin-right:-12px;padding-right:12px}.editorial-note{font-size:44px}.theme-select-row{grid-template-columns:1fr}.hero:after{right:-5px;bottom:-18px;font-size:88px}.app-shell{grid-template-columns:1fr}.side{position:static;padding:10px}.side-profile{margin-bottom:8px}.side-nav{display:flex;overflow-x:auto;gap:6px;padding-bottom:2px;scrollbar-width:none}.side-nav::-webkit-scrollbar{display:none}.side-link{white-space:nowrap;border:1px solid var(--line);background:#fff}.side-link.active{border-color:#0a0a0a}.side-public{display:none}.page-title{align-items:flex-start;flex-direction:column}.page-title h2{font-size:24px}.overview-grid{grid-template-columns:1fr}.profile-settings{grid-template-columns:1fr}.profile-preview{width:132px;height:132px;border-radius:24px}.quick-actions{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(2,1fr)}.point-grid{grid-template-columns:1fr}.point-custom{grid-template-columns:80px 1fr}.point-custom button{grid-column:1/-1}.public-board{grid-template-columns:1fr}.public-kpis{grid-template-columns:repeat(2,1fr)}.public-header{align-items:flex-start;flex-direction:column}.public-prize{text-align:left}.wrap{width:calc(100% - 18px);padding-left:0;padding-right:0}}" +
    "</style></head><body><div class=\"wrap\">" + body + "</div>" +
    "<script>" + extraScript + "</script></body></html>";
}

function topNav() {
  return "<div class=\"top\"><a class=\"brand\" href=\"/admin\"><span class=\"mark\">CL</span><span>Competition Link Tracker</span></a>" +
    "<div class=\"nav\"><a class=\"btn2\" href=\"/admin\">Dashboard</a></div></div>";
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
    const rate = r.clicks ? Math.round((r.unique / r.clicks) * 100) : 0;
    if (publicMode) {
      return "<tr data-code=\"" + esc(r.code) + "\">" +
        "<td class=\"rank " + (r.rank === 1 ? "one" : "") + "\">" + r.rank + "</td>" +
        "<td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
        "<td class=\"points-col\">" + r.points + " pts</td><td>" + r.clicks + "</td><td><b>" + r.unique + "</b></td></tr>";
    }
    return "<tr data-code=\"" + esc(r.code) + "\">" +
      "<td class=\"rank " + (r.rank === 1 ? "one" : "") + "\">" + r.rank + "</td>" +
      "<td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
      "<td class=\"points-col\">" + r.points + "</td><td>" + r.clicks + "</td><td><b>" + r.unique + "</b></td><td>" + rate + "%</td>" +
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
  if (!rows.length) return "<tr><td colspan=\"7\" class=\"empty\">Aucun participant.</td></tr>";
  return rows.map(r =>
    "<tr><td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
    "<td>#" + r.rank + "</td><td class=\"points-col\">" + r.points + "</td><td>" + r.clicks + "</td><td>" + r.unique + "</td>" +
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

async function competitionPage(origin, comp, view = "overview", publicMode = false, newCode = "") {
  const rows = await getRankedParticipants(comp);
  const profile = await getProfile(comp.id);
  const totals = {
    participants: rows.length,
    points: rows.reduce((s,r) => s + r.points, 0),
    clicks: rows.reduce((s,r) => s + r.clicks, 0),
    unique: rows.reduce((s,r) => s + r.unique, 0)
  };
  const leader = rows[0];
  const theme = ["blue","amber","red","mono"].includes(comp.theme) ? comp.theme : "blue";
  const endpoint = "/api/competition/" + encodeURIComponent(comp.id) + "/stats";
  const id = encodeURIComponent(comp.id);

  const statsHtml =
    "<div class=\"metric-grid\">" +
      "<div class=\"card stat\"><div class=\"label\">Participants</div><div class=\"num\" id=\"statParticipants\">" + totals.participants + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Points attribués</div><div class=\"num\" id=\"statPoints\">" + totals.points + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Clics</div><div class=\"num\" id=\"statClicks\">" + totals.clicks + "</div></div>" +
      "<div class=\"card stat\"><div class=\"label\">Uniques</div><div class=\"num\" id=\"statUnique\">" + totals.unique + "</div></div>" +
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
        (comp.prize ? "<b style=\"margin-top:8px\">Récompense : " + esc(comp.prize) + "</b>" : "") + "</div></div>";
    const publicKpis =
      "<div class=\"public-kpis\"><div class=\"public-kpi\"><span>Participants</span><b id=\"statParticipants\">" + totals.participants + "</b></div>" +
      "<div class=\"public-kpi\"><span>Points</span><b id=\"statPoints\">" + totals.points + "</b></div>" +
      "<div class=\"public-kpi\"><span>Clics</span><b id=\"statClicks\">" + totals.clicks + "</b></div>" +
      "<div class=\"public-kpi\"><span>Uniques</span><b id=\"statUnique\">" + totals.unique + "</b></div></div>";
    content = publicHeader + publicKpis +
      "<div class=\"public-board\"><div class=\"public-panel\"><div class=\"section-title\"><div><h2>Classement général</h2><div class=\"subnav-note\">Du premier au dernier · priorité aux points</div></div><div class=\"live\"><span class=\"pulse\"></span><span id=\"updatedAt\">live</span></div></div>" +
        "<div class=\"table-wrap\"><table class=\"public-table\"><thead><tr><th>#</th><th>Participant</th><th>Points</th><th>Clics</th><th>Uniques</th></tr></thead><tbody id=\"leaderboardBody\">" + leaderboardRowsHtml(rows, origin, comp, true) + "</tbody></table></div>" +
        "<div class=\"capture-note\">Les points sont attribués par l’administrateur après validation des actions (ex. souscription).</div></div>" +
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
      "<div class=\"card\"><div class=\"section-title\"><h2>Classement détaillé</h2><span class=\"small muted\">priorité aux points · uniques et clics départagent les égalités</span></div><div class=\"table-wrap\"><table><thead><tr><th>#</th><th>Participant</th><th>Points</th><th>Clics</th><th>Uniques</th><th>Taux unique</th><th>Lien</th><th>Action</th></tr></thead><tbody id=\"leaderboardBody\">" + leaderboardRowsHtml(rows, origin, comp, false) + "</tbody></table></div></div>";
  } else if (view === "live") {
    content = pageTitleHtml("Graphique live","Visualise la position actuelle de tous les participants.") +
      statsHtml +
      "<div class=\"card\"><div class=\"section-title\"><h2>Position en temps réel</h2><div class=\"live\"><span class=\"pulse\"></span><span>actualisation toutes les 5 s</span><span id=\"updatedAt\"></span></div></div><div class=\"chart\" id=\"liveChart\">" + chartHtml(rows) + "</div></div>";
  } else if (view === "participants") {
    content = pageTitleHtml("Participants","Ajoute les participants individuellement ou en masse.") +
      success +
      "<div class=\"grid\" style=\"margin-bottom:14px\">" +
        "<div class=\"card span6\"><div class=\"section-title\"><h2>Ajouter un participant</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/add\"><div class=\"form-grid\"><div><label>Nom</label><input name=\"name\" placeholder=\"Nom du participant\" required></div><div><label>Code (facultatif)</label><input name=\"code\" placeholder=\"Généré automatiquement\"></div><div class=\"full\"><button class=\"btn\" style=\"width:100%\" type=\"submit\">Ajouter le participant</button></div></div></form></div>" +
        "<div class=\"card span6\"><div class=\"section-title\"><h2>Ajout multiple</h2></div><form method=\"post\" action=\"/api/competition/" + id + "/bulk\"><label>Un nom par ligne</label><textarea name=\"names\" placeholder=\"Aron&#10;Tony&#10;Marc&#10;Sarah\"></textarea><button class=\"btn2\" style=\"width:100%;margin-top:9px\" type=\"submit\">Ajouter toute la liste</button></form></div>" +
      "</div>" +
      "<div class=\"card\" style=\"margin-bottom:14px\"><div class=\"section-title\"><div><h2>Attribuer des points</h2><div class=\"subnav-note\">+5, +10, +20, +50 ou une valeur personnalisée. Une valeur négative permet de corriger une erreur.</div></div></div>" + pointsCardsHtml(rows, comp) + "</div>" +
      "<div class=\"card\"><div class=\"section-title\"><h2>Liste des participants</h2><span class=\"small muted\">" + rows.length + " au total</span></div><div class=\"table-wrap\"><table class=\"participant-table\"><thead><tr><th>Participant</th><th>Rang</th><th>Points</th><th>Clics</th><th>Uniques</th><th>Lien</th><th>Action</th></tr></thead><tbody>" + participantAdminRows(rows, comp) + "</tbody></table></div></div>";
  } else if (view === "settings") {
    const currentProfile = profileAvatarHtml(profile, comp.name);
    content = pageTitleHtml("Paramètres","Identité, photo, palette et statut de cette compétition.") +
      "<div class=\"grid\">" +
        "<div class=\"card span5\"><div class=\"section-title\"><h2>Photo de la compétition</h2></div><div class=\"profile-settings\"><div id=\"profilePreviewWrap\">" +
          (profile ? "<img class=\"profile-preview\" src=\"" + esc(profile) + "\" alt=\"Photo actuelle\">" : "<div class=\"profile-preview\">" + esc(comp.name.charAt(0).toUpperCase()) + "</div>") +
          "</div><div><div class=\"upload-zone\"><label>Choisir une image</label><input id=\"profileFile\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"><div class=\"footer-note\">L’image sera automatiquement recadrée et compressée en carré.</div></div><form id=\"profileForm\" method=\"post\" action=\"/api/competition/" + id + "/profile\" style=\"margin-top:10px\"><input id=\"profileData\" type=\"hidden\" name=\"profileData\"><button class=\"btn\" type=\"submit\">Enregistrer la photo</button></form>" +
          (profile ? "<form method=\"post\" action=\"/api/competition/" + id + "/profile\" style=\"margin-top:8px\"><input type=\"hidden\" name=\"remove\" value=\"1\"><button class=\"danger\" type=\"submit\">Retirer la photo</button></form>" : "") +
        "</div></div></div>" +
        "<div class=\"card span7\"><div class=\"section-title\"><h2>Configuration</h2><span class=\"status\"><span class=\"theme-swatch\"></span>" + esc(comp.status) + "</span></div><form method=\"post\" action=\"/api/competition/" + id + "/status\"><div class=\"form-grid\"><div><label>Statut</label><select name=\"status\"><option value=\"active\"" + (comp.status==="active"?" selected":"") + ">Active</option><option value=\"paused\"" + (comp.status==="paused"?" selected":"") + ">En pause</option><option value=\"ended\"" + (comp.status==="ended"?" selected":"") + ">Terminée</option><option value=\"draft\"" + (comp.status==="draft"?" selected":"") + ">Brouillon</option></select></div><div><label>Palette</label><select name=\"theme\"><option value=\"blue\"" + (theme==="blue"?" selected":"") + ">Bleu premium</option><option value=\"amber\"" + (theme==="amber"?" selected":"") + ">Ambre premium</option><option value=\"red\"" + (theme==="red"?" selected":"") + ">Rouge profond</option><option value=\"mono\"" + (theme==="mono"?" selected":"") + ">Monochrome</option></select></div><div class=\"full\"><button class=\"btn\" type=\"submit\">Enregistrer</button></div></div></form><hr style=\"border:0;border-top:1px solid var(--line);margin:18px 0\"><div class=\"notice\"><b>Lien public du classement</b><br><span class=\"muted\">" + esc(origin + "/leaderboard/" + comp.id) + "</span><div class=\"actions\" style=\"margin-top:10px\"><button class=\"btn2 copy\" type=\"button\" data-link=\"" + esc(origin + "/leaderboard/" + comp.id) + "\">Copier</button><a class=\"btn2\" target=\"_blank\" href=\"/leaderboard/" + id + "\">Ouvrir</a><a class=\"btn2\" href=\"/api/competition/" + id + "/export.csv\">Exporter CSV</a></div></div></div>" +
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
    "function render(data){const rows=data.participants||[];const a=document.getElementById('statParticipants'),p=document.getElementById('statPoints'),b=document.getElementById('statClicks'),u=document.getElementById('statUnique'),l=document.getElementById('statLeader');if(a)a.textContent=rows.length;if(p)p.textContent=data.totals.points||0;if(b)b.textContent=data.totals.clicks;if(u)u.textContent=data.totals.unique;if(l)l.textContent=rows[0]?rows[0].name:'—';" +
      "const body=document.getElementById('leaderboardBody');if(body){body.textContent='';rows.forEach(r=>{const tr=document.createElement('tr');tr.appendChild(el('td','rank'+(r.rank===1?' one':''),String(r.rank)));const tdP=el('td');tdP.append(el('div','person',r.name),el('div','code',r.code));tr.appendChild(tdP);tr.appendChild(el('td','points-col',String(r.points)+' pts'));tr.appendChild(el('td','',String(r.clicks)));const tdU=el('td');tdU.appendChild(el('b','',String(r.unique)));tr.appendChild(tdU);if(!publicMode){tr.appendChild(el('td','',r.clicks?Math.round(r.unique/r.clicks*100)+'%':'0%'));const tdL=el('td');const ac=el('div','actions');const cp=el('button','iconbtn copy','Copier');cp.type='button';cp.dataset.link=origin+r.link;const op=el('a','iconbtn','Ouvrir');op.href=origin+r.link;op.target='_blank';ac.append(cp,op);tdL.appendChild(ac);tr.appendChild(tdL);const td=el('td');const fm=document.createElement('form');fm.method='post';fm.action='/api/competition/'+encodeURIComponent(data.competition.id)+'/delete-participant';const input=document.createElement('input');input.type='hidden';input.name='code';input.value=r.code;const bt=el('button','danger','Supprimer');bt.type='submit';fm.append(input,bt);td.appendChild(fm);tr.appendChild(td)}body.appendChild(tr)})}" +
      "const chart=document.getElementById('liveChart');if(chart){chart.textContent='';const max=Math.max(1,...rows.map(r=>r.points||0));if(!rows.length){chart.appendChild(el('div','empty','Le graphique apparaîtra dès l’attribution des premiers points.'))}else rows.forEach(r=>{const row=el('div','bar-row');row.appendChild(el('div','bar-name',r.name));const track=el('div','track');const fill=el('div','fill');fill.style.width=Math.max(2,Math.round((r.points||0)/max*100))+'%';track.appendChild(fill);row.append(track,el('div','bar-value',String(r.points||0)+' pts'));chart.appendChild(row)})}const t=document.getElementById('updatedAt');if(t)t.textContent='· '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}" +
    "async function refresh(){try{const r=await fetch(endpoint,{cache:'no-store'});if(r.ok)render(await r.json())}catch{}}if(document.getElementById('liveChart')||document.getElementById('leaderboardBody')){setInterval(refresh,5000);setTimeout(refresh,900)}" +
    "const pf=document.getElementById('profileFile');if(pf){pf.addEventListener('change',()=>{const file=pf.files&&pf.files[0];if(!file)return;if(file.size>8000000){alert('Image trop lourde. Choisis une image de moins de 8 Mo.');pf.value='';return}const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const size=320;const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;const ctx=canvas.getContext('2d');const s=Math.min(img.width,img.height);const sx=(img.width-s)/2,sy=(img.height-s)/2;ctx.drawImage(img,sx,sy,s,s,0,0,size,size);const data=canvas.toDataURL('image/jpeg',0.78);document.getElementById('profileData').value=data;const wrap=document.getElementById('profilePreviewWrap');wrap.textContent='';const im=document.createElement('img');im.className='profile-preview';im.src=data;wrap.appendChild(im)};img.src=reader.result};reader.readAsDataURL(file)})}" ;

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

async function registerClick(comp, participant, req) {
  await redis(["HINCRBY", statsKey(comp.id, participant.code), "clicks", 1]);

  const forwarded = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "");
  const secret = storageConfig().token;
  const fingerprint = createHash("sha256")
    .update(comp.id + "|" + participant.code + "|" + forwarded + "|" + ua + "|" + secret)
    .digest("hex");

  const uniqueKey = PREFIX + ":unique:" + fingerprint;
  const first = await redis(["SET", uniqueKey, "1", "EX", 7776000, "NX"]);
  if (first === "OK") {
    await redis(["HINCRBY", statsKey(comp.id, participant.code), "unique", 1]);
  }
}

async function apiStats(res, comp) {
  const participants = await getRankedParticipants(comp);
  return send(res, 200, JSON.stringify({
    competition: {id:comp.id,name:comp.name,status:comp.status},
    totals: {
      participants: participants.length,
      points: participants.reduce((s,r)=>s+r.points,0),
      clicks: participants.reduce((s,r)=>s+r.clicks,0),
      unique: participants.reduce((s,r)=>s+r.unique,0)
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

    if (path === "" || path === "admin") {
      return send(res, 200, await dashboardPage(origin));
    }

    if (path.startsWith("c/")) {
      const parts = path.split("/").map(decodeURIComponent);
      const id = parts[1] || "";
      const view = parts[2] || "overview";
      const allowedViews = ["overview","links","ranking","live","participants","settings"];
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
      await registerClick(comp, participant, req);
      return redirect(res, comp.destination || WA_DEFAULT);
    }

    if (path === "api/competition/create" && req.method === "POST") {
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
      return redirect(res, "/c/" + encodeURIComponent(id), 303);
    }

    const match = path.match(/^api\/competition\/([^/]+)\/(.+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      const comp = await findCompetition(id);
      if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");

      if (action === "stats" && req.method === "GET") return apiStats(res, comp);

      if (action === "add" && req.method === "POST") {
        const b = parseBody(req);
        const name = String(b.name || "").trim();
        if (!name) return send(res, 400, "Nom requis", "text/plain; charset=utf-8");
        const code = await uniqueParticipantCode(id, String(b.code || name));
        const participants = await getParticipants(id);
        participants.push({name,code,active:true,createdAt:new Date().toISOString()});
        await saveParticipants(id, participants);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/links?new=" + encodeURIComponent(code), 303);
      }

      if (action === "bulk" && req.method === "POST") {
        const b = parseBody(req);
        const names = String(b.names || "").split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,200);
        const participants = await getParticipants(id);
        for (const name of names) {
          let base = slugify(name).slice(0,28) || "participant";
          let code = base, n = 2;
          while (participants.some(p=>p.code===code)) code = base + "-" + n++;
          participants.push({name,code,active:true,createdAt:new Date().toISOString()});
        }
        await saveParticipants(id, participants);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/links", 303);
      }

      if (action === "delete-participant" && req.method === "POST") {
        const b = parseBody(req);
        const code = String(b.code || "");
        const participants = (await getParticipants(id)).filter(p=>p.code!==code);
        await saveParticipants(id, participants);
        await redis(["DEL", statsKey(id, code)]);
        return redirect(res, "/c/" + encodeURIComponent(id) + "/participants", 303);
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
        if (newTotal < 0) await redis(["HSET", statsKey(id, code), "points", "0"]);
        await redis(["HSET", statsKey(id, code), "lastReason", reason || "Ajustement manuel", "updatedAt", new Date().toISOString()]);
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
          ["Rang","Participant","Code","Points","Clics","Visiteurs uniques","Lien"],
          ...rows.map(r=>[r.rank,r.name,r.code,r.points,r.clicks,r.unique,origin+r.link])
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
