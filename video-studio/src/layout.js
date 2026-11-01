// Timeline JSON -> frame positions. Shared by the Remotion composition, the lint and the render service,
// so the three agree on every scene's start, the captions' timing and the total length.

export const TRANSITIONS = {cut: 0, fade: 0.3, slide: 0.35, wipe: 0.4, flip: 0.45};
export const SCENE_TYPES = ['clip', 'product', 'stat', 'specs', 'photo', 'title', 'end'];

const frames = (sec, fps) => Math.max(1, Math.round((Number(sec) || 0) * fps));

export function layout(t) {
  const fps = t.fps || 30;
  const width = t.width || 1080;
  const height = t.height || 1920;
  const scenes = Array.isArray(t.scenes) ? t.scenes : [];
  if (t.avatar && t.avatar.src) {
    const base = frames(t.avatar.seconds, fps);
    const end = scenes.find((s) => s.type === 'end');
    const endDur = end ? frames(end.seconds || 2.5, fps) : 0;
    const overlays = scenes
      .filter((s) => s.type !== 'end')
      .map((s, i) => {
        const from = Math.min(base - 1, Math.max(0, Math.round((Number(s.at) || 0) * fps)));
        return {...s, i, from, dur: Math.max(1, Math.min(frames(s.seconds || 2, fps), base - from))};
      });
    const captions = (t.captions || []).map((c) => ({text: String(c.text || ''), from: Math.round(c.start * fps), to: Math.round(c.end * fps)}));
    return {mode: 'avatar', fps, width, height, total: base + endDur, base, overlays, end: end ? {...end, from: base, dur: endDur} : null, captions};
  }
  const items = [];
  let at = 0;
  scenes.forEach((s, i) => {
    const dur = frames(s.seconds || 2, fps);
    let tin = 0;
    if (i > 0) {
      const prev = items[i - 1];
      tin = Math.round((TRANSITIONS[s.transition] || 0) * fps);
      tin = Math.max(0, Math.min(tin, prev.dur - 1, dur - 1));
      at = prev.from + prev.dur - tin;
    }
    items.push({...s, i, from: at, dur, tin});
  });
  const total = items.length ? items[items.length - 1].from + items[items.length - 1].dur : fps;
  const captions = [];
  items.forEach((s, i) => {
    if (!s.caption) return;
    const next = items[i + 1];
    const from = s.from + Math.floor(s.tin / 2);
    const to = s.from + s.dur - (next ? Math.ceil(next.tin / 2) : 0);
    if (to > from) captions.push({text: String(s.caption), from, to, scene: i});
  });
  return {mode: 'scenes', fps, width, height, total, scenes: items, captions};
}

// Caption pages: a few words at a time, each word lit while it is "spoken".
export function captionPages(text, from, to, maxWords = 3) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length || to <= from) return [];
  const pages = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || /[.!?,;:]$/.test(w)) {
      pages.push(cur);
      cur = [];
    }
  }
  if (cur.length) pages.push(cur);
  const weight = (w) => 1 + Math.min(w.length, 12) / 6;
  const totalW = words.reduce((a, w) => a + weight(w), 0);
  const span = to - from;
  let t = from;
  return pages.map((p) => {
    const ws = p.map((w) => {
      const d = (span * weight(w)) / totalW;
      const o = {text: w, from: Math.round(t), to: Math.round(t + d)};
      t += d;
      return o;
    });
    return {from: ws[0].from, to: ws[ws.length - 1].to, words: ws};
  });
}
