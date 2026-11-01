import React, {createContext, useContext} from 'react';
import {AbsoluteFill, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {captionPages} from './layout.js';

export const Ctx = createContext({base: '', brand: {}, u: 1});
export const useCtx = () => useContext(Ctx);

export const FONT = 'Inter, "DejaVu Sans", sans-serif';

export function colors(brand = {}) {
  const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : d);
  return {dark: hex(brand.dark, '#1f2147'), accent: hex(brand.accent, '#e8662a'), light: '#f4f1ea', ink: '#14151f'};
}

export function useMedia() {
  const {base} = useCtx();
  return (name) => (name ? base + encodeURIComponent(name) : '');
}

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const out = Easing.bezier(0.16, 1, 0.3, 1);

// Backgrounds ------------------------------------------------------------

export const Backdrop = ({bg = 'light', src}) => {
  const {brand} = useCtx();
  const media = useMedia();
  const c = colors(brand);
  if (bg === 'photo' && src) {
    return (
      <AbsoluteFill style={{background: c.dark}}>
        <Img src={media(src)} style={{width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(28px) brightness(0.55)', scale: '1.15'}} />
      </AbsoluteFill>
    );
  }
  if (bg === 'scene' && src) return <SceneBackdrop src={src} />;
  if (bg === 'dark' || bg === 'brand') {
    return (
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 70% at 50% 38%, ${bg === 'brand' ? c.accent : '#3a3d78'}55 0%, ${c.dark} 55%, #0d0e22 100%)`,
        }}
      />
    );
  }
  return <AbsoluteFill style={{background: `radial-gradient(110% 70% at 50% 40%, #ffffff 0%, ${c.light} 60%, #e3ded3 100%)`}} />;
};

// A setting the product stands in: sharp, slightly darkened, drifting in; gradients keep headline and captions readable.
const SceneBackdrop = ({src}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const media = useMedia();
  const scale = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.04, 1.1]);
  return (
    <AbsoluteFill style={{background: '#111'}}>
      <Img src={media(src)} style={{width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.8) saturate(1.05)', scale: String(scale)}} />
      <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 28%, rgba(0,0,0,0) 62%, rgba(0,0,0,.6) 100%)'}} />
    </AbsoluteFill>
  );
};

export const isDark = (bg) => bg === 'dark' || bg === 'brand' || bg === 'photo' || bg === 'scene';

// Text -------------------------------------------------------------------

// *word* marks an accent word.
export const Rich = ({text, accent}) =>
  String(text || '')
    .split(/(\*[^*]+\*)/)
    .map((p, i) =>
      p.startsWith('*') && p.endsWith('*') ? (
        <span key={i} style={{color: accent}}>
          {p.slice(1, -1)}
        </span>
      ) : (
        <React.Fragment key={i}>{p}</React.Fragment>
      ),
    );

export const Headline = ({text, sub, dark, top = 0.12, delay = 0, size = 92, align = 'center'}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const {u, brand, pip} = useCtx();
  const c = colors(brand);
  if (!text && !sub) return null;
  const p = spring({frame: frame - delay, fps, config: {damping: 200}, durationInFrames: Math.round(0.5 * fps)});
  return (
    <div
      style={{
        position: 'absolute',
        top: height * top,
        left: 80 * u,
        right: pip ? width * 0.33 : 80 * u,
        textAlign: pip ? 'left' : align,
        fontFamily: FONT,
        opacity: p,
        translate: `0 ${(1 - p) * 40 * u}px`,
      }}
    >
      {text ? (
        <div style={{fontWeight: 900, fontSize: size * u, lineHeight: 1.05, letterSpacing: -1.5 * u, color: dark ? '#fff' : c.ink}}>
          <Rich text={text} accent={c.accent} />
        </div>
      ) : null}
      {sub ? (
        <div style={{marginTop: 22 * u, fontWeight: 600, fontSize: 44 * u, lineHeight: 1.25, color: dark ? 'rgba(255,255,255,.82)' : '#4a4d5e'}}>{sub}</div>
      ) : null}
    </div>
  );
};

