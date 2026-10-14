import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  formatRead,
  formatUnread,
  inboxStatus,
  postLine,
  readInbox,
  reminderFor,
  sessionIdOf,
  unreadOf,
  type InboxDeps,
} from './inbox.ts';
import { lineHash, type InboxMark } from './marks.ts';
import { InboxDir, JsonlMarkLog } from './store.ts';

const DIR = 'state/inbox';
const MARKS = 'state/inbox-marks.jsonl';
const SESSION = '0a1b2c3d-1111-2222-3333-444455556666';
const NOW = new Date('2030-01-08T10:00:00Z');
const LINES = ['- 2030-01-07 09:00 lead: first', '- 2030-01-07 10:00 bravo: second', '- 2030-01-07 11:00 lead: third'];

function setup(files: Readonly<Record<string, string>> = {}): { files: MemoryFiles; deps: InboxDeps } {
  const memory = new MemoryFiles(files);
  return { files: memory, deps: { inboxes: new InboxDir(memory, DIR), marks: new JsonlMarkLog(memory, MARKS) } };
}

function mark(line: number, lastLineHash: string | null): InboxMark {
  return { v: 1, area: 'alpha', line, at: '2030-01-07T12:00:00.000Z', claudeSession: null, lastLineHash };
}

describe('unreadOf', () => {
  it('starts after the mark when the file only grew', () => {
    const unread = unreadOf('alpha', LINES, mark(2, lineHash(LINES[1] ?? '')));
    assert.deepEqual([unread.resume, unread.lines], ['grew', [LINES[2]]]);
  });

  it('finds its place again after old lines were trimmed from the top', () => {
    const trimmed = [LINES[1] ?? '', LINES[2] ?? '', '- 2030-01-08 08:00 lead: fourth'];
    const unread = unreadOf('alpha', trimmed, mark(2, lineHash(LINES[1] ?? '')));
    assert.deepEqual([unread.resume, unread.lines], ['moved', trimmed.slice(1)]);
  });

  it('shows everything when the last line read is gone', () => {
    assert.equal(unreadOf('alpha', LINES, mark(2, lineHash('- something else'))).resume, 'rewritten');
    assert.equal(unreadOf('alpha', LINES, mark(3, lineHash('x'))).lines.length, 3);
  });

  it('trusts a v0 mark unless the file shrank below it', () => {
    assert.deepEqual(unreadOf('alpha', LINES, mark(1, null)).lines, LINES.slice(1));
    assert.equal(unreadOf('alpha', LINES, mark(5, null)).resume, 'rewritten');
    assert.equal(unreadOf('alpha', LINES, null).resume, 'never');
  });
});

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
    assert.equal(formatRead(first), 'READ alpha: the 3 line(s) above, read to line 3; the reminder hook follows this session');

    const second = await readInbox(deps, { area: 'alpha', claudeSession: null, now: NOW });
    assert.deepEqual(second.unread.lines, []);
    assert.match(formatRead(second), /nothing new.*no Claude Code session id here/);
    assert.equal(files.get(MARKS)?.trim().split('\n').length, 2);
  });

  it('marks an area nobody has posted to yet, so its first line is unread', async () => {
    const { deps } = setup();
    const empty = await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    assert.deepEqual([empty.unread.lines, empty.mark.line, empty.mark.lastLineHash], [[], 0, null]);
    assert.equal(formatRead(empty), 'READ alpha: nothing new, read to line 0; the reminder hook follows this session');

    await deps.inboxes.append('alpha', LINES[0] ?? '');
    assert.equal(await reminderFor(deps, SESSION, 'teamrig'), `INBOX: 1 unread line(s) in ${DIR}/alpha.md since 01-07 09:00. Read them with: teamrig inbox read --session alpha`);
  });
});

describe('inboxStatus and reminderFor', () => {
  it('reports unread lines per area and reminds the session that last read', async () => {
    const { deps } = setup({ [`${DIR}/alpha.md`]: LINES.slice(0, 2).join('\n'), [`${DIR}/bravo.md`]: '', [`${DIR}/notes.txt`]: 'x' });
    assert.equal(await reminderFor(deps, SESSION, 'teamrig'), undefined, 'no area known for the session yet');
    await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    await deps.inboxes.append('alpha', LINES[2] ?? '');

    assert.deepEqual((await inboxStatus(deps)).map(formatUnread), [
      'alpha 1 unread since 01-07 11:00 (read to line 2 of 3 at 01-08 10:00)',
      'bravo 0 unread (never marked read)',
    ]);
    assert.equal(
      await reminderFor(deps, SESSION, 'teamrig'),
      'INBOX: 1 unread line(s) in state/inbox/alpha.md since 01-07 11:00. Read them with: teamrig inbox read --session alpha',
    );
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
