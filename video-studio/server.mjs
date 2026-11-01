// Render service for muxu videos: bundles the Remotion templates once, then renders stills, contact sheets and
// final MP4s from timeline JSON, and runs the director agent. Listens on 127.0.0.1 only; every call needs the token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {openBrowser, renderFrames, renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {lint} from './lint.mjs';
import {layout} from './src/layout.js';
import {direct} from './director.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STUDIO_PORT || 8772);
const DATA = fs.realpathSync(process.env.MUXU_DATA_DIR || path.join(HERE, '..', 'data'));
const TOKEN = process.env.STUDIO_TOKEN || fs.readFileSync(path.join(DATA, 'video', 'studio.token'), 'utf8').trim();
const FONT_DIR = process.env.STUDIO_FONT_DIR || '/root/.fonts/inter/extras/ttf';
const CONCURRENCY = Number(process.env.STUDIO_CONCURRENCY || 16);
if (!TOKEN) throw new Error('STUDIO_TOKEN is required');

const log = (...a) => console.log(new Date().toISOString(), ...a);

function findChrome() {
  if (process.env.STUDIO_CHROME) return process.env.STUDIO_CHROME;
  const root = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of fs.readdirSync(path.join(root, d))) {
      const p = path.join(root, d, sub, 'chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  }
  return null; // Remotion downloads its own headless shell
}
const CHROME = findChrome();

// public/: the template fonts and two generated sound effects. Nothing here comes from the network.
function preparePublic() {
  const pub = path.join(HERE, 'public');
  fs.mkdirSync(path.join(pub, 'fonts'), {recursive: true});
  fs.mkdirSync(path.join(pub, 'sfx'), {recursive: true});
  for (const f of ['Inter-SemiBold.ttf', 'Inter-Bold.ttf', 'Inter-ExtraBold.ttf', 'Inter-Black.ttf']) {
    const src = path.join(FONT_DIR, f);
    const dst = path.join(pub, 'fonts', f);
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  const sfx = {
    whoosh: "anoisesrc=d=0.45:c=pink:a=0.6,highpass=f=300,lowpass=f=5000,afade=t=in:d=0.18,afade=t=out:st=0.2:d=0.25,volume=1.4",
    pop: "sine=f=880:d=0.09,afade=t=out:d=0.09,volume=0.8",
    // 10 s loop at 96 BPM: Am-F-C-G pad, soft kick on the beat, a little hat on the off-beat
    bed:
      "aevalsrc='st(0,floor(mod(t,10)/2.5));st(1,mod(t,2.5));st(2,mod(t,0.625));" +
      "st(3,if(lt(ld(0),1),220,if(lt(ld(0),2),174.61,if(lt(ld(0),3),261.63,196))));" +
      "st(4,if(lt(ld(0),1),261.63,if(lt(ld(0),2),220,if(lt(ld(0),3),329.63,246.94))));" +
      "st(5,if(lt(ld(0),1),329.63,if(lt(ld(0),2),261.63,if(lt(ld(0),3),392,293.66))));" +
      "0.09*(sin(2*PI*ld(3)*t)+sin(2*PI*ld(4)*t)+0.8*sin(2*PI*ld(5)*t)+0.5*sin(PI*ld(3)*t))*min(1,ld(1)*6)*min(1,(2.5-ld(1))*6)" +
      "+0.45*sin(2*PI*(50+90*exp(-ld(2)*40))*ld(2))*exp(-ld(2)*14)" +
      "+0.05*(random(0)*2-1)*exp(-mod(t+0.3125,0.625)*55)':s=48000:d=10," +
      "lowpass=f=6000,aecho=0.8:0.5:60:0.25,volume=3.6",
  };
  for (const [name, graph] of Object.entries(sfx)) {
    const dst = path.join(pub, 'sfx', `${name}.wav`);
    if (!fs.existsSync(dst)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', graph, '-ar', '48000', '-ac', '2', dst]);
  }
  return pub;
}

function sourceHash() {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(p));
    }
  };
  walk(path.join(HERE, 'src'));
  walk(path.join(HERE, 'public'));
  return h.digest('hex').slice(0, 16);
}

let serveUrl = null;
let browser = null;

