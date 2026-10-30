import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
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
      'PREVIEW hire helper (name app-helper) for "port the importer": model opus at high effort, review by 2030-01-15; nothing written (add --yes to write)',
    ]);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(LEAD_TEAM));
    assert.equal(kit.files.get(HIRES), undefined);
  });

  it('logs the hire and writes the session with --yes, keeping the old config first', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    const result = await hire(kit, 'helper', ...JOB, '--name', 'hand', '--effort', 'xhigh', '--review', '2030-01-10', '--yes');
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.match(result.stdout[0] ?? '', /^HIRED helper \(name hand\) for "port the importer": model opus at xhigh effort, review by 2030-01-10; the old config is at .*config\.hire\.json$/);
    assert.match(result.stdout[1] ?? '', /^NEXT give it its first task: teamrig add --owner helper --title "<task>" --description "<what and why>" --session lead; then open it: teamrig open helper$/);
    const config = configOf(kit);
    assert.deepEqual(config['sessions'], ['lead', 'alpha', 'helper']);
    assert.deepEqual(config['names'], { helper: 'hand' });
    assert.deepEqual(config['launch'], { lead: { model: 'opus', effort: 'high' }, helper: { model: 'opus', effort: 'xhigh' } });
    assert.deepEqual(config['budget'], LEAD_TEAM['budget'], 'a hire gets no fixed daily budget');
    assert.equal(kit.files.get(BACKUP), formatConfig(LEAD_TEAM));
    const logged: unknown = JSON.parse(kit.files.get(HIRES) ?? '');
    assert.ok(isRecord(logged));
    assert.equal(logged['session'], 'helper');
    assert.equal(logged['by'], 'lead');
    const read = await kit.run(['config', 'validate']);
    assert.equal(read.code, EXIT.ok, read.stdout.join('\n'));
  });

  it('refuses a hire with --yes when the host has no room for one more session, and only says so without', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    const records = new SessionRecordStore(kit.files, { sessions: join(TEAM_HOME, 'state', 'sessions') });
    await records.write('lead', { claudePid: 6900, claudeSession: 'claude-lead', at: '2030-01-08T09:00:00.000Z' });
    const lead = { pid: 6900, parent: 1, bytes: 800 * 2 ** 20, committed: 2000 * 2 ** 20 };
    const memory = new FakeHostMemory().lists([lead], { usedMb: 91_000, limitMb: 100_000 });
    memory.free = 20_000;
    const short =
      'no room on the host to hire helper, counted at 800 MB resident and 2000 MB committed: with it the commit charge would be 93000 MB, over 92% of its ' +
      '100000 MB limit (open.headroom.commitMaxPct). Close a session first: teamrig sessions lists what each one holds';
    const preview = await kit.run(['hire', 'helper', ...JOB, '--session', 'lead'], { memory });
    assert.equal(preview.code, EXIT.ok, preview.stderr.join('\n'));
    assert.equal(preview.stdout.at(-1), `NOTE ${short}; --yes refuses until there is room`);
    assert.equal(refusal(await kit.run(['hire', 'helper', ...JOB, '--yes', '--session', 'lead'], { memory })), `REFUSED ${short}`);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(LEAD_TEAM));
    assert.equal(kit.files.get(HIRES), undefined);
  });

  it('hires a third session beside two earlier hires: no cap bounds hiring', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    for (const id of ['helper', 'second', 'third']) {
      const result = await hire(kit, id, ...JOB, '--yes');
      assert.equal(result.code, EXIT.ok, `${id}: ${result.stdout.join('\n')}`);
    }
    assert.deepEqual(configOf(kit)['sessions'], ['lead', 'alpha', 'helper', 'second', 'third']);
  });

  it("lets a sub-lead hire into its own group, on the lead's launch", async () => {
    const kit = new CliHarness({ ...LEAD_TEAM, sessions: ['lead', 'alpha', 'beta'], leads: { alpha: ['beta'] } });
    const result = await kit.run(['hire', 'helper', ...JOB, '--session', 'alpha', '--yes']);
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.match(result.stdout[0] ?? '', /^HIRED helper \(name app-helper\) for "port the importer", led by app-alpha: model opus at high effort, /);
    const config = configOf(kit);
    assert.deepEqual(config['leads'], { alpha: ['beta', 'helper'] });
    assert.deepEqual(config['sessions'], ['lead', 'alpha', 'beta', 'helper']);
    assert.match(refusal(await kit.run(['hire', 'second', ...JOB, '--session', 'beta'])), /only a lead hires sessions/);
  });

  it('is for a lead only, and follows hiring.policy', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    assert.match(refusal(await kit.run(['hire', 'helper', ...JOB, '--session', 'alpha'])), /only a lead hires sessions: the lead \(lead\), or a sub-lead into its own group/);
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
    // --daily-pct went with the fixed daily budgets.
    assert.equal((await hire(kit, 'helper', ...JOB, '--daily-pct', '1')).code, EXIT.usage);
    assert.equal((await hire(kit, ...JOB)).code, EXIT.usage);
  });
});
