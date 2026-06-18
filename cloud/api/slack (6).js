// /api/slack — handles the digest's buttons (Slack interactivity).
// Reads the niche the buyer picked from the per-story dropdown, generates the asset,
// and posts the result into the message thread:
//   ✍️ Copy     -> headline + description (text)
//   🎬 Video    -> 4-scene script (text)
//   🖼 Image    -> a news-anchored AI photo (regular Nano Banana) + matching copy
//   📸 Image Ad -> a complete, professionally designed ad on Nano Banana Pro: a relevant image plus
//                  the REAL generated headline + benefit line, varied layout each time. Nothing is
//                  fabricated — no fake names, quotes, ratings, prices, badges or branding.
//   ⚡ Generate all -> all of the above for one story
// No image compositing / no canvas dependency. Env: AUTH_SECRET, SLACK_BOT_TOKEN,
// SLACK_VERIFY_TOKEN (optional), SITE_URL (optional).
import crypto from "crypto";

export const maxDuration = 60;

const SITE = (process.env.SITE_URL || "https://signal-desk-jade.vercel.app").replace(/\/$/, "");

/* ---------- auth / helpers ---------- */
function sign(p, secret) {
  const b = Buffer.from(JSON.stringify(p)).toString("base64url");
  return b + "." + crypto.createHmac("sha256", secret).update(b).digest("base64url");
}
const adminToken = () => sign({ role: "admin", exp: Date.now() + 5 * 60 * 1000 }, process.env.AUTH_SECRET);
const str = (v) => Array.isArray(v) ? v.map(str).join(" ") : (v == null ? "" : String(v));
const clean = (v) => str(v).replace(/\*+/g, "").trim();
const firstSentence = (v) => clean(v).split(/(?<=[.!?])\s/)[0].slice(0, 140);
// On-image supporting line = the benefit only. Drop a trailing call-to-action clause
// (e.g. "..., get a free quote") so the image shows no CTA/button text; the caption keeps the full copy.
const CTA_START_RX = /^(get|grab|claim|call|dial|sign\s?up|learn\s+more|find\s+out|apply|enroll|request|click|tap|visit|shop|buy|order|start|join|compare|act|don'?t\s+wait|switch\s+today|save\s+today)\b/i;
function benefitOnly(desc) {
  const parts = firstSentence(desc).split(/\s*[—,-]\s*/);
  if (parts.length > 1 && CTA_START_RX.test(parts[parts.length - 1].trim())) parts.pop();
  return parts.join(", ").replace(/[.,;:!\s]+$/, "").trim();
}

async function slack(method, body) {
  const r = await fetch("https://slack.com/api/" + method, {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.SLACK_BOT_TOKEN, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}
const post = (channel, thread, text) => slack("chat.postMessage", { channel, thread_ts: thread, text, unfurl_links: false });

async function generate(payload) {
  const r = await fetch(SITE + "/api/generate", {
    method: "POST", headers: { Authorization: "Bearer " + adminToken(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}
async function makeImage(niche, prompt, tier) {
  const body = { niche, prompt };
  if (tier) body.tier = tier;                 // "pro" routes to Nano Banana Pro for the ad
  const r = await fetch(SITE + "/api/image", {
    method: "POST", headers: { Authorization: "Bearer " + adminToken(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
// News-anchored prompt for the plain photo (🖼 Image). Falls back to a story-named prompt.
async function storyImagePrompt(niche, article) {
  try {
    const pr = await generate({ mode: "imgprompt", niche, article });
    const p = str(pr.prompt).trim();
    if (p) return p;
  } catch {}
  return `Photorealistic advertising photo reacting to this news: "${str(article.title)}". ` +
    `Build the image around the single most recognizable real subject of that story, ` +
    `in a polished, positive, ad-ready setting that ties naturally to ${niche}. ` +
    `No text, no words, no logos, no watermarks, no recognizable faces.`;
}

/* ---------- proper designed AD creative (Nano Banana Pro) ---------- */
// Rotating REAL ad layouts so each ad looks fresh. All text is the real generated copy —
// nothing is fabricated (no fake names, quotes, ratings, prices, badges or branding).
const AD_STYLES = [
  "a bold hero photograph filling the frame, with the headline set large across a clean area of the image and the supporting line just beneath it",
  "a modern split layout — a striking relevant photo on one side and a solid premium color panel on the other carrying the headline and supporting line in clean type",
  "a refined editorial layout with generous negative space, an elegant oversized headline, the supporting line, and a beautiful relevant image",
  "a clean content-card layout — the relevant photo on top and a tidy panel below holding the headline and supporting line in strong modern type",
  "a vivid full-bleed photo with a confident headline band near the top and the supporting line in a clean strip toward the bottom",
  "a sleek cinematic hero shot with dramatic lighting and the headline integrated boldly into the composition, supporting line below",
  "a clean two-tone layout with a bold colored header area holding the headline, a relevant photo below, and the supporting line in a slim footer band",
  "a premium magazine cover-style ad: a powerful full-frame relevant image with the headline placed boldly across the top and the supporting line beneath, like a high-end publication cover",
];
const pickStyle = () => AD_STYLES[Math.floor(Math.random() * AD_STYLES.length)];
// Pick n distinct layout styles (so the variations in one tap don't repeat a layout).
function pickStyles(n) {
  const pool = AD_STYLES.slice(), out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

function adPrompt(niche, headline, subline, story, style) {
  return [
    "Create a high-end, scroll-stopping Facebook / Instagram advertisement, 1:1 square, with the craft and polish of a top DTC brand's best-performing creative.",
    "This is a real, professionally DESIGNED ad — NOT a generic template, and NOT a plain stock photo with text slapped on top.",
    "Layout for THIS ad: " + style + ".",
    "Create a relevant, high-quality image for this offer that fits the mood of the news (do NOT print the news text): " + story + ".",
    'Render this headline, large, bold and perfectly spelled: "' + headline + '".',
    subline ? 'Include this one supporting benefit line, smaller and clear: "' + subline + '".' : "",
    "Do NOT render any call-to-action or button text in the image (no 'get a quote', 'learn more', 'call now', 'sign up', etc.).",
    "Strong visual hierarchy, a modern premium color palette, professional typography, and high production value.",
    "Use ONLY the exact text provided above. Do NOT invent or add any prices, percentages, statistics, savings figures, star ratings, reviews, testimonials, customer names, badges, logos, brand names, watermarks, 'Signal Desk', or fake clickable buttons.",
    "No recognizable real public figures. Give it a fresh, original layout each time.",
  ].filter(Boolean).join(" ");
}

function adCopy(cp) {
  const headline = clean(cp.headline) || "A Smarter Choice";
  const description = clean(cp.description);
  return { headline, description, subline: benefitOnly(description) };
}
async function makeOneAd(niche, headline, subline, story, style) {
  return makeImage(niche, adPrompt(niche, headline, subline, story, style), "pro");
}
async function makeAdImage(niche, article) {     // single ad (used by ⚡ Generate all)
  const cp = await generate({ mode: "copy", niche, article });
  const { headline, description, subline } = adCopy(cp);
  const img = await makeOneAd(niche, headline, subline, str(article.title), pickStyle());
  return { img, headline, description };
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

/* ---------- Slack file upload (bytes) ---------- */
async function uploadBytes(channel, thread, bytes, mime, filename, comment) {
  const token = process.env.SLACK_BOT_TOKEN;
  const u = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filename, length: String(bytes.length) }),
  }).then((r) => r.json());
  if (!u.ok) throw new Error("getUploadURL: " + (u.error || "failed"));

  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime || "image/png" }), filename);
  const up = await fetch(u.upload_url, { method: "POST", body: fd });
  if (!up.ok) throw new Error("upload failed (" + up.status + ")");

  const c = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      files: JSON.stringify([{ id: u.file_id, title: filename }]),
      channel_id: channel, thread_ts: thread || "", initial_comment: comment || "",
    }),
  }).then((r) => r.json());
  if (!c.ok) throw new Error("complete: " + (c.error || "failed"));
}

/* ---------- niche from the per-story dropdown ---------- */
function pickNiche(payload, blockId, fallback) {
  try { return payload.state.values[blockId].niche.selected_option.value || fallback; }
  catch { return fallback; }
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");

  let body = req.body;
  if (typeof body === "string") { try { body = Object.fromEntries(new URLSearchParams(body)); } catch { body = {}; } }
  let payload;
  try { payload = JSON.parse(body.payload); } catch { return res.status(400).send("bad payload"); }

  if (process.env.SLACK_VERIFY_TOKEN && payload.token !== process.env.SLACK_VERIFY_TOKEN)
    return res.status(401).send("unauthorized");
  if (payload.type !== "block_actions") return res.status(200).end();

  const action = (payload.actions || [])[0];
  const channel = payload.channel && payload.channel.id;
  const thread = payload.message && payload.message.ts;
  if (!action || !channel) return res.status(200).end();
  if (action.action_id === "niche") return res.status(200).end();

  let meta = {};
  try { meta = JSON.parse(action.value); } catch {}
  const niche = pickNiche(payload, action.block_id, meta.n || "");
  const article = { title: meta.t, source: meta.s, domain: meta.d, category: meta.c, sensitive: !!meta.x };
  const kind = action.action_id;

  if (!niche) {
    await post(channel, thread, "👆 Pick a niche from the *Select niche* dropdown on that story first, then tap the button again.");
    return res.status(200).end();
  }

  try {
    if (kind === "gen_copy") {
      const j = await generate({ mode: "copy", niche, article });
      if (j.error) throw new Error(j.error);
      await post(channel, thread, `✍️ *Ad Copy — ${niche}*\n*${clean(j.headline)}*\n${clean(j.description)}`);

    } else if (kind === "gen_script") {
      const j = await generate({ mode: "script", niche, article });
      if (j.error) throw new Error(j.error);
      await post(channel, thread, scriptText(niche, j.script));

    } else if (kind === "gen_image") {
      const prompt = await storyImagePrompt(niche, article);
      const img = await makeImage(niche, prompt);                 // regular Nano Banana
      const d = dataUrlToBuffer(img.image);
      if (!d) throw new Error(img.error || "image failed");
      let cap = `🖼 *Image — ${niche}*`;
      try {
        const cp = await generate({ mode: "copy", niche, article });
        if (!cp.error) cap += `\n*${clean(cp.headline)}*\n${clean(cp.description)}`;
      } catch {}
      await uploadBytes(channel, thread, d.bytes, d.mime, "signal-desk-image.png", cap);

    } else if (kind === "gen_imagead") {
      const cp = await generate({ mode: "copy", niche, article });
      if (cp.error) throw new Error(cp.error);
      const { headline, description, subline } = adCopy(cp);
      const styles = pickStyles(2);
      const results = await Promise.all(
        styles.map((s) => makeOneAd(niche, headline, subline, str(article.title), s).catch((e) => ({ error: String((e && e.message) || e) })))
      );
      let n = 0;
      for (const r of results) {
        const d = dataUrlToBuffer(r.image);
        if (!d) continue;
        n++;
        const cap = n === 1
          ? `📸 *Image Ad — ${niche}*  ·  2 options, pick your favorite\n*${headline}*${description ? "\n" + description : ""}`
          : `📸 Option ${n}`;
        await uploadBytes(channel, thread, d.bytes, d.mime, `signal-desk-ad-${n}.png`, cap);
      }
      if (!n) throw new Error((results.find((r) => r.error) || {}).error || "ad image failed");

    } else if (kind === "gen_all") {
      const safe = (p) => generate(p).catch(() => ({ error: "failed" }));
      const [cp, scr, photoPrompt] = await Promise.all([
        safe({ mode: "copy", niche, article }),
        safe({ mode: "script", niche, article }),
        storyImagePrompt(niche, article),
      ]);

      // 1) Ad copy
      if (!cp.error) await post(channel, thread, `✍️ *Ad Copy — ${niche}*\n*${clean(cp.headline)}*\n${clean(cp.description)}`);

      // 2) Clean image (regular Nano Banana) + matching copy
      const photo = await makeImage(niche, photoPrompt);
      const pd = dataUrlToBuffer(photo.image);
      if (pd) {
        let cap = `🖼 *Image — ${niche}*`;
        if (!cp.error) cap += `\n*${clean(cp.headline)}*\n${clean(cp.description)}`;
        await uploadBytes(channel, thread, pd.bytes, pd.mime, "signal-desk-image.png", cap);
      }

      // 3) Designed ad creative (Nano Banana Pro) — real copy, fresh layout
      const adRes = await makeAdImage(niche, article);
      const ad = dataUrlToBuffer(adRes.img.image);
      if (ad) await uploadBytes(channel, thread, ad.bytes, ad.mime, "signal-desk-ad.png",
        `📸 *Image Ad — ${niche}*\n*${adRes.headline}*${adRes.description ? "\n" + adRes.description : ""}`);

      // 4) Video script
      if (!scr.error) await post(channel, thread, scriptText(niche, scr.script));

    } else {
      return res.status(200).end();
    }
  } catch (e) {
    await post(channel, thread, `⚠️ Couldn't generate that — ${str(e.message || e).slice(0, 160)}`);
  }
  return res.status(200).end();
}

function scriptText(niche, script) {
  const sc = script || {};
  let txt = `🎬 *Video Ad — ${niche}*\n_${clean(sc.concept)}_`;
  (sc.scenes || []).forEach((x) => {
    txt += `\n\n*${clean(x.scene)}*  ${clean(x.time)}\n• *Visual:* ${clean(x.visual)}\n• *VO:* ${clean(x.voiceover)}\n• *On-screen:* ${clean(x.onscreen)}`;
  });
  txt += `\n\n*CTA:* ${clean(sc.cta) || "Learn More"}`;
  return txt;
}
