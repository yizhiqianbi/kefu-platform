// Records crawler visits (search engines, AI crawlers) on the routes listed in _routes.json.
// People are counted by /k.js instead, so a crawler that runs scripts is never counted as a visitor.
import { botName, clip, insert } from "../lib/k.js";

export async function onRequest({ request, env, next, waitUntil }) {
  const res = await next();
  const url = new URL(request.url);
  if (!env.DB || url.pathname.startsWith("/k/")) return res;
  const ua = request.headers.get("user-agent") || "";
  const name = botName(ua);
  if (name) {
    waitUntil(insert(env.DB, {
      ts: Date.now(), k: "bot", path: clip(url.pathname, 200), name, status: res.status,
      cc: clip(request.cf?.country, 2), ua: clip(ua, 200),
    }).catch(() => {}));
  }
  return res;
}
