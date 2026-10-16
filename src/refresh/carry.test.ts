import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { carryLines, carryOf, carryStartOf, readCarry, RECURRING_MAX_AGE_MS, scratchpadOf, toldScratchpadOf, type Carry } from './carry.ts';

const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const lines = (...entries: readonly object[]): string => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

function call(id: string, name: string, input: object, at: number): object {
  return { type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function result(id: string, toolUseResult: object, isError = false): object {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] }, toolUseResult };
}

/** The `environment` attachment Claude Code writes with what the session was told about its machine. */
function environment(snapshot: object): object {
  return { type: 'attachment', attachment: { type: 'environment', snapshot } };
}

function cronCreate(id: string, job: string, cron: string, prompt: string, recurring: boolean, at: number): readonly object[] {
  return [call(id, 'CronCreate', { cron, prompt, recurring }, at), result(id, { id: job, humanSchedule: cron, recurring, durable: false })];
}

const SNAPSHOT = {
  type: 'attachment',
  attachment: {
    type: 'session_cron_carry',
    tasks: [
      { id: 'old1', cron: '3 13 * * *', prompt: 'budget checkpoint', createdAt: NOW - 60 * MINUTE, recurring: true },
      { id: 'old2', cron: '0 9 * * *', prompt: 'deleted later', createdAt: NOW - 60 * MINUTE, recurring: true },
    ],
  },
};

describe('carryOf', () => {
  it("counts the jobs from the last compaction's snapshot on, with those made after and less those deleted", () => {
    const earlier = cronCreate('toolu_0', 'gone', '1 1 * * *', 'before the snapshot', true, NOW - 120 * MINUTE);
    const text = lines(
      ...earlier,
      SNAPSHOT,
      ...cronCreate('toolu_1', 'new1', '30 11 * * *', 'check the roll', true, NOW - 10 * MINUTE),
      call('toolu_2', 'CronDelete', { id: 'old2' }, NOW - 5 * MINUTE),
    );
    const carry = carryOf(text, NOW);
    assert.deepEqual(
      carry.crons.map((cron) => [cron.id, cron.cron, cron.prompt, cron.recurring]),
      [
        ['old1', '3 13 * * *', 'budget checkpoint', true],
        ['new1', '30 11 * * *', 'check the roll', true],
      ],
    );
    assert.equal(carry.crons[1]?.createdAt, NOW - 10 * MINUTE);
  });

  it('drops a one-shot job once its prompt was queued, and keeps a recurring one', () => {
    const text = lines(
      ...cronCreate('toolu_1', 'once', '13 8 8 1 *', 'morning brief', false, NOW - 120 * MINUTE),
      ...cronCreate('toolu_2', 'daily', '3 13 * * *', 'daily check', true, NOW - 120 * MINUTE),
      { type: 'queue-operation', operation: 'enqueue', content: 'morning brief' },
      { type: 'queue-operation', operation: 'enqueue', content: 'daily check' },
    );
    assert.deepEqual(
      carryOf(text, NOW).crons.map((cron) => cron.id),
      ['daily'],
    );
  });

  it('drops a recurring job past its 7 days, and a job whose CronCreate failed', () => {
    const text = lines(
      ...cronCreate('toolu_1', 'stale', '3 13 * * *', 'old', true, NOW - RECURRING_MAX_AGE_MS - MINUTE),
      call('toolu_2', 'CronCreate', { cron: 'bad', prompt: 'x', recurring: true }, NOW - MINUTE),
      result('toolu_2', { id: 'never' }, true),
    );
    assert.deepEqual(carryOf(text, NOW).crons, []);
  });

  it('keeps the last wake-up still to come, at the time its result says', () => {
    const text = lines(
      call('toolu_1', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'first', reason: 'r' }, NOW - 20 * MINUTE),
      call('toolu_2', 'ScheduleWakeup', { delaySeconds: 1200, prompt: 'check CI', reason: 'r' }, NOW - 5 * MINUTE),
      result('toolu_2', { scheduledFor: NOW + 16 * MINUTE, clampedDelaySeconds: 1200, wasClamped: false }),
    );
    assert.deepEqual(carryOf(text, NOW).wake, { dueAt: NOW + 16 * MINUTE, prompt: 'check CI' });
  });

  it('has no wake-up once it is due, fired, stopped or refused', () => {
    const asked = call('toolu_1', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'check CI', reason: 'r' }, NOW - 5 * MINUTE);
    assert.equal(carryOf(lines(asked), NOW + 10 * MINUTE).wake, undefined);
    assert.equal(carryOf(lines(asked, { type: 'queue-operation', operation: 'enqueue', content: 'check CI' }), NOW).wake, undefined);
    assert.equal(carryOf(lines(asked, call('toolu_2', 'ScheduleWakeup', { stop: true }, NOW - MINUTE)), NOW).wake, undefined);
    assert.equal(carryOf(lines(asked, result('toolu_1', {}, true)), NOW).wake, undefined);
  });

  it("names the session's slug from its last entry, and skips lines it cannot read", () => {
    const text = `{"cut":\n${lines({ type: 'user', slug: 'first-slug' }, { type: 'assistant', slug: 'quiet-river-otter' })}`;
    assert.deepEqual(carryOf(text, NOW), { crons: [], wake: undefined, planSlug: 'quiet-river-otter' });
    assert.equal(carryOf(lines({ type: 'user', slug: '../bad' }), NOW).planSlug, undefined);
  });
});

