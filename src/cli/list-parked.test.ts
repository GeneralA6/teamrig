import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };

/** The ids of the task rows `list` printed, in their order. */
function rowIds(stdout: readonly string[]): string[] {
  return stdout.join('\n').split('\n').flatMap((line) => /^(T\d+) /.exec(line)?.[1] ?? []);
}

/** T1 goes quiet with a class the park rule takes, T2 holds a class it never takes, T3 has none; the lead adds T4 with none. */
async function parkedKit(): Promise<CliHarness> {
  const kit = new CliHarness();
  const fields = ['--description', 'what and why', '--priority', 'p2'];
  await kit.run(['add', '--title', 'Tidy the old notes', ...fields, '--class', 'Improvements', '--owner', 'alpha'], AS_ALPHA);
  await kit.run(['add', '--title', 'Ship the roadmap item', ...fields, '--class', 'Roadmap', '--owner', 'alpha'], AS_ALPHA);
  await kit.run(['add', '--title', 'Look at this later', ...fields, '--owner', 'alpha'], AS_ALPHA);
  await kit.run(['add', '--title', 'The lead asks for this', ...fields, '--owner', 'alpha'], AS_LEAD);
  kit.clock.advance(30 * MS_PER_DAY);
  return kit;
}

describe('runCli: list --parked and --untriaged (T2090)', () => {
  it('leaves a parked task out of a plain list, and shows only those with --parked', async () => {
    const kit = await parkedKit();
    const plain = await kit.run(['list'], AS_ALPHA);
    assert.equal(plain.code, EXIT.ok, plain.stderr.join('\n'));
    assert.deepEqual(rowIds(plain.stdout).sort(), ['T2', 'T3', 'T4']);
    const parked = await kit.run(['list', '--parked'], AS_ALPHA);
    assert.equal(parked.code, EXIT.ok, parked.stderr.join('\n'));
    assert.deepEqual(rowIds(parked.stdout), ['T1']);
  });

  it('shows with --untriaged only the tasks no leader classed, never a leader add or a classed task', async () => {
    const kit = await parkedKit();
    const untriaged = await kit.run(['list', '--untriaged'], AS_ALPHA);
    assert.equal(untriaged.code, EXIT.ok, untriaged.stderr.join('\n'));
    assert.deepEqual(rowIds(untriaged.stdout), ['T3']);
  });

  it('refuses the two switches together, as the answer could only be an empty list', async () => {
    const kit = await parkedKit();
    const refused = await kit.run(['list', '--parked', '--untriaged'], AS_ALPHA);
    assert.equal(refused.code, EXIT.usage);
    assert.match(refused.stderr.join('\n'), /--parked and --untriaged exclude each other/);
  });
});
