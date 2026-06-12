// /api/image — generate an ad IMAGE via Pollinations' current endpoint (Flux, free + unlimited).
// Fetched SERVER-SIDE and returned as a base64 data URL, so the viewer's network is never involved
// and the browser can safely draw it onto a <canvas> (for poster ads) without tainting it.
// Admin-only. Env: AUTH_SECRET (required), POLLINATIONS_KEY (recommended, free from enter.pollinations.ai).
//
// Body: { niche, prompt?, headline? }
//   - prompt   : a topic-aware scene from /api/generate (preferred). If present, it drives the image.
//   - niche    : used to pick fallback art direction when no prompt is given.
//   - headline : optional story headline, lightly used to flavor the fallback.

import crypto from "crypto";

export const maxDuration = 60;

const MODEL = "flux"; // free + unlimited on Pollinations

// Fallback art direction per niche (used only when no LLM prompt is supplied).
const SCENES = {
  "Home Insurance":
    "a warm, well-protected modern suburban family home at golden hour, strong sense of safety and security, soft cinematic light",
  "Medicare":
    "a happy healthy senior couple smiling outdoors in a sunny park, warm and reassuring, vibrant healthcare lifestyle feel",
  "Refinance":
    "a relieved homeowner at a bright modern kitchen table with a sense of savings and financial relief, clean editorial light",
  "Memory Loss Supplements":
    "a calm, sharp older adult enjoying a crossword and morning coffee by a sunlit window, fresh and clear, brain-healthy wellness mood",
  "Weight Loss Supplements":
    "a bright fresh wellness flat-lay with colorful fruit, a measuring tape and a glass of water on a clean surface, energetic and healthy",
  "Bathroom Services":
    "a sparkling newly renovated modern bathroom with a walk-in glass shower and clean tile, bright natural light, premium and spotless",
  "Gun Permits":
    "a clean professional indoor shooting range, safety gear neatly arranged, responsible and lawful tone, subtle American flag accent, no violence",
  "Bizops":
    "an aspirational work-from-home scene: a bright modern home office with a laptop, coffee and a sunlit window, sense of freedom, opportunity and independence, clean and motivating",
  "Window Services":
    "a bright modern living room with large beautiful new energy-efficient windows and sunlight streaming in, clean and airy",
  "Auto Insurance":
    "a clean modern car on an open scenic road at golden hour, sense of safety and freedom, polished commercial automotive look",
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
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || "*");
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
  body = body || {};
  const niche = body.niche || "Home Insurance";

  // Prefer the topic-aware prompt from /api/generate; otherwise fall back to niche art direction.
  let scene = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!scene) {
    scene = SCENES[niche] || SCENES["Home Insurance"];
    const hl = typeof body.headline === "string" ? body.headline.trim() : "";
    if (hl) scene += ", subtly evoking the mood of current news without showing any text";
  }

  const prompt =
    "Professional advertising photograph. " + scene +
    ". Photorealistic, clean modern commercial advertising style, high detail. " +
    "No text, no words, no letters, no numbers, no logos, no watermarks, no recognizable real faces.";

  const seed = Math.floor(Math.random() * 1e9);
  const url =
    "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt) +
    "?model=" + MODEL + "&width=1024&height=1024&seed=" + seed;

  const headers = { Accept: "image/*" };
  const key = process.env.POLLINATIONS_KEY;
  if (key) headers.Authorization = "Bearer " + key;

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

    const detail = await r.text().catch(() => "");
    return res.status(502).json({
      error: "Pollinations " + r.status + ": " + (detail || "(no body)").slice(0, 200),
    });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "timed out after 50s" : String((e && e.message) || e);
    return res.status(502).json({ error: "Pollinations request failed: " + msg.slice(0, 200) });
  }
}
