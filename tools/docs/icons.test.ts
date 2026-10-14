import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { icon, ICON_GRID, ICON_NAMES } from './icons.ts';
import { parseXml, placesIn } from './xml.ts';

describe('icon', () => {
  it('places an icon at its corner, scaled from the 24-unit grid to its size, in the class it is given', () => {
    assert.match(icon('done', 10, 20, 36, 'icon done'), /^<g transform="translate\(10 20\) scale\(1\.5\)" class="icon done"><circle /);
    assert.equal(ICON_GRID, 24);
  });

  it('draws every icon as well-formed lines and shapes with no colour of its own', () => {
    assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
    for (const name of ICON_NAMES) {
      const shapes = placesIn(parseXml(icon(name, 0, 0, 24, 'icon'))).slice(1);
      assert.ok(shapes.length > 0, name);
      for (const { element } of shapes) {
        assert.ok(['path', 'circle', 'rect'].includes(element.name), `${name}: <${element.name}>`);
        assert.ok(!element.attributes.has('fill') && !element.attributes.has('stroke'), `${name} sets its own colour`);
      }
    }
  });
});
