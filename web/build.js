// Vercel runs this before publishing: it writes the public Supabase settings into config.js.
// The anon key is designed to be public; the database's access rules do the protecting.
const fs = require("fs");
const path = require("path");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel: Project → Settings → Environment Variables.");
  process.exit(1);
}
fs.writeFileSync(
  path.join(__dirname, "config.js"),
  `window.PLUCK_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key })};\n`
);
console.log("Wrote web/config.js");
