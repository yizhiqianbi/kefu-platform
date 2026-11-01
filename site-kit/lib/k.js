// Shared by the site-kit functions. No cookies and no IP addresses are stored: a visitor is
// sha256(day | key | ip | user-agent), so the same person counts once a day and can't be followed across days.

export const BOT = /bot\b|bot\/|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|python|curl|wget|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|facebookexternalhit|meta-externalagent|chatgpt-user|perplexity-user|claude-user|mistralai-user|anthropic-ai|cohere-ai|bytespider|ccbot|diffbot|preview|whatsapp|telegram|slack|discord|embedly|monitor|uptime/i;

// Most specific first; the first match names the bot.
const NAMES = ["OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot", "anthropic-ai",
  "Perplexity-User", "PerplexityBot", "Google-InspectionTool", "GoogleOther", "Google-Extended", "Googlebot", "AdsBot-Google",
  "Storebot-Google", "bingbot", "BingPreview", "Applebot-Extended", "Applebot", "Amazonbot", "Bytespider", "CCBot",
  "meta-externalagent", "meta-externalfetcher", "FacebookBot", "facebookexternalhit", "DuckAssistBot", "DuckDuckBot",
  "YandexBot", "Baiduspider", "PetalBot", "Sogou", "YisouSpider", "MistralAI-User", "cohere-ai", "Diffbot", "AhrefsBot",
  "SemrushBot", "MJ12bot", "DotBot", "DataForSeoBot", "Timpibot", "ImagesiftBot", "Twitterbot", "LinkedInBot", "WhatsApp",
  "TelegramBot", "Slackbot", "Discordbot", "Chrome-Lighthouse", "HeadlessChrome", "python", "curl", "wget", "Go-http-client"];

export function botName(ua) {
  if (!BOT.test(ua)) return "";
  const low = ua.toLowerCase();
  return NAMES.find((n) => low.includes(n.toLowerCase())) || "other";
}

export function device(ua) {
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return "mobile";
  return "desktop";
}

export const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, n);

export async function visitor(key, ip, ua, day) {
  const data = new TextEncoder().encode(`${day}|${key}|${ip}|${ua}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let ready = false;
export async function table(db) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, k TEXT NOT NULL,
    path TEXT, ref TEXT, cc TEXT, dev TEXT, lang TEXT, vid TEXT, name TEXT, utm TEXT, secs INTEGER, status INTEGER, ua TEXT)`).run();
  ready = true;
}

export async function insert(db, row) {
  await table(db);
  const cols = Object.keys(row);
  await db.prepare(`INSERT INTO hits (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
}

export function sameKey(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
