import { createHash } from "node:crypto";

const WA_DEFAULT = "https://chat.whatsapp.com/GYyW35sRFnK48pLdCQGMdv?mode=gi_t";
const STATE_KEY = "competition:state";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
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

  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || ("Redis HTTP " + response.status));
  }
  return data.result;
}

async function getState() {
  try {
    const value = await redis(["GET", STATE_KEY]);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("getState:", error.message);
    return [];
  }
}

async function setState(state) {
  await redis(["SET", STATE_KEY, JSON.stringify(state)]);
}

async function markUnique(code, req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const ua = String(req.headers["user-agent"] || "");
  const day = new Date().toISOString().slice(0, 10);
  const fingerprint = createHash("sha256")
    .update(code + "|" + day + "|" + forwarded + "|" + ua)
    .digest("hex");
  const result = await redis(["SET", "unique:" + fingerprint, "1", "EX", 172800, "NX"]);
  return result === "OK";
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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    const params = new URLSearchParams(req.body);
    return Object.fromEntries(params.entries());
  }
  return {};
}

export default async function handler(req, res) {
  try {
    const rawPath = req.query && req.query.path;
    const path = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");
    const origin = "https://" + req.headers.host;
    const cfg = storageConfig();

    if (path === "api/health") {
      return send(res, 200, JSON.stringify({
        ok: true,
        storageConfigured: Boolean(cfg.url && cfg.token),
        provider: process.env.KV_REST_API_URL ? "vercel-kv/upstash" : (process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "none")
      }), "application/json; charset=utf-8");
    }

    if (path.startsWith("r/")) {
      const code = decodeURIComponent(path.slice(2));
      const participants = await getState();
      const index = participants.findIndex((p) => p.code === code && p.active !== false);
      if (index < 0) return send(res, 404, "Lien inconnu", "text/plain; charset=utf-8");

      participants[index].clicks = (participants[index].clicks || 0) + 1;
      if (await markUnique(code, req)) {
        participants[index].unique = (participants[index].unique || 0) + 1;
      }
      await setState(participants);
      return redirect(res, participants[index].destination || WA_DEFAULT);
    }

    if (path === "api/add" && req.method === "POST") {
      if (!cfg.url || !cfg.token) return send(res, 503, "Stockage Upstash non configuré.", "text/plain; charset=utf-8");

      const body = parseBody(req);
      const name = String(body.name || "").trim();
      const code = String(body.code || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const destination = String(body.destination || WA_DEFAULT).trim();

      if (!name || !code) return send(res, 400, "Nom/code requis", "text/plain; charset=utf-8");

      const participants = await getState();
      if (participants.some((p) => p.code === code)) {
        return send(res, 409, "Code déjà utilisé", "text/plain; charset=utf-8");
      }

      participants.push({ name, code, destination, clicks: 0, unique: 0, active: true });
      await setState(participants);
      return redirect(res, "/admin", 303);
    }

    if (path === "api/delete" && req.method === "POST") {
      if (!cfg.url || !cfg.token) return send(res, 503, "Stockage Upstash non configuré.", "text/plain; charset=utf-8");

      const body = parseBody(req);
      const code = String(body.code || "");
      const participants = (await getState()).filter((p) => p.code !== code);
      await setState(participants);
      return redirect(res, "/admin", 303);
    }

    if (path === "api/stats") {
      return send(res, 200, JSON.stringify(await getState()), "application/json; charset=utf-8");
    }

    if (path === "" || path === "admin") {
      const configured = Boolean(cfg.url && cfg.token);
      const participants = (await getState()).sort((a, b) => (b.unique || 0) - (a.unique || 0));

      const rows = participants.map((p, i) =>
        "<tr>" +
          "<td>" + (i + 1) + "</td>" +
          "<td>" + esc(p.name) + "</td>" +
          "<td><code>" + esc(origin + "/r/" + p.code) + "</code></td>" +
          "<td>" + (p.clicks || 0) + "</td>" +
          "<td><b>" + (p.unique || 0) + "</b></td>" +
          "<td><form method=\"post\" action=\"/api/delete\">" +
            "<input type=\"hidden\" name=\"code\" value=\"" + esc(p.code) + "\">" +
            "<button type=\"submit\">Supprimer</button>" +
          "</form></td>" +
        "</tr>"
      ).join("");

      const warning = configured ? "" :
        "<p class=\"warn\">⚠️ Stockage Upstash non détecté. Vérifie la connexion de la base au projet Vercel puis redéploie.</p>";

      const html = "<!doctype html>" +
        "<html lang=\"fr\"><head><meta charset=\"utf-8\">" +
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<title>Competition Tracker</title>" +
        "<style>" +
        "body{font-family:system-ui,-apple-system,sans-serif;max-width:1000px;margin:30px auto;padding:0 16px;background:#f5f7fb;color:#111}" +
        "main{background:#fff;padding:24px;border-radius:18px;box-shadow:0 8px 30px #0001}" +
        "input,button{padding:11px;margin:4px;border:1px solid #ddd;border-radius:9px}button{font-weight:700;cursor:pointer}" +
        "table{width:100%;border-collapse:collapse;margin-top:18px}td,th{padding:10px;border-bottom:1px solid #eee;text-align:left}" +
        "code{word-break:break-all}.warn{padding:12px;background:#fff3cd;border-radius:10px}.ok{color:#087f23}" +
        "@media(max-width:700px){table{font-size:13px}main{padding:14px}input{width:calc(100% - 30px)}}" +
        "</style></head><body><main>" +
        "<h1>🏆 Competition Link Tracker</h1>" +
        warning +
        (configured ? "<p class=\"ok\">● Stockage connecté</p>" : "") +
        "<p>Ajoute autant de participants que nécessaire. Le classement utilise les visiteurs uniques détectés sur chaque lien.</p>" +
        "<form method=\"post\" action=\"/api/add\">" +
          "<input name=\"name\" placeholder=\"Nom du participant\" required>" +
          "<input name=\"code\" placeholder=\"Code : p1, tonny...\" required>" +
          "<input name=\"destination\" style=\"min-width:320px\" value=\"" + esc(WA_DEFAULT) + "\" required>" +
          "<button type=\"submit\">+ Créer le lien</button>" +
        "</form>" +
        "<table><thead><tr><th>#</th><th>Participant</th><th>Lien</th><th>Clics</th><th>Uniques</th><th></th></tr></thead>" +
        "<tbody>" + (rows || "<tr><td colspan=\"6\">Aucun participant.</td></tr>") + "</tbody></table>" +
        "</main></body></html>";

      return send(res, 200, html);
    }

    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    console.error("handler:", error);
    return send(res, 500, "Erreur interne : " + error.message, "text/plain; charset=utf-8");
  }
}