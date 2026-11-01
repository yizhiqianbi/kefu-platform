import React from 'react';
import {AbsoluteFill, Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig, OffthreadVideo} from 'remotion';
import {Backdrop, Callout, FONT, Headline, ProductShot, Rich, colors, fitBox, isDark, placeCallouts, useCtx, useMedia} from './parts.jsx';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const out = Easing.bezier(0.16, 1, 0.3, 1);

const aspect = (info, name) => {
  const m = (info || {})[name];
  return m && m.w && m.h ? m.w / m.h : 1;
};

// A video clip: an AI shot or real footage. fit: cover | blur (whole frame over a blurred copy).
export const ClipScene = ({s}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const media = useMedia();
  const {info} = useCtx();
  const t = frame / Math.max(1, durationInFrames);
  const zoom = s.zoom === 'out' ? interpolate(t, [0, 1], [1.12, 1]) : s.zoom === 'none' ? 1 : interpolate(t, [0, 1], [1, 1.1]);
  const trim = Math.round((Number(s.trim) || 0) * fps);
  const volume = s.volume === undefined ? 1 : Math.max(0, Math.min(1, Number(s.volume)));
  const src = media(s.src);
  const ar = aspect(info, s.src);
  const blur = s.fit === 'blur' || (s.fit !== 'cover' && Math.abs(ar - 9 / 16) / (9 / 16) > 0.3);
  return (
    <AbsoluteFill style={{background: '#000', overflow: 'hidden'}}>
      {blur ? (
        <>
          <OffthreadVideo src={src} trimBefore={trim} muted style={{objectFit: 'cover', width: '100%', height: '100%', filter: 'blur(30px) brightness(.6)', scale: '1.2'}} />
          <AbsoluteFill style={{justifyContent: 'center'}}>
            <OffthreadVideo src={src} trimBefore={trim} volume={volume} style={{objectFit: 'contain', width: '100%', scale: String(zoom)}} />
          </AbsoluteFill>
        </>
      ) : (
        <OffthreadVideo src={src} trimBefore={trim} volume={volume} style={{objectFit: 'cover', width: '100%', height: '100%', scale: String(zoom)}} />
      )}
      {s.headline || s.sub ? (
        <>
          <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 32%)'}} />
          <Headline text={s.headline} sub={s.sub} dark top={0.1} delay={4} size={88} />
        </>
      ) : null}
    </AbsoluteFill>
  );
};

// The real product photo on a clean stage, with optional callouts pointing at parts of it.
export const ProductScene = ({s}) => {
  const {width, height, fps} = useVideoConfig();
  const {info, u} = useCtx();
  const dark = isDark(s.bg);
  const hasHead = Boolean(s.headline || s.sub);
  const box = {x: width * 0.04, y: height * (hasHead ? 0.27 : 0.2), w: width * 0.92, h: height * 0.46};
  const ar = aspect(info, s.src);
  const img = fitBox(box, ar);
  const callouts = placeCallouts((s.callouts || []).slice(0, 4), img, width, u);
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <Backdrop bg={s.bg || 'light'} src={s.bg_src || s.src} />
      <ProductShot src={s.src} ar={ar} box={box} motion={s.motion || 'push'} plaque={s.bg === 'scene' && !(info[s.src] || {}).alpha} />
      {callouts.map((c) => (
        <Callout key={c.i} {...c} delay={Math.round((0.45 + c.i * 0.45) * fps)} dark={dark} />
      ))}
      <Headline text={s.headline} sub={s.sub} dark={dark} top={0.1} delay={2} />
    </AbsoluteFill>
  );
};

