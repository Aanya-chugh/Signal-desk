// /api/image — generate an ad IMAGE via Pollinations (free tier, your existing POLLINATIONS_KEY).
// Tries a higher-adherence model first (default: gptimage = OpenAI GPT-Image, free-tier usable),
// then falls back to Flux. Both are free on the seed tier — no billing required.
// Fetched SERVER-SIDE and returned as a base64 data URL so the browser can draw it on a <canvas>.
// Admin-only. Env: AUTH_SECRET (required), POLLINATIONS_KEY (required), IMAGE_MODEL (optional override).
//
// Body: { niche, prompt?, headline? }
//   - prompt : a topic-aware scene from /api/generate (preferred). If present, it drives the image.
//   - niche  : used to pick fallback art direction when no prompt is given.

import crypto from "crypto";

export const maxDuration = 60;

const PRIMARY = process.env.IMAGE_MODEL || "gptimage"; // free-tier, strong prompt adherence
const FALLBACK = "flux";                                // always available on the free tier

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

  // 1) Primary model (default gptimage — better adherence, free tier).
  const primary = await pollImage(prompt, PRIMARY);
  if (primary.image) return res.status(200).json({ niche, source: "pollinations-" + PRIMARY, image: primary.image });

  // 2) Fallback to Flux (always free).
  if (PRIMARY !== FALLBACK) {
    const fx = await pollImage(prompt, FALLBACK);
    if (fx.image) return res.status(200).json({ niche, source: "pollinations-" + FALLBACK, image: fx.image, note: primary.error || "" });
    return res.status(502).json({ error: fx.error || "image generation failed", note: primary.error || "" });
  }
  return res.status(502).json({ error: primary.error || "image generation failed" });
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
    return { error: model + " HTTP " + r.status + ": " + (detail || "(no body)").slice(0, 180) };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "timed out" : String((e && e.message) || e);
    return { error: model + " request failed: " + msg.slice(0, 180) };
  }
}
