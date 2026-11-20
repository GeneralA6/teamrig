import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClaim, stampCredit } from '../../../plugin-api/index.ts';
import { adfText, textAdf } from './adf.ts';

function text(value: string): object {
  return { type: 'text', text: value };
}

function node(type: string, ...content: readonly object[]): object {
  return { type, content };
}

function doc(...content: readonly object[]): object {
  return { type: 'doc', version: 1, content };
}

describe('adfText', () => {
  it('reads paragraphs a blank line apart, a hard break as a new line', () => {
    const body = doc(node('paragraph', text('First '), { type: 'text', text: 'line', marks: [{ type: 'strong' }] }, { type: 'hardBreak' }, text('second line')), node('heading', text('Then')));
    assert.equal(adfText(body), 'First line\nsecond line\n\nThen');
  });

  it('reads a mention, an emoji and a status by their text, and a card by its address', () => {
    const body = doc(
      node(
        'paragraph',
        { type: 'mention', attrs: { id: '5b10', text: '@Dana' } },
        text(' see '),
        { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/ENG-3' } },
        text(' '),
        { type: 'emoji', attrs: { shortName: ':ok:', text: 'OK' } },
        text(' '),
        { type: 'status', attrs: { text: 'DONE', color: 'green' } },
      ),
    );
    assert.equal(adfText(body), '@Dana see https://acme.atlassian.net/browse/ENG-3 OK DONE');
  });

  it('gives nothing for an inline node that lacks its text', () => {
    assert.equal(adfText(doc(node('paragraph', { type: 'mention' }, { type: 'text' }, { type: 'inlineCard', attrs: { url: 7 } }, text('kept')))), 'kept');
  });

  it('reads lists item by item, a nested list under its item', () => {
    const body = doc(
      node('bulletList', node('listItem', node('paragraph', text('one')), node('orderedList', node('listItem', node('paragraph', text('inner'))))), node('listItem', node('paragraph', text('two')))),
      node('orderedList', node('listItem', node('paragraph', text('first'))), node('listItem', node('paragraph')), node('listItem', node('paragraph', text('second')))),
    );
    assert.equal(adfText(body), '- one\n  1. inner\n- two\n\n1. first\n2. second');
  });

  it('reads the children of a node it does not know, each block of them', () => {
    const body = doc(node('panel', node('paragraph', text('in a panel'))), node('table', node('tableRow', node('tableCell', node('paragraph', text('a'))), node('tableCell', node('paragraph', text('b'))))), { type: 'rule' });
    assert.equal(adfText(body), 'in a panel\n\na\n\nb');
  });

  it('keeps inline text and the block after it apart when a node holds both', () => {
    assert.equal(adfText(node('expand', text('title'), node('paragraph', text('body')), text('tail'))), 'title\n\nbody\n\ntail');
  });

  it('gives the empty text for what is no document', () => {
    for (const value of [undefined, null, 'text', 7, [], {}, { type: 'doc' }, { type: 'doc', content: 'x' }, doc(node('paragraph')), doc(node('blockquote')), { type: 'doc', content: ['stray'] }]) {
      assert.equal(adfText(value), '', JSON.stringify(value));
    }
  });

  it('reads one inline node given alone', () => {
    assert.equal(adfText(text('alone')), 'alone');
  });

  it('stops at a depth no real document has', () => {
    let deep: object = node('paragraph', text('bottom'));
    for (let level = 0; level < 60; level += 1) {
      deep = node('panel', deep);
    }
    assert.equal(adfText(doc(node('paragraph', text('top')), deep)), 'top');
  });

  describe('for the claim line', () => {
    const take = node('paragraph', text("I'll take this"));

    it('shows a claim written as a paragraph of its own, or after a hard break', () => {
      assert.equal(isClaim(adfText(doc(node('paragraph', text('Hello')), take))), true);
      assert.equal(isClaim(adfText(doc(node('paragraph', text('Hello'), { type: 'hardBreak' }, text('/take'))))), true);
    });

    it('hides one in a quote, behind > on every line', () => {
      const body = doc(node('blockquote', take, node('paragraph', text('/take'))));
      assert.equal(adfText(body), "> I'll take this\n>\n> /take");
      assert.equal(isClaim(adfText(body)), false);
    });

    it('hides one in a code block, behind a fence', () => {
      const body = doc({ type: 'codeBlock', attrs: { language: 'text' }, content: [text('/take\nmore')] });
      assert.equal(adfText(body), '```\n/take\nmore\n```');
      assert.equal(isClaim(adfText(body)), false);
    });

    it('keeps a code block closed when a line of the code is itself a fence', () => {
      const body = doc({ type: 'codeBlock', content: [text('```\n/take\n  ~~~\n/take'), 'stray'] });
      assert.equal(adfText(body), '```\n\\```\n/take\n\\  ~~~\n/take\n```');
      assert.equal(isClaim(adfText(body)), false);
    });

    it('hides one in a list item, as a Markdown host does', () => {
      assert.equal(isClaim(adfText(doc(node('bulletList', node('listItem', take))))), false);
    });
  });
});

describe('textAdf', () => {
  it('writes a paragraph for each run of lines, its lines apart by hard breaks', () => {
    assert.deepEqual(textAdf('one\r\ntwo\n\n \nthree  \n'), {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
      ],
    });
  });

  it('writes no empty text node, which Jira refuses', () => {
    assert.deepEqual(textAdf(''), { type: 'doc', version: 1, content: [] });
    assert.deepEqual(textAdf('\n\n  \nfirst').content, [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }]);
    assert.deepEqual(textAdf('\nfirst').content, [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }]);
  });

  it('ends with the credit as a paragraph, its name a link', () => {
    const credit = stampCredit('1.2.3');
    assert.deepEqual(textAdf('Done.', credit).content, [
      { type: 'paragraph', content: [{ type: 'text', text: 'Done.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Made with ' }, { type: 'text', text: 'teamrig', marks: [{ type: 'link', attrs: { href: credit.link } }] }, { type: 'text', text: ' 1.2.3' }] },
    ]);
    assert.equal(textAdf('', credit).content.length, 1);
  });

  it('keeps one credit when a text read back from Jira, or one stamped in Markdown, is written again', () => {
    const credit = stampCredit('2.0.0');
    const once = textAdf('Done.\n\nMore.', stampCredit('1.0.0'));
    assert.equal(adfText(once), 'Done.\n\nMore.\n\nMade with teamrig 1.0.0');
    const again = textAdf(adfText(once), credit);
    assert.equal(adfText(again), 'Done.\n\nMore.\n\nMade with teamrig 2.0.0');
    assert.equal(adfText(textAdf('Done.\n\n<sub>Made with [teamrig](https://example.com) 1.0.0</sub>\n<!-- teamrig-stamp -->', credit)), 'Done.\n\nMade with teamrig 2.0.0');
  });

  it('takes off only a last paragraph that is the credit alone', () => {
    const credit = stampCredit('2.0.0');
    const kept = ['Made with teamrig 1.0.0\n\nAfter it.', 'Made with teamrig 1.0.0\nand a second line', 'Made with teamrig', 'Made with teamrig 1.0.0 and more', 'Made with care 1.0.0'];
    for (const body of kept) {
      assert.equal(adfText(textAdf(body, credit)), `${body}\n\nMade with teamrig 2.0.0`, body);
    }
    assert.equal(adfText(textAdf('Made with teamrig 1.0.0')), 'Made with teamrig 1.0.0');
  });
});