async function setup() {
  const publicDir = preparePublic();
  const outDir = path.join(HERE, '.bundle', sourceHash());
  if (fs.existsSync(path.join(outDir, 'index.html'))) {
    serveUrl = outDir;
  } else {
    log('bundling templates');
    serveUrl = await bundle({entryPoint: path.join(HERE, 'src', 'index.jsx'), outDir, publicDir, rootDir: HERE});
    for (const old of fs.readdirSync(path.join(HERE, '.bundle'))) {
      if (path.join(HERE, '.bundle', old) !== outDir) fs.rmSync(path.join(HERE, '.bundle', old), {recursive: true, force: true});
    }
  }
  await getBrowser();
  log('ready', serveUrl, CHROME || '(remotion headless shell)');
}

async function getBrowser() {
  if (!browser) browser = await openBrowser('chrome', {browserExecutable: CHROME, chromeMode: 'headless-shell', logLevel: 'error'});
  return browser;
}

// One render at a time: they each use many cores.
let chain = Promise.resolve();
const queued = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function withBrowser(fn) {
  try {
    return await fn(await getBrowser());
  } catch (e) {
    if (/Target closed|Session closed|browser has disconnected|Protocol error/i.test(String(e))) {
      try {
        await browser?.close({silent: true});
      } catch {}
      browser = null;
      return fn(await getBrowser());
    }
    throw e;
  }
}

// ---------- job directories and the media they serve ----------

const jobs = new Map(); // id -> absolute dir

function jobFor(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(DATA + path.sep)) throw Object.assign(new Error('dir must be inside the data directory'), {status: 400});
  for (const [id, d] of jobs) if (d === real) return id;
  const id = crypto.randomBytes(12).toString('hex');
  jobs.set(id, real);
  return id;
}

function props(dir, timeline) {
  return {...timeline, base: `http://127.0.0.1:${PORT}/f/${jobFor(dir)}/`};
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const TYPES = {'.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg'};

function serveFile(req, res, id, name) {
  const dir = jobs.get(id);
  if (!dir || !NAME.test(name)) return send(res, 404, {error: 'not found'});
  const p = path.join(dir, name);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return send(res, 404, {error: 'not found'});
  }
  const head = {'Content-Type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'};
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) return send(res, 416, {error: 'range'});
    res.writeHead(206, {...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1});
    return fs.createReadStream(p, {start, end}).pipe(res);
  }
  res.writeHead(200, {...head, 'Content-Length': st.size});
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).pipe(res);
}

// ---------- rendering ----------

async function composition(inputProps, puppeteerInstance) {
  return selectComposition({serveUrl, id: 'Ad', inputProps, puppeteerInstance, logLevel: 'error'});
}

// Renders the given frames in one pass (one page pool) and returns their files in frame order.
async function grab(b, comp, inputProps, list, scale, outDir) {
  fs.rmSync(outDir, {recursive: true, force: true});
  fs.mkdirSync(outDir, {recursive: true});
  const frames = [...new Set(list)].sort((x, y) => x - y);
  await renderFrames({serveUrl, composition: comp, inputProps, frames, outputDir: outDir, puppeteerInstance: b, scale, imageFormat: 'jpeg', jpegQuality: 80,
    concurrency: Math.min(CONCURRENCY, frames.length), onStart: () => {}, onFrameUpdate: () => {}, timeoutInMilliseconds: 120000, logLevel: 'error'});
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpeg') || f.endsWith('.jpg')).sort();
  if (files.length !== frames.length) throw new Error(`expected ${frames.length} frames, got ${files.length}`);
  return frames.map((frame, i) => ({frame, file: path.join(outDir, files[i])}));
}

export async function still(dir, timeline, seconds, scale = 0.5) {
  return queued(() =>
    withBrowser(async (b) => {
      const inputProps = props(dir, timeline);
      const comp = await composition(inputProps, b);
      const list = seconds.slice(0, 4).map((s) => Math.max(0, Math.min(comp.durationInFrames - 1, Math.round(Number(s) * comp.fps))));
      const got = await grab(b, comp, inputProps, list, scale, path.join(dir, 'preview', 'still'));
      return got.map((g) => ({second: g.frame / comp.fps, file: g.file}));
    }),
  );
}

// One frame per `every` seconds, tiled 8 across: what the director "watches".
export async function sheet(dir, timeline, every = 1) {
  return queued(() =>
    withBrowser(async (b) => {
      const inputProps = props(dir, timeline);
      const comp = await composition(inputProps, b);
      const step = Math.max(1, Math.round(every * comp.fps));
      const wanted = [];
      for (let f = Math.min(comp.durationInFrames - 1, Math.round(step / 2)); f < comp.durationInFrames; f += step) wanted.push(f);
      const outDir = path.join(dir, 'preview', 'sheet');
      const got = await grab(b, comp, inputProps, wanted, 0.2, outDir);
      got.forEach((g, i) => fs.renameSync(g.file, path.join(outDir, `f${String(i).padStart(3, '0')}.jpg`)));
      const cols = 8;
      const rows = Math.ceil(wanted.length / cols);
      const file = path.join(dir, 'preview', 'sheet.jpg');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(outDir, 'f%03d.jpg'), '-vf', `tile=${cols}x${rows}:padding=6:color=white`,
        '-frames:v', '1', '-q:v', '4', file]);
      return {file, seconds: wanted.map((f) => Math.round((f / comp.fps) * 10) / 10)};
    }),
  );
}