// Product cut-out with callouts -----------------------------------------

// Where an image of aspect `ar` lands when fitted (contain) into a box.
export function fitBox(box, ar) {
  const bar = box.w / box.h;
  if (!ar || !isFinite(ar)) return box;
  if (ar > bar) {
    const h = box.w / ar;
    return {x: box.x, y: box.y + (box.h - h) / 2, w: box.w, h};
  }
  const w = box.h * ar;
  return {x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h};
}

// Dot positions in pixels, which side each label goes, and label heights pushed apart so labels never overlap.
export function placeCallouts(callouts, img, width, u) {
  const pts = callouts.map((c, i) => {
    const ax = img.x + img.w * Math.max(0, Math.min(1, Number(c.x) || 0.5));
    const ay = img.y + img.h * Math.max(0, Math.min(1, Number(c.y) || 0.5));
    let dir = c.side === 'left' ? -1 : c.side === 'right' ? 1 : ax > width / 2 ? 1 : -1;
    if (dir < 0 && ax < 440 * u) dir = 1;
    else if (dir > 0 && width - ax < 440 * u) dir = -1;
    return {i, text: c.text, ax, ay, dir, ly: ay};
  });
  for (const dir of [-1, 1]) {
    const side = pts.filter((p) => p.dir === dir).sort((a, b) => a.ay - b.ay);
    side.forEach((p, k) => {
      if (k > 0) p.ly = Math.max(p.ay, side[k - 1].ly + 92 * u);
    });
  }
  return pts.sort((a, b) => a.i - b.i);
}

export const Callout = ({ax, ay, ly, dir, text, delay, dark}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const {u, brand} = useCtx();
  const c = colors(brand);
  const len = Math.min(170 * u, dir > 0 ? width - ax - 260 * u : ax - 260 * u);
  const dot = spring({frame: frame - delay, fps, config: {damping: 14}});
  const line = interpolate(frame - delay, [4, 14], [0, 1], {...clamp, easing: out});
  const label = spring({frame: frame - delay - 10, fps, config: {damping: 200}});
  const lx = ax + dir * Math.max(60 * u, len);
  const dx = lx - ax;
  const dy = ly - ay;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: ax - 16 * u,
          top: ay - 16 * u,
          width: 32 * u,
          height: 32 * u,
          borderRadius: '50%',
          background: c.accent,
          boxShadow: `0 0 0 ${10 * u}px ${c.accent}44`,
          scale: String(dot),
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: ay - 2 * u,
          left: ax,
          width: Math.hypot(dx, dy) * line,
          height: 4 * u,
          background: dark ? '#fff' : c.ink,
          transformOrigin: '0 50%',
          rotate: `${Math.atan2(dy, dx)}rad`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: ly - 40 * u,
          left: dir > 0 ? lx + 10 * u : undefined,
          right: dir < 0 ? width - lx + 10 * u : undefined,
          maxWidth: 360 * u,
          padding: `${12 * u}px ${22 * u}px`,
          borderRadius: 16 * u,
          background: dark ? '#fff' : c.dark,
          color: dark ? c.ink : '#fff',
          fontFamily: FONT,
          fontWeight: 800,
          fontSize: 38 * u,
          lineHeight: 1.1,
          opacity: label,
          translate: `${(1 - label) * dir * 30 * u}px 0`,
        }}
      >
        {text}
      </div>
    </>
  );
};

