import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, renderSvg } from './svg.ts';
import { parseXml, textOf } from './xml.ts';

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    assert.equal(escapeXml(`a&b<c>d"e'f &amp;`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f &amp;amp;');
  });
});

describe('renderSvg', () => {
  const svg = renderSvg({ width: 40, height: 20, label: 'Tom & "Jerry" <3', style: ['.a{fill:red}', '.b{fill:blue}'], body: ['<rect class="a" width="4" height="4"/>'] });

  it('frames the drawing in a sized svg element with a viewBox, ending in a newline', () => {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="40" height="20" viewBox="0 0 40 20" /);
    assert.ok(svg.endsWith('<rect class="a" width="4" height="4"/>\n</svg>\n'));
  });

  it('names the picture for screen readers, escaped, in the aria-label and the title', () => {
    const root = parseXml(svg);
    assert.equal(root.attributes.get('role'), 'img');
    assert.equal(root.attributes.get('aria-label'), 'Tom & "Jerry" <3');
    const title = root.children.find((node) => typeof node !== 'string' && node.name === 'title');
    assert.ok(title !== undefined);
    assert.equal(textOf(title), 'Tom & "Jerry" <3');
  });

  it('writes the style rules one per line', () => {
    assert.match(svg, /<style>\n\.a\{fill:red\}\n\.b\{fill:blue\}\n<\/style>/);
  });
});
