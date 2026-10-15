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
  type InboxDeps,
} from './inbox.ts';
import { lineHash } from './line-hash.ts';
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
    assert.equal(await reminderFor(deps, 'alpha', 'teamrig'), `INBOX: 1 unread line(s) in ${DIR}/alpha.md since 01-07 09:00. Read them with: teamrig inbox read --session alpha`);
  });
});

describe('inboxStatus and reminderFor', () => {
  it('reports unread lines per area and reminds from the last read on', async () => {
    const { deps } = setup({ [`${DIR}/alpha.md`]: LINES.slice(0, 2).join('\n'), [`${DIR}/bravo.md`]: '', [`${DIR}/notes.txt`]: 'x' });
    assert.equal(await reminderFor(deps, 'charlie', 'teamrig'), undefined, 'no inbox file');
    assert.equal(await reminderFor(deps, 'bravo', 'teamrig'), undefined, 'nothing unread');
    assert.match(await reminderFor(deps, 'alpha', 'teamrig') ?? '', /^INBOX: 2 unread line\(s\) .* since 01-07 09:00\./, 'never read: every line is new');
    await readInbox(deps, { area: 'alpha', claudeSession: SESSION, now: NOW });
    await deps.inboxes.append('alpha', LINES[2] ?? '');

    assert.deepEqual((await inboxStatus(deps)).map(formatUnread), [
      'alpha 1 unread since 01-07 11:00 (read to line 2 of 3 at 01-08 10:00)',
      'bravo 0 unread (never marked read)',
    ]);
    assert.equal(
      await reminderFor(deps, 'alpha', 'teamrig'),
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