// One big number counting up, with its label; optionally the product below.
export const StatScene = ({s}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const {u, brand, info} = useCtx();
  const c = colors(brand);
  const bg = s.bg || 'dark';
  const dark = isDark(bg);
  const value = Number(s.value) || 0;
  const dec = Math.max(0, Math.min(2, Number(s.decimals) || 0));
  const p = interpolate(frame, [3, Math.round(0.9 * fps)], [0, 1], {...clamp, easing: out});
  const shown = (value * p).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, value >= 10000 ? ',' : '');
  const pop = spring({frame, fps, config: {damping: 12}});
  const lab = spring({frame: frame - Math.round(0.5 * fps), fps, config: {damping: 200}});
  const final = value.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, value >= 10000 ? ',' : '');
  const est = 0.6 * final.length + 0.6 * 0.46 * String(s.prefix || '').length + 0.6 * 0.44 * String(s.suffix || '').length;
  const size = 250 * Math.min(1, (width / u - 120) / (250 * est));
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <Backdrop bg={bg} src={s.bg_src} />
      <div style={{position: 'absolute', top: height * 0.2, left: 0, width, textAlign: 'center', fontFamily: FONT}}>
        <div style={{fontWeight: 900, fontSize: size * u, lineHeight: 1, letterSpacing: -0.03 * size * u, whiteSpace: 'nowrap', color: dark ? '#fff' : c.ink, scale: String(0.85 + 0.15 * pop)}}>
          <span style={{fontSize: size * 0.48 * u, letterSpacing: 0}}>{s.prefix || ''}</span>
          {shown}
          <span style={{fontSize: size * 0.44 * u, letterSpacing: 0, color: c.accent}}>{s.suffix || ''}</span>
        </div>
        <div style={{marginTop: 26 * u, fontWeight: 700, fontSize: 54 * u, color: dark ? 'rgba(255,255,255,.85)' : '#3d4052', opacity: lab, translate: `0 ${(1 - lab) * 24 * u}px`}}>
          {s.label}
        </div>
      </div>
      {s.src ? (
        <ProductShot src={s.src} ar={aspect(info, s.src)} box={{x: width * 0.2, y: height * 0.5, w: width * 0.6, h: height * 0.26}} motion="float" delay={6} />
      ) : null}
    </AbsoluteFill>
  );
};

