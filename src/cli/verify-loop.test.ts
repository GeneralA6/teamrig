import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord } from '../core/guards.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** A harness holding T1, owned by alpha and in progress. */
async function startedTask(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  return kit;
}

describe('runCli: set verifying names its proof', () => {
  it('refuses verifying without --proof, then shows the proof it was set with', async () => {
    const kit = await startedTask();
    const bare = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--session', 'alpha']);
    assert.deepEqual([bare.code, bare.stdout], [EXIT.refused, ['REFUSED verifying needs --proof saying what will prove the shipped change works']]);

    const set = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run is green', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 verifying, .*\(proof: the nightly run is green\)$/);
    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.match(shown.stdout.join('\n'), /\nproof: the nightly run is green\n[\s\S]*status verifying note="shipped" proof="the nightly run is green"/);
  });

  it('takes the date to verify by as --due', async () => {
    const kit = await startedTask();
    const set = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--due', '2030-01-09', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 verifying, p2, owner alpha, due 01-09,/);
  });
});

describe('runCli: verify lists the verifying tasks of a session', () => {
  it('lists them oldest first, with the proof and the date to verify by', async () => {
    const kit = await startedTask();
    await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--due', '2030-01-09', '--session', 'alpha']);
    kit.clock.advance(60 * 60 * 1000);
    await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['set', 'T2', '--status', 'in-progress', '--session', 'alpha']);
    await kit.run(['set', 'T2', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the docs build', '--session', 'alpha']);

    const listed = await kit.run(['verify', '--session', 'alpha']);
    assert.deepEqual(
      [listed.code, listed.stdout],
      [
        EXIT.ok,
        [
          'VERIFY 2 tasks of alpha, oldest first',
          'T1 since 01-08 10:00 UTC, verify by 01-09 | Ship the CLI (proof: the nightly run)',
          'T2 since 01-08 11:00 UTC, no verify-by date | Ship the docs (proof: the docs build)',
        ],
      ],
    );
    const none = await kit.run(['verify', '--session', 'bravo']);
    assert.deepEqual([none.code, none.stdout], [EXIT.ok, ['VERIFY 0 tasks of bravo, oldest first']]);
  });
});

describe('the verify queue reaches its session', () => {
  const queue = 'VERIFY 1, oldest first:\n  T1 (proof: the nightly run)';
  const start = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'startup' });

  async function verifying(): Promise<CliHarness> {
    const kit = await startedTask();
    await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--session', 'alpha']);
    return kit;
  }

  it('in the start context of a session that holds verifying tasks, and of no other', async () => {
    const kit = await verifying();
    const context = contextOf(await kit.run(['hook', 'session-start'], { stdin: start, env: { TEAMRIG_SESSION: 'alpha' } }));
    assert.ok(context.includes(`
${queue}`), context);
    const other = contextOf(await kit.run(['hook', 'session-start'], { stdin: start, env: { TEAMRIG_SESSION: 'bravo' } }));
    assert.ok(!other.includes('VERIFY'));
  });

  it('starts the session without it when the register cannot be read', async () => {
    const kit = await verifying();
    const files = new FaultyFiles(kit.files).fail('read', EVENTS_PATH, systemError('EACCES'));
    const result = await kit.run(['hook', 'session-start'], { stdin: start, env: { TEAMRIG_SESSION: 'alpha' }, files });
    assert.equal(result.code, EXIT.ok);
    assert.ok(!contextOf(result).includes('VERIFY'));
  });

  it('after the lines of inbox read', async () => {
    const kit = await verifying();
    const read = await kit.run(['inbox', 'read', '--session', 'alpha']);
    assert.equal(read.code, EXIT.ok);
    assert.equal(read.stdout.at(-1), queue);
    const other = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.ok(other.stdout.every((line) => !line.startsWith('VERIFY')), other.stdout.join('\n'));
  });
});

