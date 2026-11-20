import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { refOf, ServedText, type Connector } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

/** A tracker whose refs are `<prefix><item>`, counting how often it is asked. */
class PrefixConnector implements Connector {
  readonly id: string;
  readonly name: string;
  asked = 0;
  private readonly prefix: string;
  private readonly page: string | null;

  constructor(id: string, name: string, prefix: string, page: string | null) {
    this.id = id;
    this.name = name;
    this.prefix = prefix;
    this.page = page;
  }

  itemOf(ref: string): { id: string; url: string | null } | undefined {
    this.asked += 1;
    if (!ref.startsWith(this.prefix)) {
      return undefined;
    }
    const id = ref.slice(this.prefix.length);
    return { id, url: this.page === null ? null : `${this.page}${id}` };
  }
}

const NONE = { connector: null, id: null, label: null, url: null };

describe('a served ref', () => {
  it('is null for a task with no ref', () => {
    assert.equal(refOf(new ServedText(new SecretScanner()), 'T1', null, [new PrefixConnector('tracker', 'Tracker', 'tr:', null)]), null);
  });

  it('carries the connector, the item, its label as outside text and its page when a tracker knows the ref', () => {
    const served = new ServedText(new SecretScanner());
    const tracker = new PrefixConnector('tracker', 'Tracker', 'tr:', 'https://tracker.example/item/');
    assert.deepEqual(refOf(served, 'T1', 'tr:acme/app#12', [tracker]), {
      text: 'tr:acme/app#12',
      connector: { id: 'tracker', name: 'Tracker' },
      id: 'acme/app#12',
      label: { text: 'acme/app#12', source: 'outside' },
      url: 'https://tracker.example/item/acme/app#12',
    });
    assert.deepEqual(served.cuts, []);
  });

  it('keeps a free-text ref as its text alone, and a tracker with no page gives a null url', () => {
    const served = new ServedText(new SecretScanner());
    const tracker = new PrefixConnector('tracker', 'Tracker', 'tr:', null);
    assert.deepEqual(refOf(served, 'T1', 'src/cli/run.ts:136', [tracker]), { text: 'src/cli/run.ts:136', ...NONE });
    assert.deepEqual(refOf(served, 'T1', 'the 14:30 message', []), { text: 'the 14:30 message', ...NONE });
    assert.equal(refOf(served, 'T2', 'tr:7', [tracker])?.url, null);
  });

  it('is named by the first tracker that knows it', () => {
    const first = new PrefixConnector('first', 'First', 'x:', null);
    const second = new PrefixConnector('second', 'Second', 'x:', null);
    const other = new PrefixConnector('other', 'Other', 'y:', null);
    const served = new ServedText(new SecretScanner());
    assert.equal(refOf(served, 'T1', 'x:1', [other, first, second])?.connector?.id, 'first');
    assert.equal(second.asked, 0);
  });

  it('serves a tracker\'s page only as an https address, and no link for any other', () => {
    const served = new ServedText(new SecretScanner());
    const urlOf = (page: string): string | null | undefined => refOf(served, 'T1', 'tr:7', [new PrefixConnector('tracker', 'Tracker', 'tr:', page)])?.url;
    assert.deepEqual(
      ['javascript:alert(1)//', ' javascript:alert(1)//', 'file:///srv/items/', 'http://tracker.example/item/', 'data:text/html,', 'not a page ', 'HTTPS://tracker.example/item/'].map(urlOf),
      [null, null, null, null, null, null, 'https://tracker.example/item/7'],
    );
    const known = refOf(served, 'T1', 'tr:7', [new PrefixConnector('tracker', 'Tracker', 'tr:', 'javascript:alert(1)//')]);
    assert.deepEqual([known?.connector?.id, known?.id], ['tracker', '7']);
  });

  it('never takes a link from the stored ref\'s own text', () => {
    const served = new ServedText(new SecretScanner());
    const tracker = new PrefixConnector('tracker', 'Tracker', 'tr:', 'https://tracker.example/item/');
    for (const text of ['javascript:alert(1)', 'file:///srv/items/7', 'https://elsewhere.example/7']) {
      assert.deepEqual(refOf(served, 'T1', text, [tracker]), { text, ...NONE });
    }
  });

  it('escapes the control marks of a label, which is the tracker\'s word', () => {
    const served = new ServedText(new SecretScanner());
    const ref = refOf(served, 'T1', 'tr:a\u001b[31mb', [new PrefixConnector('tracker', 'Tracker', 'tr:', null)]);
    assert.deepEqual(ref?.label, { text: 'a\\x1b[31mb', source: 'outside' });
    assert.equal(ref?.text, 'tr:a\u001b[31mb');
  });

  it('serves a ref that matches a secret shape as its cut alone, asking no tracker', () => {
    const scanner = new SecretScanner();
    const shape = scanner.find(SECRET)?.description;
    assert.ok(shape !== undefined, 'the fixture matches a shipped shape');
    const served = new ServedText(scanner);
    const tracker = new PrefixConnector('tracker', 'Tracker', 'tr:', 'https://tracker.example/item/');
    const ref = refOf(served, 'T9', `tr:${SECRET}`, [tracker]);
    assert.deepEqual(ref, { text: `[cut: ${shape}]`, ...NONE });
    assert.equal(tracker.asked, 0);
    assert.deepEqual(served.cuts, [{ id: 'T9', field: 'ref', shape }]);
    assert.ok(!JSON.stringify(ref).includes('hunter2'));
  });
});
