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
        `You are an award-winning US creative director writing a SHOOTABLE 15-second social VIDEO AD for a ${niche} brand.\n` +
        `Trending story:\nTITLE: "${a.title || ""}"\nTOPIC: ${a.category || ""}\n\n` +
        `Newsjack this story to promote ${niche} to a US audience — natural and tasteful, never forced or exploitative.${sens}\n` +
        `Write a real shot list: a one-line creative concept, then exactly 4 scenes covering 0-15 seconds. ` +
        `Each scene needs a time range, what the camera SHOWS (visual/action), a spoken VOICEOVER line, and the on-screen TEXT overlay (short, punchy).\n` +
        `Return ONLY valid JSON, no markdown. Every value must be a plain string:\n` +
        `{"concept":"one punchy sentence","scenes":[{"scene":"Scene 1","time":"0-4 sec","visual":"what we see / action","voiceover":"the spoken line","onscreen":"on-screen text overlay"}],"cta":"button label, e.g. Learn More or Get a Quote"}\n` +
        `Use exactly 4 scenes telling a clear mini story: hook -> reveal -> payoff -> brand + CTA.`;
      max_tokens = 800;
    } else {
      prompt =
        `You are a senior US direct-response copywriter for a ${niche} brand creating a Facebook/Instagram IMAGE AD.\n` +
        `Trending story:\nTITLE: "${a.title || ""}"\nSOURCE: ${a.source || a.domain || ""}\nTOPIC: ${a.category || ""}\n\n` +
        `Newsjack this story to promote ${niche} to a US audience — natural and tasteful, never forced or exploitative.${sens}\n` +
        `Return ONLY valid JSON, no markdown. Every value a plain string; points is an array of exactly 3 short strings:\n` +
        `{"headline":"<=8 words, punchy, may begin with one emoji","body":"2-3 short sentences of primary ad text","points":["short benefit","short benefit","short benefit"],"cta":"button label, e.g. Learn More or Get a Quote"}`;
      max_tokens = 380;
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
    return res.status(200).json({
      niche, mode,
      headline: obj.headline || "",
      body: obj.body || obj.description || "",
      points: Array.isArray(obj.points) ? obj.points : [],
      cta: obj.cta || "Learn More",
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
