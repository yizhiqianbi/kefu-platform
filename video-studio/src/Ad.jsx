import React, {useContext} from 'react';
import {AbsoluteFill, Easing, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig, OffthreadVideo} from 'remotion';
import {Audio} from '@remotion/media';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {wipe} from '@remotion/transitions/wipe';
import {flip} from '@remotion/transitions/flip';
import {layout} from './layout.js';
import {AiLabel, Captions, Ctx, Sfx, useMedia} from './parts.jsx';
import {SCENES, EndScene} from './scenes.jsx';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};

const presentation = (name) =>
  name === 'slide' ? slide({direction: 'from-right'}) : name === 'wipe' ? wipe({direction: 'from-left'}) : name === 'flip' ? flip() : fade();

const Scene = ({s}) => {
  const C = SCENES[s.type] || SCENES.title;
  return <C s={s} />;
};

// The talking head under everything; `zooms` are punch-ins ({at, scale}) cut on the beat.
const AvatarBase = ({avatar}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const media = useMedia();
  const zs = (avatar.zooms || []).slice().sort((a, b) => a.at - b.at);
  let scale = 1;
  for (const z of zs) {
    const f = Math.round(z.at * fps);
    if (frame >= f) scale = interpolate(frame, [f, f + 3], [scale, Math.max(1, Math.min(1.6, Number(z.scale) || 1))], clamp);
  }
  return (
    <AbsoluteFill style={{background: '#000', overflow: 'hidden'}}>
      <OffthreadVideo src={media(avatar.src)} style={{objectFit: 'cover', width: '100%', height: '100%', scale: String(scale), transformOrigin: '50% 32%'}} />
    </AbsoluteFill>
  );
};

const Pip = ({avatar, from}) => {
  const {width, height} = useVideoConfig();
  const media = useMedia();
  const size = width * 0.25;
  return (
    <div style={{position: 'absolute', top: height * 0.05, right: width * 0.04, width: size, height: size, borderRadius: '50%', overflow: 'hidden', border: `${size * 0.03}px solid #fff`, boxShadow: '0 10px 30px rgba(0,0,0,.35)'}}>
      <OffthreadVideo src={media(avatar.src)} trimBefore={from} muted style={{objectFit: 'cover', width: '100%', height: '140%', marginTop: '-8%'}} />
    </div>
  );
};

const Overlay = ({o, avatar}) => {
  const frame = useCurrentFrame();
  const ctx = useContext(Ctx);
  const k = Math.min(5, Math.floor(o.dur / 3));
  const opacity = interpolate(frame, [0, k, o.dur - k, o.dur], [0, 1, 1, 0], {...clamp, easing: Easing.inOut(Easing.quad)});
  const pip = o.layout === 'pip';
  return (
    <AbsoluteFill style={{opacity}}>
      <Ctx.Provider value={{...ctx, pip}}>
        <Scene s={{...o, volume: 0}} />
      </Ctx.Provider>
      {pip ? <Pip avatar={avatar} from={o.from} /> : null}
    </AbsoluteFill>
  );
};

const Music = ({src, volume, total, quiet}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const v = Math.max(0, Math.min(1, Number(volume) || (quiet ? 0.1 : 0.22)));
  return (
    <Audio
      src={src}
      loop
      volume={interpolate(frame, [0, 0.5 * fps, total - fps, total], [0, v, v, 0], clamp)}
    />
  );
};

export const Ad = (props) => {
  const L = layout(props);
  const {width, height} = useVideoConfig();
  const ctx = {base: props.base || '', brand: props.brand || {}, info: props.info || {}, logo: props.logo || '', u: Math.min(width, height) / 1080};
  const sfx = props.sfx !== false;
  const cues = [];
  if (sfx && L.mode === 'scenes') {
    L.scenes.forEach((s) => {
      if (s.i > 0 && s.tin > 0) cues.push({name: 'whoosh', at: s.from});
      if (s.type === 'stat') cues.push({name: 'pop', at: s.from + 3});
      (s.type === 'product' ? (s.callouts || []).slice(0, 4) : []).forEach((c, i) => cues.push({name: 'pop', at: s.from + Math.round((0.45 + i * 0.45) * L.fps) + 10, v: 0.25}));
    });
  }
  if (sfx && L.mode === 'avatar') L.overlays.forEach((o) => cues.push({name: 'whoosh', at: o.from, v: 0.2}));
  return (
    <Ctx.Provider value={ctx}>
      <AbsoluteFill style={{background: '#000'}}>
        {L.mode === 'scenes' ? (
          <TransitionSeries>
            {L.scenes.flatMap((s) => [
              s.i > 0 && s.tin > 0 ? (
                <TransitionSeries.Transition key={`t${s.i}`} presentation={presentation(s.transition)} timing={linearTiming({durationInFrames: s.tin})} />
              ) : null,
              <TransitionSeries.Sequence key={`s${s.i}`} durationInFrames={s.dur} name={`${s.i + 1} ${s.type}`}>
                <Scene s={s} />
              </TransitionSeries.Sequence>,
            ].filter(Boolean))}
          </TransitionSeries>
        ) : (
          <>
            <Sequence durationInFrames={L.base} name="avatar">
              <AvatarBase avatar={props.avatar} />
            </Sequence>
            {L.overlays.map((o) => (
              <Sequence key={o.i} from={o.from} durationInFrames={o.dur} name={`${o.i + 1} ${o.type}`}>
                <Overlay o={o} avatar={props.avatar} />
              </Sequence>
            ))}
            {L.end ? (
              <Sequence from={L.end.from} durationInFrames={L.end.dur} name="end">
                <EndScene s={L.end} />
              </Sequence>
            ) : null}
          </>
        )}
        <Captions events={L.captions} />
        {props.label ? <AiLabel text={props.label} /> : null}
        {cues.map((c, i) => (
          <Sfx key={i} name={c.name} at={c.at} volume={c.v} />
        ))}
        {props.music && props.music.src ? (
          <Music src={ctx.base + encodeURIComponent(props.music.src)} volume={props.music.volume} total={L.total} quiet={L.mode === 'avatar'} />
        ) : props.bed !== false ? (
          <Music src={staticFile('sfx/bed.wav')} volume={L.mode === 'avatar' ? 0.08 : 0.25} total={L.total} quiet={L.mode === 'avatar'} />
        ) : null}
      </AbsoluteFill>
    </Ctx.Provider>
  );
};