describe('readCarry', () => {
  const TEMP = join('/', 'tmp');
  const CLAUDE = join('/', 'cfg');
  const TRANSCRIPT = join(CLAUDE, 'projects', 'C--work-app', '6f1c2d3e.jsonl');
  const PLACES = { tempDir: TEMP, claudeDir: CLAUDE };

  it('names the old scratchpad, when it holds anything, and the plan file, when there is one', async () => {
    const scratchpad = join(TEMP, 'claude', 'C--work-app', '6f1c2d3e', 'scratchpad');
    assert.equal(scratchpadOf(TRANSCRIPT, TEMP), scratchpad);
    const files = new MemoryFiles({
      [TRANSCRIPT]: lines({ type: 'assistant', slug: 'quiet-river-otter' }),
      [join(scratchpad, 'notes.md')]: 'n',
      [join(scratchpad, 'tools', 'a.cjs')]: 'a',
      [join(CLAUDE, 'plans', 'quiet-river-otter.md')]: '# plan',
    });
    const carry = await readCarry(files, TRANSCRIPT, NOW, PLACES);
    assert.deepEqual(carry?.scratchpad, { path: scratchpad, entries: 2 });
    assert.equal(carry?.plan, join(CLAUDE, 'plans', 'quiet-river-otter.md'));
  });

  it('leaves out an empty scratchpad and a missing plan, and reads nothing from a missing transcript', async () => {
    const files = new MemoryFiles({ [TRANSCRIPT]: lines({ type: 'assistant', slug: 'quiet-river-otter' }) });
    assert.deepEqual(await readCarry(files, TRANSCRIPT, NOW, PLACES), { crons: [], wake: undefined, planSlug: 'quiet-river-otter', scratchpad: undefined, plan: undefined });
    assert.equal(await readCarry(new MemoryFiles(), TRANSCRIPT, NOW, PLACES), undefined);
  });

  it('names the scratchpad Claude Code last gave the session, though its transcript moved to another project folder', async () => {
    const before = join(TEMP, 'claude', 'C--work', '6f1c2d3e', 'scratchpad');
    const told = join(TEMP, 'claude', 'C--work-first', '6f1c2d3e', 'scratchpad');
    const files = new MemoryFiles({
      [TRANSCRIPT]: lines(
        environment({ workingDirectory: '/work', scratchpadDirectory: before }),
        environment({ workingDirectory: '/work/app', scratchpadDirectory: told }),
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: JSON.stringify(environment({ scratchpadDirectory: before })) }] } },
      ),
      [join(told, 'notes.md')]: 'n',
    });
    const carry = await readCarry(files, TRANSCRIPT, NOW, PLACES);
    assert.deepEqual(carry?.scratchpad, { path: told, entries: 1 });
  });
});

