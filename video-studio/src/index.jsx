import React from 'react';
import {Composition, registerRoot, staticFile} from 'remotion';
import {loadFont} from '@remotion/fonts';
import {Ad} from './Ad.jsx';
import {Cover} from './Cover.jsx';
import {layout} from './layout.js';

for (const [file, weight] of [['Inter-SemiBold.ttf', '600'], ['Inter-Bold.ttf', '700'], ['Inter-ExtraBold.ttf', '800'], ['Inter-Black.ttf', '900']]) {
  loadFont({family: 'Inter', url: staticFile(`fonts/${file}`), weight});
}

const sample = {
  width: 1080,
  height: 1920,
  fps: 30,
  label: 'AI-generated',
  brand: {dark: '#1f2147', accent: '#e8662a'},
  scenes: [{type: 'title', seconds: 2, lines: ['Hello *Remotion*']}],
};

const Root = () => (
  <>
  <Composition
    id="Ad"
    component={Ad}
    defaultProps={sample}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={60}
    calculateMetadata={({props}) => {
      const L = layout(props);
      return {durationInFrames: Math.max(1, L.total), width: L.width, height: L.height, fps: L.fps};
    }}
  />
  <Composition
    id="Cover"
    component={Cover}
    defaultProps={{title: 'Hello *Cover*', label: 'AI-generated'}}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={1}
    calculateMetadata={({props}) => ({width: props.width || 1080, height: props.height || 1920})}
  />
  </>
);

registerRoot(Root);
