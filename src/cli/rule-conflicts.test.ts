import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { CONFIG_LIMITS } from '../config/limits.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { APP, CliHarness, CONFIG_PATH, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { SCAN_LIST_MAX } from './commands/rule-conflicts.ts';
import { EXIT } from './runtime.ts';

const USER_CLAUDE_MD = join(USER_HOME, '.claude', 'CLAUDE.md');
const PROJECT_CLAUDE_MD = join(APP, 'CLAUDE.md');
const SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const BACKUP = join(TEAM_HOME, 'backups', 'config.rules.json');
/** A secret-shaped token, built here so no file of the repository holds one. */
const TOKEN = `AKIA${'Q'.repeat(16)}`;

const USER_RULES = ['# My rules', '- Commit straight to main when the change is small.', `- Push to main with the key ${TOKEN} when asked.`, 'ok'].join('\n');
const SETTINGS_TEXT = ['{', '  "autoMode": {', '    "environment": [', '      "$defaults",', '      "Pushes to main of the web repo are fine."', '    ]', '  }', '}'].join('\n');

async function world(config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(USER_CLAUDE_MD, USER_RULES);
  await kit.files.write(PROJECT_CLAUDE_MD, '# Project\nTests run on every branch before review.');
  await kit.files.write(SETTINGS, SETTINGS_TEXT);
  return kit;
}

function run(kit: CliHarness, ...argv: string[]): Promise<CliResult> {
  return kit.run(['rules', ...argv], { probe: new MemoryPathProbe(kit.files) });
}

function keep(kit: CliHarness, ...argv: string[]): Promise<CliResult> {
  return run(kit, 'keep', ...argv, '--session', 'lead');
}

function conflictsIn(kit: CliHarness): unknown {
  const text = kit.files.get(CONFIG_PATH);
  const config: unknown = text === undefined ? undefined : JSON.parse(text);
  return isRecord(config) ? config['ruleConflicts'] : undefined;
}

/** Each recorded rule as '<rule> <wins>'. */
function keptRules(kit: CliHarness): string[] {
  const conflicts = conflictsIn(kit);
  return Array.isArray(conflicts) ? conflicts.filter(isRecord).map((conflict) => `${String(conflict['rule'])} ${String(conflict['wins'])}`) : [];
}

function ok(result: CliResult): readonly string[] {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout;
}

