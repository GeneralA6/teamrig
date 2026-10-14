import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ascending, keyframesIn, rulesIn, valueOf } from './stylesheet.ts';
import { FADE, Timeline, type TypingSegment } from './timeline.ts';

const CLOCK = { loop: 10, end: 9, rest: 8 } as const;

describe('Timeline', () => {
  it('refuses a clock whose rest, end and loop are out of order', () => {
    for (const clock of [
      { loop: 10, end: 9, rest: 0 },
      { loop: 10, end: 9, rest: 9 },
      { loop: 10, end: 10, rest: 8 },
    ]) {
      assert.throws(() => new Timeline(clock), RangeError);
    }
  });

  it('names its classes a0, a1, ... in the order they are made, and writes nothing before', () => {
    const t = new Timeline(CLOCK);
    assert.equal(t.css(), '');
    assert.equal(t.show(1), 'a0');
    assert.equal(t.slide([{ from: 1, duration: 1, chars: 2, reset: 3 }], 9), 'a1');
    assert.equal(t.show(2, { to: 4 }), 'a2');
    assert.equal(t.css().split('\n').length, 6);
  });
});

describe('Timeline.show', () => {
  it('fades and rises in, holds, then fades and sinks out, on keyframes that ascend', () => {
    const t = new Timeline(CLOCK);
    t.show(2, { to: 5 });
    assert.equal(
      t.css().split('\n')[0],
      '@keyframes a0{0%,20.000%{opacity:0;transform:translateY(5px)}23.000%,47.000%{opacity:1;transform:translateY(0)}50.000%,100%{opacity:0;transform:translateY(5px)}}',
    );
    const stops = keyframesIn(t.css()).get('a0')?.stops ?? [];
    assert.equal(stops.length, 6);
    assert.ok(ascending(stops), stops.join(' '));
  });

  it('only fades, with no movement, for the fade motion', () => {
    const t = new Timeline(CLOCK);
    t.show(2, { to: 5, motion: 'fade' });
    assert.doesNotMatch(t.css(), /transform/);
  });

  it('shows its part still when the rest moment falls in [from, to), and runs the class on the loop', () => {
    const t = new Timeline(CLOCK);
    const shown = [t.show(1), t.show(8, { to: 8.7 }), t.show(1, { to: 8 }), t.show(8.2)];
    const rules = rulesIn(t.css());
    const opacity = shown.map((name) => valueOf(rules.get(`.${name}`) ?? '', 'opacity'));
    assert.deepEqual(opacity, ['1', '1', '0', '0']);
    assert.equal(valueOf(rules.get('.a0') ?? '', 'animation'), 'a0 10s linear infinite');
  });

  it('shows a part until the clock ends unless told otherwise', () => {
    const t = new Timeline(CLOCK);
    t.show(1);
    assert.match(t.css(), /87\.000%\{opacity:1;transform:translateY\(0\)\}90\.000%,100%/);
  });

  it(`refuses a window of ${2 * FADE}s or less, one that starts at 0 or one that runs past the loop`, () => {
    const t = new Timeline(CLOCK);
    assert.throws(() => t.show(2, { to: 2 + 2 * FADE }), /needs more than 0.6s inside the 10s loop/);
    assert.throws(() => t.show(0, { to: 3 }), RangeError);
    assert.throws(() => t.show(5, { to: 10 }), RangeError);
    assert.doesNotThrow(() => t.show(2, { to: 2.61 }));
  });
});

describe('Timeline.slide', () => {
  const typed: TypingSegment = { from: 1, duration: 2, chars: 4, reset: 4 };

  it('steps once per character, holds at the far end, and snaps back at the reset', () => {
    const t = new Timeline(CLOCK);
    t.slide([typed], 9);
    assert.equal(
      t.css(),
      '@keyframes a0{0%{transform:translateX(0)}10.000%{transform:translateX(0);animation-timing-function:steps(4,end)}30.000%,39.800%{transform:translateX(36.0px)}40.000%{transform:translateX(0)}100%{transform:translateX(0)}}\n' +
        '.a0{animation:a0 10s linear infinite}',
    );
  });

  it('chains segments on one class, on keyframes that ascend, and leaves the part unmoved when still', () => {
    const t = new Timeline(CLOCK);
    t.slide([typed, { from: 5, duration: 0.5, chars: 3, reset: 6 }], 9);
    const block = keyframesIn(t.css()).get('a0');
    assert.ok(block !== undefined && ascending(block.stops), block?.stops.join(' '));
    assert.deepEqual([...(block?.body.matchAll(/steps\((\d+),end\)/g) ?? [])].map((found) => Number(found[1])), [4, 3]);
    assert.equal(valueOf(rulesIn(t.css()).get('.a0') ?? '', 'transform'), undefined);
  });

  it('refuses segments that type nothing, overlap, outrun their reset or leave the loop', () => {
    const refused: ReadonlyArray<readonly TypingSegment[]> = [
      [{ ...typed, chars: 0 }],
      [{ ...typed, chars: 2.5 }],
      [{ ...typed, from: 0 }],
      [typed, { ...typed, from: 3.5, reset: 6 }],
      [{ ...typed, duration: 3 }],
      [{ ...typed, reset: 10 }],
    ];
    for (const segments of refused) assert.throws(() => new Timeline(CLOCK).slide(segments, 9), /does not fit after/);
  });
});
