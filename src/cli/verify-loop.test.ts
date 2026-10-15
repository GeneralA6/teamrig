import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** A harness holding T1, owned by alpha and in progress. */
async function startedTask(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.run(['add', '--title', 'Ship the CLI', '--priority', 'p2', '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  return kit;
}

describe('runCli: set verifying names its proof', () => {
  it('refuses verifying without --proof, then shows the proof it was set with', async () => {
    const kit = await startedTask();
    const bare = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--session', 'alpha']);
    assert.deepEqual([bare.code, bare.stdout], [EXIT.refused, ['REFUSED verifying needs --proof saying what will prove the shipped change works']]);

    const set = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--proof', 'the nightly run is green', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 verifying, .*\(proof: the nightly run is green\)$/);
    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.match(shown.stdout.join('\n'), /\nproof: the nightly run is green\n[\s\S]*status verifying note="shipped" proof="the nightly run is green"/);
  });

  it('takes the date to verify by as --due', async () => {
    const kit = await startedTask();
    const set = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--proof', 'the nightly run', '--due', '2030-01-09', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 verifying, p2, owner alpha, due 01-09,/);
  });
});

/** A harness where bravo's T1 is verifying and alpha's T2 is planned after it. */
async function heldStart(kit = new CliHarness()): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Ship the CLI', '--priority', 'p2', '--session', 'bravo']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'bravo']);
  await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--proof', 'the nightly run', '--session', 'bravo']);
  await kit.run(['add', '--title', 'Build on the CLI', '--priority', 'p2', '--after', 'T1', '--session', 'alpha']);
  return kit;
}

describe('runCli: a start waits for the verifying tasks it needs', () => {
  const told = '- 2030-01-08 10:00 alpha: T2 waits on your verifying T1: the nightly run';

  it('refuses the start and tells the verifying task owner once a day', async () => {
    const kit = await heldStart();
    const start = ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'];
    const first = await kit.run(start);
    assert.deepEqual(
      [first.code, first.stdout, first.stderr],
      [EXIT.refused, ['REFUSED T2 needs T1, still verifying (proof: the nightly run, owner bravo); start T2 once T1 is done'], ['NOTE bravo has an inbox line: T2 waits on your verifying T1: the nightly run']],
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
    await kit.run(['add', '--title', 'Ship the CLI', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--proof', 'the nightly run', '--session', 'alpha']);
    await kit.run(['add', '--title', 'Build on the CLI', '--priority', 'p2', '--after', 'T1', '--session', 'alpha']);
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
});
