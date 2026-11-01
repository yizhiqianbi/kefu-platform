// Pulled by the platform: GET /k/r?after=<id>&limit=<n> with "Authorization: Bearer <STATS_KEY>".
// Rows older than KEEP_DAYS are dropped here, since the platform keeps its own copy.
import { sameKey, table } from "../../lib/k.js";

const KEEP_DAYS = 90;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function onRequestGet({ request, env }) {
  const auth = request.headers.get("authorization") || "";
  if (!env.STATS_KEY || !sameKey(auth, `Bearer ${env.STATS_KEY}`)) return json({ error: "forbidden" }, 403);
  if (!env.DB) return json({ error: "no D1 binding named DB" }, 500);
  await table(env.DB);
  const q = new URL(request.url).searchParams;
  const after = Math.max(0, Number(q.get("after")) | 0);
  const limit = Math.max(1, Math.min(5000, Number(q.get("limit")) | 0 || 2000));
  await env.DB.prepare("DELETE FROM hits WHERE ts < ?").bind(Date.now() - KEEP_DAYS * 86400000).run();
  const { results } = await env.DB.prepare("SELECT * FROM hits WHERE id > ? ORDER BY id LIMIT ?").bind(after, limit).all();
  return json({ rows: results, more: results.length === limit });
}