// 2-4 spec cards sliding in next to the product.
export const SpecsScene = ({s}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const {u, brand, info} = useCtx();
  const c = colors(brand);
  const bg = s.bg || 'light';
  const dark = isDark(bg);
  const items = (s.items || []).slice(0, 4);
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <Backdrop bg={bg} src={s.bg_src} />
      <Headline text={s.title} dark={dark} top={0.1} size={84} />
      {s.src ? (
        <ProductShot src={s.src} ar={aspect(info, s.src)} box={{x: width * 0.06, y: height * 0.27, w: width * 0.88, h: height * 0.27}} motion="float" />
      ) : null}
      <div style={{position: 'absolute', top: height * (s.src ? 0.57 : 0.3), left: 80 * u, right: 80 * u, display: 'flex', flexDirection: 'column', gap: 22 * u}}>
        {items.map((it, i) => {
          const p = spring({frame: frame - Math.round((0.3 + i * 0.28) * fps), fps, config: {damping: 200}});
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 26 * u,
                padding: `${20 * u}px ${32 * u}px`,
                borderRadius: 24 * u,
                background: dark ? 'rgba(255,255,255,.1)' : '#fff',
                boxShadow: dark ? 'none' : `0 ${10 * u}px ${30 * u}px rgba(20,21,31,.08)`,
                borderLeft: `${10 * u}px solid ${c.accent}`,
                fontFamily: FONT,
                opacity: p,
                translate: `${(1 - p) * 120 * u}px 0`,
              }}
            >
              <div style={{fontWeight: 900, fontSize: 66 * u, color: dark ? '#fff' : c.ink, whiteSpace: 'nowrap'}}>{it.value}</div>
              <div style={{fontWeight: 600, fontSize: 38 * u, color: dark ? 'rgba(255,255,255,.8)' : '#4a4d5e', lineHeight: 1.2}}>{it.label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// A real photo (factory, workshop, use scene) with a slow camera move.
export const PhotoScene = ({s}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const media = useMedia();
  const t = frame / Math.max(1, durationInFrames);
  const m = s.motion || 'in';
  const scale = m === 'out' ? interpolate(t, [0, 1], [1.18, 1.04]) : interpolate(t, [0, 1], [1.04, 1.18]);
  const x = m === 'left' ? interpolate(t, [0, 1], [4, -4]) : m === 'right' ? interpolate(t, [0, 1], [-4, 4]) : 0;
  return (
    <AbsoluteFill style={{background: '#000', overflow: 'hidden'}}>
      <Img src={media(s.src)} style={{width: '100%', height: '100%', objectFit: 'cover', scale: String(m === 'left' || m === 'right' ? 1.15 : scale), translate: `${x}% 0`}} />
      <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(8,9,20,.7) 0%, rgba(8,9,20,0) 38%, rgba(8,9,20,0) 60%, rgba(8,9,20,.55) 100%)'}} />
      <Headline text={s.headline} sub={s.sub} dark top={0.1} delay={3} size={90} />
    </AbsoluteFill>
  );
};

// Big kinetic words. *word* is accented.
export const TitleScene = ({s}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const {u, brand} = useCtx();
  const c = colors(brand);
  const bg = s.bg || 'dark';
  const dark = isDark(bg);
  const lines = (s.lines || []).slice(0, 4);
  const words = lines.flatMap((l, li) =>
    String(l)
      .split(/(\*[^*]+\*)/)
      .flatMap((part) => {
        const acc = part.startsWith('*') && part.endsWith('*') && part.length > 2;
        return (acc ? part.slice(1, -1) : part).split(/\s+/).filter(Boolean).map((w) => ({w, li, acc}));
      }),
  );
  const step = Math.max(2, Math.round(Math.min(0.12 * fps, (0.6 * fps) / Math.max(1, words.length))));
  let k = 0;
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <Backdrop bg={bg} src={s.bg_src} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', padding: `0 ${90 * u}px`, paddingBottom: height * 0.12}}>
        <div style={{fontFamily: FONT, fontWeight: 900, fontSize: (s.size === 'xl' ? 150 : 118) * u, lineHeight: 1.02, letterSpacing: -3 * u, textAlign: 'center', color: dark ? '#fff' : c.ink}}>
          {lines.map((l, li) => (
            <div key={li}>
              {words
                .filter((x) => x.li === li)
                .map((x, wi) => {
                  const p = spring({frame: frame - k++ * step, fps, config: {damping: 13, stiffness: 160}});
                  return (
                    <span key={wi} style={{display: 'inline-block', margin: `0 ${14 * u}px`, opacity: Math.min(1, p * 1.4), scale: String(0.6 + 0.4 * p), color: x.acc ? c.accent : undefined}}>
                      {x.w}
                    </span>
                  );
                })}
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const EndScene = ({s}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const {u, brand, info, logo} = useCtx();
  const media = useMedia();
  const c = colors(brand);
  const a = spring({frame, fps, config: {damping: 200}});
  const b = spring({frame: frame - Math.round(0.35 * fps), fps, config: {damping: 200}});
  const pulse = 1 + 0.03 * Math.sin(frame / 5);
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <Backdrop bg="dark" />
      {logo ? (
        <div style={{position: 'absolute', top: height * 0.09, left: width * 0.22, width: width * 0.56, height: 170 * u, borderRadius: 28 * u, background: '#fff', opacity: a, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <Img src={media(logo)} style={{width: '82%', height: '62%', objectFit: 'contain'}} />
        </div>
      ) : null}
      {s.src ? <ProductShot src={s.src} ar={aspect(info, s.src)} box={{x: width * 0.15, y: height * 0.22, w: width * 0.7, h: height * 0.28}} motion="float" shadow={false} /> : null}
      <div style={{position: 'absolute', top: height * (s.src ? 0.54 : 0.36), left: 80 * u, right: 80 * u, textAlign: 'center', fontFamily: FONT}}>
        <div style={{fontWeight: 900, fontSize: 104 * u, lineHeight: 1.04, letterSpacing: -2 * u, color: '#fff', opacity: a, translate: `0 ${(1 - a) * 30 * u}px`}}>
          <Rich text={s.cta} accent={c.accent} />
        </div>
        {s.contact ? (
          <div
            style={{
              display: 'inline-block',
              marginTop: 48 * u,
              padding: `${20 * u}px ${44 * u}px`,
              borderRadius: 999,
              background: c.accent,
              color: '#fff',
              fontWeight: 800,
              fontSize: 50 * u,
              opacity: b,
              scale: String(pulse * (0.9 + 0.1 * b)),
            }}
          >
            {s.contact}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

export const SCENES = {clip: ClipScene, product: ProductScene, stat: StatScene, specs: SpecsScene, photo: PhotoScene, title: TitleScene, end: EndScene};
