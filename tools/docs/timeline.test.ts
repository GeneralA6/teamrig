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

describe('Timeline.pop', () => {
  it('grows in past full size about its own centre, settles, holds, then fades out', () => {
    const t = new Timeline(CLOCK);
    t.pop(2, { to: 5 });
    assert.equal(
      t.css(),
      '@keyframes a0{0%,20.000%{opacity:0;transform:scale(.2)}22.200%{opacity:1;transform:scale(1.15)}24.000%,47.000%{opacity:1;transform:scale(1)}50.000%,100%{opacity:0;transform:scale(1)}}\n' +
        '.a0{transform-box:fill-box;transform-origin:center;opacity:0;animation:a0 10s linear infinite}',
    );
    assert.ok(ascending(keyframesIn(t.css()).get('a0')?.stops ?? []));
  });

  it('stays until the clock ends unless told otherwise, shows still when the rest moment falls inside, and takes an overshoot', () => {
    const t = new Timeline(CLOCK);
    t.pop(1, { overshoot: 1.3 });
    assert.match(t.css(), /scale\(1\.3\)/);
    assert.match(t.css(), /87\.000%\{opacity:1;transform:scale\(1\)\}90\.000%,100%/);
    assert.equal(valueOf(rulesIn(t.css()).get('.a0') ?? '', 'opacity'), '1');
  });

  it('refuses a part that starts at 0, has no time to settle before it fades, or leaves the loop', () => {
    const t = new Timeline(CLOCK);
    assert.throws(() => t.pop(0), RangeError);
    assert.throws(() => t.pop(2, { to: 2.69 }), /needs more than 0.7s inside the 10s loop/);
    assert.throws(() => t.pop(2, { to: 10 }), RangeError);
    assert.doesNotThrow(() => t.pop(2, { to: 2.71 }));
  });
});

describe('Timeline.draw', () => {
  it('draws the line from its start, holds it, then fades it out', () => {
    const t = new Timeline(CLOCK);
    t.draw(2, 120, { to: 5 });
    assert.equal(
      t.css(),
      '@keyframes a0{0%,20.000%{stroke-dashoffset:120;opacity:1}23.500%,47.000%{stroke-dashoffset:0;opacity:1}50.000%,100%{stroke-dashoffset:0;opacity:0}}\n' +
        '.a0{opacity:0;animation:a0 10s linear infinite}',
    );
  });

  it('takes a drawing time, stays until the clock ends unless told otherwise, and shows still when the rest moment falls inside', () => {
    const t = new Timeline(CLOCK);
    t.draw(1, 50, { duration: 2 });
    assert.match(t.css(), /30\.000%,87\.000%\{stroke-dashoffset:0;opacity:1\}90\.000%,100%/);
    assert.equal(valueOf(rulesIn(t.css()).get('.a0') ?? '', 'opacity'), '1');
    assert.ok(ascending(keyframesIn(t.css()).get('a0')?.stops ?? []));
  });

  it('refuses no length, a start at 0, no drawing time, a line not drawn before it fades, or one that leaves the loop', () => {
    const t = new Timeline(CLOCK);
    assert.throws(() => t.draw(2, 0), RangeError);
    assert.throws(() => t.draw(0, 10), RangeError);
    assert.throws(() => t.draw(2, 10, { duration: 0 }), RangeError);
    assert.throws(() => t.draw(2, 10, { to: 2.65 }), /a 10px line drawn from 2s for 0.35s and gone at 2.65s does not fit the 10s loop/);
    assert.throws(() => t.draw(2, 10, { to: 10 }), RangeError);
    assert.doesNotThrow(() => t.draw(2, 10, { to: 2.66 }));
  });
});

describe('Timeline.steps', () => {
  const ease = 'animation-timing-function:cubic-bezier(.45,0,.25,1)';
  const half = { at: 2, duration: 1, value: 'scale(.5)' } as const;
  const quarter = { at: 5, duration: 1, value: 'scale(.25)' } as const;

  it('holds the start, eases to each stop and holds it, and opens its rule with the extra declarations', () => {
    const t = new Timeline(CLOCK);
    t.steps('scale(1)', [half, quarter], 'transform-origin:0 0;');
    assert.equal(
      t.css(),
      `@keyframes a0{0%,20.000%{transform:scale(1);${ease}}30.000%,50.000%{transform:scale(.5);${ease}}60.000%,100%{transform:scale(.25);${ease}}}\n` +
        '.a0{transform-origin:0 0;transform:scale(.25);animation:a0 10s linear infinite}',
    );
    assert.ok(ascending(keyframesIn(t.css()).get('a0')?.stops ?? []));
  });

  it('shows still the last value reached by the rest moment, or the start when none is', () => {
    const t = new Timeline(CLOCK);
    t.steps('scale(1)', [half, { at: 7.5, duration: 1, value: 'scale(.1)' }]);
    t.steps('scale(1)', [{ at: 8.5, duration: 1, value: 'scale(.1)' }]);
    const rules = rulesIn(t.css());
    assert.deepEqual(['.a0', '.a1'].map((name) => valueOf(rules.get(name) ?? '', 'transform')), ['scale(.5)', 'scale(1)']);
  });

  it('refuses no stops, and stops that start at 0, take no time, overlap or leave the loop', () => {
    assert.throws(() => new Timeline(CLOCK).steps('none', []), /needs at least one stop/);
    const refused: ReadonlyArray<readonly { at: number; duration: number; value: string }[]> = [
      [{ ...half, at: 0 }],
      [{ ...half, duration: 0 }],
      [half, { ...quarter, at: 2.5 }],
      [{ ...half, at: 9 }],
    ];
    for (const stops of refused) assert.throws(() => new Timeline(CLOCK).steps('none', stops), /does not fit after/);
  });
});
