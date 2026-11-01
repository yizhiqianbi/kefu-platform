// Messenger 个人号连接，一个号一个进程（ws3-fca 把登录状态放在模块全局变量里，同一进程挂不了两个号）。
// muxu 启动它：node worker.js <账号目录>。目录里的 messenger.json 是登录后的 cookie（600）。
// 标准输出一行一个 JSON 给 muxu（状态、收到的私信、发送结果）；标准输入一行一个 JSON 是 muxu 的命令（发消息、退出）。
// 库自己的日志全部改到标准错误，免得混进协议里。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");

const DIR = process.argv[2];
const STATE = path.join(DIR, "messenger.json");
const PROXY = process.env.PERSONAL_PROXY || "";
const UA = process.env.FB_USER_AGENT || "";
const { login } = require("ws3-fca");

let api = null;
const names = new Map();

function out(obj) {
  fs.writeSync(1, JSON.stringify(obj) + "\n");
}

function save() {
  if (!api) return;
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(api.getAppState()), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}

function quit(state, error, code) {
  out({ type: "state", state, error: String(error || "").slice(0, 300) });
  setTimeout(() => process.exit(code), 200);
}

function expired(err) {
  const s = JSON.stringify(err?.error || err?.originalError || err || "") + String(err);
  return /not logged in|login_required|appstate|checkpoint|1357001|Error retrieving userID/i.test(s);
}

async function nameOf(id) {
  if (names.has(id)) return names.get(id);
  let name = "";
  try {
    const info = await api.getUserInfo(id);
    name = info?.name && info.name !== "Facebook User" ? info.name : "";
  } catch { /* the id is enough to reply */ }
  names.set(id, name);
  return name;
}

const MEDIA = { photo: "图片", animated_image: "动图", video: "视频", audio: "语音", file: "文件", sticker: "表情", share: "分享", location: "位置" };

async function onMessage(m) {
  if (m.type !== "message" && m.type !== "message_reply") return;
  if (m.isGroup) return;
  const me = api.getCurrentUserID();
  const fromMe = String(m.senderID) === String(me);
  const peer = String(m.threadID);
  const kinds = (m.attachments || []).map((a) => MEDIA[a.type] || "附件");
  out({
    type: "message", peer, name: fromMe ? "" : await nameOf(String(m.senderID)), from_me: fromMe,
    text: m.body || "", media: kinds[0] || "", msgid: String(m.messageID || ""), ts: Number(m.timestamp || Date.now()) / 1000,
  });
}

function listen() {
  api.listenMqtt((err, m) => {
    if (err) {
      if (expired(err)) return quit("logged_out", "Facebook 要求重新登录（cookie 失效或账号被检查）", 3);
      return quit("closed", err?.message || err, 2);
    }
    onMessage(m).catch((e) => console.error("message", e));
  });
}

async function command(line) {
  let c;
  try { c = JSON.parse(line); } catch { return; }
  if (c.op === "quit") return quit("stopped", "", 0);
  if (c.op === "send") {
    try {
      const r = await api.sendMessage({ body: String(c.text || "") }, String(c.peer), undefined, true);
      out({ type: "reply", rid: c.rid, msgid: String(r?.messageID || "") });
    } catch (e) {
      out({ type: "reply", rid: c.rid, error: String(e?.message || e?.error || e).slice(0, 300) });
    }
  }
}

let appState;
try {
  appState = JSON.parse(fs.readFileSync(STATE, "utf8"));
} catch {
  quit("logged_out", "还没有登录", 3);
  return;
}
const options = { selfListen: true, listenEvents: false, autoMarkRead: false, autoMarkDelivery: false, online: false, updatePresence: false };
if (UA) options.userAgent = UA;
if (PROXY) options.proxy = PROXY;
const NETWORK = /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|proxy|50[234]/i;
login({ appState }, options, async (err, a) => {
  // ws3-fca doesn't report bad cookies as such (it fails while reading the page); anything that isn't the network means log in again
  if (err && NETWORK.test(String(err?.message || err))) return quit("closed", err?.message || err, 2);
  if (err) return quit("logged_out", "Facebook 不认这个登录（cookie 失效，或账号要先在浏览器里通过验证）", 3);
  api = a;
  save();
  const me = api.getCurrentUserID();
  out({ type: "state", state: "open", me: { id: String(me), name: await nameOf(String(me)) } });
  setInterval(() => { try { save(); } catch (e) { console.error("save", e); } }, 10 * 60 * 1000);
  listen();
  readline.createInterface({ input: process.stdin }).on("line", (l) => { command(l).catch((e) => console.error("command", e)); });
});
process.stdin.on("end", () => quit("stopped", "", 0));
