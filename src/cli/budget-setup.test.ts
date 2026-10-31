import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { APP, CliHarness, CONFIG_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { CONFIG_LOCK_PATH, configChangedMeanwhile, hired } from '../testing/config-race.ts';
import { EXIT } from './runtime.ts';

const BACKUP = join(TEAM_HOME, 'backups', 'config.budget.json');
/** The owner's policy of the design: ask the lead, ask before helpers at night. */
const POLICY = ['--over', 'ask-lead', '--escalate', 'session-and-fleet', '--quiet', '22:00-06:00', '--quiet-action', 'ask'];

function setup(kit: CliHarness, ...argv: string[]): Promise<CliResult> {
  return kit.run(['budget', 'setup', '--session', 'lead', ...argv]);
}

function budgetIn(kit: CliHarness): unknown {
  const text = kit.files.get(CONFIG_PATH);
  const config: unknown = text === undefined ? undefined : JSON.parse(text);
  return isRecord(config) ? config['budget'] : undefined;
}

/** Claude Code's status input for a session in the project, so a status line reading exists. */
function status(): string {
  return JSON.stringify({
    session_id: '0123abcd-0000-4000-8000-0000000000aa',
    cwd: APP,
    workspace: { current_dir: APP },
    rate_limits: { seven_day: { used_percentage: 30, resets_at: Date.parse('2030-01-14T01:00:00Z') / 1000 } },
  });
}

describe('budget setup', () => {
  it('previews the change and writes nothing without --yes', async () => {
    const kit = new CliHarness();
    const result = await setup(kit, '--over', 'ask-lead');
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.match(result.stdout[0] ?? '', /^PREVIEW .*config\.json: 2 to change, 2 unchanged; nothing written \(add --yes to write\)$/);
    assert.deepEqual(result.stdout.slice(1, 5), [
      '  CHANGE budget.enabled: off (not set) -> on',
      '  CHANGE budget.overAction: warn (not set) -> ask-lead',
      '  KEEP budget.escalate: session-and-fleet (not set)',
      '  KEEP budget.quietHours: none (not set)',
    ]);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(TEAM));
    assert.equal(kit.files.get(BACKUP), undefined);
  });

  it('writes the policy with --yes, keeping the old file first', async () => {
    const kit = new CliHarness();
    const result = await setup(kit, ...POLICY, '--yes');
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.match(result.stdout[0] ?? '', /^WROTE .*config\.json: 4 to change, 0 unchanged; the old file is at .*config\.budget\.json$/);
    assert.ok(result.stdout.includes('  CHANGE budget.quietHours: none (not set) -> 22:00-06:00 UTC, ask'));
    assert.deepEqual(budgetIn(kit), {
      enabled: true,
      overAction: 'ask-lead',
      escalate: 'session-and-fleet',
      quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' },
    });
    assert.equal(kit.files.get(BACKUP), formatConfig(TEAM));
    const read = await kit.run(['config', 'validate']);
    assert.equal(read.code, EXIT.ok, read.stdout.join('\n'));
  });

  it('writes nothing when the budget already reads that way', async () => {
    const kit = new CliHarness();
    await setup(kit, ...POLICY, '--yes');
    const written = kit.files.get(CONFIG_PATH);
    const again = await setup(kit, ...POLICY, '--yes');
    assert.equal(again.code, EXIT.ok);
    assert.match(again.stdout[0] ?? '', /^UNCHANGED .*: the budget already reads this way$/);
    assert.equal(kit.files.get(CONFIG_PATH), written);
  });

  it('turns the budget off with --off and keeps its policy', async () => {
    const kit = new CliHarness({ ...TEAM, budget: { enabled: true, overAction: 'ask' } });
    const result = await setup(kit, '--off', '--yes');
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(budgetIn(kit), { enabled: false, overAction: 'ask' });
    assert.ok(!result.stdout.some((line) => line.startsWith('NOTE')));
  });

  it('notes when no status line reading or weekly limit tells the budget the week\'s use', async () => {
    const silent = await setup(new CliHarness(), '--yes');
    assert.ok(silent.stdout.some((line) => line.startsWith('NOTE no status line reading yet')));
    const limited = await setup(new CliHarness({ ...TEAM, budget: { weeklyLimitW: 1_000_000 } }), '--yes');
    assert.ok(!limited.stdout.some((line) => line.startsWith('NOTE')));
    const kit = new CliHarness();
    const saved = await kit.run(['statusline'], { stdin: status() });
    assert.equal(saved.code, EXIT.ok, saved.stderr.join('\n'));
    const read = await setup(kit, '--yes');
    assert.ok(!read.stdout.some((line) => line.startsWith('NOTE')), read.stdout.join('\n'));
  });

  it('is the lead\'s only', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['budget', 'setup', '--session', 'alpha', '--yes']);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout.join('\n'), /only the lead \(app-lead\) sets the team's budget/);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(TEAM));
  });

  it('refuses flags it cannot read, writing nothing', async () => {
    const cases: readonly (readonly string[])[] = [
      // The team's daily budget is the pace, recomputed at every reading: no flag sets a fixed one.
      ['--daily', 'pace'],
      ['--max-daily', '12'],
      ['--over', 'pause'],
      ['--escalate', 'fleet'],
      ['--quiet', '2200-0600'],
      ['--quiet', '22:00-06:00'],
      ['--quiet-action', 'ask'],
      ['--quiet', 'off', '--quiet-action', 'ask'],
      ['extra'],
    ];
    for (const argv of cases) {
      const kit = new CliHarness();
      const result = await setup(kit, ...argv, '--yes');
      assert.equal(result.code, EXIT.usage, `${argv.join(' ')}: ${result.stdout.join('\n')}`);
      assert.equal(kit.files.get(CONFIG_PATH), formatConfig(TEAM));
    }
  });

  it('refuses a value the config parser rejects, writing nothing', async () => {
    const kit = new CliHarness();
    const result = await setup(kit, '--quiet', '25:00-06:00', '--quiet-action', 'ask', '--yes');
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout.join('\n'), /nothing written: budget\.quietHours\.startUtc/);
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(TEAM));
  });

  it('keeps the rest of the file as it was, its config version included', async () => {
    const config: JsonRecord = { ...TEAM, configVersion: 1, budget: { weeklyLimitW: 1_000_000 } };
    const kit = new CliHarness(config);
    const result = await setup(kit, '--over', 'ask', '--yes');
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    const text = kit.files.get(CONFIG_PATH);
    assert.deepEqual(text === undefined ? undefined : JSON.parse(text), { ...config, budget: { weeklyLimitW: 1_000_000, enabled: true, overAction: 'ask' } });
  });

  it('keeps a session hired while it waited for the config lock', async () => {
    const kit = new CliHarness();
    const sleep = await configChangedMeanwhile(kit, hired('dave'));
    const result = await kit.run(['budget', 'setup', '--session', 'lead', '--over', 'ask', '--yes'], { sleep });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    const text = kit.files.get(CONFIG_PATH);
    const config: unknown = text === undefined ? undefined : JSON.parse(text);
    assert.deepEqual(isRecord(config) ? config['sessions'] : undefined, ['lead', 'alpha', 'bravo', 'dave']);
    assert.deepEqual(budgetIn(kit), { enabled: true, overAction: 'ask' });
    assert.equal(kit.files.get(CONFIG_LOCK_PATH), undefined);
  });
});
