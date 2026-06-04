// Vercel serverless function — keeps your Groq key server-side.
// Set GROQ_API_KEY in Vercel: Project Settings -> Environment Variables.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(400).json({ error: "GROQ_API_KEY not set in Vercel env" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const a = body.article || {};
    const niche = body.niche || "Home Insurance";
    const sens = a.sensitive
      ? " NOTE: this story is sensitive/tragic, so be respectful, lead with empathy, and do not trivialize it."
      : "";
    const prompt =
      `You are a senior US direct-response copywriter for a ${niche} brand.\n` +
      `Trending story:\nTITLE: "${a.title || ""}"\nSOURCE: ${a.source || a.domain || ""}\n` +
      `TOPIC: ${a.category || ""}\n\nWrite ONE scroll-stopping social ad that newsjacks this story ` +
      `to promote ${niche} to a US audience. The bridge must feel natural and tasteful, never forced ` +
      `or exploitative.${sens}\nReturn ONLY valid JSON, no markdown:\n` +
      `{"headline":"<=8 words, punchy","description":"1-2 sentences, <=30 words, ends with a soft CTA"}`;
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", temperature: 0.9, max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const txt = data?.choices?.[0]?.message?.content || "{}";
    const ad = JSON.parse(txt);
    return res.status(200).json({ niche, headline: ad.headline || "", description: ad.description || "" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
