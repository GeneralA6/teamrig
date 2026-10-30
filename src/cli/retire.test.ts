import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { CliHarness, CONFIG_PATH, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { HELPER_HANDOVER as HANDOVER, HIRES, LEAD_TEAM, ok, teamWithHelper } from '../testing/hired-team.ts';
import { EXIT } from './runtime.ts';

const BACKUP = join(TEAM_HOME, 'backups', 'config.retire.json');

function configOf(kit: CliHarness): JsonRecord {
  const text = kit.files.get(CONFIG_PATH);
  const config: unknown = text === undefined ? undefined : JSON.parse(text);
  assert.ok(isRecord(config));
  return config;
}

function refusal(result: CliResult): string {
  assert.equal(result.code, EXIT.refused, result.stdout.join('\n'));
  return result.stdout.join('\n');
}

function retire(kit: CliHarness, by: string, ...argv: string[]): Promise<CliResult> {
  return kit.run(['retire', ...argv, '--session', by]);
}

describe('retire', () => {
  it('previews the retire and writes nothing without --yes', async () => {
    const kit = await teamWithHelper();
    const before = kit.files.get(CONFIG_PATH);
    const result = ok(await retire(kit, 'lead', 'app-helper'));
    assert.deepEqual(result.stdout, [`PREVIEW retire helper (name app-helper, hired): its job is done; handover ${HANDOVER}; nothing written (add --yes to write)`]);
    assert.equal(kit.files.get(CONFIG_PATH), before);
    assert.equal(kit.files.get(HIRES)?.trim().split('\n').length, 1);
  });

  it('hands its open tasks to the heir, takes it off the config and logs the retire with --yes', async () => {
    const kit = await teamWithHelper(LEAD_TEAM, ['port the importer']);
    const before = kit.files.get(CONFIG_PATH);
    const result = ok(await retire(kit, 'lead', 'helper', '--to', 'alpha', '--yes'));
    assert.match(result.stdout[0] ?? '', /^RETIRED helper \(name app-helper, hired\): its job is done; its open task\(s\) T1 go to alpha; handover .*helper\.md; the old config is at .*config\.retire\.json$/);
    assert.equal(result.stdout[1], 'NEXT its records stay readable by its id (teamrig list --session helper --all); close its tab if it is open');
    assert.deepEqual(result.stderr, [`NOTE alpha has an inbox line: T1 is yours: helper retired; its handover: ${HANDOVER}`]);
    const config = configOf(kit);
    assert.deepEqual(config['sessions'], ['lead', 'alpha']);
    assert.deepEqual(config['launch'], {});
    assert.equal(config['budget'], undefined, 'the hire wrote no budget entry, so the retire leaves none');
    assert.equal(kit.files.get(BACKUP), before);
    const lines = kit.files.get(HIRES)?.trim().split('\n') ?? [];
    const logged: unknown = JSON.parse(lines[1] ?? '');
    assert.ok(isRecord(logged));
    assert.equal(logged['kind'], 'retire');
    assert.equal(logged['heir'], 'alpha');
    assert.match((await kit.run(['show', 'T1'])).stdout.join('\n'), /alpha/);
    ok(await kit.run(['config', 'validate']));
    assert.match(ok(await kit.run(['list', '--session', 'alpha'])).stdout.join('\n'), /T1/);
    ok(await kit.run(['list', '--session', 'helper', '--all']));
  });

  it('tells two tasks apart from one, and says when the inbox line could not be posted', async () => {
    const kit = await teamWithHelper({ ...LEAD_TEAM, register: { secretPatterns: ['yours'] } }, ['first', 'second'], false);
    const result = ok(await retire(kit, 'lead', 'helper', '--to', 'alpha', '--no-handover', 'nothing left to say', '--reason', 'the job moved', '--yes'));
    assert.match(result.stdout[0] ?? '', /: the job moved; its open task\(s\) T1, T2 go to alpha; no handover: nothing left to say;/);
    assert.match(result.stderr[0] ?? '', /^WARN alpha was not told of T1, T2: /);
  });

  it('refuses open tasks without --to and a missing handover without --no-handover, writing nothing', async () => {
    const kit = await teamWithHelper(LEAD_TEAM, ['port the importer'], false);
    const before = kit.files.get(CONFIG_PATH);
    assert.match(refusal(await retire(kit, 'lead', 'helper', '--yes')), /owns open task\(s\) T1: pass --to <heir>/);
    assert.match(refusal(await retire(kit, 'lead', 'helper', '--to', 'alpha', '--yes')), /no handover at .*helper\.md/);
    assert.equal(kit.files.get(CONFIG_PATH), before);
  });

  it('stops before the config when a task cannot be handed over', async () => {
    const kit = await teamWithHelper({ ...LEAD_TEAM, register: { secretPatterns: ['retired'] } }, ['port the importer']);
    const before = kit.files.get(CONFIG_PATH);
    assert.match(refusal(await retire(kit, 'lead', 'helper', '--to', 'alpha', '--yes')), /T1 was not handed to alpha, so nothing else was written: /);
    assert.equal(kit.files.get(CONFIG_PATH), before);
    assert.equal(kit.files.get(HIRES)?.trim().split('\n').length, 1);
  });

  it('refuses anyone but a lead over the session, and a hired session retiring itself under hiring.policy automatic too', async () => {
    const kit = await teamWithHelper({ ...LEAD_TEAM, hiring: { policy: 'automatic' } });
    const before = kit.files.get(CONFIG_PATH);
    assert.match(refusal(await retire(kit, 'alpha', 'helper')), /only a lead over the session retires it/);
    assert.match(refusal(await retire(kit, 'helper', 'helper', '--yes')), /only a lead over the session retires it/);
    assert.equal(kit.files.get(CONFIG_PATH), before);
    assert.match(refusal(await retire(await teamWithHelper(), 'helper', 'helper')), /only a lead over the session retires it/);
  });

  it('retires a session the team was set up with, and says when the hire log had damaged lines', async () => {
    const kit = new CliHarness({ ...LEAD_TEAM, sessions: ['lead', 'alpha', 'helper'] });
    await kit.files.write(HANDOVER, 'done');
    await kit.files.write(HIRES, 'not json\n');
    const result = ok(await retire(kit, 'lead', 'helper'));
    assert.match(result.stdout[0] ?? '', /^NOTE 1 damaged or newer line\(s\) in .*hires\.jsonl were skipped/);
    assert.match(result.stdout[1] ?? '', /^PREVIEW retire helper \(name app-helper, set up with the team\): its job is done;/);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig({ ...LEAD_TEAM, sessions: ['lead', 'alpha', 'helper'] }));
  });

  it('refuses bad flags', async () => {
    const kit = await teamWithHelper();
    assert.equal((await kit.run(['retire', '--session', 'lead'])).code, EXIT.usage);
    assert.equal((await kit.run(['retire', 'helper', '--colour', 'red', '--session', 'lead'])).code, EXIT.usage);
    assert.equal((await retire(kit, 'lead', 'ghost')).code, EXIT.refused);
  });
});
