import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyframesIn } from './stylesheet.ts';
import { lineParts, trackMarks, type Line, type Look } from './story.ts';
import { mark } from './terminal-view.ts';
import { FADE, Timeline } from './timeline.ts';

const CLOCK = { loop: 10, end: 9, rest: 8 } as const;
const draw = (status: Parameters<typeof mark>[0]): string => mark(status, 10, 10);

describe('trackMarks', () => {
  it('draws a held status as one still mark, with no animation', () => {
    const t = new Timeline(CLOCK);
    assert.deepEqual(trackMarks(t, 'working', CLOCK.end, draw), [draw('working')]);
    assert.equal(t.css(), '');
  });

  it('shows each change from its moment until the next, and the last until the end it is given', () => {
    const t = new Timeline(CLOCK);
    const parts = trackMarks(t, [{ status: 'needs-you', at: 1 }, { status: 'working', at: 4 }], 7, draw);
    assert.deepEqual(parts, [`<g class="a0">${draw('needs-you')}</g>`, `<g class="a1">${draw('working')}</g>`]);
    const frames = keyframesIn(t.css());
    const percent = (seconds: number): number => Number(((seconds / CLOCK.loop) * 100).toFixed(3));
    assert.deepEqual(frames.get('a0')?.stops, [0, percent(1), percent(1 + FADE), percent(4 - FADE), percent(4), 100]);
    assert.deepEqual(frames.get('a1')?.stops, [0, percent(4), percent(4 + FADE), percent(7 - FADE), percent(7), 100]);
  });
});

describe('lineParts', () => {
  const line = (look: Look): Line => ({ y: 100, from: 1, words: 'Tests pass.', look });

  it('puts your ask after the prompt mark', () => {
    assert.deepEqual(lineParts(line('ask')), ['<text x="24" y="100" class="mono accent">&gt;</text>', '<text x="42" y="100" class="mono">Tests pass.</text>']);
  });

  it('gives a said line and a command the bullet, the command in the accent colour', () => {
    const [saidBullet, said] = lineParts(line('said'));
    const [commandBullet, command] = lineParts(line('command'));
    assert.ok(saidBullet?.startsWith('<circle cx="28.5" cy="95.5"'), saidBullet);
    assert.equal(commandBullet, saidBullet);
    assert.equal(said, '<text x="42" y="100" class="mono">Tests pass.</text>');
    assert.equal(command, '<text x="42" y="100" class="mono accent">Tests pass.</text>');
  });

  it('mutes a tool output, with no bullet', () => {
    assert.deepEqual(lineParts(line('output')), ['<text x="42" y="100" class="mono muted">Tests pass.</text>']);
  });
});