describe('toldScratchpadOf', () => {
  it('skips an environment entry with no scratchpad and a cut first line, and finds none in a transcript without one', () => {
    const told = join('/', 'tmp', 'claude', 'C--work', 'a1', 'scratchpad');
    const cut = JSON.stringify(environment({ scratchpadDirectory: '/elsewhere' })).slice(20);
    assert.equal(toldScratchpadOf(`${cut}\n${lines(environment({ scratchpadDirectory: told }), environment({ workingDirectory: '/work' }))}`), told);
    assert.equal(toldScratchpadOf(`${cut}\n`), undefined);
    assert.equal(toldScratchpadOf(lines({ type: 'assistant', slug: 'quiet-river-otter' })), undefined);
  });
});

describe('carryStartOf', () => {
  it('starts in the same process after a /clear, and in a new one after any other fresh start', () => {
    assert.equal(carryStartOf('clear'), 'same-process');
    for (const source of ['startup', 'resume', undefined]) {
      assert.equal(carryStartOf(source), 'new-process', String(source));
    }
  });
});

describe('carryLines', () => {
  const EMPTY: Carry = { crons: [], wake: undefined, planSlug: undefined, scratchpad: undefined, plan: undefined };

  it('says nothing when there is nothing to take over', () => {
    assert.deepEqual(carryLines(EMPTY, NOW, 'new-process'), []);
  });

  it('gives each job and the wake-up exactly as they were asked for, and where the old files are', () => {
    const carry: Carry = {
      ...EMPTY,
      crons: [{ id: 'old1', cron: '3 13 * * *', prompt: 'budget "checkpoint"', recurring: true, createdAt: NOW }],
      wake: { dueAt: NOW + 7 * MINUTE + 1, prompt: 'check CI' },
      scratchpad: { path: '/tmp/s', entries: 3 },
      plan: '/cfg/plans/p.md',
    };
    assert.deepEqual(carryLines(carry, NOW, 'new-process'), [
      'Your old session had 1 scheduled job(s), which end with its process: run CronList and make each one it does not show again with CronCreate:',
      '- cron "3 13 * * *", recurring true, prompt "budget \\"checkpoint\\""',
      'It had a wake-up due at 10:07 UTC: schedule it again with ScheduleWakeup, delaySeconds 421, prompt "check CI".',
      'Its scratchpad stays at /tmp/s (3 entries); yours is a new, empty one, so read or copy from the old one what you still need.',
      'Its plan file: /cfg/plans/p.md.',
    ]);
  });

  it('after a /clear, says the jobs are still scheduled and lists none to make again', () => {
    const crons = [
      { id: 'old1', cron: '3 13 * * *', prompt: 'budget check', recurring: true, createdAt: NOW },
      { id: 'old2', cron: '30 9 * * 1', prompt: 'weekly', recurring: true, createdAt: NOW },
    ];
    assert.deepEqual(carryLines({ ...EMPTY, crons, plan: '/cfg/plans/p.md' }, NOW, 'same-process'), [
      "Your old session's 2 scheduled job(s) are still scheduled, since a /clear keeps the process (CronList shows them): do not make them again.",
      'Its plan file: /cfg/plans/p.md.',
    ]);
    assert.deepEqual(carryLines(EMPTY, NOW, 'same-process'), []);
  });

  it('asks for the shortest wake-up delay when the old one is nearly due', () => {
    assert.match(carryLines({ ...EMPTY, wake: { dueAt: NOW + 5_000, prompt: 'p' } }, NOW, 'new-process')[0] ?? '', /delaySeconds 60,/);
  });
});
