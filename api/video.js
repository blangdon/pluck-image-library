// Streams a library video from Google Drive to the browser, so videos play in a normal <video> tag
// without Drive's embedded player (which needs Google cookies many browsers block).
// GET /api/video?id=<drive file id>&t=<supabase access token>
// Access: the signed-in person's token must be able to see the file in the images table (same rules as the site).
const crypto = require("crypto");

const CHUNK = 8 * 1024 * 1024;
let driveToken = null; // { token, exp }
const seen = new Map(); // "token|id" -> expiry ms

async function googleToken() {
  if (driveToken && driveToken.exp > Date.now() + 60_000) return driveToken.token;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sig}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google sign-in failed");
  driveToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return driveToken.token;
}

async function allowed(token, id) {
  const key = `${token}|${id}`;
  if ((seen.get(key) || 0) > Date.now()) return true;
  const url = `${process.env.SUPABASE_URL}/rest/v1/images?select=id&id=eq.${encodeURIComponent(id)}&limit=1`;
  const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  const ok = r.ok && (await r.json()).length === 1;
  if (ok) seen.set(key, Date.now() + 10 * 60_000);
  return ok;
}

module.exports = async (req, res) => {
  try {
    const { id, t } = req.query;
    if (!id || !t || !/^[\w-]+$/.test(id)) return res.status(400).end("Missing video");
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return res.status(500).end("Video playback isn't set up yet");
    if (!(await allowed(t, id))) return res.status(403).end("No access");

    const headers = { authorization: `Bearer ${await googleToken()}` };
    // Serve at most 8 MB per request so each one finishes quickly; the browser asks for the next piece itself.
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "bytes=0-");
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), start + CHUNK - 1) : start + CHUNK - 1;
    headers.range = `bytes=${start}-${end}`;
    const d = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers });
    if (!d.ok && d.status !== 206) return res.status(d.status).end("Drive error");

    res.status(d.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = d.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!d.headers.get("accept-ranges")) res.setHeader("accept-ranges", "bytes");
    res.setHeader("cache-control", "private, max-age=3600");
    const reader = d.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).end("Couldn't play this video");
    else res.end();
  }
};