describe('the Stop hook names a verifying task once its verify-by day has come', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const SCANS = join(TEAM_HOME, 'state', 'verify-notices.jsonl');
  const stop = (kit: CliHarness, files?: FaultyFiles): Promise<CliResult> =>
    kit.run(['hook', 'stop'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, stop_hook_active: false }), env: { TEAMRIG_SESSION: 'alpha' }, ...(files === undefined ? {} : { files }) });
  const shown = (result: CliResult): unknown => {
    const parsed: unknown = JSON.parse(result.stdout[0] ?? '{}');
    return isRecord(parsed) ? parsed['systemMessage'] : undefined;
  };
  const line = 'VERIFY T1 was to be verified by 01-08 (proof: the nightly run): done with the proof, or back to in-progress';

  it('once a day from that day on, reading the register at the first stop of the day only', async () => {
    const kit = await startedTask();
    await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--due', '2030-01-09', '--session', 'alpha']);
    assert.deepEqual((await stop(kit)).stdout, [], 'not before the day');
    await kit.run(['update', 'T1', '--due', '2030-01-08', '--session', 'lead']);
    assert.deepEqual((await stop(kit)).stdout, [], 'a date that comes later in the day waits for the next one');

    kit.clock.advance(DAY);
    const unread = new FaultyFiles(kit.files).fail('read', EVENTS_PATH, systemError('EACCES'));
    assert.deepEqual((await stop(kit, unread)).stdout, [], 'an unread register says nothing');
    assert.equal(shown(await stop(kit)), line, 'and is read again at the next stop');
    assert.deepEqual((await stop(kit)).stdout, [], 'once a day');
    kit.clock.advance(DAY);
    assert.equal(shown(await stop(kit)), line, 'and again the next day');
    kit.clock.advance(DAY);
    await kit.run(['set', 'T1', '--status', 'done', '--note', 'green', '--evidence', 'run 7', '--skill', 'none', '--followups', 'none', '--session', 'alpha']);
    assert.deepEqual((await stop(kit)).stdout, [], 'a proven task is out of the queue');
  });

  it('says nothing when it cannot keep its daily record, so it never repeats', async () => {
    const kit = await startedTask();
    await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--due', '2030-01-08', '--session', 'alpha']);
    const files = new FaultyFiles(kit.files).fail('write', SCANS, systemError('EACCES'));
    assert.deepEqual(await stop(kit, files), { code: EXIT.ok, stdout: [], stderr: [] });
    assert.equal(shown(await stop(kit)), line);
  });
});

/** A harness where bravo's T1 is verifying and alpha's T2 is planned after it. */
async function heldStart(kit = new CliHarness()): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'bravo']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'bravo']);
  await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--session', 'bravo']);
  await kit.run(['add', '--title', 'Build on the CLI', '--description', 'what and why', '--priority', 'p2', '--after', 'T1', '--session', 'alpha']);
  return kit;
}