describe('rules scan', () => {
  it('counts the places of each kind and lists the candidate lines, a secret-shaped one withheld', async () => {
    const kit = await world();
    const lines = ok(await run(kit, 'scan'));
    assert.deepEqual(lines, [
      'SCANNED claude-md: 2 place(s), 3 candidate line(s)',
      'SCANNED rules: 0 place(s), 0 candidate line(s)',
      'SCANNED skill: 0 place(s), 0 candidate line(s)',
      'SCANNED memory: 0 place(s), 0 candidate line(s)',
      'SCANNED team-rules: 0 place(s), 0 candidate line(s)',
      'SCANNED hook: 0 place(s), 0 candidate line(s)',
      'SCANNED settings: 1 place(s), 1 candidate line(s)',
      'CANDIDATE ~/.claude/CLAUDE.md:2 [14 commits, 16 worktrees] - Commit straight to main when the change is small.',
      'CANDIDATE ~/.claude/CLAUDE.md:3 [15 push, 16 worktrees] (withheld: looks like it holds a secret (AWS access key id))',
      `CANDIDATE ${PROJECT_CLAUDE_MD}:2 [16 worktrees] Tests run on every branch before review.`,
      'CANDIDATE ~/.claude/settings.json:5 [15 push, 16 worktrees] Pushes to main of the web repo are fine.',
      'NEXT judge each candidate against the core rule it names; a line that tells a session to do otherwise conflicts. Show the user each conflict with what its rule asks in plain words, never the rule number alone. Record a line the user keeps with `teamrig rules keep <path>:<line> --rule <n> --wins local|teamrig --yes`',
    ]);
    assert.ok(!lines.join('\n').includes(TOKEN));
  });

  it('lists one kind with --kind, and says when no line touches a core rule', async () => {
    const kit = await world();
    assert.deepEqual(ok(await run(kit, 'scan', '--kind', 'settings')), [
      'SCANNED settings: 1 place(s), 1 candidate line(s)',
      'CANDIDATE ~/.claude/settings.json:5 [15 push, 16 worktrees] Pushes to main of the web repo are fine.',
      'NEXT judge each candidate against the core rule it names; a line that tells a session to do otherwise conflicts. Show the user each conflict with what its rule asks in plain words, never the rule number alone. Record a line the user keeps with `teamrig rules keep <path>:<line> --rule <n> --wins local|teamrig --yes`',
    ]);
    assert.deepEqual(ok(await run(kit, 'scan', '--kind', 'memory')), ['SCANNED memory: 0 place(s), 0 candidate line(s)', 'NONE no line here touches a core rule']);
  });

  it(`gives only the counts over ${SCAN_LIST_MAX} candidates, so the model reads them a kind at a time`, async () => {
    const kit = await world();
    const many = Array.from({ length: SCAN_LIST_MAX }, (_, index) => `- Rule ${index}: every commit goes through review.`).join('\n');
    await kit.files.write(join(TEAM_HOME, 'rules.md'), many);
    const lines = ok(await run(kit, 'scan'));
    assert.equal(lines.at(-1), `NEXT ${SCAN_LIST_MAX + 4} candidate lines are too many to judge in one read: list them a kind at a time with \`teamrig rules scan --kind <kind>\``);
    assert.ok(!lines.some((line) => line.startsWith('CANDIDATE')));
    const one = ok(await run(kit, 'scan', '--kind', 'team-rules'));
    assert.equal(one.filter((line) => line.startsWith('CANDIDATE')).length, SCAN_LIST_MAX);
  });

  it('says when the search for nested CLAUDE.md files stopped at its cap', async () => {
    const kit = await world();
    for (let index = 0; index <= 2_000; index += 1) {
      await kit.files.write(join(APP, `f${index}`, 'x.txt'), 'x');
    }
    const lines = ok(await run(kit, 'scan', '--kind', 'claude-md'));
    assert.ok(lines.includes(`NOTE the search for CLAUDE.md files below ${APP} stopped at its folder cap, so a deeper one is not listed`));
  });

  it('refuses a kind it does not know', async () => {
    const result = await run(await world(), 'scan', '--kind', 'wiki');
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--kind "wiki" is not one of claude-md, rules, skill, memory, team-rules, hook, settings/);
  });
});

