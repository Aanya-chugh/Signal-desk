// Vercel function: generate a niche-themed ad IMAGE. ADMIN only.
// Tries Hugging Face first (higher quality, needs free HF_TOKEN); if that's
// unavailable it falls back to Pollinations (keyless), so images always work.
// Set in Vercel: AUTH_SECRET, and (optional but recommended) HF_TOKEN
import crypto from "crypto";

export const maxDuration = 60; // give image generation room to finish

// If HF ever rejects this model on your free token, just change this one line
// to another text-to-image model id, e.g. "stabilityai/stable-diffusion-xl-base-1.0".
const HF_MODEL = "black-forest-labs/FLUX.1-schnell";

const SCENES = {
  "Home Insurance": "a warm, well-protected modern suburban family home at golden hour, strong sense of safety and security, soft cinematic light",
  "Refinance": "a relieved homeowner reviewing finances at a bright modern kitchen table, sense of savings and relief, clean editorial light",
  "Home Services": "a freshly renovated, spotless modern home interior with a neatly arranged tool kit, sense of quality craftsmanship, bright natural light",
};

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}
function pollinations(prompt) {
  const seed = Math.floor(Math.random() * 1e9);
  return "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    "?width=768&height=768&nologo=true&seed=" + seed;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const p = verify(getToken(req), process.env.AUTH_SECRET);
  if (!p) return res.status(401).json({ error: "unauthorized" });
  if (p.role !== "admin") return res.status(403).json({ error: "Viewer access can't generate — ask an admin for the admin key." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const niche = SCENES[body.niche] ? body.niche : "Home Insurance";
  const styles = ["premium advertising photography", "clean commercial poster style", "modern lifestyle brand photo", "bright editorial ad photography"];
  const style = styles[Math.floor(Math.random() * styles.length)];
  const prompt = `${SCENES[niche]}, ${style}, high detail, professional color grading. ` +
    `No text, no words, no logos, no watermarks, no real recognizable faces.`;

  const hf = process.env.HF_TOKEN;
  if (hf) {
    try {
      const r = await fetch("https://api-inference.huggingface.co/models/" + HF_MODEL, {
        method: "POST",
        headers: { Authorization: "Bearer " + hf, "Content-Type": "application/json", Accept: "image/png" },
        body: JSON.stringify({ inputs: prompt, parameters: { num_inference_steps: 4 } }),
      });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.startsWith("image/")) {
        const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
        return res.status(200).json({ niche, source: "huggingface", image: "data:" + ct + ";base64," + b64 });
      }
      // HF returned JSON (loading / error) -> fall through to Pollinations
    } catch (e) { /* fall through */ }
  }

  // Fallback: fetch from keyless Pollinations server-side and return the actual
  // image bytes as a data URL, so the browser always gets a ready-to-render image
  // (no slow/blank client-side load).
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const r = await fetch(pollinations(prompt), { signal: ctrl.signal });
    clearTimeout(timer);
    const ct = r.headers.get("content-type") || "image/jpeg";
    if (r.ok && ct.startsWith("image/")) {
      const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
      return res.status(200).json({ niche, source: "pollinations", image: "data:" + ct + ";base64," + b64 });
    }
    return res.status(502).json({ error: "Image service was busy — tap Regenerate to try again." });
  } catch (e) {
    return res.status(502).json({ error: "Image timed out — tap Regenerate to try again." });
  }
}
