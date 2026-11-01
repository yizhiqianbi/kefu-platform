// Beacon from /k.js: page views (pv), clicks on contact links and form sends (ev), time on page (end).
import { botName, clip, device, insert, visitor } from "../../lib/k.js";

const KINDS = new Set(["pv", "ev", "end"]);
const ok = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export async function onRequestPost({ request, env, waitUntil }) {
  const ua = request.headers.get("user-agent") || "";
  const site = request.headers.get("sec-fetch-site");
  if (!env.DB || !env.STATS_KEY || botName(ua) || (site && site !== "same-origin")) return ok();
  let d;
  try {
    d = JSON.parse((await request.text()).slice(0, 4096));
  } catch {
    return ok();
  }
  if (!d || !KINDS.has(d.k)) return ok();
  const host = new URL(request.url).hostname.replace(/^www\./, "");
  let ref = "";
  try {
    const r = new URL(d.r || "");
    if (r.hostname.replace(/^www\./, "") !== host) ref = r.hostname;
  } catch {}
  const ts = Date.now();
  const ip = request.headers.get("cf-connecting-ip") || "";
  const row = {
    ts, k: d.k, path: clip(d.p, 200), ref: clip(ref, 120), cc: clip(request.cf?.country, 2), dev: device(ua),
    lang: clip(d.l, 12), vid: await visitor(env.STATS_KEY, ip, ua, new Date(ts).toISOString().slice(0, 10)),
    name: clip(d.n, 40), utm: clip(d.u, 60), secs: d.k === "end" ? Math.max(0, Math.min(3600, Number(d.s) | 0)) : null,
  };
  waitUntil(insert(env.DB, row).catch(() => {}));
  return ok();
}
