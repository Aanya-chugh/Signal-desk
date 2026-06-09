// Vercel function: generate a niche-themed ad IMAGE via Google's Gemini image
// model (gemini-2.5-flash-image, "Nano Banana"). ADMIN only.
// Set in Vercel: AUTH_SECRET, GEMINI_API_KEY (free key from aistudio.google.com).
import crypto from "crypto";

export const maxDuration = 60; // give image generation room to finish

// If you ever want a different image model, change this one line.
const GEMINI_MODEL = "gemini-2.5-flash-image";

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

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const p = verify(getToken(req), process.env.AUTH_SECRET);
  if (!p) return res.status(401).json({ error: "unauthorized" });
  if (p.role !== "admin") return res.status(403).json({ error: "Viewer access can't generate — ask an admin for the admin key." });

  const gkey = process.env.GEMINI_API_KEY;
  if (!gkey) return res.status(400).json({ error: "Set GEMINI_API_KEY in Vercel (free key from aistudio.google.com)." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const niche = SCENES[body.niche] ? body.niche : "Home Insurance";
  const prompt = `Professional advertising photo: ${SCENES[niche]}. Clean modern commercial style, high detail. ` +
    `No text, no words, no logos, no watermarks, no real recognizable faces.`;

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gkey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const data = await r.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const part = parts.find((x) => (x.inlineData && x.inlineData.data) || (x.inline_data && x.inline_data.data));
    const inline = part && (part.inlineData || part.inline_data);
    if (inline && inline.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      return res.status(200).json({ niche, source: "gemini", image: "data:" + mime + ";base64," + inline.data });
    }
    const msg = (data && data.error && data.error.message) || "Gemini returned no image (check the model name or your key's image access).";
    return res.status(502).json({ error: "Gemini: " + String(msg).slice(0, 200) });
  } catch (e) {
    return res.status(502).json({ error: "Gemini error: " + String(e.message || e).slice(0, 200) });
  }
}
