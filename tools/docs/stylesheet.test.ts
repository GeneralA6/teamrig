import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';

const CSS = [
  '.mono{font-family:x}.sans{font-family:y}',
  '@keyframes a0{0%,10.000%{opacity:0}20%,80%{opacity:1}90%,100%{opacity:0}}',
  '.a0{opacity:1;animation:a0 17s linear infinite}',
  '@keyframes flow{to{stroke-dashoffset:-20}}',
  '@keyframes blink{from{opacity:1}50%{opacity:0}}',
  '@media (prefers-reduced-motion:reduce){.a0{animation:none}}',
  '.a0{fill:red}',
].join('\n');

describe('keyframesIn', () => {
  it('reads each block with its stops in written order, from and to as 0 and 100', () => {
    const blocks = keyframesIn(CSS);
    assert.deepEqual([...blocks.keys()], ['a0', 'flow', 'blink']);
    assert.deepEqual(blocks.get('a0')?.stops, [0, 10, 20, 80, 90, 100]);
    assert.deepEqual(blocks.get('flow'), { stops: [100], body: 'to{stroke-dashoffset:-20}' });
    assert.deepEqual(blocks.get('blink')?.stops, [0, 50]);
  });

  it('refuses a stop that is not a percentage, from or to', () => {
    assert.throws(() => keyframesIn('@keyframes x{half{opacity:0}}'), /not a keyframe stop: half/);
  });
});

describe('mediaIn', () => {
  it('reads each block by its condition', () => {
    assert.deepEqual([...mediaIn(CSS)], [['(prefers-reduced-motion:reduce)', '.a0{animation:none}']]);
  });
});

describe('rulesIn', () => {
  it('reads the top-level rules only, joining a selector given twice', () => {
    const rules = rulesIn(CSS);
    assert.deepEqual([...rules.keys()], ['.mono', '.sans', '.a0']);
    assert.equal(rules.get('.a0'), 'opacity:1;animation:a0 17s linear infinite;fill:red');
  });
});

describe('valueOf', () => {
  it("finds one property's value, trimmed, or nothing", () => {
    assert.equal(valueOf('opacity: 0 ;animation:a0 17s', 'opacity'), '0');
    assert.equal(valueOf('opacity:0;animation:a0 17s', 'animation'), 'a0 17s');
    assert.equal(valueOf('opacity:0;broken', 'fill'), undefined);
  });
});

describe('animationsIn', () => {
  it('names the animation each top-level rule runs, skipping none and the rules inside @media', () => {
    assert.deepEqual([...animationsIn(`${CSS}\n.still{animation:none}.blink{animation:blink 1s steps(1,end) infinite}`)], [
      ['.a0', 'a0'],
      ['.blink', 'blink'],
    ]);
  });
});

describe('ascending', () => {
  it('holds when each stop is past the one before', () => {
    assert.equal(ascending([0, 10, 10.5, 100]), true);
    assert.equal(ascending([]), true);
    assert.equal(ascending([0, 10, 10]), false);
    assert.equal(ascending([0, 20, 10]), false);
  });
});
