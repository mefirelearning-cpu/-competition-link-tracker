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
    unique: Number(raw.unique || 0)
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
      link: "/r/" + comp.id + "/" + p.code
    };
  }));
  rows.sort((a,b) => b.unique - a.unique || b.clicks - a.clicks || a.name.localeCompare(b.name));
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
      "unique", String(Number(legacy[i].unique || 0))
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
    ":root{--bg:#f4f4f2;--card:#fff;--text:#0b0b0b;--muted:#6f6f6f;--line:#e7e7e3;--soft:#f8f8f6;--ok:#2e7d32;--danger:#b42318}" +
    "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}" +
    "a{color:inherit;text-decoration:none}.wrap{max-width:1180px;margin:auto;padding:22px 16px 60px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}" +
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
    "@media(max-width:850px){.span8,.span7,.span6,.span5,.span4,.span3{grid-column:span 12}.form-grid{grid-template-columns:1fr}.top{align-items:flex-start}.hero{padding:22px}.comp{align-items:flex-start;flex-direction:column}.bar-row{grid-template-columns:90px 1fr 36px}.wrap{padding-top:14px}}" +
    "</style></head><body><div class=\"wrap\">" + body + "</div>" +
    "<script>" + extraScript + "</script></body></html>";
}

function topNav() {
  return "<div class=\"top\"><a class=\"brand\" href=\"/admin\"><span class=\"mark\">CL</span><span>Competition Link Tracker</span></a>" +
    "<div class=\"nav\"><a class=\"btn2\" href=\"/admin\">Dashboard</a></div></div>";
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
    "<div class=\"comp\"><div><div class=\"comp-meta\"><span class=\"status\"><span class=\"dot " + esc(c.status) + "\"></span>" + esc(c.status) + "</span><span class=\"small muted\">" + c.participants + " participants</span></div>" +
    "<h3>" + esc(c.name) + "</h3><div class=\"small muted\">" + c.unique + " uniques · " + c.clicks + " clics" + (c.endsAt ? " · fin " + esc(c.endsAt) : "") + "</div></div>" +
    "<div class=\"actions\"><a class=\"btn2\" href=\"/leaderboard/" + encodeURIComponent(c.id) + "\">Classement public</a><a class=\"btn\" href=\"/c/" + encodeURIComponent(c.id) + "\">Gérer</a></div></div>"
  ).join("") : "<div class=\"empty\">Aucune compétition pour le moment.</div>";

  const body = topNav() +
    "<section class=\"hero\"><div class=\"eyebrow\">Dashboard</div><h1>Compétitions.<br>Claires. Mesurables.</h1><p>Crée tes compétitions, génère des liens individuels et suis les classements presque en temps réel depuis un seul tableau de bord.</p></section>" +
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
          "<div class=\"full\"><button class=\"btn\" type=\"submit\" style=\"width:100%\">Créer la compétition</button></div>" +
        "</div></form>" +
        "<div class=\"footer-note\">Les clics et visiteurs uniques indiquent l’activité des liens. Ils ne prouvent pas à eux seuls qu’une personne a effectivement rejoint le groupe WhatsApp.</div>" +
      "</div>" +
    "</div>";
  return pageShell("Competition Link Tracker", body);
}

function leaderboardRowsHtml(rows, origin, comp, publicMode) {
  if (!rows.length) return "<tr><td colspan=\"" + (publicMode ? "6" : "7") + "\" class=\"empty\">Aucun participant.</td></tr>";
  return rows.map((r) => {
    const link = origin + r.link;
    const rate = r.clicks ? Math.round((r.unique / r.clicks) * 100) : 0;
    return "<tr data-code=\"" + esc(r.code) + "\">" +
      "<td class=\"rank " + (r.rank === 1 ? "one" : "") + "\">" + r.rank + "</td>" +
      "<td><div class=\"person\">" + esc(r.name) + "</div><div class=\"code\">" + esc(r.code) + "</div></td>" +
      "<td>" + r.clicks + "</td><td><b>" + r.unique + "</b></td><td>" + rate + "%</td>" +
      "<td><div class=\"actions\"><button type=\"button\" class=\"iconbtn copy\" data-link=\"" + esc(link) + "\">Copier</button><a class=\"iconbtn\" href=\"" + esc(link) + "\" target=\"_blank\">Ouvrir</a></div></td>" +
      (publicMode ? "" : "<td><form method=\"post\" action=\"/api/competition/" + encodeURIComponent(comp.id) + "/delete-participant\"><input type=\"hidden\" name=\"code\" value=\"" + esc(r.code) + "\"><button class=\"danger\" type=\"submit\">Supprimer</button></form></td>") +
      "</tr>";
  }).join("");
}

