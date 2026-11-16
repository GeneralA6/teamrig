import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord } from './guards.ts';
import { STAMP_LINK, STAMP_MARKER, stampFooter, stampTrailer, withoutStampFooter, withStampFooter, withStampTrailer } from './stamp.ts';
import { KIT_VERSION } from './version.ts';

/** How many times `part` is in `text`. */
function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('stampFooter', () => {
  it('names teamrig with its link and version, then the hidden marker on its own line', () => {
    assert.equal(stampFooter('0.422.0'), '<sub>Made with [teamrig](https://github.com/GeneralA6/teamrig) 0.422.0</sub>\n<!-- teamrig-stamp -->');
    assert.ok(stampFooter().includes(` ${KIT_VERSION}</sub>`));
  });

  it("links the repository the plugin manifest names, so the link cannot drift from the project's home", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    assert.ok(isRecord(manifest));
    assert.equal(manifest['repository'], STAMP_LINK);
  });
});

describe('withStampFooter', () => {
  it('adds the footer a blank line after the text', () => {
    assert.equal(withStampFooter('Fixed in #9, thank you.', '1.0.0'), `Fixed in #9, thank you.\n\n${stampFooter('1.0.0')}`);
    assert.equal(withStampFooter('Trailing lines\n\n\n', '1.0.0'), `Trailing lines\n\n${stampFooter('1.0.0')}`);
  });

  it('keeps one footer when a stamped text is stamped again: a rerun, a retry', () => {
    const once = withStampFooter('Thanks', '1.0.0');
    assert.equal(withStampFooter(once, '1.0.0'), once);
    assert.equal(count(withStampFooter(withStampFooter(once)), STAMP_MARKER), 1);
  });

  it('replaces an older footer, of another version or wording, with one at the version given', () => {
    const old = `Spec\n\n<sub>Made with teamrig 0.1.0</sub>\n${STAMP_MARKER}`;
    assert.equal(withStampFooter(old, '2.0.0'), `Spec\n\n${stampFooter('2.0.0')}`);
    assert.equal(withStampFooter(`Spec\n${STAMP_MARKER}`, '2.0.0'), `Spec\n\n${stampFooter('2.0.0')}`);
  });

  it('keeps text a person added after the footer in an edit, and moves the footer to the end', () => {
    const edited = `${withStampFooter('Spec', '1.0.0')}\n\nAnd one more step.`;
    assert.equal(withStampFooter(edited, '1.0.0'), `Spec\n\nAnd one more step.\n\n${stampFooter('1.0.0')}`);
  });

  it('reads a footer in a body saved with Windows line ends', () => {
    const crlf = `Step one\r\nStep two\r\n\r\n<sub>Made with teamrig 0.1.0</sub>\r\n${STAMP_MARKER}\r\n`;
    assert.equal(withStampFooter(crlf, '1.0.0'), `Step one\r\nStep two\n\n${stampFooter('1.0.0')}`);
  });

  it('leaves a marker that is not alone on its line, as a person wrote it', () => {
    const quoted = `The stamp ends with ${STAMP_MARKER} on a line.`;
    assert.equal(withoutStampFooter(quoted), quoted);
  });

  it('stamps an empty text with the footer alone', () => {
    assert.equal(withStampFooter('', '1.0.0'), stampFooter('1.0.0'));
    assert.equal(withStampFooter(stampFooter('0.1.0'), '1.0.0'), stampFooter('1.0.0'));
  });
});

describe('withStampTrailer', () => {
  it('is Made-with: teamrig <version>', () => {
    assert.equal(stampTrailer('0.422.0'), 'Made-with: teamrig 0.422.0');
  });

  it("joins the message's trailer block, after the trailers already there", () => {
    const message = 'fix: a thing\n\nWhy it was broken.\n\nReviewed-by: A Reviewer';
    assert.equal(withStampTrailer(message, '1.0.0'), `${message}\nMade-with: teamrig 1.0.0`);
  });

  it('starts a trailer block when the last paragraph is prose or the subject alone', () => {
    assert.equal(withStampTrailer('fix: a thing\n\nWhy it was broken.', '1.0.0'), 'fix: a thing\n\nWhy it was broken.\n\nMade-with: teamrig 1.0.0');
    assert.equal(withStampTrailer('fix: a thing', '1.0.0'), 'fix: a thing\n\nMade-with: teamrig 1.0.0');
  });

  it('keeps one Made-with trailer, at the version given, when a stamped message is stamped again', () => {
    const once = withStampTrailer('fix: a thing\n\nReviewed-by: A Reviewer', '1.0.0');
    assert.equal(withStampTrailer(once, '1.0.0'), once);
    const again = withStampTrailer(once.replace('Made-with', 'made-with'), '2.0.0');
    assert.equal(again, 'fix: a thing\n\nReviewed-by: A Reviewer\nMade-with: teamrig 2.0.0');
  });
});
