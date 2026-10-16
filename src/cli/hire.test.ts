import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { CliHarness, CONFIG_PATH, KIT, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const BACKUP = join(TEAM_HOME, 'backups', 'config.hire.json');
const HIRES = join(TEAM_HOME, 'state', 'hires.jsonl');
const LEAD_TEAM: JsonRecord = { sessions: ['lead', 'alpha'], roles: { lead: 'lead' }, hiring: { policy: 'lead' }, launch: { lead: { model: 'opus', effort: 'high' } } };
const JOB = ['--scope', 'port the importer', '--reason', 'release week'];

function hire(kit: CliHarness, ...argv: string[]): Promise<CliResult> {
  return kit.run(['hire', ...argv, '--session', 'lead']);
}

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

describe('hire', () => {
  it('previews the hire and writes nothing without --yes', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    const result = await hire(kit, 'helper', ...JOB);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      'PREVIEW hire helper (name app-helper) for "port the importer": model opus at high effort, 1% of the week a day, review by 2030-01-15; nothing written (add --yes to write)',
      '  hired sessions with it: 1 of 2, 1% of 3% of the week a day',
    ]);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(LEAD_TEAM));
    assert.equal(kit.files.get(HIRES), undefined);
  });

  it('logs the hire and writes the session with --yes, keeping the old config first', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    const result = await hire(kit, 'helper', ...JOB, '--name', 'hand', '--effort', 'xhigh', '--daily-pct', '0.5', '--review', '2030-01-10', '--yes');
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.match(result.stdout[0] ?? '', /^HIRED helper \(name hand\) for "port the importer": model opus at xhigh effort, 0\.5% of the week a day, review by 2030-01-10; the old config is at .*config\.hire\.json$/);
    assert.match(result.stdout[2] ?? '', /^NEXT give it its first task: teamrig add --owner helper --title "<task>" --description "<what and why>" --session lead; then open it: teamrig open helper$/);
    const config = configOf(kit);
    assert.deepEqual(config['sessions'], ['lead', 'alpha', 'helper']);
    assert.deepEqual(config['names'], { helper: 'hand' });
    assert.deepEqual(config['launch'], { lead: { model: 'opus', effort: 'high' }, helper: { model: 'opus', effort: 'xhigh' } });
    assert.deepEqual(config['budget'], { sessions: { helper: { dailyPct: 0.5 } } });
    assert.equal(kit.files.get(BACKUP), formatConfig(LEAD_TEAM));
    const logged: unknown = JSON.parse(kit.files.get(HIRES) ?? '');
    assert.ok(isRecord(logged));
    assert.equal(logged['session'], 'helper');
    assert.equal(logged['by'], 'lead');
    const read = await kit.run(['config', 'validate']);
    assert.equal(read.code, EXIT.ok, read.stdout.join('\n'));
  });

  it('counts earlier hires toward the caps', async () => {
    const kit = new CliHarness({ ...LEAD_TEAM, hiring: { policy: 'lead', maxSessions: 1 } });
    assert.equal((await hire(kit, 'helper', ...JOB, '--yes')).code, EXIT.ok);
    assert.match(refusal(await hire(kit, 'second', ...JOB)), /already has 1 hired session\(s\), the most hiring\.maxSessions allows/);
  });

  it('is for the lead only, and follows hiring.policy', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    assert.match(refusal(await kit.run(['hire', 'helper', ...JOB, '--session', 'alpha'])), /only the lead .*hires sessions/);
    const owner = new CliHarness({ ...LEAD_TEAM, hiring: { policy: 'owner' } });
    assert.match(refusal(await hire(owner, 'helper', ...JOB)), /--approved-by/);
    assert.equal((await hire(owner, 'helper', ...JOB, '--approved-by', 'the owner')).code, EXIT.ok);
  });

  it('refuses a name the config or another team already gives a session', async () => {
    const kit = new CliHarness({ ...LEAD_TEAM, names: { alpha: 'hand' } });
    assert.match(refusal(await hire(kit, 'helper', ...JOB, '--name', 'hand')), /nothing written: names/);
    await kit.files.write(join(KIT, 'teams', 'other', 'config.json'), formatConfig({ sessions: ['boss', 'x'], roles: { lead: 'boss' }, names: { x: 'app-helper' } }));
    assert.match(refusal(await hire(kit, 'helper', ...JOB)), /nothing written: app-helper is the session name of .*other\/x.*machine-wide/);
    assert.equal(kit.files.get(HIRES), undefined);
  });

  it('refuses bad flags', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    assert.equal((await hire(kit, 'helper', '--scope', 'x')).code, EXIT.usage);
    assert.equal((await hire(kit, 'helper', ...JOB, '--effort', 'extreme')).code, EXIT.usage);
    assert.equal((await hire(kit, 'helper', ...JOB, '--daily-pct', '0')).code, EXIT.usage);
    assert.equal((await hire(kit, ...JOB)).code, EXIT.usage);
  });
});
