import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';
import { REGISTER_ONLY_LINE } from './commands/register.ts';

const TOLD = 'NOTE bravo has an inbox line: T1 is yours (p2, due 2030-01-10): Ship the docs';

async function inboxOf(kit: CliHarness, session: string): Promise<string[]> {
  const read = await kit.run(['inbox', 'read', '--session', session]);
  return read.stdout.filter((line) => line.startsWith('- '));
}

describe('runCli: giving a task to another session posts it an inbox line', () => {
  it('tells the owner of a task added for it, and nobody of a task the caller keeps', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-10', '--owner', 'bravo', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /^ADDED T1 /);
    assert.deepEqual(added.stderr, [TOLD]);
    assert.deepEqual(await inboxOf(kit, 'bravo'), ['- 2030-01-08 10:00 UTC alpha: T1 is yours (p2, due 2030-01-10): Ship the docs']);

    const kept = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    assert.deepEqual([kept.code, kept.stderr], [EXIT.ok, []]);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);
  });

  it('tells the new owner of a reassigned task, and nobody when the owner stays', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const moved = await kit.run(['update', 'T1', '--owner', 'bravo', '--session', 'lead']);
    assert.equal(moved.code, EXIT.ok, moved.stderr.join('\n'));
    assert.deepEqual(moved.stderr, ['NOTE bravo has an inbox line: T1 is yours (p1): Ship the CLI']);

    const reprioritized = await kit.run(['update', 'T1', '--priority', 'p2', '--session', 'lead']);
    assert.deepEqual([reprioritized.code, reprioritized.stderr], [EXIT.ok, []]);
    const taken = await kit.run(['update', 'T1', '--owner', 'lead', '--session', 'lead']);
    assert.deepEqual([taken.code, taken.stderr], [EXIT.ok, []]);
    assert.deepEqual(await inboxOf(kit, 'lead'), []);
  });

  it('takes a note alone on a task the caller does not own, and tells nobody', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const noted = await kit.run(['update', 'T1', '--note', 'the ask came with 72 of 75 cold wakes', '--session', 'bravo']);
    assert.equal(noted.code, EXIT.ok, noted.stderr.join('\n'));
    assert.match(noted.stdout[0] ?? '', /^UPDATED T1 /);
    assert.deepEqual(noted.stderr, [REGISTER_ONLY_LINE]);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);

    const empty = await kit.run(['update', 'T1', '--session', 'bravo']);
    assert.notEqual(empty.code, EXIT.ok);
    assert.match([...empty.stdout, ...empty.stderr].join('\n'), /REFUSED nothing to change: give a field or a --note/);
  });

  it('names a line it could not post, and keeps the task', async () => {
    const kit = new CliHarness({ ...TEAM, register: { secretPatterns: ['is yours'] } });
    const added = await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--owner', 'bravo', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok);
    assert.match(added.stdout[0] ?? '', /^ADDED T1 /);
    assert.deepEqual(added.stderr.map((line) => line.split(':')[0]), ['WARN bravo was not told of T1']);
    assert.deepEqual(await inboxOf(kit, 'bravo'), []);
  });
});
