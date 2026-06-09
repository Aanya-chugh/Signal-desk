// /api/image — generate a niche-themed ad IMAGE.
// Uses Pollinations' CURRENT endpoint: https://gen.pollinations.ai/image/{prompt}?model=flux
// (Flux is free + unlimited.) Fetched SERVER-SIDE so the viewer's network is never involved;
// we hand the browser a finished image as a data URL.
// Admin-only. Env: AUTH_SECRET (required), POLLINATIONS_KEY (optional but recommended).

import crypto from "crypto";

export const maxDuration = 60;

const MODEL = "flux"; // free + unlimited on Pollinations

// Per-niche art direction. No text/logos/faces so it's clean ad-ready imagery.
const SCENES = {
  "Home Insurance":
    "a warm, sunlit modern suburban family home exterior at golden hour, neat green lawn, protective cozy feeling, soft natural light",
  "Refinance":
    "a bright modern living room interior with a happy sense of financial relief, sunlight through large windows, plants, calm and aspirational",
  "Home Services":
    "a clean modern kitchen and home interior freshly maintained, bright and tidy, subtle tools neatly arranged, professional and inviting",
};

function verify(token, secret) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (sig !== expect) return null;
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function cors(res) {
  const site = process.env.SITE_URL || "*";
  res.setHeader("Access-Control-Allow-Origin", site);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.AUTH_SECRET;
  if (!secret) return res.status(500).json({ error: "Server missing AUTH_SECRET" });

  const claims = verify(getToken(req), secret);
  if (!claims) return res.status(401).json({ error: "Not signed in" });
  if (claims.role !== "admin") return res.status(403).json({ error: "Admin only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const niche = (body && body.niche) || "Home Insurance";
  const scene = SCENES[niche] || SCENES["Home Insurance"];

  const prompt =
    "Professional advertising photograph: " + scene +
    ". Clean modern commercial style, high detail, photorealistic. " +
    "No text, no words, no letters, no logos, no watermarks, no recognizable real faces.";

  const seed = Math.floor(Math.random() * 1e9);
  const url =
    "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt) +
    "?model=" + MODEL + "&width=1024&height=1024&seed=" + seed;

  const headers = { Accept: "image/*" };
  const key = process.env.POLLINATIONS_KEY;
  if (key) headers.Authorization = "Bearer " + key; // optional; reliable + no rate limit with a secret key

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 50000);
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);

    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.startsWith("image/")) {
      const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
      return res.status(200).json({
        niche,
        source: "pollinations-flux",
        image: "data:" + ct + ";base64," + b64,
      });
    }

    // Surface Pollinations' real response so any failure is diagnosable.
    const detail = await r.text().catch(() => "");
    return res.status(502).json({
      error: "Pollinations " + r.status + ": " + (detail || "(no body)").slice(0, 200),
    });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "timed out after 50s" : String((e && e.message) || e);
    return res.status(502).json({ error: "Pollinations request failed: " + msg.slice(0, 200) });
  }
}
