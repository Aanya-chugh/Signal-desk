// Vercel function: write ad copy OR a short video script with Groq. ADMIN only.
// Set in Vercel: AUTH_SECRET, GROQ_API_KEY
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const p = verify(getToken(req), process.env.AUTH_SECRET);
  if (!p) return res.status(401).json({ error: "unauthorized" });
  if (p.role !== "admin") return res.status(403).json({ error: "Viewer access can't generate — ask an admin for the admin key." });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(400).json({ error: "GROQ_API_KEY not set in Vercel env" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const a = body.article || {};
    const niche = body.niche || "Home Insurance";
    const mode = body.mode === "script" ? "script" : "copy";
    const sens = a.sensitive
      ? " NOTE: this story is sensitive/tragic, so be respectful, lead with empathy, and do not trivialize it."
      : "";

    let prompt, max_tokens;
    if (mode === "script") {
      prompt =
        `You are an award-winning US creative director writing a SHOOTABLE 20-30 second video ad script for a ${niche} brand.\n` +
        `Trending story:\nTITLE: "${a.title || ""}"\nTOPIC: ${a.category || ""}\n\n` +
        `Newsjack this story to promote ${niche} to a US audience. The bridge must feel natural and tasteful, never forced or exploitative.${sens}\n` +
        `Write a real production-ready script: a creative concept, who is on camera, what they actually SAY (real spoken lines), what we SEE (visual/action direction), and on-screen captions.\n` +
        `Return ONLY valid JSON, no markdown:\n` +
        `{"concept":"one punchy sentence describing the creative idea","format":"e.g. UGC selfie-video / talking-head / mini-skit","talent":"who is on camera, e.g. a relatable homeowner in their 30s","scenes":[{"time":"0-3s","visual":"what the camera shows and any action","line":"the exact words the person says on camera or in voiceover","onscreen":"on-screen caption text"}],"cta":"the final spoken + on-screen call to action"}\n` +
        `Use 3 to 4 scenes that tell a clear mini story: problem -> turn -> payoff.`;
      max_tokens = 750;
    } else {
      prompt =
        `You are a senior US direct-response copywriter for a ${niche} brand.\n` +
        `Trending story:\nTITLE: "${a.title || ""}"\nSOURCE: ${a.source || a.domain || ""}\n` +
        `TOPIC: ${a.category || ""}\n\nWrite ONE scroll-stopping social ad that newsjacks this story ` +
        `to promote ${niche} to a US audience. The bridge must feel natural and tasteful, never forced ` +
        `or exploitative.${sens}\nReturn ONLY valid JSON, no markdown:\n` +
        `{"headline":"<=8 words, punchy","description":"1-2 sentences, <=30 words, ends with a soft CTA"}`;
      max_tokens = 300;
    }

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", temperature: 0.9, max_tokens,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const txt = data?.choices?.[0]?.message?.content || "{}";
    const obj = JSON.parse(txt);

    if (mode === "script")
      return res.status(200).json({ niche, mode, script: obj });
    return res.status(200).json({ niche, mode, headline: obj.headline || "", description: obj.description || "" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
