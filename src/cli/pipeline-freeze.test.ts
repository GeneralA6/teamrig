import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PIPELINE_FREEZES_FILE } from '../delivery/pipeline-freezes.ts';
import { CliHarness, KIT, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** The freezes beside the host lock in the kit home, where every team on the host reads them. */
const FREEZES = join(KIT, PIPELINE_FREEZES_FILE);
/** TEAM with alpha its delivery owner. */
const OWNED = { ...TEAM, roles: { lead: 'lead', deliveryOwner: 'alpha' } };

function freezesIn(kit: CliHarness): unknown {
  return JSON.parse(kit.files.get(FREEZES) ?? 'null');
}

describe('teamrig pipeline freeze', () => {
  it('freezes every step kind from now to --to and prints FROZEN with its id', async () => {
    const kit = new CliHarness(OWNED);
    assert.deepEqual(await kit.run(['pipeline', 'freeze', '--session', 'alpha', '--to', '12:00', '--reason', 'PC downtime']), {
      code: EXIT.ok,
      stdout: ['FROZEN F1 2030-01-08 10:00 UTC → 2030-01-08 12:00 UTC, all steps, by alpha (PC downtime)'],
      stderr: [],
    });
    assert.deepEqual(freezesIn(kit), [{ id: 'F1', session: 'alpha', from: '2030-01-08T10:00:00.000Z', to: '2030-01-08T12:00:00.000Z', reason: 'PC downtime', at: '2030-01-08T10:00:00.000Z' }]);
  });

  it('freezes the kinds --kinds names from --from, by the lead', async () => {
    const kit = new CliHarness(OWNED);
    const result = await kit.run(['pipeline', 'freeze', '--session', 'lead', '--from', '2030-01-09 00:00', '--to', '2030-01-09 02:00', '--kinds', 'merge,deploy', '--reason', 'backup']);
    assert.deepEqual(result.stdout, ['FROZEN F1 2030-01-09 00:00 UTC → 2030-01-09 02:00 UTC, merge,deploy, by lead (backup)']);
  });

  it('refuses a session that is neither the lead nor the delivery owner, writing nothing', async () => {
    const kit = new CliHarness(OWNED);
    assert.deepEqual(await kit.run(['pipeline', 'freeze', '--session', 'bravo', '--to', '12:00', '--reason', 'PC downtime']), {
      code: EXIT.refused,
      stdout: ['REFUSED only the lead or the delivery owner (app-lead, app-alpha) freezes the pipeline'],
      stderr: [],
    });
    assert.equal(kit.files.get(FREEZES), undefined);
  });

  it('refuses an end before the start, and is a usage error for an unknown kind or a time it cannot read', async () => {
    const kit = new CliHarness(OWNED);
    assert.deepEqual((await kit.run(['pipeline', 'freeze', '--session', 'lead', '--to', '09:00', '--reason', 'late'])).stdout, ['REFUSED a freeze ends after it starts']);
    const unknown = await kit.run(['pipeline', 'freeze', '--session', 'lead', '--to', '12:00', '--kinds', 'merge,nap', '--reason', 'x']);
    assert.equal(unknown.code, EXIT.usage);
    assert.ok([...unknown.stdout, ...unknown.stderr].some((line) => line.includes('--kinds "merge,nap": nap is not a step kind (build, test, lint, push, merge, deploy, other)')), JSON.stringify(unknown));
    assert.equal((await kit.run(['pipeline', 'freeze', '--session', 'lead', '--to', 'soon', '--reason', 'x'])).code, EXIT.usage);
    assert.equal(kit.files.get(FREEZES), undefined);
  });
});

describe('teamrig pipeline unfreeze', () => {
  it('ends a holding freeze now and prints UNFROZEN; refuses an id no live freeze has', async () => {
    const kit = new CliHarness(OWNED);
    assert.equal((await kit.run(['pipeline', 'freeze', '--session', 'alpha', '--to', '12:00', '--reason', 'PC downtime'])).code, EXIT.ok);
    assert.deepEqual(await kit.run(['pipeline', 'unfreeze', 'F1', '--session', 'lead']), {
      code: EXIT.ok,
      stdout: ['UNFROZEN F1 2030-01-08 10:00 UTC → 2030-01-08 10:00 UTC, all steps, by alpha (PC downtime)'],
      stderr: [],
    });
    assert.deepEqual((await kit.run(['pipeline', 'unfreeze', 'F1', '--session', 'lead'])).stdout, ['REFUSED no live pipeline freeze is F1 (live: none)']);
  });

  it('refuses another session, and is a usage error with no id', async () => {
    const kit = new CliHarness(OWNED);
    assert.deepEqual((await kit.run(['pipeline', 'unfreeze', 'F1', '--session', 'bravo'])).stdout, ['REFUSED only the lead or the delivery owner (app-lead, app-alpha) ends a pipeline freeze']);
    assert.equal((await kit.run(['pipeline', 'unfreeze', '--session', 'lead'])).code, EXIT.usage);
  });
});
