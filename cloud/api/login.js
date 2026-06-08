// Vercel function: exchange a shared access key for a short-lived signed token.
// Set these in Vercel -> Settings -> Environment Variables:
//   AUTH_SECRET  = any long random string (used to sign tokens)
//   ADMIN_KEY    = the password you give people who may generate
//   VIEWER_KEY   = the password you give people who may only view
import crypto from "crypto";

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
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

  const secret = process.env.AUTH_SECRET;
  const adminKey = process.env.ADMIN_KEY;
  const viewerKey = process.env.VIEWER_KEY;
  if (!secret || !(adminKey || viewerKey))
    return res.status(500).json({ error: "Auth not configured (set AUTH_SECRET, ADMIN_KEY, VIEWER_KEY in Vercel)" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const key = (body.key || "").trim();

  let role = null;
  if (adminKey && key === adminKey) role = "admin";
  else if (viewerKey && key === viewerKey) role = "viewer";
  if (!role) return res.status(401).json({ error: "Incorrect access key" });

  const token = sign({ role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }, secret); // 7 days
  return res.status(200).json({ token, role });
}
