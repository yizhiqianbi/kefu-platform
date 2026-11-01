// The director: a pi agent that edits the timeline JSON, looks at rendered frames and revises until the lint is
// clean and the cut looks right. It has three tools and nothing else: no shell, no files, no network.
import fs from 'node:fs';
import {Agent} from '@earendil-works/pi-agent-core';
import {Type, createModels} from '@earendil-works/pi-ai';
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter';

const SYSTEM = `You are the editor of short vertical ads (1080x1920) for a manufacturer selling to overseas buyers.
You edit a timeline JSON. The renderer turns it into video with fixed, tested templates; you cannot write code.

Workflow: study the brief, the material sheet and the draft. Call set_timeline with a better cut, call preview to
look at it, fix what looks wrong, repeat. Call finish when the lint shows no errors and the frames look good.
You have a limited number of turns: aim for 2-4 set_timeline/preview rounds.

HARD RULES (the lint enforces most of them; breaking one wastes a turn):
- Facts only from the brief. Every number on screen must be one of the allowed numbers. No claims not in the facts.
- The product's appearance comes only from the real product photos. Never describe colours or features you cannot
  see in the photos or read in the facts.
- Use only material names from the material list, each with a scene type that fits its kind.
- AI pictures: "aiscene" (g…) is an AI-made setting with no product in it; use it as a photo scene, or as bg_src with
  "bg": "scene" so the real product photo stands in that setting. "aiproduct" (r…) is an AI-made picture of the
  product in use that a person has checked; use it only as a whole photo scene. Callouts and specs go on real product
  photos (p…) only, never on AI pictures.
- Keep the AI label; do not try to hide that the video is AI-assisted.
- Scenes mode must end with an "end" scene. Captions and on-screen text are in the brief's language.

CRAFT:
- The first 1.5 s decide everything: open on motion (an AI or footage clip) or a big pain-point title, never a logo.
- Show, then tell: alternate moving shots with product/stat scenes; never three text-heavy scenes in a row.
- One idea per scene, few words: headline <= 6 words, caption <= 12 words, callouts <= 3 words.
- Captions are what a voice would say; do not repeat the headline word for word.
- Callouts must point at the right part of the product photo: x/y are fractions of the photo (0,0 top-left).
  Check them in preview and move them if the dot is off the product.
- Vary transitions; cut on action; slide/wipe between topics, fade into the end card.
- Use every AI clip that was paid for. Don't reuse the same picture back to back.
- Footage: pick the trim by what is actually on screen. Skip moments showing screens, web pages, slides, other
  products or text from elsewhere; check your pick with preview(seconds) and move the trim if it looks off.
- Hit the target length within about 15%.

TIMELINE JSON (scenes mode):
{"fps":30,"width":1080,"height":1920,"scenes":[SCENE,...]}
Every scene: "type", "seconds", optional "transition" (into this scene: cut|fade|slide|wipe|flip), optional "caption".
- clip:    {"src": ai/footage video, "trim": seconds into the source, "zoom": in|out|none, "fit": cover|blur,
            "volume": 0-1 (AI clips carry their own sound), "headline", "sub"}
- product: {"src": product photo, "bg": light|dark|brand|photo|scene, "bg_src": scene/aiscene picture (photo = blurred,
            scene = sharp setting the product stands in),
            "motion": push|pull|float|drop|pan, "headline", "sub", "callouts": [{"x","y","text","side":left|right}] (max 4)}
- stat:    {"value": number, "decimals", "prefix", "suffix", "label", "src": optional product photo, "bg"}
- specs:   {"title", "items": [{"value","label"}] (2-4), "src": optional product photo, "bg"}
- photo:   {"src": scene, aiscene or aiproduct picture, "motion": in|out|left|right, "headline", "sub"}
- title:   {"lines": ["...", "..."] (1-3 short lines, *word* = accent colour), "bg": dark|brand|light|photo, "bg_src", "size": xl}
- end:     {"src": optional product photo, "cta", "contact"}
Avatar mode (a presenter video under everything) instead has "avatar": {"src","seconds","zooms":[{"at","scale"}]} and
"captions": [{"text","start","end"}]; its scenes are overlays with "at" (start second) and "layout": full|pip, plus a
final "end". Keep the presenter visible most of the time, punch in (scale 1.15-1.3) on key words, and never move or
rewrite the captions: they are the presenter's real words.

finish takes short notes in Simplified Chinese for the client: what you changed and why (2-4 sentences).`;

