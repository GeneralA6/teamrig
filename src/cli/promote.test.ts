import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { CliHarness, CONFIG_PATH, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { EXIT } from './runtime.ts';

const TREE_TEAM: JsonRecord = { sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta'], roles: { lead: 'lead' } };

function leadsOf(kit: CliHarness): unknown {
  const text = kit.files.get(CONFIG_PATH);
  const config: unknown = text === undefined ? undefined : JSON.parse(text);
  assert.ok(isRecord(config));
  return config['leads'];
}

function refusal(result: CliResult): string {
  assert.equal(result.code, EXIT.refused, result.stdout.join('\n'));
  return result.stdout.join('\n');
}

describe('promote and demote', () => {
  it('previews a promote and writes nothing without --yes', async () => {
    const kit = new CliHarness(TREE_TEAM);
    const before = kit.files.get(CONFIG_PATH);
    const result = ok(await kit.run(['promote', 'alpha', '--members', 'bravo, charlie', '--session', 'lead']));
    assert.deepEqual(result.stdout, ['PREVIEW promote alpha leads bravo, charlie, under lead; nothing written (add --yes to write)']);
    assert.equal(kit.files.get(CONFIG_PATH), before);
  });

  it('writes leads with --yes, keeps the old config and tells the sub-lead; a sub-lead promotes in turn', async () => {
    const kit = new CliHarness(TREE_TEAM);
    const before = kit.files.get(CONFIG_PATH);
    const result = ok(await kit.run(['promote', 'alpha', '--members', 'bravo,charlie', '--session', 'lead', '--yes']));
    assert.match(result.stdout[0] ?? '', /^PROMOTED alpha leads bravo, charlie, under lead; the old config is at .*config\.promote\.json$/);
    assert.deepEqual(result.stderr, [
      'NOTE alpha has an inbox line: lead made you a sub-lead over bravo, charlie: their decision and approval waits may come to you, answered with teamrig approve',
    ]);
    assert.deepEqual(leadsOf(kit), { alpha: ['bravo', 'charlie'] });
    assert.equal(kit.files.get(join(TEAM_HOME, 'backups', 'config.promote.json')), before);
    ok(await kit.run(['config', 'validate']));
    ok(await kit.run(['promote', 'bravo', '--members', 'charlie', '--session', 'alpha', '--yes']));
    assert.deepEqual(leadsOf(kit), { alpha: ['bravo'], bravo: ['charlie'] });
  });

  it("demotes a sub-lead, its members going back to its leader, and drops leads once empty", async () => {
    const kit = new CliHarness({ ...TREE_TEAM, leads: { alpha: ['bravo'], bravo: ['charlie'] } });
    const result = ok(await kit.run(['demote', 'bravo', '--session', 'alpha', '--yes']));
    assert.match(result.stdout[0] ?? '', /^DEMOTED bravo leads no one; charlie go back to alpha; the old config is at .*config\.demote\.json$/);
    assert.deepEqual(result.stderr, ['NOTE bravo has an inbox line: alpha took back the sessions you led (charlie); you lead no one now']);
    assert.deepEqual(leadsOf(kit), { alpha: ['bravo', 'charlie'] });
    ok(await kit.run(['demote', 'alpha', '--session', 'lead', '--yes']));
    assert.equal(leadsOf(kit), undefined);
  });

  it('refuses a caller outside the tree rule, writing nothing', async () => {
    const kit = new CliHarness({ ...TREE_TEAM, leads: { alpha: ['bravo'] } });
    const before = kit.files.get(CONFIG_PATH);
    assert.match(refusal(await kit.run(['promote', 'charlie', '--members', 'delta', '--session', 'bravo', '--yes'])), /bravo leads no one/);
    assert.match(refusal(await kit.run(['promote', 'bravo', '--members', 'delta', '--session', 'lead', '--yes'])), /bravo is led by alpha/);
    assert.match(refusal(await kit.run(['demote', 'alpha', '--session', 'bravo', '--yes'])), /alpha is led by lead: only its own leader demotes it/);
    assert.equal(kit.files.get(CONFIG_PATH), before);
  });

  it('refuses bad flags', async () => {
    const kit = new CliHarness(TREE_TEAM);
    assert.equal((await kit.run(['promote', 'alpha', '--session', 'lead'])).code, EXIT.usage);
    assert.equal((await kit.run(['promote', 'alpha', '--members', ' , ', '--session', 'lead'])).code, EXIT.usage);
    assert.equal((await kit.run(['demote', '--session', 'lead'])).code, EXIT.usage);
    assert.equal((await kit.run(['promote', 'alpha', '--members', 'ghost', '--session', 'lead'])).code, EXIT.refused);
  });
});
