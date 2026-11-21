import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shippedTranscripts } from '../testing/shipped-transcripts.ts';
import { OWNER_TURNS_MAX_CHARS, ownerTurnsLine, ownerTurnsOf, ownerTurnsText } from './owner-turns.ts';

const HANDOVER = '/team/handover/lead.md';
const reader = shippedTranscripts();

/** One transcript line per entry. */
function transcriptOf(...entries: readonly object[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

const typed = (text: string, extra: object = {}): object => ({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, ...extra });
const call = (name: string, input: object): object => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }] } });
const result = (text: string): object => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: text }] }, toolUseResult: { stdout: text } });
const CHECK = '[lead check: inbox + queue health]\n1) Inbox: run teamrig inbox read';

describe('ownerTurnsOf', () => {
  it('keeps what the owner typed, marking what came after the last handover write', () => {
    const text = transcriptOf(
      typed('Ship the cleanup only after I approve the counts'),
      call('Write', { file_path: HANDOVER, content: '# first' }),
      typed('Decision: approve the release once the photos are checked'),
      call('Edit', { file_path: HANDOVER, old_string: 'a', new_string: 'b' }),
      typed('Also hold the PR until Monday'),
    );
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER), [
      { text: 'Ship the cleanup only after I approve the counts', afterHandover: false },
      { text: 'Decision: approve the release once the photos are checked', afterHandover: false },
      { text: 'Also hold the PR until Monday', afterHandover: true },
    ]);
  });

  it('counts a shell command naming the handover as its write', () => {
    const text = transcriptOf(typed('first'), call('Bash', { command: `cat > ${HANDOVER} <<'E'` }), typed('second'));
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER).map((turn) => turn.afterHandover), [false, true]);
  });

  it('marks nothing after the handover when the transcript never wrote it', () => {
    assert.deepEqual(ownerTurnsOf(reader, transcriptOf(typed('hello')), HANDOVER), [{ text: 'hello', afterHandover: false }]);
  });

  it('skips the turns nobody typed: tool results, meta, summaries, subagents, scheduled, notifications, peers, commands and the prompts teamrig types', () => {
    const text = transcriptOf(
      result('ok'),
      typed('Caveat: the messages below', { isMeta: true }),
      typed('This session is being continued', { isCompactSummary: true }),
      typed('a subagent prompt', { isSidechain: true }),
      typed('scheduled run', { turnOrigin: 'scheduled' }),
      typed('from a peer', { origin: { kind: 'peer' } }),
      typed('<task-notification>done</task-notification>'),
      typed('<command-name>/clear</command-name>'),
      typed('/model opus'),
      typed('You were started fresh after your context refresh: read your handover now'),
      typed('the one real prompt'),
    );
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER), [{ text: 'the one real prompt', afterHandover: false }]);
  });

  it('skips a scheduled job firing and a prompt repeated three times or more, and carries a repeated one once', () => {
    const text = transcriptOf(
      call('CronCreate', { cron: '*/30 * * * *', prompt: 'check the build', recurring: true }),
      typed('check the build'),
      typed(CHECK),
      typed('approve it'),
      typed(CHECK),
      typed('approve it'),
      typed(CHECK),
      typed('inherited job'),
    );
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER, ['inherited job']), [{ text: 'approve it', afterHandover: false }]);
  });

  it('skips the firing of a job the host lists as live at a compaction, the session\'s own or one an earlier session armed', () => {
    const job = (id: string, prompt: string): object => ({ id, cron: '3 13 * * *', prompt, recurring: true, createdAt: 1 });
    const text = transcriptOf(
      typed('budget checkpoint'),
      { type: 'attachment', attachment: { type: 'session_cron_carry', tasks: [job('own1', 'budget checkpoint')], otherArmed: [job('armed1', ' morning brief ')] } },
      typed('morning brief'),
      typed('the "session_cron_carry" list is wrong'),
    );
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER), [{ text: 'the "session_cron_carry" list is wrong', afterHandover: false }]);
  });

  it('skips a notification and a hand-back by their origin, and a prompt a wake-up call scheduled', () => {
    const text = transcriptOf(
      call('ScheduleWakeup', { delaySeconds: 600, prompt: 'look at the run' }),
      typed('look at the run'),
      typed('a task ended', { origin: { kind: 'task-notification' } }),
      typed('another ended', { turnOrigin: 'task_notification' }),
      typed('the helper is back', { origin: { kind: 'peer', handback: true } }),
      typed('typed by a person', { origin: { kind: 'human' } }),
    );
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER), [{ text: 'typed by a person', afterHandover: false }]);
  });

  it('passes over a damaged line and a blank one', () => {
    const text = `${transcriptOf(typed('before'))}{"type":"user","message":{"role":"us\n\n  \n${transcriptOf(typed('after'))}`;
    assert.deepEqual(ownerTurnsOf(reader, text, HANDOVER).map((turn) => turn.text), ['before', 'after']);
  });

  it('reads text blocks, and keeps the newest within the cap', () => {
    const blocks = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'image' }, { type: 'text', text: 'part two' }] } };
    assert.deepEqual(ownerTurnsOf(reader, transcriptOf(blocks), HANDOVER), [{ text: 'part one\npart two', afterHandover: false }]);
    const long = 'x'.repeat(OWNER_TURNS_MAX_CHARS - 10);
    const turns = ownerTurnsOf(reader, transcriptOf(typed('oldest'), typed(long), typed('newest message')), HANDOVER);
    assert.equal(turns.length, 2, 'the oldest finds no room left');
    assert.equal(turns[1]?.text, 'newest message');
    assert.equal(turns[0]?.text.length, OWNER_TURNS_MAX_CHARS - 'newest message'.length);
    assert.ok(turns[0]?.text.endsWith('…'), 'the older one is cut to the room left');
  });

  it('writes a file of headed prompts, and a pointer line that names the late ones', () => {
    const turns = [
      { text: 'approve the release', afterHandover: false },
      { text: 'hold the PR', afterHandover: true },
    ];
    assert.equal(
      ownerTurnsText(turns),
      '# What the owner typed in your old session\n\nOldest first. Check each against your handover and act on any decision or ask it does not cover.\n\n' +
        '## 1\n\napprove the release\n\n## 2 (after your handover was written: it does not hold this)\n\nhold the PR\n',
    );
    assert.equal(
      ownerTurnsLine(turns, '/h/lead.owner.md'),
      'The owner typed 2 prompt(s) in your old session, 1 of them after your handover was written: read /h/lead.owner.md after your handover and act on any decision or ask it does not cover.',
    );
    assert.equal(ownerTurnsLine([], '/h/lead.owner.md'), undefined);
  });
});
