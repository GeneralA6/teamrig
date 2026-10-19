import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { TimeZone } from '../core/zone.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import {
  formatRead,
  formatUnread,
  inboxStatus,
  lineOnClock,
  postLine,
  readInbox,
  sessionIdOf,
  type InboxDeps,
} from './inbox.ts';
import { lineHash } from './line-hash.ts';
import { INJECT_CAPS } from './shown.ts';
import { InboxDir, JsonlMarkLog } from './store.ts';

const DIR = 'state/inbox';
const MARKS = 'state/inbox-marks.jsonl';
const SHOWN = 'state/inbox-shown.jsonl';
const OTHER_SESSION = '9f8e7d6c-1111-2222-3333-444455556666';
const SESSION = '0a1b2c3d-1111-2222-3333-444455556666';
const NOW = new Date('2030-01-08T10:00:00Z');
const LINES = ['- 2030-01-07 09:00 lead: first', '- 2030-01-07 10:00 bravo: second', '- 2030-01-07 11:00 lead: third'];

function setup(files: Readonly<Record<string, string>> = {}): { files: MemoryFiles; deps: InboxDeps } {
  const memory = new MemoryFiles(files);
  return { files: memory, deps: { inboxes: new InboxDir(memory, DIR), marks: new JsonlMarkLog(memory, MARKS), shown: new JsonlMarkLog(memory, SHOWN) } };
}

/** A line of `inbox-shown.jsonl`: the prompt hook showed `claudeSession` the area's lines through `line`. */
function shownLine(area: string, line: string, through: number, claudeSession: string): string {
  return `${JSON.stringify({ v: 1, area, line: through, at: NOW.toISOString(), claudeSession, lastLineHash: lineHash(line) })}\n`;
}

describe('readInbox', () => {
  it('returns the unread lines and marks them read with a hash of the last line', async () => {
    const { files, deps } = setup({ [`${DIR}/alpha.md`]: `${LINES.join('\r\n')}\r\n\r\n` });
    const first = await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    assert.deepEqual(first.unread.lines, LINES);
    assert.deepEqual(first.mark, {
      v: 1,
      area: 'alpha',
      line: 3,
      at: NOW.toISOString(),
      claudeSession: SESSION,
      lastLineHash: lineHash(LINES[2] ?? ''),
    });
    assert.equal(formatRead(first), 'READ alpha: 3 new lines, shown above; new ones are shown at your next prompt');

    const second = await readInbox(deps, { area: 'alpha', claudeSession: null, now: NOW });
    assert.deepEqual(second.unread.lines, []);
    assert.match(formatRead(second), /^READ alpha: nothing new; outside Claude Code, so no prompt will remind you of new ones$/);
    assert.equal(files.get(MARKS)?.trim().split('\n').length, 2);
  });

  it('marks an area nobody has posted to yet, so its first line is unread', async () => {
    const { deps } = setup();
    const empty = await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    assert.deepEqual([empty.unread.lines, empty.mark.line, empty.mark.lastLineHash], [[], 0, null]);
    assert.equal(formatRead(empty), 'READ alpha: nothing new; new ones are shown at your next prompt');

    await deps.inboxes.append('alpha', LINES[0] ?? '');
    assert.deepEqual((await inboxStatus(deps, 'alpha')).map((unread) => unread.lines), [[LINES[0]]]);
  });

  it('marks read, without printing again, the lines the prompt hook showed this Claude Code session', async () => {
    const { deps } = setup({ [`${DIR}/alpha.md`]: LINES.join('\n'), [SHOWN]: shownLine('alpha', LINES[1] ?? '', 2, SESSION) });
    const result = await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    assert.deepEqual([result.unread.lines, result.lines, result.shownBefore, result.mark.line], [LINES, [LINES[2]], 2, 3]);
    assert.equal(
      formatRead(result),
      'READ alpha: 1 new line, shown above, and 2 the prompt hook showed this session, now marked read too; new ones are shown at your next prompt',
    );
    assert.equal(formatRead(await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW })), 'READ alpha: nothing new; new ones are shown at your next prompt');
  });

  it('prints every unread line to another Claude Code session, and outside Claude Code', async () => {
    const files = { [`${DIR}/alpha.md`]: LINES.join('\n'), [SHOWN]: shownLine('alpha', LINES[2] ?? '', 3, SESSION) };
    const other = await readInbox(setup(files).deps, { area: 'alpha', claudeSession: OTHER_SESSION, now: NOW });
    const outside = await readInbox(setup(files).deps, { area: 'alpha', claudeSession: null, now: NOW });
    assert.deepEqual([other.lines, other.shownBefore, outside.lines, outside.shownBefore], [LINES, 0, LINES, 0]);
  });

  it('prints again a line the prompt hook had to cut, and every line after a rewrite', async () => {
    const long = `- 2030-01-07 12:00 lead: ${'x'.repeat(INJECT_CAPS.maxChars)}`;
    const cut = setup({ [`${DIR}/alpha.md`]: [long, ...LINES].join('\n'), [SHOWN]: shownLine('alpha', LINES[0] ?? '', 2, SESSION) });
    const result = await readInbox(cut.deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    assert.deepEqual([result.lines, result.shownBefore], [[long, LINES[1], LINES[2]], 1]);

    const gone = setup({ [`${DIR}/alpha.md`]: LINES.join('\n'), [SHOWN]: shownLine('alpha', 'a line no longer there', 2, SESSION) });
    assert.deepEqual((await readInbox(gone.deps, { area: 'alpha', claudeSession: SESSION, now: NOW })).lines, LINES);
  });
});