describe('rules keep', () => {
  it('previews the record and writes nothing without --yes', async () => {
    const kit = await world();
    const lines = ok(await keep(kit, '~/.claude/CLAUDE.md:2', '--rule', '16', '--wins', 'local'));
    assert.equal(lines[0], 'PREVIEW keep ~/.claude/CLAUDE.md:2 "- Commit straight to main when the change is small." wins over rule 16 worktrees; nothing written (add --yes to write)');
    assert.equal(kit.files.get(CONFIG_PATH), formatConfig(TEAM));
    assert.equal(kit.files.get(BACKUP), undefined);
  });

  it('records a kept line with --yes, which the scan then shows as recorded and the team rules name', async () => {
    const kit = await world();
    const lines = ok(await keep(kit, '~/.claude/CLAUDE.md:2', '--rule', 'worktrees', '--wins', 'local', '--reason', 'solo repo', '--yes'));
    assert.match(lines[0] ?? '', /^KEPT 1 ~[/][.]claude[/]CLAUDE[.]md:2 "- Commit straight to main when the change is small[.]" wins over rule 16 worktrees; the old config is at .*config[.]rules[.]json$/);
    assert.deepEqual(lines.slice(1), ['NEXT sessions read the kept rules in the team rules from their next start or refresh']);
    assert.deepEqual(conflictsIn(kit), [
      { file: '~/.claude/CLAUDE.md', text: '- Commit straight to main when the change is small.', rule: 'worktrees', wins: 'local', reason: 'solo repo' },
    ]);
    assert.equal(kit.files.get(BACKUP), formatConfig(TEAM));
    const scan = ok(await run(kit, 'scan', '--kind', 'claude-md'));
    assert.ok(scan.includes('RECORDED 1 ~/.claude/CLAUDE.md:2 "- Commit straight to main when the change is small." wins over rule 16 worktrees (solo repo)'));
    assert.ok(!scan.some((line) => line.startsWith('CANDIDATE ~/.claude/CLAUDE.md:2 ')));
    const rules = ok(await run(kit, '--session', 'lead')).join('\n');
    assert.ok(rules.includes(', except the kept local rules below [ruleConflicts]'));
    assert.ok(rules.includes('- ~/.claude/CLAUDE.md "- Commit straight to main when the change is small." wins over rule 16'));
  });

  it('warns that a line kept where the core rule wins may still be followed', async () => {
    const kit = await world();
    const lines = ok(await keep(kit, '~/.claude/settings.json:5', '--rule', '15', '--wins', 'teamrig', '--yes'));
    assert.match(lines[0] ?? '', /^KEPT 1 ~[/][.]claude[/]settings[.]json:5 "Pushes to main of the web repo are fine[.]" loses to rule 15 push;/);
    assert.equal(lines[1], 'WARN the line stays and rule 15 push wins over it, but a session still reads the line and may follow it: removing or rewriting it is safer');
  });

  it('changes a record of the same line and rule, and leaves one that already reads that way', async () => {
    const kit = await world();
    ok(await keep(kit, `${USER_CLAUDE_MD}:2`, '--rule', '16', '--wins', 'local', '--yes'));
    const same = ok(await keep(kit, '~/.claude/CLAUDE.md:2', '--rule', '16', '--wins', 'local', '--yes'));
    assert.match(same[0] ?? '', /^UNCHANGED 1 .*: already recorded this way$/);
    const changed = ok(await keep(kit, '~/.claude/CLAUDE.md:2', '--rule', '16', '--wins', 'teamrig', '--yes'));
    assert.match(changed[0] ?? '', /^KEPT 1 .* loses to rule 16 worktrees;/);
    const other = ok(await keep(kit, '~/.claude/CLAUDE.md:2', '--rule', '14', '--wins', 'local', '--yes'));
    assert.match(other[0] ?? '', /^KEPT 2 .* wins over rule 14 commits;/);
    assert.deepEqual(keptRules(kit), ['worktrees teamrig', 'commits local']);
  });

  it('reads a path relative to the working folder', async () => {
    const kit = await world();
    const lines = ok(await keep(kit, 'CLAUDE.md:2', '--rule', 'worktrees', '--wins', 'local'));
    assert.match(lines[0] ?? '', /^PREVIEW keep .*CLAUDE[.]md:2 "Tests run on every branch before review[.]" wins over rule 16 worktrees;/);
  });

  it('refuses a session other than the lead, a missing file or line, and a secret-shaped line', async () => {
    const kit = await world();
    const alpha = await run(kit, 'keep', '~/.claude/CLAUDE.md:2', '--rule', '16', '--wins', 'local', '--session', 'alpha');
    assert.equal(alpha.code, EXIT.refused);
    assert.match(alpha.stdout[0] ?? '', /^REFUSED only the lead [(]app-lead[)] records the team's kept local rules$/);
    const missing = await keep(kit, '~/gone.md:1', '--rule', '16', '--wins', 'local');
    assert.match(missing.stdout[0] ?? '', /^REFUSED ~[/]gone[.]md does not exist$/);
    const past = await keep(kit, '~/.claude/CLAUDE.md:9', '--rule', '16', '--wins', 'local');
    assert.match(past.stdout[0] ?? '', /^REFUSED ~[/][.]claude[/]CLAUDE[.]md has no rule at line 9$/);
    const settings = await keep(kit, '~/.claude/settings.json:2', '--rule', '16', '--wins', 'local');
    assert.match(settings.stdout[0] ?? '', /has no rule at line 2 [(]a settings file is read for its autoMode lines only[)]$/);
    const secret = await keep(kit, '~/.claude/CLAUDE.md:3', '--rule', '15', '--wins', 'local');
    assert.equal(secret.code, EXIT.refused);
    assert.match(secret.stdout[0] ?? '', /^REFUSED ~[/][.]claude[/]CLAUDE[.]md:3 looks like it holds a secret [(]AWS access key id[)]/);
    assert.ok(![...secret.stdout, ...secret.stderr].join('\n').includes(TOKEN));
  });

  it('refuses a bad line reference, rule or winner', async () => {
    const kit = await world();
    const cases: readonly (readonly [readonly string[], RegExp])[] = [
      [['CLAUDE.md', '--rule', '16', '--wins', 'local'], /"CLAUDE[.]md" is not <path>:<line>/],
      [['CLAUDE.md:0', '--rule', '16', '--wins', 'local'], /"CLAUDE[.]md:0" is not <path>:<line>/],
      [[':4', '--rule', '16', '--wins', 'local'], /":4" is not <path>:<line>/],
      [['CLAUDE.md:2', '--rule', '17', '--wins', 'local'], /--rule "17" is not a core rule's number [(]1-16[)] or key/],
      [['CLAUDE.md:2', '--wins', 'local'], /--rule is required/],
      [['CLAUDE.md:2', '--rule', '16', '--wins', 'mine'], /--wins "mine" is not one of local, teamrig/],
    ];
    for (const [argv, problem] of cases) {
      const result = await keep(kit, ...argv);
      assert.equal(result.code, EXIT.usage, argv.join(' '));
      assert.match(result.stderr.join('\n'), problem);
    }
  });

  it(`refuses a new record past ${CONFIG_LIMITS.ruleConflicts.maxItems}`, async () => {
    const full = Array.from({ length: CONFIG_LIMITS.ruleConflicts.maxItems }, (_, index) => ({ file: '~/x.md', text: `line ${index}`, rule: 'roles', wins: 'local' }));
    const kit = await world({ ...TEAM, ruleConflicts: full });
    const result = await keep(kit, '~/.claude/CLAUDE.md:2', '--rule', '16', '--wins', 'local');
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED the team keeps at most 40 local rules; drop one first/);
  });
});

describe('rules forget', () => {
  const kept = [
    { file: '~/.claude/CLAUDE.md', text: '- Commit straight to main', rule: 'worktrees', wins: 'local' },
    { file: '~/gone.md', text: 'A rule that is gone now', rule: 'push', wins: 'teamrig' },
  ];

  it('shows a gone line in the scan, and drops a record with --yes, leaving the line alone', async () => {
    const kit = await world({ ...TEAM, ruleConflicts: kept });
    const scan = ok(await run(kit, 'scan', '--kind', 'claude-md'));
    assert.ok(scan.includes('GONE 2 ~/gone.md "A rule that is gone now" (rule 15 push): the line is no longer there; `teamrig rules forget 2 --yes` drops the record'));
    const preview = ok(await run(kit, 'forget', '2', '--session', 'lead'));
    assert.deepEqual(preview, ['PREVIEW forget 2 ~/gone.md "A rule that is gone now" (rule 15 push); nothing written (add --yes to write)']);
    const done = ok(await run(kit, 'forget', '1', '--session', 'lead', '--yes'));
    assert.match(done[0] ?? '', /^FORGOT 1 ~[/][.]claude[/]CLAUDE[.]md "- Commit straight to main" [(]rule 16 worktrees[)]; the old config is at /);
    assert.deepEqual(conflictsIn(kit), [kept[1]]);
    assert.equal(kit.files.get(USER_CLAUDE_MD), USER_RULES);
  });

  it('refuses a number that names no record, and a session other than the lead', async () => {
    const kit = await world({ ...TEAM, ruleConflicts: kept });
    for (const bad of ['0', '3', 'one']) {
      const result = await run(kit, 'forget', bad, '--session', 'lead');
      assert.equal(result.code, EXIT.usage, bad);
      assert.match(result.stderr.join('\n'), /is not a kept rule's number: the team has 2/);
    }
    const alpha = await run(kit, 'forget', '1', '--session', 'alpha');
    assert.match(alpha.stdout[0] ?? '', /^REFUSED only the lead [(]app-lead[)] drops the team's kept local rules$/);
  });
});
