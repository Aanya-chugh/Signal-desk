// /api/slack — handles the digest's buttons (Slack interactivity).
// Reads the niche the buyer picked from the per-story dropdown, generates the asset,
// and posts the result into the message thread:
//   ✍️ Copy     -> headline + description (text)
//   🎬 Video    -> 4-scene script (text)
//   🖼 Image    -> AI photo uploaded to the thread
//   📸 Image Ad -> a finished POSTER: the ad copy is composited (burned in) onto the AI photo
//                  server-side and the single PNG is uploaded to the thread.
//
// Deps: @napi-rs/canvas (see cloud/package.json). Fonts are fetched once at runtime from a CDN.
// Env: AUTH_SECRET, SLACK_BOT_TOKEN, SLACK_VERIFY_TOKEN (optional), SITE_URL (optional).
import crypto from "crypto";
// @napi-rs/canvas is loaded lazily (only when the Image Ad poster is built), so Copy / Video /
// Image keep working even if the canvas binary has any trouble loading on the host.
let _cv = null;
async function canvasLib() { if (!_cv) _cv = await import("@napi-rs/canvas"); return _cv; }

export const maxDuration = 60;

const SITE = (process.env.SITE_URL || "https://signal-desk-jade.vercel.app").replace(/\/$/, "");

