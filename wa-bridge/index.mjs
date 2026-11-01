// WhatsApp 个人号连接。muxu 通过本机 HTTP 让它登录、发消息；收到的私信和连接状态推回 muxu。
// 只监听 127.0.0.1；两边用 data/personal/wa-bridge.token 里的令牌互相认证。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import makeWASocket, { Browsers, DisconnectReason, isJidGroup, isLidUser, isPnUser, jidNormalizedUser, useMultiFileAuthState } from "baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import pino from "pino";
import QRCode from "qrcode";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DATA = process.env.MUXU_DATA_DIR || path.join(HERE, "..", "data");
const DIR = path.join(DATA, "personal");
const PORT = Number(process.env.WA_BRIDGE_PORT || 8771);
const MUXU = (process.env.MUXU_INTERNAL_URL || "http://127.0.0.1:8770").replace(/\/$/, "");
const PROXY = process.env.PERSONAL_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
const TOKEN = fs.readFileSync(path.join(DIR, "wa-bridge.token"), "utf8").trim();
const log = pino({ level: process.env.WA_LOG_LEVEL || "warn" });

const sessions = new Map(); // account id -> { sock, state, qr, code, me, error, phone, stopping, retries }

function authDir(id) {
  return path.join(DIR, String(id), "wa-auth");
}

async function notify(body) {
  try {
    await fetch(`${MUXU}/muxu/api/personal/wa/event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": TOKEN },
      body: JSON.stringify(body),
    });
  } catch (e) {
    log.warn({ err: String(e) }, "muxu unreachable");
  }
}

function setState(id, s, patch) {
  Object.assign(s, patch);
  notify({ type: "state", id, state: s.state, me: s.me, error: s.error || "" });
}

function textOf(m) {
  const c = m.message || {};
  const inner = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c;
  const text = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption
    || inner.documentMessage?.caption || "";
  const media = inner.imageMessage ? "图片" : inner.videoMessage ? "视频" : inner.audioMessage ? "语音" : inner.documentMessage ? "文件"
    : inner.stickerMessage ? "表情" : inner.locationMessage ? "位置" : inner.contactMessage ? "名片" : "";
  return { text, media };
}

function loggedIn(id) {
  try {
    return !!JSON.parse(fs.readFileSync(path.join(authDir(id), "creds.json"), "utf8")).me?.id;
  } catch {
    return false;
  }
}

async function start(id, phone = "", fresh = false) {
  if (fresh) {
    await stop(id, false);
    fs.rmSync(authDir(id), { recursive: true, force: true });
  }
  const old = sessions.get(id);
  if (old && !["closed", "logged_out", "expired"].includes(old.state)) return old;
  const s = { state: "connecting", qr: "", code: "", me: null, error: "", phone, stopping: false, retries: old?.retries || 0 };
  sessions.set(id, s);
  fs.mkdirSync(authDir(id), { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(authDir(id));
  const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
  const sock = makeWASocket({
    auth: state, logger: log, agent, fetchAgent: agent, browser: Browsers.macOS("Chrome"),
    markOnlineOnConnect: false, syncFullHistory: false,
  });
  s.sock = sock;
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      if (s.phone && !state.creds.registered && !s.code) {
        try {
          s.code = await sock.requestPairingCode(s.phone.replace(/\D/g, ""));
        } catch (e) {
          s.error = `配对码申请失败：${String(e).slice(0, 120)}`;
        }
      }
      setState(id, s, { state: "qr", qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }) });
    }
    if (u.connection === "open") {
      const me = sock.user || {};
      setState(id, s, { state: "open", qr: "", code: "", error: "", retries: 0, me: { id: jidNormalizedUser(me.id), name: me.name || me.notify || "" } });
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (s.stopping) return;
      if (!state.creds.me?.id) {
        // never finished logging in: the QR / pairing code ran out
        fs.rmSync(authDir(id), { recursive: true, force: true });
        setState(id, s, { state: "expired", qr: "", code: "", error: "二维码过期了，点「重新生成」再扫" });
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        start(id, s.phone);
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(authDir(id), { recursive: true, force: true });
        setState(id, s, { state: "logged_out", qr: "", error: "手机上退出了这个设备，要重新扫码登录" });
        return;
      }
      s.retries += 1;
      const wait = Math.min(60, 2 ** Math.min(s.retries, 6)) * 1000;
      setState(id, s, { state: "closed", error: `连接断开（${code || "网络"}），${Math.round(wait / 1000)} 秒后重连` });
      setTimeout(() => { if (sessions.get(id) === s && !s.stopping) start(id, s.phone); }, wait);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // notify = live; append = arrived while offline (and our own sends, which muxu recognises by id)
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      const jid = m.key.remoteJid || "";
      if (!jid || isJidGroup(jid) || jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) continue;
      if (!isPnUser(jid) && !isLidUser(jid)) continue;
      const { text, media } = textOf(m);
      if (!text && !media) continue;
      const alt = m.key.remoteJidAlt || "";
      const pn = isPnUser(jid) ? jid : isPnUser(alt) ? alt : "";
      await notify({
        type: "message", id, jid: jidNormalizedUser(jid), pn: pn ? jidNormalizedUser(pn) : "", name: m.pushName || "",
        text, media, from_me: !!m.key.fromMe, msgid: m.key.id, ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
      });
    }
  });
  return s;
}

async function stop(id, logout) {
  const s = sessions.get(id);
  if (s) {
    s.stopping = true;
    try {
      if (logout) await s.sock?.logout();
      else s.sock?.end(undefined);
    } catch (e) { /* already closed */ }
    sessions.delete(id);
  }
  if (logout) fs.rmSync(authDir(id), { recursive: true, force: true });
}

function view(id) {
  const s = sessions.get(id);
  if (!s) return { state: loggedIn(id) ? "stopped" : "none" };
  return { state: s.state, qr: s.qr, code: s.code, me: s.me, error: s.error };
}

function body(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

function reply(res, code, data) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  if (req.headers["x-bridge-token"] !== TOKEN) return reply(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  const b = req.method === "POST" ? await body(req) : {};
  const id = Number(b.id || url.searchParams.get("id"));
  try {
    if (url.pathname === "/health") return reply(res, 200, { ok: true, sessions: [...sessions.keys()] });
    if (!id) return reply(res, 400, { error: "id" });
    if (url.pathname === "/start") { await start(id, b.phone || "", !!b.fresh); return reply(res, 200, view(id)); }
    if (url.pathname === "/status") return reply(res, 200, view(id));
    if (url.pathname === "/stop") { await stop(id, !!b.logout); return reply(res, 200, { ok: true }); }
    if (url.pathname === "/send") {
      const s = sessions.get(id);
      if (!s || s.state !== "open") return reply(res, 409, { error: "这个 WhatsApp 个人号没有在线" });
      const sent = await s.sock.sendMessage(b.jid, { text: String(b.text || "") });
      return reply(res, 200, { msgid: sent?.key?.id || "" });
    }
    return reply(res, 404, { error: "not found" });
  } catch (e) {
    return reply(res, 500, { error: String(e?.message || e).slice(0, 300) });
  }
}).listen(PORT, "127.0.0.1", () => {
  log.warn(`wa-bridge on 127.0.0.1:${PORT}`);
  for (const name of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (/^\d+$/.test(name) && loggedIn(name)) start(Number(name)).catch((e) => log.warn(String(e)));
  }
});
