import React from 'react';
import {AbsoluteFill, Img, useVideoConfig} from 'remotion';
import {Ctx, FONT, Rich, colors, fitBox, useMedia} from './parts.jsx';

// A still: cover for a video or a poster. The background may be AI-made; the product is always the real photo.
// Portrait and square stack title / product / points; landscape puts the text on the left and the product on the right.

const Background = ({src, brand}) => {
  const media = useMedia();
  const c = colors(brand);
  if (!src) {
    return <AbsoluteFill style={{background: `radial-gradient(120% 75% at 50% 45%, #3a3d78 0%, ${c.dark} 55%, #0d0e22 100%)`}} />;
  }
  return (
    <AbsoluteFill style={{background: '#111'}}>
      <Img src={media(src)} style={{width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.78) saturate(1.05)'}} />
    </AbsoluteFill>
  );
};

const Product = ({src, box, alpha, bottom = 1, u}) => {
  const media = useMedia();
  return (
    <>
      <div
        style={{
          position: 'absolute', left: box.x + box.w * 0.1, width: box.w * 0.8, top: box.y + box.h * (alpha ? bottom - 0.05 : 0.95), height: box.h * 0.1, borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(0,0,0,.5), rgba(0,0,0,0))',
        }}
      />
      <Img
        src={media(src)}
        style={{
          position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, objectFit: 'contain',
          ...(alpha ? {filter: 'drop-shadow(0 24px 40px rgba(0,0,0,.35))'} : {background: '#fff', borderRadius: 28 * u, padding: 20 * u, boxSizing: 'border-box',
            boxShadow: '0 30px 80px rgba(0,0,0,.5)'}),
        }}
      />
    </>
  );
};

const Points = ({points, accent, u, align, size = 34}) =>
  points.length ? (
    <div style={{display: 'flex', flexWrap: 'wrap', gap: 14 * u, justifyContent: align === 'left' ? 'flex-start' : 'center'}}>
      {points.map((p, i) => (
        <div key={i} style={{fontFamily: FONT, fontWeight: 800, fontSize: size * u, color: '#fff', padding: `${size * 0.3 * u}px ${size * 0.7 * u}px`, borderRadius: 999,
          background: 'rgba(0,0,0,.45)', border: `${3 * u}px solid ${accent}`}}>{p}</div>
      ))}
    </div>
  ) : null;

export const Cover = (props) => {
  const {width, height} = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const c = colors(props.brand);
  const info = props.info || {};
  const ctx = {base: props.base || '', brand: props.brand || {}, info, logo: props.logo || '', u};
  const land = width > height * 1.2;
  const portrait = height >= width * 1.5;
  const tall = !portrait && height > width * 1.1;
  const points = (props.points || []).filter(Boolean).slice(0, 3);
  const m = info[props.src] || {};
  const ar = m.w && m.h ? m.w / m.h : 1;
  const area = land
    ? {x: width * 0.5, y: height * 0.12, w: width * 0.46, h: height * 0.76}
    : portrait
      ? {x: width * 0.04, y: height * 0.33, w: width * 0.92, h: height * 0.4}
      : tall
        ? {x: width * 0.1, y: height * 0.42, w: width * 0.8, h: height * 0.36}
        : {x: width * 0.14, y: height * 0.41, w: width * 0.72, h: height * 0.38};
  const box = fitBox(area, ar);
  const title = {fontFamily: FONT, fontWeight: 900, color: '#fff', lineHeight: 1.05, textWrap: 'balance', letterSpacing: -1 * u, textShadow: '0 4px 24px rgba(0,0,0,.45)'};
  const sub = {fontFamily: FONT, fontWeight: 700, color: 'rgba(255,255,255,.92)', lineHeight: 1.25, textWrap: 'balance', textShadow: '0 2px 12px rgba(0,0,0,.5)'};
  const media = (name) => (name ? ctx.base + encodeURIComponent(name) : '');
  const logo = props.logo ? (
    <div style={{background: '#fff', borderRadius: 18 * u, padding: `${12 * u}px ${20 * u}px`, display: 'inline-flex'}}>
      <Img src={media(props.logo)} style={{height: (portrait || land ? 56 : 44) * u, maxWidth: 300 * u, objectFit: 'contain'}} />
    </div>
  ) : null;
  const cta = props.cta ? (
    <div style={{fontFamily: FONT, fontWeight: 800, fontSize: (portrait ? 50 : 38) * u, color: '#fff', background: c.accent, borderRadius: 16 * u, padding: `${16 * u}px ${30 * u}px`,
      display: 'inline-block'}}>{props.cta}</div>
  ) : null;
  return (
    <Ctx.Provider value={ctx}>
      <AbsoluteFill style={{overflow: 'hidden'}}>
        <Background src={props.bg_src} brand={props.brand} />
        <AbsoluteFill style={{background: land
          ? 'linear-gradient(90deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.35) 48%, rgba(0,0,0,0) 70%)'
          : 'linear-gradient(180deg, rgba(0,0,0,.65) 0%, rgba(0,0,0,.1) 34%, rgba(0,0,0,0) 60%, rgba(0,0,0,.7) 100%)'}} />
        {props.src ? <Product src={props.src} box={box} alpha={Boolean(m.alpha)} bottom={m.bottom || 1} u={u} /> : null}
        {land ? (
          <div style={{position: 'absolute', left: width * 0.06, top: height * 0.12, width: width * 0.42, display: 'flex', flexDirection: 'column', gap: 30 * u}}>
            {logo}
            <div style={{...title, fontSize: 104 * u}}><Rich text={props.title} accent={c.accent} /></div>
            {props.sub ? <div style={{...sub, fontSize: 44 * u}}>{props.sub}</div> : null}
            <Points points={points} accent={c.accent} u={u} align="left" />
            {cta ? <div>{cta}</div> : null}
          </div>
        ) : (
          <>
            <div style={{position: 'absolute', left: width * 0.07, right: width * 0.07, top: height * (portrait ? 0.07 : 0.045), display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: (portrait ? 22 : 14) * u, textAlign: 'center'}}>
              {logo}
              <div style={{...title, fontSize: (portrait ? 118 : 84) * u}}><Rich text={props.title} accent={c.accent} /></div>
              {props.sub ? <div style={{...sub, fontSize: (portrait ? 46 : 34) * u}}>{props.sub}</div> : null}
            </div>
            <div style={{position: 'absolute', left: width * 0.06, right: width * 0.06, bottom: height * (portrait ? 0.07 : 0.045), display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: (portrait ? 24 : 14) * u}}>
              <Points points={points} accent={c.accent} u={u} size={portrait ? 44 : 30} />
              {cta}
            </div>
          </>
        )}
        {props.label ? (
          <div style={{position: 'absolute', right: 28 * u, bottom: 24 * u, fontFamily: FONT, fontWeight: 700, fontSize: 24 * u, color: '#fff',
            background: 'rgba(0,0,0,.55)', borderRadius: 999, padding: `${6 * u}px ${16 * u}px`}}>{props.label}</div>
        ) : null}
      </AbsoluteFill>
    </Ctx.Provider>
  );
};