export const ProductShot = ({src, ar, box, motion = 'push', delay = 0, shadow = true, plaque = false}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const {u} = useCtx();
  const media = useMedia();
  const enter = spring({frame: frame - delay, fps, config: {damping: motion === 'drop' ? 11 : 200}});
  const t = frame / Math.max(1, durationInFrames);
  const img = fitBox(box, ar);
  const scale =
    motion === 'push' ? interpolate(t, [0, 1], [0.94, 1.04]) : motion === 'pull' ? interpolate(t, [0, 1], [1.06, 0.97]) : 1;
  const y = motion === 'float' ? Math.sin(frame / 14) * 10 : motion === 'drop' ? (1 - enter) * -box.h * 0.6 : (1 - enter) * 40;
  const x = motion === 'pan' ? interpolate(t, [0, 1], [-box.w * 0.04, box.w * 0.04]) : 0;
  return (
    <>
      {shadow ? (
        <div
          style={{
            position: 'absolute',
            left: img.x + img.w * 0.12,
            width: img.w * 0.76,
            top: img.y + img.h * 0.94,
            height: img.h * 0.08,
            borderRadius: '50%',
            background: 'radial-gradient(closest-side, rgba(0,0,0,.35), rgba(0,0,0,0))',
            opacity: enter,
          }}
        />
      ) : null}
      <Img
        src={media(src)}
        style={{
          position: 'absolute',
          left: img.x,
          top: img.y,
          width: img.w,
          height: img.h,
          objectFit: 'contain',
          opacity: motion === 'drop' ? 1 : enter,
          scale: String(scale),
          translate: `${x}px ${y}px`,
          ...(plaque ? {background: '#fff', borderRadius: 28 * u, padding: 18 * u, boxSizing: 'border-box', boxShadow: '0 28px 70px rgba(0,0,0,.45)'} : {}),
        }}
      />
    </>
  );
};

// Captions ---------------------------------------------------------------

const CaptionPage = ({page, offset}) => {
  const frame = useCurrentFrame() + offset;
  const {fps, width, height} = useVideoConfig();
  const {u, brand} = useCtx();
  const c = colors(brand);
  const pop = spring({frame: frame - page.from, fps, config: {damping: 200}, durationInFrames: 6});
  const portrait = height > width;
  return (
    <div
      style={{
        position: 'absolute',
        left: 90 * u,
        right: (portrait ? 170 : 90) * u,
        bottom: height * (portrait ? 0.24 : 0.1),
        textAlign: 'center',
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: 72 * u,
        lineHeight: 1.12,
        letterSpacing: -0.5 * u,
        color: '#fff',
        WebkitTextStroke: `${12 * u}px #0b0b12`,
        paintOrder: 'stroke fill',
        scale: String(0.92 + 0.08 * pop),
        opacity: pop,
      }}
    >
      {page.words.map((w, i) => {
        const on = frame >= w.from && frame < w.to;
        return (
          <span key={i} style={{color: on ? c.accent : '#fff', display: 'inline-block', scale: on ? '1.06' : '1', margin: `0 ${9 * u}px`}}>
            {w.text}
          </span>
        );
      })}
    </div>
  );
};

export const Captions = ({events}) =>
  events.flatMap((e, k) =>
    captionPages(e.text, e.from, e.to).map((p, i) => (
      <Sequence key={`${k}-${i}`} from={p.from} durationInFrames={Math.max(1, p.to - p.from)} layout="none" name="Caption">
        <CaptionPage page={p} offset={p.from} />
      </Sequence>
    )),
  );

// AI label ---------------------------------------------------------------

export const AiLabel = ({text}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const {u} = useCtx();
  const big = frame < 2.5 * fps;
  const pill = {fontFamily: FONT, fontWeight: 700, color: '#fff', background: 'rgba(0,0,0,.55)', borderRadius: 999};
  return big ? (
    <div style={{position: 'absolute', top: 64 * u, left: 0, width, display: 'flex', justifyContent: 'center'}}>
      <div style={{...pill, fontSize: 46 * u, padding: `${12 * u}px ${30 * u}px`}}>{text}</div>
    </div>
  ) : (
    <div style={{...pill, position: 'absolute', top: 60 * u, left: 44 * u, fontSize: 28 * u, padding: `${7 * u}px ${18 * u}px`}}>{text}</div>
  );
};

// Sound effects (generated locally by the studio service) ------------------

export const Sfx = ({name, at, volume = 0.35}) => (
  <Sequence from={Math.max(0, at)} durationInFrames={30} layout="none" name={`sfx ${name}`}>
    <Audio src={staticFile(`sfx/${name}.wav`)} volume={volume} />
  </Sequence>
);