describe('inboxStatus', () => {
  it('reports unread lines per area from the last read on', async () => {
    const { deps } = setup({ [`${DIR}/alpha.md`]: LINES.slice(0, 2).join('\n'), [`${DIR}/bravo.md`]: '', [`${DIR}/notes.txt`]: 'x' });
    assert.deepEqual(await inboxStatus(deps, 'charlie'), [], 'no inbox file');
    await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    await deps.inboxes.append('alpha', LINES[2] ?? '');

    assert.deepEqual((await inboxStatus(deps)).map((unread) => formatUnread(unread, TimeZone.UTC)), [
      'alpha 1 unread since 01-07 11:00 UTC (read to line 2 of 3 at 01-08 10:00 UTC)',
      'bravo 0 unread (never marked read)',
    ]);
    assert.deepEqual((await inboxStatus(deps, 'alpha')).map((unread) => formatUnread(unread, JERUSALEM)), [
      'alpha 1 unread since 01-07 13:00 IST (read to line 2 of 3 at 01-08 12:00 IST)',
    ]);
  });
});

describe('lineOnClock', () => {
  it("shows a dated line's time on the team's clock, and an undated line as it is", () => {
    assert.equal(lineOnClock('- 2030-01-08 10:00 lead: ship it', TimeZone.UTC), '- 2030-01-08 10:00 UTC lead: ship it');
    assert.equal(lineOnClock('- 2030-01-08 10:00 lead: ship it', JERUSALEM), '- 2030-01-08 12:00 IST lead: ship it');
    assert.equal(lineOnClock('- 2030-01-08 23:30 lead: late', JERUSALEM), '- 2030-01-09 01:30 IST lead: late');
    assert.equal(lineOnClock('written by hand at 10:00', JERUSALEM), 'written by hand at 10:00');
  });
});

describe('postLine', () => {
  const secrets = new SecretScanner();

  it('appends one dated line, starting a new line when the file lacks a final newline', async () => {
    const { files, deps } = setup({ [`${DIR}/bravo.md`]: '- 2030-01-07 09:00 lead: old' });
    assert.equal(await postLine(deps.inboxes, secrets, { to: 'bravo', from: 'alpha', text: ' disk is at 91% ', now: NOW }), undefined);
    assert.equal(files.get(`${DIR}/bravo.md`), '- 2030-01-07 09:00 lead: old\n- 2030-01-08 10:00 alpha: disk is at 91%\n');
  });

  it('refuses bad areas, multi-line text and secrets', async () => {
    const { deps } = setup();
    const post = (to: string, text: string) => postLine(deps.inboxes, secrets, { to, from: 'alpha', text, now: NOW });
    assert.match((await post('../etc', 'x')) ?? '', /not a session id/);
    assert.match((await post('bravo', 'one\ntwo')) ?? '', /one non-empty line/);
    assert.match((await post('bravo', ['pass', 'word=', 'x'].join(''))) ?? '', /secret/);
    const token = ['xoxb', '-', '1'.repeat(12), '-abc'].join('');
    assert.equal(await post('bravo', `bot token ${token}`), 'the line looks like it holds a secret (Slack token); refer to where it is kept instead');
  });
});

describe('sessionIdOf', () => {
  it('reads a well-formed session id from hook input', () => {
    assert.equal(sessionIdOf({ session_id: SESSION, prompt: 'hi' }), SESSION);
    assert.equal(sessionIdOf({ session_id: 'not-an-id' }), null);
    assert.equal(sessionIdOf({ session_id: 7 }), null);
    assert.equal(sessionIdOf(undefined), null);
    assert.equal(sessionIdOf([SESSION]), null);
  });
});