/* ---------- auth / helpers ---------- */
function sign(p, secret) {
  const b = Buffer.from(JSON.stringify(p)).toString("base64url");
  return b + "." + crypto.createHmac("sha256", secret).update(b).digest("base64url");
}
const adminToken = () => sign({ role: "admin", exp: Date.now() + 5 * 60 * 1000 }, process.env.AUTH_SECRET);
const str = (v) => Array.isArray(v) ? v.map(str).join(" ") : (v == null ? "" : String(v));

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
async function makeImage(niche, prompt) {
  const r = await fetch(SITE + "/api/image", {
    method: "POST", headers: { Authorization: "Bearer " + adminToken(), "Content-Type": "application/json" },
    body: JSON.stringify({ niche, prompt }),
  });
  return r.json();
}
// Always return an image prompt that is anchored to THIS news story (the strong "imgprompt"
// mode). If that call hiccups, fall back to a prompt that still names the story, so the image
// never silently drifts to a generic niche stock scene.
async function storyImagePrompt(niche, article) {
  try {
    const pr = await generate({ mode: "imgprompt", niche, article });
    const p = str(pr.prompt).trim();
    if (p) return p;
  } catch {}
  return `Photorealistic advertising photo reacting to this news: "${str(article.title)}". ` +
    `Build the image around the single most recognizable real subject of that story (the object, place, or scene a reader instantly pictures), ` +
    `in a polished, positive, ad-ready setting that ties naturally to ${niche}. ` +
    `No text, no words, no logos, no watermarks, no recognizable faces.`;
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

/* ---------- poster compositing (server-side canvas) ---------- */
const FONT_URLS = {
  Head:  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/anton/Anton-Regular.ttf",
  Body:  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ptsans/PTSans-Regular.ttf",
  BodyB: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ptsans/PTSans-Bold.ttf",
};
let fontsReady = false;
async function ensureFonts() {
  if (fontsReady) return;
  const { GlobalFonts } = await canvasLib();
  for (const [alias, url] of Object.entries(FONT_URLS)) {
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    GlobalFonts.register(buf, alias);
  }
  fontsReady = true;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrapLines(ctx, text, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function coverDraw(ctx, img, W, H) {
  const ir = img.width / img.height, cr = W / H; let w, h, x, y;
  if (ir > cr) { h = H; w = H * ir; x = (W - w) / 2; y = 0; } else { w = W; h = W / ir; x = 0; y = (H - h) / 2; }
  ctx.drawImage(img, x, y, w, h);
}
async function buildPoster(o) {
  await ensureFonts();
  const { createCanvas, loadImage } = await canvasLib();
  const W = 1080, H = 1350, M = 72;
  const cv = createCanvas(W, H); const ctx = cv.getContext("2d");

  const niche = str(o.niche);
  const headline = str(o.headline).trim() || (niche ? niche + " — A Smarter Choice" : "A Smarter Choice Today");
  let subhead = str(o.subhead).trim() || "See how much you could save in minutes.";
  const badge = (str(o.badge).trim() || "Free Quote").toUpperCase();
  const cta = (str(o.cta).trim() || "Learn More").toUpperCase();

  let bg = null;
  if (o.imageBuf) { try { bg = await loadImage(o.imageBuf); } catch { bg = null; } }
  if (bg) coverDraw(ctx, bg, W, H);
  else { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#243016"); g.addColorStop(1, "#0c0c0e"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }

  const gt = ctx.createLinearGradient(0, 0, 0, H * 0.22); gt.addColorStop(0, "rgba(8,8,10,.6)"); gt.addColorStop(1, "rgba(8,8,10,0)"); ctx.fillStyle = gt; ctx.fillRect(0, 0, W, H * 0.22);

  const maxW = W - M * 2;
  let hlSize = 96, hl = [];
  for (const s of [96, 84, 74, 64, 56]) { ctx.font = s + "px Head"; hl = wrapLines(ctx, headline, maxW); hlSize = s; if (hl.length <= 3) break; }
  const hlLH = Math.round(hlSize * 1.04);
  ctx.font = "40px Body"; let sh = wrapLines(ctx, subhead, maxW); if (sh.length > 3) sh = sh.slice(0, 3); const shLH = 52;
  ctx.font = "34px BodyB"; const ctaW = Math.min(maxW, ctx.measureText(cta).width + 76), ctaH = 88;
  const kick = niche.toUpperCase(), kickH = kick ? 40 : 0, gKick = kick ? 18 : 0, gHS = 26, gSC = 34, pad = 46;
  const blockH = kickH + gKick + hl.length * hlLH + gHS + sh.length * shLH + gSC + ctaH;
  let startY = H - M - blockH; if (startY < M + 10) startY = M + 10;
  const panelTop = startY - pad;

  const pe = ctx.createLinearGradient(0, panelTop - 100, 0, panelTop); pe.addColorStop(0, "rgba(8,8,10,0)"); pe.addColorStop(1, "rgba(8,8,10,.85)"); ctx.fillStyle = pe; ctx.fillRect(0, panelTop - 100, W, 100);
  ctx.fillStyle = "rgba(8,8,10,.85)"; ctx.fillRect(0, panelTop, W, H - panelTop);

  ctx.font = "30px BodyB"; const bw = ctx.measureText(badge).width; ctx.fillStyle = "#C9F24A"; roundRect(ctx, M, M, bw + 46, 58, 29); ctx.fill();
  ctx.fillStyle = "#0c0c0e"; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillText(badge, M + 23, M + 31);
  ctx.font = "26px BodyB"; ctx.fillStyle = "rgba(236,234,226,.92)"; ctx.textAlign = "right"; ctx.fillText("SIGNAL // DESK", W - M, M + 31);

  let y = startY; ctx.textAlign = "left"; ctx.textBaseline = "top";
  if (kick) { ctx.font = "26px BodyB"; ctx.fillStyle = "#C9F24A"; ctx.fillText(kick, M, y); y += kickH + gKick; }
  ctx.font = hlSize + "px Head"; ctx.fillStyle = "#ffffff"; for (const ln of hl) { ctx.fillText(ln, M, y); y += hlLH; }
  y += gHS;
  ctx.font = "40px Body"; ctx.fillStyle = "rgba(236,234,226,.95)"; for (const ln of sh) { ctx.fillText(ln, M, y); y += shLH; }
  y += gSC;
  ctx.fillStyle = "#C9F24A"; roundRect(ctx, M, y, ctaW, ctaH, 16); ctx.fill();
  ctx.fillStyle = "#0c0c0e"; ctx.font = "34px BodyB"; ctx.textBaseline = "middle"; ctx.fillText(cta, M + 38, y + ctaH / 2 + 2);

  return cv.toBuffer("image/png");
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
  if (action.action_id === "niche") return res.status(200).end(); // dropdown change — nothing to do

  let meta = {};
  try { meta = JSON.parse(action.value); } catch {}
  const niche = pickNiche(payload, action.block_id, meta.n || "");
  const article = { title: meta.t, source: meta.s, domain: meta.d, category: meta.c, sensitive: !!meta.x };
  const kind = action.action_id;
  const labels = { gen_copy: "Ad Copy", gen_image: "Image", gen_imagead: "Image Ad", gen_script: "Video Ad" };

  if (!niche) {
    await post(channel, thread, "👆 Pick a niche from the *Select niche* dropdown on that story first, then tap the button again.");
    return res.status(200).end();
  }

  await post(channel, thread, `⏳ Generating *${labels[kind] || "asset"}* for *${niche}*…`);

  try {
    if (kind === "gen_copy") {
      const j = await generate({ mode: "copy", niche, article });
      if (j.error) throw new Error(j.error);
      await post(channel, thread, `✍️ *Ad Copy — ${niche}*\n*${str(j.headline)}*\n${str(j.description)}`);

    } else if (kind === "gen_script") {
      const j = await generate({ mode: "script", niche, article });
      if (j.error) throw new Error(j.error);
      const sc = j.script || {};
      let txt = `🎬 *Video Ad — ${niche}*\n_${str(sc.concept)}_`;
      (sc.scenes || []).forEach((x) => {
        txt += `\n\n*${str(x.scene)}*  ${str(x.time)}\n• *Visual:* ${str(x.visual)}\n• *VO:* ${str(x.voiceover)}\n• *On-screen:* ${str(x.onscreen)}`;
      });
      txt += `\n\n*CTA:* ${str(sc.cta) || "Learn More"}`;
      await post(channel, thread, txt);

    } else if (kind === "gen_image") {
      // news-anchored image, plus a matching headline/description shown with it
      const prompt = await storyImagePrompt(niche, article);
      const img = await makeImage(niche, prompt);
      const d = dataUrlToBuffer(img.image);
      if (!d) throw new Error(img.error || "image failed");
      let cap = `🖼 *Image — ${niche}*`;
      try {
        const cp = await generate({ mode: "copy", niche, article });
        if (!cp.error) cap += `\n*${str(cp.headline)}*\n${str(cp.description)}`;
      } catch {}
      await uploadBytes(channel, thread, d.bytes, d.mime, "signal-desk-image.png", cap);

    } else if (kind === "gen_imagead") {
      const c = await generate({ mode: "imagead", niche, article });   // poster text
      if (c.error) throw new Error(c.error);
      const prompt = await storyImagePrompt(niche, article);           // news-anchored photo
      const img = await makeImage(niche, prompt);
      const d = dataUrlToBuffer(img.image);            // null if image service failed
      const poster = await buildPoster({
        niche, badge: str(c.badge), headline: str(c.headline),
        subhead: str(c.subhead), cta: str(c.cta),
        imageBuf: d ? d.bytes : null,                  // falls back to gradient bg if no photo
      });
      const note = d ? "" : "  _(photo service didn't respond — poster uses a fallback background; tap 📸 again to retry)_";
      await uploadBytes(channel, thread, poster, "image/png", "signal-desk-poster.png",
        `📸 *Image Ad — ${niche}*${note}`);

    } else {
      return res.status(200).end();
    }
  } catch (e) {
    await post(channel, thread, `⚠️ Couldn't generate that — ${str(e.message || e).slice(0, 160)}`);
  }
  return res.status(200).end();
}
