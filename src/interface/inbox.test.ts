import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import { inboxLineOf } from '../inbox/inbox.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { cutText, inboxBody, type ConnectorName, type InboxBody, type InboxInput } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

const TRACKER: ConnectorName = { id: 'tracker', name: 'Tracker' };
const NOON = Date.parse('2030-01-08T12:00:00.000Z');
const HOUR = 3_600_000;

/** A line as teamrig posts it, `hoursAgo` before noon. */
function posted(hoursAgo: number, from: string, text: string): string {
  return inboxLineOf(new Date(NOON - hoursAgo * HOUR), from, text);
}

function bodyOf(lines: readonly string[], input: Partial<InboxInput> = {}): InboxBody {
  return inboxBody({
    session: { id: 'alpha', name: 'app-alpha' },
    lines,
    unread: 0,
    readSince: NOON - 24 * HOUR,
    keyOf: lineHash,
    connectors: [TRACKER],
    shapes: new SecretScanner(),
    ...input,
  });
}

function textsOf(body: InboxBody): string[] {
  return body.lines.map((line) => line.text.text);
}

describe('inboxBody', () => {
  it('serves a posted line as its key, minute, sender and words, in this order', () => {
    const line = posted(1, 'lead', 'T5 is yours: start now');
    const body = bodyOf([line], { unread: 1 });
    assert.deepEqual(body, {
      session: { id: 'alpha', name: 'app-alpha' },
      unread: 1,
      lines: [{ key: lineHash(line), at: '2030-01-08T11:00:00.000Z', from: 'lead', text: { text: 'T5 is yours: start now', source: 'team' }, unread: true }],
      cuts: [],
    });
    assert.deepEqual(Object.keys(body.lines[0] ?? {}), ['key', 'at', 'from', 'text', 'unread']);
  });

  it('names a sender of another team as the line does', () => {
    assert.deepEqual(bodyOf([posted(1, 'web/api', 'the contract changes')]).lines[0]?.from, 'web/api');
  });

  it('serves every unread line however old, and a read one only inside the window', () => {
    const lines = [posted(80, 'lead', 'old and read'), posted(30, 'lead', 'read a day ago'), posted(2, 'lead', 'read today'), posted(1, 'lead', 'new')];
    const body = bodyOf(lines, { unread: 1 });
    assert.deepEqual(textsOf(body), ['read today', 'new']);
    assert.deepEqual(body.lines.map((line) => line.unread), [false, true]);
    assert.deepEqual(textsOf(bodyOf(lines, { unread: 4 })), ['old and read', 'read a day ago', 'read today', 'new']);
  });

  it('keeps a read line posted at the window\'s first minute and leaves out the one before', () => {
    const lines = [posted(25, 'lead', 'before'), posted(24, 'lead', 'at the edge')];
    assert.deepEqual(textsOf(bodyOf(lines)), ['at the edge']);
  });

  it('counts every line unread for a session that never read its inbox, and says so as null', () => {
    const body = bodyOf([posted(80, 'lead', 'old'), posted(1, 'lead', 'new')], { unread: null });
    assert.equal(body.unread, null);
    assert.deepEqual(body.lines.map((line) => [line.text.text, line.unread]), [['old', true], ['new', true]]);
  });

  it('serves a line with no date whole while unread, and leaves it out once read', () => {
    const lines = ['a note someone typed', '- 2030-13-45 99:99 lead: no calendar holds this'];
    const body = bodyOf(lines, { unread: 2 });
    assert.deepEqual(body.lines.map((line) => [line.at, line.from, line.text.text]), [[null, null, lines[0]], [null, null, lines[1]]]);
    assert.deepEqual(bodyOf(lines).lines, []);
  });

  it('serves a dated line that names no sender with a null sender', () => {
    const [line] = bodyOf(['- 2030-01-08 11:00 see https://example.test/a: b', '- 2030-01-08 11:00']).lines;
    assert.deepEqual([line?.from, line?.text.text], [null, 'see https://example.test/a: b']);
    assert.deepEqual(bodyOf(['- 2030-01-08 11:00']).lines.map((served) => [served.at, served.from, served.text.text]), [['2030-01-08T11:00:00.000Z', null, '']]);
  });

  it('marks a connector\'s line as outside text and escapes what a terminal would act on', () => {
    const [line] = bodyOf([posted(1, 'tracker', 'Fix \u001b[31mred gate')]).lines;
    assert.deepEqual([line?.from, line?.text], ['tracker', { text: 'Fix \\x1b[31mred gate', source: 'outside' }]);
  });

  it('cuts a line matching a secret shape, listing the cut by the line\'s key', () => {
    const line = posted(1, 'lead', `use ${SECRET}`);
    const shape = new SecretScanner().find(SECRET)?.description ?? '';
    const body = bodyOf([line]);
    assert.deepEqual(body.lines[0]?.text, { text: cutText(shape), source: 'team' });
    assert.deepEqual(body.cuts, [{ id: 'cut-1', field: 'text', shape }]);
    assert.equal(JSON.stringify(body).includes('hunter2'), false);
  });

  it('keys a cut line by its place in the file, never by a fingerprint of its words', () => {
    const secret = posted(1, 'lead', `use ${SECRET}`);
    const lines = [posted(80, 'lead', 'long read'), secret, posted(1, 'lead', 'plain'), secret];
    const body = bodyOf(lines);
    assert.deepEqual(body.lines.map((line) => line.key), ['cut-2', lineHash(lines[2] ?? ''), 'cut-4']);
    assert.deepEqual(body.cuts.map((cut) => cut.id), ['cut-2', 'cut-4']);
    assert.equal(JSON.stringify(body).includes(lineHash(secret)), false);
  });

  it('cuts the session\'s name when it holds a secret shape, under the session\'s id', () => {
    const shape = new SecretScanner().find(SECRET)?.description ?? '';
    const body = bodyOf([], { session: { id: 'alpha', name: SECRET } });
    assert.deepEqual([body.session, body.cuts], [{ id: 'alpha', name: cutText(shape) }, [{ id: 'alpha', field: 'session.name', shape }]]);
  });

  it('never scans a line it leaves out', () => {
    assert.deepEqual(bodyOf([posted(80, 'lead', `use ${SECRET}`)]).cuts, []);
  });

  it('gives a line the file holds twice a key of its own, the same whatever the window serves', () => {
    const twice = posted(30, 'lead', 'ping');
    const lines = [twice, twice, posted(1, 'lead', 'pong')];
    const all = bodyOf(lines, { unread: 3 }).lines.map((line) => line.key);
    assert.deepEqual(all, [lineHash(twice), `${lineHash(twice)}-2`, lineHash(lines[2] ?? '')]);
    assert.deepEqual(bodyOf(lines, { unread: 2 }).lines.map((line) => line.key), all.slice(1));
  });
});
