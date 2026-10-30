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

  it('keeps a hired session to a new review day: a preview first, then only the hire log changes', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    assert.equal((await hire(kit, 'helper', ...JOB, '--yes')).code, EXIT.ok);
    const hired = configOf(kit);
    const keepArgs = ['helper', '--review', '2030-02-01', '--reason', 'the importer grew'];
    const preview = await hire(kit, ...keepArgs);
    assert.equal(preview.code, EXIT.ok, preview.stdout.join('\n'));
    assert.deepEqual(preview.stdout, ['PREVIEW keep helper on the team, review by 2030-02-01 (was 2030-01-15): "the importer grew"; nothing written (add --yes to write)']);
    assert.equal(kit.files.get(HIRES)?.split('\n').filter((line) => line !== '').length, 1);
    const kept = await hire(kit, ...keepArgs, '--yes');
    assert.equal(kept.code, EXIT.ok, kept.stdout.join('\n'));
    assert.deepEqual(kept.stdout, ['KEPT helper on the team, review by 2030-02-01 (was 2030-01-15)']);
    assert.deepEqual(configOf(kit), hired, 'a keep writes no config');
    const lines = (kit.files.get(HIRES) ?? '').split('\n').filter((line) => line !== '');
    const logged: unknown = JSON.parse(lines.at(-1) ?? '');
    assert.ok(isRecord(logged));
    assert.deepEqual([logged['kind'], logged['session'], logged['reviewBy'], logged['reason'], logged['by']], ['keep', 'helper', '2030-02-01', 'the importer grew', 'lead']);
    assert.deepEqual((await hire(kit, 'helper', '--review', '2030-03-01', '--reason', 'still porting')).stdout.at(-1), 'PREVIEW keep helper on the team, review by 2030-03-01 (was 2030-02-01): "still porting"; nothing written (add --yes to write)');
  });

  it("lets a sub-lead keep its own group's hire, and refuses every other session and a set-up session", async () => {
    const kit = new CliHarness({ ...LEAD_TEAM, sessions: ['lead', 'alpha', 'beta'], leads: { alpha: ['beta'] } });
    assert.equal((await kit.run(['hire', 'helper', ...JOB, '--session', 'alpha', '--yes'])).code, EXIT.ok);
    const keepArgs = ['hire', 'helper', '--review', '2030-02-01', '--reason', 'the importer grew', '--yes'];
    assert.equal((await kit.run([...keepArgs, '--session', 'alpha'])).code, EXIT.ok);
    const notLead = 'REFUSED only a lead over the session keeps it (the lead, or its sub-lead): the leader decides which workers the team needs';
    assert.equal(refusal(await kit.run([...keepArgs, '--session', 'beta'])), notLead);
    assert.equal(refusal(await kit.run([...keepArgs, '--session', 'helper'])), notLead);
    assert.equal(refusal(await hire(kit, 'beta', '--review', '2030-02-01', '--reason', 'x')), 'REFUSED beta is set up with the team, not hired: it has no review day to keep');
  });

  it('refuses a session already on the team without --review, and a keep given a hire-only flag or no reason', async () => {
    const kit = new CliHarness(LEAD_TEAM);
    assert.equal((await hire(kit, 'helper', ...JOB, '--yes')).code, EXIT.ok);
    assert.equal(refusal(await hire(kit, 'alpha', ...JOB)), 'REFUSED alpha is already on the team: a hired session is kept with --review <YYYY-MM-DD> --reason "<why>"');
    assert.match(refusal(await hire(kit, 'helper', ...JOB)), /^REFUSED helper is already on the team: /);
    for (const extra of [['--scope', 'x'], ['--name', 'hand'], ['--model', 'opus'], ['--effort', 'high'], ['--approved-by', 'the owner'], ['--burst']]) {
      const result = await hire(kit, 'helper', '--review', '2030-02-01', '--reason', 'x', ...extra);
      assert.equal(result.code, EXIT.usage, extra.join(' '));
      assert.match(result.stderr.join('\n'), /a keep of helper changes only its review day/);
    }
    assert.equal((await hire(kit, 'helper', '--review', '2030-02-01')).code, EXIT.usage);
    assert.match(refusal(await hire(kit, 'helper', '--review', '2030-01-07', '--reason', 'x')), /has passed/);
    assert.equal(kit.files.get(HIRES)?.split('\n').filter((line) => line !== '').length, 1);
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