export async function render(dir, timeline, out) {
  return queued(() =>
    withBrowser(async (b) => {
      const inputProps = props(dir, timeline);
      const comp = await composition(inputProps, b);
      const outputLocation = path.join(dir, out);
      const t0 = Date.now();
      await renderMedia({serveUrl, composition: comp, inputProps, codec: 'h264', outputLocation, puppeteerInstance: b, concurrency: CONCURRENCY,
        crf: 18, x264Preset: 'medium', audioCodec: 'aac', audioBitrate: '192k', timeoutInMilliseconds: 120000, logLevel: 'error'});
      const L = layout(timeline);
      log('rendered', out, `${(Date.now() - t0) / 1000}s`);
      return {file: outputLocation, seconds: L.total / L.fps,
        captions: L.captions.map((c) => ({text: c.text, start: c.from / L.fps, end: c.to / L.fps}))};
    }),
  );
}

// A cover or poster: one full-size frame of the Cover composition, saved as `out` (a .jpg name) in dir.
export async function cover(dir, props, out) {
  if (!NAME.test(out) || !/\.(jpe?g|png)$/i.test(out)) throw Object.assign(new Error('bad file name'), {status: 400});
  return queued(() =>
    withBrowser(async (b) => {
      const inputProps = {...props, base: `http://127.0.0.1:${PORT}/f/${jobFor(dir)}/`};
      const comp = await selectComposition({serveUrl, id: 'Cover', inputProps, puppeteerInstance: b, logLevel: 'error'});
      const output = path.join(dir, out);
      const png = /\.png$/i.test(out);
      await renderStill({serveUrl, composition: comp, inputProps, output, puppeteerInstance: b, imageFormat: png ? 'png' : 'jpeg', jpegQuality: 92,
        timeoutInMilliseconds: 120000, logLevel: 'error'});
      return {file: output, width: comp.width, height: comp.height};
    }),
  );
}

// ---------- HTTP ----------

function send(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 20 * 1024 * 1024) throw Object.assign(new Error('body too large'), {status: 413});
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const routes = {
  'GET /health': async () => ({ok: true, ready: Boolean(serveUrl)}),
  'POST /lint': async (b) => lint(b.timeline, b.rules),
  'POST /still': async (b) => ({files: await still(b.dir, b.timeline, b.seconds || [0], b.scale)}),
  'POST /sheet': async (b) => sheet(b.dir, b.timeline, b.every || 1),
  'POST /render': async (b) => render(b.dir, b.timeline, b.out || 'studio.mp4'),
  'POST /cover': async (b) => cover(b.dir, b.props || {}, b.out || 'cover.jpg'),
  // `extra` (label, logo, sizes, brand, music) is rendered with every preview but is not the director's to edit
  'POST /direct': async (b) => {
    const full = (t) => ({...t, ...(b.extra || {})});
    return direct({...b, tools: {lint, still: (t, s) => still(b.dir, full(t), s), sheet: (t) => sheet(b.dir, full(t), 1)}});
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const f = /^\/f\/([a-f0-9]{24})\/([^/]+)$/.exec(url.pathname);
  if (f && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, f[1], decodeURIComponent(f[2]));
  if (req.headers['x-studio-token'] !== TOKEN) return send(res, 403, {error: 'forbidden'});
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, {error: 'not found'});
  try {
    if (!serveUrl && url.pathname !== '/health') return send(res, 503, {error: 'still bundling the templates'});
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await route(body));
  } catch (e) {
    log('error', url.pathname, e?.stack || e);
    send(res, e.status || 500, {error: String(e?.message || e).slice(0, 500)});
  }
});

server.listen(PORT, '127.0.0.1', () => log('listening', PORT));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    setTimeout(() => process.exit(0), 2000).unref();
    server.close();
    Promise.resolve(browser?.close({silent: true})).finally(() => process.exit(0));
  });
}
setup().catch((e) => {
  log('setup failed', e?.stack || e);
  process.exit(1);
});
