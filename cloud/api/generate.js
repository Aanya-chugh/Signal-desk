// Vercel function: write ad copy / video script / image-ad poster text / image prompt with Groq. ADMIN only.
// Set in Vercel: AUTH_SECRET, GROQ_API_KEY
import crypto from "crypto";

// Short audience/angle hints so copy lands for each vertical.
const NICHE_HINTS = {
  "Home Insurance": "US homeowners who want to protect their property and lower their premiums",
  "Medicare": "US seniors 65+ comparing Medicare / Medicare Advantage plans and benefits",
  "Refinance": "US homeowners who want to lower their mortgage rate or monthly payment",
  "Memory Loss Supplements": "older US adults who want sharper memory and focus — wellness framing only, never claim to treat or cure any disease",
  "Weight Loss Supplements": "US adults trying to lose weight — wellness framing only, no medical guarantees or specific pound/lbs promises",
  "Bathroom Services": "US homeowners who want a bathroom remodel, walk-in shower, or repair",
  "Gun Permits": "lawful US adults seeking concealed-carry permits and firearm training — responsible, safety-first, respectful tone",
  "Bizops": "US adults looking for a business opportunity, side income, or work-from-home / make-money venture — aspirational and motivating, but NO income guarantees, earnings claims, or get-rich-quick promises",
  "Window Services": "US homeowners who want new or replacement windows — energy savings and curb appeal",
  "Auto Insurance": "US drivers who want to save on car insurance",
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

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(400).json({ error: "GROQ_API_KEY not set in Vercel env" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const a = body.article || {};
    const niche = body.niche || "Home Insurance";
    const hint = NICHE_HINTS[niche] || ("US customers interested in " + niche);
    const mode =
      body.mode === "script" ? "script" :
      body.mode === "imagead" ? "imagead" :
      body.mode === "imgprompt" ? "imgprompt" :
      body.mode === "adset" ? "adset" : "copy";
    const sens = a.sensitive
      ? " NOTE: this story is sensitive/tragic, so be respectful, lead with empathy, and never trivialize or exploit it."
      : "";
    const story = `TITLE: "${a.title || ""}"\nSOURCE: ${a.source || a.domain || ""}\nTOPIC: ${a.category || ""}`;

    let prompt, max_tokens;
    if (mode === "script") {
      prompt =
        `You are an award-winning US creative director writing a SHOOTABLE 15-second social VIDEO AD for a ${niche} brand.\n` +
        `Audience: ${hint}.\nTrending story:\n${story}\n\n` +
        `Newsjack this story to promote ${niche} — natural and tasteful, never forced or exploitative.${sens}\n` +
        `Write a real shot list: a one-line creative concept, then exactly 4 scenes covering 0-15 seconds. ` +
        `Each scene needs a time range, what the camera SHOWS (visual/action), a spoken VOICEOVER line, and the on-screen TEXT overlay (short, punchy).\n` +
        `Return ONLY valid JSON, no markdown. Every value must be a plain string:\n` +
        `{"concept":"one punchy sentence","scenes":[{"scene":"Scene 1","time":"0-4 sec","visual":"what we see / action","voiceover":"the spoken line","onscreen":"on-screen text overlay"}],"cta":"button label, e.g. Learn More or Get a Quote"}\n` +
        `Use exactly 4 scenes telling a clear mini story: hook -> reveal -> payoff -> brand + CTA.`;
      max_tokens = 800;
    } else if (mode === "imagead") {
      prompt =
        `You are a senior US direct-response creative making a Facebook/Instagram IMAGE AD (a poster) for a ${niche} brand.\n` +
        `Audience: ${hint}.\nTrending story:\n${story}\n\n` +
        `Newsjack this story to promote ${niche} — natural and tasteful, never forced or exploitative.${sens}\n` +
        `Produce SHORT text that will be OVERLAID on a poster image (so keep it tight and legible), plus a description of the background photo.\n` +
        `The badge is a small offer/info tag. Do NOT invent exact prices or guarantees; use safe, generic offers (e.g. "Free Quote", "Compare Rates", "Open Enrollment", "Limited Time").\n` +
        `Return ONLY valid JSON, no markdown. Every value a plain string:\n` +
        `{"badge":"<=4 words offer or info tag","headline":"<=6 words, bold, scroll-stopping","subhead":"<=14 words, the key benefit or info line","cta":"<=4 words button label","imgprompt":"a concrete photorealistic background photo built around the story's single most recognizable visual subject (the object/place/scene a reader instantly pictures), placed in a positive ad-ready setting tied to ${niche}; absolutely NO text, words, letters, numbers, logos, watermarks, or real recognizable faces"}`;
      max_tokens = 380;
    } else if (mode === "imgprompt") {
      prompt =
        `You are an art director creating ONE photorealistic advertising photo that reacts to a SPECIFIC trending US news story, for a ${niche} brand.\n` +
        `Audience: ${hint}.\nTrending story:\n${story}\n\n` +
        `First identify the single most RECOGNIZABLE VISUAL SUBJECT of this story — the object, place, vehicle, setting, or type of scene a reader instantly pictures. Build the image around THAT subject so anyone who sees it immediately connects it to this exact story, then place it in a polished, positive, ad-ready setting that ties naturally to ${niche}.\n` +
        `Be concrete and specific about the subject, setting, lighting and composition.${sens ? " The story is sensitive, so DO NOT depict death, injury, blood, or violence — show a safe, preventative, or hopeful angle instead." : ""} About 40-60 words.\n` +
        `Hard rules: absolutely NO text, NO words, NO letters, NO numbers, NO logos, NO watermarks, and NO real or recognizable faces (use only generic, anonymous people).\n` +
        `Return ONLY valid JSON, no markdown: {"prompt":"the image description"}`;
      max_tokens = 240;
    } else if (mode === "adset") {
      prompt =
        `You are a senior US art director AND direct-response copywriter making ONE Facebook/Instagram image ad for a ${niche} brand that newsjacks a trending story.\n` +
        `Audience: ${hint}.\nTrending story:\n${story}\n\n` +
        `Produce three parts that ALL fit together as one coherent ad:${sens}\n` +
        `1) HEADLINE: <=8 words, hooks the SPECIFIC angle of this news so the connection is obvious — not a generic slogan.\n` +
        `2) DESCRIPTION: 1-2 short sentences (<=28 words), the benefit/message. Truthful and general — do NOT invent prices, percentages, dollar amounts, statistics, star ratings, or testimonials.\n` +
        `3) SCENE: about 40-55 words describing ONE photorealistic image that visually fits BOTH the headline AND the description above, built around the single most recognizable visual subject of this news, placed in a positive, ad-ready setting that ties naturally to ${niche}.${sens ? " Sensitive story: show a safe, preventative or hopeful angle — no death, injury, blood or violence." : ""} The scene is only the BACKDROP for overlaid text, so describe imagery only — NO text, words, letters, numbers, logos, watermarks, or real recognizable faces.\n` +
        `Return ONLY valid JSON, no markdown: {"headline":"...","description":"...","scene":"..."}`;
      max_tokens = 420;
    } else {
      prompt =
        `You are a senior US direct-response copywriter for a ${niche} brand.\n` +
        `Audience: ${hint}.\nTrending story:\n${story}\n\n` +
        `Write ONE scroll-stopping social ad that newsjacks this story to promote ${niche}. Natural and tasteful, never forced or exploitative.${sens}\n` +
        `The HEADLINE must hook readers with the specific angle of THIS story so the news connection is obvious — not a generic slogan.\n` +
        `Keep all claims truthful and general — do NOT invent specific prices, percentages, dollar amounts, statistics, star ratings, or customer testimonials.\n` +
        `Return ONLY valid JSON, no markdown:\n` +
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
    if (mode === "imagead")
      return res.status(200).json({
        niche, mode,
        badge: obj.badge || "Free Quote",
        headline: obj.headline || "",
        subhead: obj.subhead || obj.body || obj.description || "",
        cta: obj.cta || "Learn More",
        imgprompt: obj.imgprompt || "",
      });
    if (mode === "imgprompt")
      return res.status(200).json({ niche, mode, prompt: obj.prompt || "" });
    if (mode === "adset")
      return res.status(200).json({ niche, mode, headline: obj.headline || "", description: obj.description || "", scene: obj.scene || "" });
    return res.status(200).json({ niche, mode, headline: obj.headline || "", description: obj.description || "" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
