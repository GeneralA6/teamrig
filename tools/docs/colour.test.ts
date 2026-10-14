import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, luminance } from './colour.ts';

describe('contrast', () => {
  it('measures contrast the WCAG way, whichever colour comes first', () => {
    assert.equal(contrast('#000000', '#ffffff'), 21);
    assert.equal(contrast('#FFFFFF', '#000000'), 21);
    assert.equal(contrast('#777777', '#777777'), 1);
    assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
  });
});

describe('luminance', () => {
  it('runs from 0 for black to 1 for white, and refuses anything but #rrggbb', () => {
    assert.equal(luminance('#000000'), 0);
    assert.equal(luminance('#ffffff'), 1);
    for (const colour of ['#fff', 'ffffff', '#gggggg', 'red']) assert.throws(() => luminance(colour), /not a #rrggbb colour/);
  });
});