function pickModel(models, id) {
  const known = models.getModel('openrouter', id);
  if (known) return known;
  const base = models.getModel('openrouter', 'deepseek/deepseek-v4.1-flash');
  return {...base, id, name: id, input: ['text', 'image'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
}

const MIME = {png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg'};
const image = (file) => ({type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: MIME[file.split('.').pop().toLowerCase()] || 'image/jpeg'});

function lintText(r) {
  const errs = r.issues.filter((i) => i.level === 'error');
  const warns = r.issues.filter((i) => i.level === 'warn');
  const fmt = (i) => `- ${i.scene === undefined || i.scene === null ? '' : `scene ${i.scene + 1}: `}${i.msg}`;
  return [`Length ${r.seconds.toFixed(1)} s.`, errs.length ? `ERRORS (must fix):\n${errs.map(fmt).join('\n')}` : 'No errors.',
    warns.length ? `Warnings:\n${warns.map(fmt).join('\n')}` : ''].filter(Boolean).join('\n');
}

// Older preview images are dropped from the context: the model only needs to see the latest cut.
function keepLatestImages(messages, keep = 2) {
  let seen = 0;
  return messages
    .slice()
    .reverse()
    .map((m) => {
      if (m.role !== 'toolResult' || !Array.isArray(m.content) || !m.content.some((c) => c.type === 'image')) return m;
      if (seen++ < keep) return m;
      return {...m, content: [...m.content.filter((c) => c.type !== 'image'), {type: 'text', text: '(older preview removed)'}]};
    })
    .reverse();
}

/**
 * opts: {timeline, rules, brief (text), images: [file...], model, apiKey, maxTurns, maxCost, tools: {lint, still, sheet}}
 * Returns {timeline|null, notes, turns, cost, steps, lint}.
 */
export async function direct(opts) {
  const {rules, tools} = opts;
  if (!opts.apiKey) throw new Error('apiKey is required');
  const maxTurns = Math.max(3, Math.min(30, Number(opts.maxTurns) || 14));
  const maxCost = Math.max(0.02, Math.min(2, Number(opts.maxCost) || 0.3));
  const models = createModels({identity: {attribution: null}});
  models.setProvider(openrouterProvider());
  const model = pickModel(models, opts.model || 'deepseek/deepseek-v4.1-flash');

  let current = null; // {timeline, lint}
  let best = null; // last lint-clean timeline
  let notes = '';
  let done = false;
  let previews = 0;
  const steps = [];

  const setTimeline = {
    name: 'set_timeline',
    label: 'Set timeline',
    description: 'Replace the whole timeline with this JSON. Returns the lint result and the length.',
    parameters: Type.Object({timeline_json: Type.String({description: 'The complete timeline JSON object as a string'})}),
    execute: async (_id, p) => {
      let t;
      try {
        t = JSON.parse(p.timeline_json);
      } catch (e) {
        throw new Error(`Invalid JSON: ${e.message}`);
      }
      if (!t || typeof t !== 'object' || !Array.isArray(t.scenes)) throw new Error('The timeline needs a "scenes" array');
      for (const k of ['fps', 'width', 'height', 'avatar']) if (opts.timeline[k] !== undefined && t[k] === undefined) t[k] = opts.timeline[k];
      if (opts.timeline.avatar) t.captions = opts.timeline.captions;
      const r = tools.lint(t, rules);
      current = {timeline: t, lint: r};
      const errors = r.issues.filter((i) => i.level === 'error').length;
      if (!errors) best = t;
      steps.push({tool: 'set_timeline', scenes: t.scenes.length, seconds: r.seconds, errors, warnings: r.issues.length - errors});
      return {content: [{type: 'text', text: lintText(r)}], details: {errors}};
    },
  };

  const preview = {
    name: 'preview',
    label: 'Preview',
    description:
      'Render the current timeline and look at it. Without seconds: a contact sheet, one frame per second, left to right, ' +
      'top to bottom. With seconds (max 4): larger stills at those moments, for checking callouts or text.',
    parameters: Type.Object({seconds: Type.Optional(Type.Array(Type.Number(), {maxItems: 4}))}),
    execute: async (_id, p) => {
      if (!current) throw new Error('Call set_timeline first');
      if (previews >= 8) throw new Error('Preview limit reached; finish now');
      previews++;
      if (p.seconds && p.seconds.length) {
        const files = await tools.still(current.timeline, p.seconds);
        steps.push({tool: 'preview', seconds: files.map((f) => f.second)});
        return {content: [{type: 'text', text: files.map((f, i) => `Image ${i + 1}: ${f.second.toFixed(1)} s`).join('\n')}, ...files.map((f) => image(f.file))], details: {}};
      }
      const s = await tools.sheet(current.timeline);
      steps.push({tool: 'preview', sheet: s.seconds.length});
      return {content: [{type: 'text', text: `Contact sheet, 8 per row. Frames at seconds: ${s.seconds.join(', ')}`}, image(s.file)], details: {}};
    },
  };

  const finish = {
    name: 'finish',
    label: 'Finish',
    description: 'Hand in the current timeline. Refused while the lint has errors.',
    parameters: Type.Object({notes: Type.String({description: '2-4 sentences in Simplified Chinese: what you changed and why'})}),
    execute: async (_id, p) => {
      if (!current) throw new Error('Call set_timeline first');
      if (current.lint.issues.some((i) => i.level === 'error')) throw new Error('The lint still has errors; fix them first');
      notes = String(p.notes || '').slice(0, 600);
      done = true;
      steps.push({tool: 'finish'});
      return {content: [{type: 'text', text: 'Handed in.'}], details: {}, terminate: true};
    },
  };

  let turns = 0;
  let cost = 0;
  let stop = '';
  const agent = new Agent({
    initialState: {systemPrompt: SYSTEM, model, thinkingLevel: 'low', tools: [setTimeline, preview, finish], messages: []},
    streamFn: (m, ctx, o) => models.streamSimple(m, ctx, {...o, apiKey: opts.apiKey, maxTokens: 12000}),
    getApiKey: () => opts.apiKey,
    identity: {attribution: null},
    toolExecution: 'sequential',
    transformContext: async (messages) => keepLatestImages(messages),
    maxRetryDelayMs: 20000,
  });
  agent.subscribe((e) => {
    if (e.type !== 'turn_end') return;
    turns++;
    const u = e.message && e.message.usage;
    if (u && u.cost) cost += Number(u.cost.total) || 0;
    if (done) return;
    if (turns >= maxTurns || cost >= maxCost) {
      stop = turns >= maxTurns ? 'turns' : 'cost';
      agent.abort();
    } else if (turns === maxTurns - 2) {
      agent.steer({role: 'user', content: [{type: 'text', text: 'Two turns left. Fix any errors and call finish.'}], timestamp: Date.now()});
    }
  });

  const draft = tools.lint(opts.timeline, rules);
  const intro = [
    opts.brief,
    `\nAllowed numbers: ${(rules.allowed_numbers || []).join(', ') || '(none)'}`,
    `Target length: ${rules.target_seconds || 'free'} s`,
    `\nMaterial (name: kind, size, length):\n${Object.entries(rules.material || {})
      .map(([n, m]) => `- ${n}: ${m.kind}${m.w ? `, ${m.w}x${m.h}` : ''}${m.seconds ? `, ${Number(m.seconds).toFixed(1)} s` : ''}${m.note ? ` (${m.note})` : ''}`)
      .join('\n')}`,
    `\nDraft timeline (a mechanical first pass, improve it):\n${JSON.stringify(opts.timeline)}`,
    `\nDraft lint:\n${lintText(draft)}`,
    '\nAttached: the material sheet (every picture with its name), then the product photos.',
  ].join('\n');
  const content = [{type: 'text', text: intro}, ...(opts.images || []).filter((f) => fs.existsSync(f)).map(image)];

  try {
    await agent.prompt({role: 'user', content, timestamp: Date.now()});
  } catch (e) {
    if (!stop) stop = String(e?.message || e).slice(0, 300);
  }
  if (!stop && agent.state.errorMessage) stop = String(agent.state.errorMessage).slice(0, 300);
  const timeline = done ? current.timeline : best;
  return {timeline, notes, done, stop, turns, cost: Math.round(cost * 10000) / 10000, steps, lint: timeline ? tools.lint(timeline, rules) : draft};
}
