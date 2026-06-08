// Vercel function: returns the article list — but only to a logged-in token.
// The Supabase SERVICE key lives here, server-side; the browser never sees it.
// Set in Vercel: AUTH_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
import crypto from "crypto";

function verify(token, secret) {
  if (!token || !secret || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (sig !== expect) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch (e) { return null; }
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}
function getToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const p = verify(getToken(req), process.env.AUTH_SECRET);
  if (!p) return res.status(401).json({ error: "unauthorized" });

  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const skey = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !skey) return res.status(500).json({ error: "Supabase not configured in Vercel env" });

  try {
    const r = await fetch(
      base + "/rest/v1/articles?select=*&order=virality_score.desc&limit=500",
      { headers: { apikey: skey, Authorization: "Bearer " + skey } }
    );
    const rows = await r.json();
    return res.status(200).json({ role: p.role, rows: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