function chartHtml(rows) {
  const max = Math.max(1, ...rows.map(r => r.unique));
  return rows.map(r => {
    const pct = Math.max(2, Math.round((r.unique / max) * 100));
    return "<div class=\"bar-row\" data-code=\"" + esc(r.code) + "\" title=\"" + esc(r.name) + " · " + r.unique + " visiteurs uniques\">" +
      "<div class=\"bar-name\">" + esc(r.name) + "</div>" +
      "<div class=\"track\"><div class=\"fill\" style=\"width:" + pct + "%\"></div></div>" +
      "<div class=\"bar-value\">" + r.unique + "</div></div>";
  }).join("") || "<div class=\"empty\">Le graphique apparaîtra dès les premiers clics.</div>";
}

async function competitionPage(origin, comp, publicMode = false) {
  const rows = await getRankedParticipants(comp);
  const totals = {
    participants: rows.length,
    clicks: rows.reduce((s,r) => s + r.clicks, 0),
    unique: rows.reduce((s,r) => s + r.unique, 0)
  };
  const leader = rows[0];
  const endpoint = "/api/competition/" + encodeURIComponent(comp.id) + "/stats";
  const tableCols = publicMode ? 6 : 7;

  const adminTools = publicMode ? "" :
    "<div class=\"card span5\"><div class=\"section-title\"><h2>Ajouter des participants</h2><span class=\"small muted\">Individuel ou en masse</span></div>" +
      "<form method=\"post\" action=\"/api/competition/" + encodeURIComponent(comp.id) + "/add\"><div class=\"form-grid\">" +
        "<div><label>Nom</label><input name=\"name\" placeholder=\"Nom du participant\" required></div>" +
        "<div><label>Code (facultatif)</label><input name=\"code\" placeholder=\"Généré automatiquement\"></div>" +
        "<div class=\"full\"><button class=\"btn\" style=\"width:100%\" type=\"submit\">Ajouter le participant</button></div>" +
      "</div></form><hr style=\"border:0;border-top:1px solid var(--line);margin:18px 0\">" +
      "<form method=\"post\" action=\"/api/competition/" + encodeURIComponent(comp.id) + "/bulk\"><label>Ajout multiple</label><textarea name=\"names\" placeholder=\"Un nom par ligne&#10;Aron&#10;Tony&#10;Marc&#10;Sarah\"></textarea><button class=\"btn2\" style=\"width:100%;margin-top:9px\" type=\"submit\">Ajouter toute la liste</button></form>" +
    "</div>" +
    "<div class=\"card span7\"><div class=\"section-title\"><h2>Paramètres de compétition</h2><span class=\"status\"><span class=\"dot " + esc(comp.status) + "\"></span>" + esc(comp.status) + "</span></div>" +
      "<div class=\"notice\"><b>Lien public du classement</b><br><span class=\"muted\">" + esc(origin + "/leaderboard/" + comp.id) + "</span><div style=\"margin-top:10px\"><button class=\"btn2 copy\" type=\"button\" data-link=\"" + esc(origin + "/leaderboard/" + comp.id) + "\">Copier le classement public</button></div></div>" +
      "<form method=\"post\" action=\"/api/competition/" + encodeURIComponent(comp.id) + "/status\" style=\"margin-top:12px\"><label>Changer le statut</label><div class=\"actions\"><select name=\"status\" style=\"max-width:190px\"><option value=\"active\"" + (comp.status==="active"?" selected":"") + ">Active</option><option value=\"paused\"" + (comp.status==="paused"?" selected":"") + ">En pause</option><option value=\"ended\"" + (comp.status==="ended"?" selected":"") + ">Terminée</option><option value=\"draft\"" + (comp.status==="draft"?" selected":"") + ">Brouillon</option></select><button class=\"btn\" type=\"submit\">Enregistrer</button><a class=\"btn2\" href=\"/api/competition/" + encodeURIComponent(comp.id) + "/export.csv\">Exporter CSV</a></div></form>" +
    "</div>";

  const body = topNav() +
    "<section class=\"hero\"><div class=\"eyebrow\">" + (publicMode ? "Classement public" : "Gestion de compétition") + "</div><h1>" + esc(comp.name) + "</h1><p>" +
      (comp.prize ? "Récompense : " + esc(comp.prize) + ". " : "") +
      "Le classement se met à jour automatiquement à partir de l’activité des liens participants.</p></section>" +
    "<div class=\"grid\">" +
      "<div class=\"card span3 stat\"><div class=\"label\">Participants</div><div class=\"num\" id=\"statParticipants\">" + totals.participants + "</div></div>" +
      "<div class=\"card span3 stat\"><div class=\"label\">Clics</div><div class=\"num\" id=\"statClicks\">" + totals.clicks + "</div></div>" +
      "<div class=\"card span3 stat\"><div class=\"label\">Uniques</div><div class=\"num\" id=\"statUnique\">" + totals.unique + "</div></div>" +
      "<div class=\"card span3 stat\"><div class=\"label\">En tête</div><div class=\"num\" id=\"statLeader\" style=\"font-size:20px\">" + esc(leader ? leader.name : "—") + "</div></div>" +
      "<div class=\"card span12\"><div class=\"section-title\"><h2>Position en temps réel</h2><div class=\"live\"><span class=\"pulse\"></span><span>actualisation toutes les 5 s</span><span id=\"updatedAt\"></span></div></div><div class=\"chart\" id=\"liveChart\">" + chartHtml(rows) + "</div></div>" +
      "<div class=\"card span12\"><div class=\"section-title\"><h2>Classement</h2><span class=\"small muted\">1er → dernier · score basé sur les visiteurs uniques</span></div><div class=\"table-wrap\"><table><thead><tr><th>#</th><th>Participant</th><th>Clics</th><th>Uniques</th><th>Taux unique</th><th>Lien</th>" + (publicMode ? "" : "<th>Action</th>") + "</tr></thead><tbody id=\"leaderboardBody\">" + leaderboardRowsHtml(rows, origin, comp, publicMode) + "</tbody></table></div></div>" +
      adminTools +
      "<div class=\"card span12\"><div class=\"notice\"><b>À savoir</b> — « Visiteurs uniques » mesure les personnes distinctes détectées sur le lien de suivi. WhatsApp ne fournit pas à ce tracker une confirmation automatique de l’adhésion au groupe. Pour une compétition basée sur les membres réellement rejoints, il faudra ajouter une étape de validation.</div></div>" +
    "</div>";

  const script =
    "const endpoint=" + JSON.stringify(endpoint) + ";" +
    "const origin=" + JSON.stringify(origin) + ";" +
    "const publicMode=" + JSON.stringify(publicMode) + ";" +
    "let previousRanks={};" +
    "document.addEventListener('click',async e=>{const b=e.target.closest('.copy');if(!b)return;const v=b.dataset.link;try{await navigator.clipboard.writeText(v);const old=b.textContent;b.textContent='Copié ✓';setTimeout(()=>b.textContent=old,1200)}catch{prompt('Copie ce lien :',v)}});" +
    "function el(t,c,txt){const x=document.createElement(t);if(c)x.className=c;if(txt!==undefined)x.textContent=txt;return x}" +
    "function render(data){" +
      "const rows=data.participants||[];document.getElementById('statParticipants').textContent=rows.length;document.getElementById('statClicks').textContent=data.totals.clicks;document.getElementById('statUnique').textContent=data.totals.unique;document.getElementById('statLeader').textContent=rows[0]?rows[0].name:'—';" +
      "const body=document.getElementById('leaderboardBody');body.textContent='';rows.forEach(r=>{const tr=document.createElement('tr');const old=previousRanks[r.code];" +
        "const tdRank=el('td','rank'+(r.rank===1?' one':''));tdRank.textContent=r.rank;if(old&&old!==r.rank){const d=el('span','delta '+(r.rank<old?'up':'down'),r.rank<old?'↑':'↓');tdRank.appendChild(d)}tr.appendChild(tdRank);" +
        "const tdP=el('td');tdP.appendChild(el('div','person',r.name));tdP.appendChild(el('div','code',r.code));tr.appendChild(tdP);" +
        "tr.appendChild(el('td','',String(r.clicks)));const u=el('td');u.appendChild(el('b','',String(r.unique)));tr.appendChild(u);tr.appendChild(el('td','',r.clicks?Math.round(r.unique/r.clicks*100)+'%':'0%'));" +
        "const tdL=el('td');const ac=el('div','actions');const cp=el('button','iconbtn copy','Copier');cp.type='button';cp.dataset.link=origin+r.link;const op=el('a','iconbtn','Ouvrir');op.href=origin+r.link;op.target='_blank';ac.append(cp,op);tdL.appendChild(ac);tr.appendChild(tdL);" +
        "if(!publicMode){const td=el('td');const f=document.createElement('form');f.method='post';f.action='/api/competition/'+encodeURIComponent(data.competition.id)+'/delete-participant';const i=document.createElement('input');i.type='hidden';i.name='code';i.value=r.code;const b=el('button','danger','Supprimer');b.type='submit';f.append(i,b);td.appendChild(f);tr.appendChild(td)}body.appendChild(tr)});" +
      "previousRanks=Object.fromEntries(rows.map(r=>[r.code,r.rank]));" +
      "const chart=document.getElementById('liveChart');chart.textContent='';const max=Math.max(1,...rows.map(r=>r.unique));if(!rows.length){chart.appendChild(el('div','empty','Le graphique apparaîtra dès les premiers clics.'))}else rows.forEach(r=>{const row=el('div','bar-row');row.title=r.name+' · '+r.unique+' visiteurs uniques';row.appendChild(el('div','bar-name',r.name));const track=el('div','track');const fill=el('div','fill');fill.style.width=Math.max(2,Math.round(r.unique/max*100))+'%';track.appendChild(fill);row.appendChild(track);row.appendChild(el('div','bar-value',String(r.unique)));chart.appendChild(row)});" +
      "document.getElementById('updatedAt').textContent='· '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});" +
    "}" +
    "async function refresh(){try{const r=await fetch(endpoint,{cache:'no-store'});if(r.ok)render(await r.json())}catch{}}" +
    "document.querySelectorAll('.copy').forEach(()=>{});setInterval(refresh,5000);setTimeout(refresh,900);";

  return pageShell(comp.name + " — Classement", body, script);
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
      const id = decodeURIComponent(path.slice(2));
      const comp = await findCompetition(id);
      if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");
      return send(res, 200, await competitionPage(origin, comp, false));
    }

    if (path.startsWith("leaderboard/")) {
      const id = decodeURIComponent(path.slice("leaderboard/".length));
      const comp = await findCompetition(id);
      if (!comp) return send(res, 404, "Compétition introuvable", "text/plain; charset=utf-8");
      return send(res, 200, await competitionPage(origin, comp, true));
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
        return redirect(res, "/c/" + encodeURIComponent(id), 303);
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
        return redirect(res, "/c/" + encodeURIComponent(id), 303);
      }

      if (action === "delete-participant" && req.method === "POST") {
        const b = parseBody(req);
        const code = String(b.code || "");
        const participants = (await getParticipants(id)).filter(p=>p.code!==code);
        await saveParticipants(id, participants);
        await redis(["DEL", statsKey(id, code)]);
        return redirect(res, "/c/" + encodeURIComponent(id), 303);
      }

      if (action === "status" && req.method === "POST") {
        const b = parseBody(req);
        const status = String(b.status || "");
        const allowed = ["active","paused","ended","draft"];
        if (!allowed.includes(status)) return send(res, 400, "Statut invalide", "text/plain; charset=utf-8");
        const comps = await getCompetitions();
        const i = comps.findIndex(c=>c.id===id);
        comps[i].status = status;
        await saveCompetitions(comps);
        return redirect(res, "/c/" + encodeURIComponent(id), 303);
      }

      if (action === "export.csv" && req.method === "GET") {
        const rows = await getRankedParticipants(comp);
        const csv = [
          ["Rang","Participant","Code","Clics","Visiteurs uniques","Lien"],
          ...rows.map(r=>[r.rank,r.name,r.code,r.clicks,r.unique,origin+r.link])
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
