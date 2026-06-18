// /api/image — generate an ad IMAGE. First success wins, in this order:
//   1) Google Gemini / Nano Banana  (best; needs a BILLING-ENABLED GEMINI_API_KEY)
//   2) Pollinations GPT-Image        (free fallback)
//   3) Pollinations Flux             (free final fallback / catches Gemini safety blocks)
// Fetched SERVER-SIDE and returned as a base64 data URL so the browser can draw it on a <canvas>.
// Admin-only. Env: AUTH_SECRET (req), GEMINI_API_KEY (org paid key), GEMINI_IMAGE_MODEL (optional,
//   default gemini-2.5-flash-image = Nano Banana), POLLINATIONS_KEY (req), IMAGE_MODEL (optional).

import crypto from "crypto";

export const maxDuration = 60;

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image"; // Nano Banana
const POLLI_PRIMARY = process.env.IMAGE_MODEL || "gptimage";
const POLLI_FALLBACK = "flux";

const SCENES = {
  "Home Insurance": "a warm, well-protected modern suburban family home at golden hour, strong sense of safety, soft cinematic light",
  "Medicare": "a happy healthy senior couple smiling outdoors in a sunny park, warm and reassuring, vibrant healthcare lifestyle feel",
  "Refinance": "a relieved homeowner at a bright modern kitchen table, sense of savings and financial relief, clean editorial light",
  "Memory Loss Supplements": "a calm, sharp older adult enjoying a crossword and morning coffee by a sunlit window, brain-healthy wellness mood",
  "Weight Loss Supplements": "a bright fresh wellness flat-lay with colorful fruit, a measuring tape and a glass of water, energetic and healthy",
  "Bathroom Services": "a sparkling newly renovated modern bathroom with a walk-in glass shower and clean tile, bright natural light, spotless",
  "Gun Permits": "a clean professional indoor shooting range, safety gear neatly arranged, responsible lawful tone, no violence",
  "Bizops": "an aspirational bright modern home office with a laptop, coffee and a sunlit window, sense of freedom and opportunity, motivating",
  "Window Services": "a bright modern living room with large new energy-efficient windows and sunlight streaming in, clean and airy",
  "Auto Insurance": "a clean modern car on an open scenic road at golden hour, sense of safety and freedom, polished automotive look",
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
  } catch { return null; }
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

  // 1) Gemini / Nano Banana (best, org paid key).
  const gem = await geminiImage(prompt);
  if (gem.image) return res.status(200).json({ niche, source: "gemini:" + GEMINI_MODEL, image: gem.image });

  // 2) Pollinations GPT-Image (free fallback).
  const primary = await pollImage(prompt, POLLI_PRIMARY);
  if (primary.image) return res.status(200).json({ niche, source: "pollinations-" + POLLI_PRIMARY, image: primary.image, note: gem.error || "" });

  // 3) Pollinations Flux (free final fallback).
  const fx = await pollImage(prompt, POLLI_FALLBACK);
  if (fx.image) return res.status(200).json({ niche, source: "pollinations-" + POLLI_FALLBACK, image: fx.image, note: gem.error || primary.error || "" });
  return res.status(502).json({ error: fx.error || "image generation failed", note: gem.error || "" });
}

// Google Gemini image generation. Returns { image } on success or { error } explaining the fallback.
async function geminiImage(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "no GEMINI_API_KEY set" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: ctrl.signal,
      });
    clearTimeout(timer);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { error: GEMINI_MODEL + " HTTP " + r.status + ": " + (t || "").slice(0, 180) };
    }
    const j = await r.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    for (const p of parts) {
      if (p && p.inlineData && p.inlineData.data) {
        return { image: "data:" + (p.inlineData.mimeType || "image/png") + ";base64," + p.inlineData.data };
      }
    }
    const said = parts.map((p) => p && p.text).filter(Boolean).join(" ").slice(0, 140);
    return { error: GEMINI_MODEL + " returned no image" + (said ? " (said: " + said + ")" : "") };
  } catch (e) {
    clearTimeout(timer);
    return { error: GEMINI_MODEL + " request failed: " + String((e && e.message) || e).slice(0, 160) };
  }
}

// Pollinations image generation for a given model. Returns { image } or { error }.
async function pollImage(prompt, model) {
  const seed = Math.floor(Math.random() * 1e9);
  const url =
    "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt) +
    "?model=" + encodeURIComponent(model) + "&width=1024&height=1024&seed=" + seed;
  const headers = { Accept: "image/*" };
  const key = process.env.POLLINATIONS_KEY;
  if (key) headers.Authorization = "Bearer " + key;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 48000);
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.startsWith("image/")) {
      const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
      return { image: "data:" + ct + ";base64," + b64 };
    }
    const detail = await r.text().catch(() => "");
    return { error: model + " HTTP " + r.status + ": " + (detail || "(no body)").slice(0, 160) };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "timed out" : String((e && e.message) || e);
    return { error: model + " request failed: " + msg.slice(0, 160) };
  }
}
