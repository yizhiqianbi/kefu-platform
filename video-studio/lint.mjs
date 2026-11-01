// Checks a timeline against the material and the rules. Errors must be fixed before the director may finish;
// warnings are craft advice. Messages are for the director model, so they are in English.
import {layout, SCENE_TYPES, TRANSITIONS} from './src/layout.js';

const SRC_KINDS = {
  clip: ['ai', 'footage'],
  product: ['product'],
  stat: ['product'],
  specs: ['product'],
  end: ['product'],
  photo: ['scene', 'aiscene', 'aiproduct'],
};
const BG_KINDS = ['product', 'scene', 'aiscene'];
const SECONDS = {clip: [0.8, 8], product: [1.2, 4.5], stat: [1.2, 3.5], specs: [1.8, 4.5], photo: [1.2, 4], title: [0.8, 3.5], end: [1.5, 4]};
const TEXT_HEAVY = new Set(['title', 'stat', 'specs']);

export function numbers(text) {
  return (String(text || '').match(/\d+(?:[.,]\d+)*/g) || []).map((n) =>
    (/^\d{1,3}([.,]\d{3})+$/.test(n) ? n.replace(/[.,]/g, '') : n.replace(',', '.')).replace('.', ''),
  );
}

const words = (s) => String(s || '').replace(/\*/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function texts(s) {
  const out = [];
  const add = (field, v) => v !== undefined && v !== null && v !== '' && out.push([field, String(v)]);
  add('caption', s.caption);
  add('headline', s.headline);
  add('sub', s.sub);
  add('title', s.title);
  add('label', s.label);
  add('prefix', s.prefix);
  add('suffix', s.suffix);
  if (s.type === 'stat') add('value', s.value);
  add('cta', s.cta);
  (s.callouts || []).forEach((c, i) => add(`callouts[${i}].text`, c && c.text));
  (s.items || []).forEach((it, i) => {
    add(`items[${i}].value`, it && it.value);
    add(`items[${i}].label`, it && it.label);
  });
  (s.lines || []).forEach((l, i) => add(`lines[${i}]`, l));
  return out;
}

export function lint(t, rules = {}) {
  const issues = [];
  const err = (scene, msg) => issues.push({level: 'error', scene, msg});
  const warn = (scene, msg) => issues.push({level: 'warn', scene, msg});
  const material = rules.material || {};
  const allowed = new Set((rules.allowed_numbers || []).map(String));
  const contact = String(rules.contact || '');
  let risky = null;
  try {
    risky = typeof rules.risky === 'string' && rules.risky ? new RegExp(rules.risky, 'giu') : null;
  } catch {
    risky = null;
  }
  const scenes = Array.isArray(t.scenes) ? t.scenes : [];
  if (!scenes.length) {
    err(null, 'timeline.scenes is empty');
    return {issues, seconds: 0};
  }
  const avatarMode = Boolean(t.avatar && t.avatar.src);
  if (avatarMode) {
    const a = material[t.avatar.src];
    if (!a || a.kind !== 'avatar') err(null, `avatar.src "${t.avatar.src}" is not the avatar take from the material list`);
  }
  if (t.music && t.music.src && (material[t.music.src] || {}).kind !== 'music') err(null, `music.src "${t.music.src}" is not a music file from the material list`);

  const uses = {};
  scenes.forEach((s, i) => {
    const n = i + 1;
    if (!SCENE_TYPES.includes(s.type)) {
      err(n, `unknown type "${s.type}"; use one of ${SCENE_TYPES.join(', ')}`);
      return;
    }
    if (s.transition && !(s.transition in TRANSITIONS)) err(n, `unknown transition "${s.transition}"; use ${Object.keys(TRANSITIONS).join(', ')}`);
    const sec = Number(s.seconds);
    const [lo, hi] = SECONDS[s.type];
    if (!(sec >= lo && sec <= hi)) err(n, `${s.type} must last ${lo}-${hi}s (has ${s.seconds})`);
    const kinds = SRC_KINDS[s.type];
    if (s.src !== undefined && s.src !== null && s.src !== '') {
      const m = material[s.src];
      if (!m) err(n, `src "${s.src}" is not in the material list`);
      else if (kinds && !kinds.includes(m.kind)) {
        err(n, `${s.type} cannot use a ${m.kind} file ("${s.src}"); allowed: ${kinds.join(', ')}`);
      } else {
        uses[s.src] = (uses[s.src] || 0) + 1;
        if (s.type === 'clip' && m.seconds && (Number(s.trim) || 0) + sec > m.seconds + 0.05) {
          err(n, `clip "${s.src}" is only ${m.seconds}s long; trim + seconds is ${((Number(s.trim) || 0) + sec).toFixed(2)}s`);
        }
      }
    } else if (['clip', 'product', 'photo'].includes(s.type)) {
      err(n, `${s.type} needs a src`);
    }
    if (s.bg_src && !BG_KINDS.includes((material[s.bg_src] || {}).kind)) err(n, `bg_src "${s.bg_src}" must be a product, scene or aiscene picture`);
    if (s.bg_src && !['photo', 'scene'].includes(s.bg) && ['product', 'title'].includes(s.type)) warn(n, 'bg_src is only shown with "bg": "photo" or "scene"');
    if (s.bg === 'scene' && !s.bg_src) err(n, '"bg": "scene" needs a bg_src (a scene or aiscene picture)');
    if (s.type === 'stat' && !isFinite(Number(s.value))) err(n, 'stat.value must be a number');
    if (s.type === 'specs' && !(Array.isArray(s.items) && s.items.length >= 2 && s.items.length <= 4)) err(n, 'specs needs 2-4 items');
    if (s.type === 'title' && !(Array.isArray(s.lines) && s.lines.length)) err(n, 'title needs lines');
    (s.callouts || []).forEach((c, k) => {
      if (!(c && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1)) err(n, `callouts[${k}] needs x and y between 0 and 1 (fractions of the photo)`);
    });

    for (const [field, v] of texts(s)) {
      for (const num of numbers(v)) {
        if (!allowed.has(num)) err(n, `${field} "${v}": the number ${num} is not in the product material; use only numbers from the facts`);
      }
      if (risky) {
        for (const m of v.matchAll(risky)) err(n, `${field} "${v}": "${m[0]}" is a claim that needs evidence; remove it`);
      }
    }
    if (s.cta && /\d/.test(s.contact || '') && contact && s.contact !== contact) warn(n, `end.contact should be exactly "${contact}"`);
    if (s.caption && words(s.caption).length > 12) warn(n, 'caption is long; keep it under ~10 words or split it over two scenes');
    if (s.headline && words(s.headline).length > 8) warn(n, 'headline is long; 3-7 words read best');
    (s.callouts || []).forEach((c, k) => words(c && c.text).length > 4 && warn(n, `callouts[${k}] is long; 1-3 words`));
    if (TEXT_HEAVY.has(s.type) && s.caption) {
      const big = new Set(texts({...s, caption: ''}).flatMap(([, v]) => words(v)));
      const cw = words(s.caption);
      if (cw.length && cw.filter((w) => big.has(w)).length / cw.length > 0.5) {
        warn(n, 'the caption repeats the big text on screen; drop the caption or say something else');
      }
    }
  });

  if (!avatarMode) {
    if (scenes[scenes.length - 1].type !== 'end') err(scenes.length, 'the last scene must be the end card (type "end")');
    if (['specs', 'end', 'photo'].includes(scenes[0].type)) warn(1, 'weak hook: open with motion (an AI clip or footage) or a bold title');
    if (Number(scenes[0].seconds) > 3) warn(1, 'the first scene is long; the hook should land within 2-3 seconds');
    for (let i = 2; i < scenes.length; i++) {
      if ([0, 1, 2].every((k) => TEXT_HEAVY.has(scenes[i - k].type))) warn(i + 1, 'three text scenes in a row; break them up with footage or the product');
    }
    for (let i = 1; i < scenes.length; i++) {
      if (scenes[i].src && scenes[i].src === scenes[i - 1].src) warn(i + 1, `same src "${scenes[i].src}" twice in a row`);
    }
  } else {
    const L = layout(t);
    const sorted = [...L.overlays].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].from < sorted[i - 1].from + sorted[i - 1].dur) err(sorted[i].i + 1, 'this overlay overlaps the previous one');
    }
    const covered = L.overlays.filter((o) => o.layout !== 'pip').reduce((a, o) => a + o.dur, 0);
    if (covered > L.base * 0.65) warn(null, 'the presenter is hidden for most of the video; keep them on screen at least a third of the time');
    if (L.overlays.some((o) => o.from < L.fps)) warn(null, 'let the presenter open: no overlay in the first second');
    L.overlays.forEach((o) => {
      if (Number(o.at) + Number(o.seconds) > t.avatar.seconds + 0.05) err(o.i + 1, `overlay runs past the end of the talking head (${t.avatar.seconds}s)`);
    });
  }
  Object.entries(uses).forEach(([src, k]) => k > 2 && warn(null, `"${src}" is used ${k} times; vary the visuals`));
  Object.entries(material).forEach(([name, m]) => {
    if (m.kind === 'ai' && !uses[name]) warn(null, `paid AI clip "${name}" is not used`);
  });
  const L = layout(t);
  const seconds = L.total / L.fps;
  const target = Number(rules.target_seconds) || 0;
  if (target && Math.abs(seconds - target) / target > 0.25) warn(null, `total is ${seconds.toFixed(1)}s; the brief asks for about ${target}s`);
  return {issues, seconds: Math.round(seconds * 10) / 10};
}
