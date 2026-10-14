import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, placesIn, textOf, XmlError, type XmlElement } from './xml.ts';

const child = (element: XmlElement, index: number): XmlElement => {
  const node = element.children[index];
  assert.ok(node !== undefined && typeof node !== 'string', `child ${index} of <${element.name}> is not an element`);
  return node;
};

describe('parseXml', () => {
  it('reads nested elements, attributes in either quote, self-closing tags and text', () => {
    const root = parseXml(`<svg a="1" b='two'>\n<g class="x"><text>hi</text></g><rect/></svg>\n`);
    assert.equal(root.name, 'svg');
    assert.deepEqual([...root.attributes], [['a', '1'], ['b', 'two']]);
    assert.equal(root.children[0], '\n');
    assert.equal(child(child(root, 1), 0).name, 'text');
    assert.deepEqual(child(root, 2), { name: 'rect', attributes: new Map(), children: [] });
  });

  it('resolves the five named references and numeric ones, in text and in attributes', () => {
    const root = parseXml(`<t v="&quot;&apos;&#65;">&amp;&lt;&gt;&#x42;&#67;</t>`);
    assert.equal(root.attributes.get('v'), `"'A`);
    assert.equal(textOf(root), '&<>BC');
  });

  it('skips comments before, inside and after the root, and keeps > and spaces in text', () => {
    const root = parseXml('<!-- a -->\n<a>x > y<!-- b --> z</a >\n<!-- c -->');
    assert.equal(textOf(root), 'x > y z');
  });

  const refused: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['an empty document', '', /expected an element at offset 0/],
    ['a mismatched end tag', '<a><b></a></b>', /<\/a> closes <b>/],
    ['an element never closed', '<a><b></b>', /<a> is never closed/],
    ['a second root', '<a/><b/>', /content after the root element/],
    ['text outside the root', '<a/>x', /content after the root element/],
    ['a bare ampersand', '<a>x & y</a>', /a bare & or an unknown character reference/],
    ['an unknown entity', '<a>&nbsp;</a>', /a bare & or an unknown character reference/],
    ['a code point past Unicode', '<a>&#x110000;</a>', /no character &#x110000;/],
    ['an unquoted attribute', '<a b=1/>', /attribute b is not quoted/],
    ['an attribute given twice', '<a b="1" b="2"/>', /attribute b given twice/],
    ['a < in an attribute', '<a b="<"/>', /attribute b holds a < or never ends/],
    ['an attribute that never ends', '<a b="1', /attribute b holds a < or never ends/],
    ['attributes with no space between', '<a b="1"c="2"/>', /expected a space before an attribute/],
    ['an attribute with no =', '<a b/>', /expected = after attribute b/],
    ['a tag cut off', '<a', /a tag that never ends/],
    ['a word in a tag that is not an attribute', '<a "x"/>', /expected an attribute name, > or \/>/],
    ['a comment that never ends', '<a><!-- x</a>', /a comment that never ends/],
    ['an end tag with no >', '<a></a', /expected > after <\/a/],
    ['a start tag with no name', '< a/>', /expected an element name/],
    ['an end tag with no name', '<a></>', /expected an end tag name/],
  ];
  for (const [what, source, message] of refused) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseXml(source), (error: unknown) => error instanceof XmlError && message.test(error.message));
    });
  }
});

describe('placesIn', () => {
  it('lists every element in document order with its path from the root', () => {
    const places = placesIn(parseXml('<a><b><c/></b>t<d/></a>'));
    assert.deepEqual(
      places.map((place) => place.path.map((element) => element.name).join('/')),
      ['a', 'a/b', 'a/b/c', 'a/d'],
    );
    assert.deepEqual(
      places.map((place) => place.element.name),
      ['a', 'b', 'c', 'd'],
    );
  });
});

describe('textOf', () => {
  it('joins the text of every descendant, and returns a text node as it is', () => {
    assert.equal(textOf(parseXml('<a>x<b>y<c>z</c></b></a>')), 'xyz');
    assert.equal(textOf('plain'), 'plain');
  });
});