describe('runCli: a start waits for the verifying tasks it needs', () => {
  const told = '- 2030-01-08 10:00 UTC alpha: T2 waits on your verifying T1: the nightly run';

  it('refuses the start and tells the verifying task owner once a day', async () => {
    const kit = await heldStart();
    const start = ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'];
    const first = await kit.run(start);
    assert.deepEqual(
      [first.code, first.stdout, first.stderr],
      [
        EXIT.refused,
        ['REFUSED T2 needs T1, still verifying (proof: the nightly run, owner bravo); start T2 once T1 is done, or with --met "<what shows the proof exists>"'],
        ['NOTE bravo has an inbox line: T2 waits on your verifying T1: the nightly run'],
      ],
    );
    const again = await kit.run(start);
    assert.deepEqual([again.code, again.stderr], [EXIT.refused, []], 'told already today');
    const inbox = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.deepEqual(inbox.stdout.filter((line) => line.startsWith('- ')), [told]);

    kit.clock.advance(24 * 60 * 60 * 1000);
    assert.deepEqual((await kit.run(start)).stderr, ['NOTE bravo has an inbox line: T2 waits on your verifying T1: the nightly run'], 'a new day');
  });

  it('tells nobody when the caller owns the verifying task too', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--session', 'alpha']);
    await kit.run(['add', '--title', 'Build on the CLI', '--description', 'what and why', '--priority', 'p2', '--after', 'T1', '--session', 'alpha']);
    const start = await kit.run(['set', 'T2', '--status', 'in-progress', '--session', 'alpha']);
    assert.deepEqual([start.code, start.stderr], [EXIT.refused, []]);
  });

  it('names a line it could not post, and tries again on the next start', async () => {
    const kit = await heldStart(new CliHarness({ ...TEAM, register: { secretPatterns: ['waits on your'] } }));
    const start = ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'];
    const first = await kit.run(start);
    assert.equal(first.code, EXIT.refused);
    assert.deepEqual(first.stderr.map((line) => line.split(':')[0]), ['WARN bravo was not told of T2']);
    assert.equal((await kit.run(start)).stderr.length, 1, 'nothing recorded, so it tries again');
  });

  it('starts it in warn mode, warning and telling the owner', async () => {
    const kit = await heldStart(new CliHarness({ ...TEAM, register: { verifyGate: 'warn' } }));
    const start = await kit.run(['set', 'T2', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(start.code, EXIT.ok, start.stdout.join('\n'));
    assert.match(start.stdout[0] ?? '', /^SET T2 in-progress,/);
    assert.deepEqual(start.stderr, [
      'NOTE bravo has an inbox line: T2 waits on your verifying T1: the nightly run',
      'WARN T2 needs T1, still verifying (proof: the nightly run, owner bravo); started anyway, as register.verifyGate is warn',
    ]);
    const inbox = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.deepEqual(inbox.stdout.filter((line) => line.startsWith('- ')), [told]);
  });

  it('warns of no start in warn mode when the start was refused for another reason', async () => {
    const kit = await heldStart(new CliHarness({ ...TEAM, register: { verifyGate: 'warn', secretPatterns: ['hunter2'] } }));
    const start = await kit.run(['set', 'T2', '--status', 'in-progress', '--note', 'hunter2', '--session', 'alpha']);
    assert.deepEqual([start.code, start.stderr], [EXIT.refused, []]);
  });
});

describe('runCli: a start names what met the proof it waits for', () => {
  const met = 'the nightly run of 01-08 is green';
  const notice = `T2 started on your verifying T1, its proof met: ${met}; set T1 done if that holds, else reopen it`;

  it('starts it, asks the verifying task owner to confirm or reopen, and keeps it out of the evidence', async () => {
    const kit = await heldStart();
    const start = await kit.run(['set', 'T2', '--status', 'in-progress', '--met', met, '--session', 'alpha']);
    assert.equal(start.code, EXIT.ok, start.stdout.join('\n'));
    assert.match(start.stdout[0] ?? '', /^SET T2 in-progress,/);
    assert.deepEqual(start.stderr, [`NOTE bravo has an inbox line: ${notice}`]);
    const inbox = await kit.run(['inbox', 'read', '--session', 'bravo']);
    assert.deepEqual(inbox.stdout.filter((line) => line.startsWith('- ')), [`- 2030-01-08 10:00 UTC alpha: ${notice}`]);
    const shown = await kit.run(['show', 'T2', '--session', 'alpha']);
    assert.match(shown.stdout.join('\n'), new RegExp(`status in-progress met="${met}"`));
    assert.doesNotMatch(shown.stdout.join('\n'), /\nevidence:/);

    const done = await kit.run(['set', 'T2', '--status', 'done', '--note', 'built', '--followups', 'none', '--skill', 'none', '--session', 'alpha']);
    assert.deepEqual([done.code, done.stdout[0]], [EXIT.refused, 'REFUSED done needs --evidence: a commit, test count, path or number that proves it']);
  });

  it('tells the owner without the warning in warn mode', async () => {
    const kit = await heldStart(new CliHarness({ ...TEAM, register: { verifyGate: 'warn' } }));
    const start = await kit.run(['set', 'T2', '--status', 'in-progress', '--met', met, '--session', 'alpha']);
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, [`NOTE bravo has an inbox line: ${notice}`]]);
  });

  it('refuses --met on a start nothing holds', async () => {
    const kit = await startedTask();
    await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    const start = await kit.run(['set', 'T2', '--status', 'in-progress', '--met', met, '--session', 'alpha']);
    assert.deepEqual([start.code, start.stdout], [EXIT.refused, ['REFUSED --met goes only with a start that a verifying task it needs holds']]);
  });
});

/** A harness where alpha's T1 is verifying, to be verified by today, and alpha's T2 is new work. */
async function dueVerify(kit = new CliHarness()): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--followups', 'none', '--proof', 'the nightly run', '--due', '2030-01-08', '--session', 'alpha']);
  await kit.run(['add', '--title', 'Plan the next step', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
  return kit;
}

describe("runCli: new work waits for its owner's verify steps that are due", () => {
  const start = ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'];

  it('refuses the first start until the verify step is re-dated with a reason', async () => {
    const kit = await dueVerify();
    const held = await kit.run(start);
    assert.equal(held.code, EXIT.refused);
    assert.match(held.stdout[0] ?? '', /^REFUSED T2 is new work; T1 \(verify by 01-08\) is due to verify first \(teamrig verify\): /);
    const redated = await kit.run(['set', 'T1', '--status', 'verifying', '--due', '2030-01-09', '--note', 'the nightly run moved to tomorrow', '--followups', 'none', '--session', 'alpha']);
    assert.equal(redated.code, EXIT.ok, redated.stdout.join('\n'));
    const started = await kit.run(start);
    assert.equal(started.code, EXIT.ok, started.stdout.join('\n'));
  });

  it('starts it in warn mode, with a warning', async () => {
    const kit = await dueVerify(new CliHarness({ ...TEAM, register: { verifyGate: 'warn' } }));
    const started = await kit.run(start);
    assert.equal(started.code, EXIT.ok, started.stdout.join('\n'));
    assert.equal(started.stderr.length, 1, started.stderr.join('\n'));
    assert.match(started.stderr[0] ?? '', /^WARN T2 is new work; T1 \(verify by 01-08\) is due to verify first .*; started anyway, as register\.verifyGate is warn$/);
  });
});
