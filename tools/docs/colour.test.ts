import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, luminance, mix } from './colour.ts';

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

describe('mix', () => {
  it('lays a colour over another at an opacity, channel by channel', () => {
    assert.equal(mix('#000000', '#ffffff', 0), '#ffffff');
    assert.equal(mix('#000000', '#ffffff', 1), '#000000');
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(mix('#FF0000', '#0000ff', 0.25), '#4000bf');
  });

  it('refuses an opacity outside 0 to 1, or a colour that is not #rrggbb', () => {
    for (const opacity of [-0.1, 1.1, Number.NaN]) assert.throws(() => mix('#000000', '#ffffff', opacity), /not an opacity/);
    assert.throws(() => mix('#000', '#ffffff', 0.5), /not a #rrggbb colour/);
    assert.throws(() => mix('#000000', 'white', 0.5), /not a #rrggbb colour/);
  });
});
