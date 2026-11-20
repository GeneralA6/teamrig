import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { excerptAt, MENTION_EXCERPT_MAX, mentionsOf, visibleText } from './mentions.ts';

const OURS: ReadonlySet<string> = new Set(['octocat', 'hubber']);

function logins(text: string): string[] {
  return mentionsOf(text, OURS).map((mention) => mention.login);
}

describe('mentionsOf', () => {
  it('finds a mention of ours at the start, after a space or punctuation, in any case', () => {
    assert.deepEqual(logins('@octocat can you look?'), ['octocat']);
    assert.deepEqual(logins('Thanks (@OctoCat), and cc:@hubber.'), ['octocat', 'hubber']);
    assert.deepEqual(logins('line one\n@hubber, line two'), ['hubber']);
  });

  it('names each login once, in the order of its first mention, and ignores logins not ours', () => {
    assert.deepEqual(logins('@hubber @someone @octocat @hubber'), ['hubber', 'octocat']);
    assert.deepEqual(logins('@someone else'), []);
  });

  it('is no mention inside an e-mail address, a path, a longer login or after _ or .', () => {
    assert.deepEqual(logins('mail name@octocat please'), []);
    assert.deepEqual(logins('see path/@octocat and a.@octocat and x_@octocat and x-@octocat'), []);
    assert.deepEqual(logins('ping @octocat-bot and @octocat_'), ['octocat']);
    assert.deepEqual(logins('ping @octocat-bot'), []);
  });

  it('skips a fenced block, inline code and a quoted line, as GitHub sends no notice for them', () => {
    assert.deepEqual(logins('```\n@octocat in a fence\n```\n~~~js\n@hubber\n~~~'), []);
    assert.deepEqual(logins('run `teamrig @octocat` and ``a ` @hubber``'), []);
    assert.deepEqual(logins('> @octocat said this before\n  > @hubber too'), []);
  });

  it('takes a mention after a fence closes, and keeps an unclosed fence open to the end', () => {
    assert.deepEqual(logins('```\ncode\n```\n@octocat after it'), ['octocat']);
    assert.deepEqual(logins('````\n```\n@hubber still inside\n````\n@octocat'), ['octocat']);
    assert.deepEqual(logins('```\nnever closed\n@octocat'), []);
  });

  it('reads a lone backtick as text, so a mention after it counts', () => {
    assert.deepEqual(logins('a ` and then @octocat'), ['octocat']);
  });

  it('scans a body over 64 KB whole and caps only the excerpt', () => {
    const body = `${'x '.repeat(40_000)}@hubber please review ${'y '.repeat(10)}`;
    const [mention] = mentionsOf(body, OURS);
    assert.equal(mention?.login, 'hubber');
    assert.ok((mention?.excerpt.length ?? 0) <= MENTION_EXCERPT_MAX);
    assert.match(mention?.excerpt ?? '', /^….*@hubber please review/);
  });
});

describe('visibleText', () => {
  it('keeps every position and line break while blanking code and quotes', () => {
    const text = 'a `b` c\n> q\n```\nf\n```\nd';
    const visible = visibleText(text);
    assert.equal(visible.length, text.length);
    assert.deepEqual(visible.split('\n').length, text.split('\n').length);
    assert.equal(visible, 'a     c\n   \n   \n \n   \nd');
  });
});

describe('excerptAt', () => {
  it('is the whole short text on one line', () => {
    assert.equal(excerptAt('hi\n\n@octocat  look', 4), 'hi @octocat look');
  });

  it('drops control and format characters and never keeps half of a cut character', () => {
    assert.equal(excerptAt('a\u0007b‮c @octocat', 6), 'a b c @octocat');
    const text = `${'\u{1F600}'.repeat(200)}@octocat${'\u{1F600}'.repeat(200)}`;
    for (const index of [400, 401]) {
      // An odd start cuts a character in two at both ends.
      const excerpt = excerptAt(text, index);
      assert.doesNotMatch(excerpt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      assert.ok(excerpt.length <= MENTION_EXCERPT_MAX);
    }
  });

  it('marks a cut on either side and stays within the cap', () => {
    const text = `${'a'.repeat(500)}@octocat${'b'.repeat(500)}`;
    const excerpt = excerptAt(text, 500);
    assert.equal(excerpt.length, MENTION_EXCERPT_MAX);
    assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'));
    assert.ok(excerpt.includes('@octocat'));
  });

  it('ends at the text end without a mark when the mention is near it', () => {
    const text = `${'a'.repeat(500)} @octocat`;
    const excerpt = excerptAt(text, 501);
    assert.ok(excerpt.endsWith('@octocat'));
    assert.ok(excerpt.startsWith('…'));
    assert.ok(excerpt.length <= MENTION_EXCERPT_MAX);
  });
});
