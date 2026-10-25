import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeProjectSlug } from '../budget/discover.ts';
import { APP, CliHarness, SKILLS_DIR, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { replyLine } from '../testing/transcript-lines.ts';
import { DEFAULT_SCAN_DAYS } from './commands/setup-scan.ts';
import { EXIT } from './runtime.ts';

const CLAUDE_DIR = join(USER_HOME, '.claude');
const NOW = Date.parse('2030-01-08T10:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;
}

async function world(harness: CliHarness = new CliHarness()): Promise<CliHarness> {
  await harness.files.write(join(CLAUDE_DIR, 'CLAUDE.md'), '# Mine\n- Ping the lead after each step so it always knows.\n');
  await harness.files.write(join(APP, 'CLAUDE.md'), '# Project\nPrices are shown in the local currency of each user.\n');
  await harness.files.write(join(SKILLS_DIR, 'alpha-check', 'SKILL.md'), skill('alpha-check', 'Checks alpha.'));
  await harness.files.write(join(SKILLS_DIR, 'beta-run', 'SKILL.md'), skill('beta-run', 'Runs beta.'));
  return harness;
}

/** A transcript of the project whose one call loads `alpha-check`, last written `ago` before the harness's clock. */
function transcripts(ago: number): MemoryTranscripts {
  const line = replyLine({ id: 'm', at: '2030-01-08T09:00:00Z', usage: { input: 1, output: 1 }, tools: [{ id: 't', name: 'Skill', skill: 'alpha-check' }] });
  return new MemoryTranscripts({ [join(CLAUDE_DIR, 'projects', claudeProjectSlug(APP), '0123abcd-0000-4000-8000-00000000000a.jsonl')]: `${line}\n` }, NOW - ago);
}

function scan(harness: CliHarness, argv: readonly string[] = [], source: MemoryTranscripts = new MemoryTranscripts()): Promise<CliResult> {
  return harness.run(['setup', 'scan', ...argv], { probe: new MemoryPathProbe(harness.files), transcripts: source });
}

function okLines(result: CliResult): readonly string[] {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout;
}

describe('setup scan', () => {
  it("in a team's project: loads the team's rules, lists the team's skills, the override line and the skill no transcript used", async () => {
    const harness = await world();
    await harness.files.write(join(TEAM_HOME, 'rules.md'), 'Team rules.\n');
    const lines = okLines(await scan(harness, [], transcripts(HOUR_MS)));
    assert.match(lines[0] ?? '', / \(team app\)$/);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('CONTEXT')).map((line) => line.split(' ').slice(0, 2).join(' ')),
      ['CONTEXT claude-md', 'CONTEXT claude-md', 'CONTEXT team-rules', 'CONTEXT skills'],
    );
    assert.ok(lines.includes('OVERRIDE 1 line(s) in 1 file(s) may override a core rule: claude-md 1; 0 recorded'), lines.join('\n'));
    assert.ok(lines.includes('NEXT teamrig rules scan, to judge each line with the user'));
    assert.ok(lines.includes(`UNUSED 1 of 2 skill(s) not used in ${DEFAULT_SCAN_DAYS} day(s) (read 1 transcript(s), 0.0 MB)`), lines.join('\n'));
    assert.match(lines.find((line) => line.startsWith('U1 ')) ?? '', /^U1 unused-skill .*beta-run.*: no Skill call or \/beta-run in 30 day\(s\)/);
    assert.match(lines.at(-1) ?? '', /^SAVINGS ~\d+ tokens\/turn/);
  });

  it('before a team exists: the user skills folder, no team rules, and the NEXT steps after team create', async () => {
    const harness = await world(new CliHarness(null, null));
    const lines = okLines(await scan(harness));
    assert.match(lines[0] ?? '', / \(no team yet\)$/);
    assert.equal(lines.some((line) => line.startsWith('CONTEXT team-rules')), false);
    assert.ok(lines.includes('NEXT teamrig rules scan, after teamrig team create, to judge each line with the user'), lines.join('\n'));
    assert.ok(lines.includes(`UNUSED not checked: no transcript on this machine in ${DEFAULT_SCAN_DAYS} day(s)`));
  });

  it('reads only the transcripts written in the last --days days', async () => {
    const harness = await world();
    const source = transcripts(2 * DAY_MS);
    assert.ok(okLines(await scan(harness, ['--days', '1'], source)).includes('UNUSED not checked: no transcript on this machine in 1 day(s)'));
    assert.ok(okLines(await scan(harness, ['--days', '3'], source)).some((line) => line.startsWith('UNUSED 1 of 2 skill(s) not used in 3 day(s)')));
  });

  it('scans the --project folder, from the working folder, outside any team', async () => {
    const harness = await world();
    const lines = okLines(await scan(harness, ['--project', '../other']));
    assert.match(lines[0] ?? '', /other \(no team yet\)$/);
  });

  it('refuses a --days that is not a whole number of 1 or more, a positional and a broken team pointer', async () => {
    const harness = await world();
    for (const days of ['0', '1.5', 'x']) {
      const result = await scan(harness, ['--days', days]);
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stderr.join('\n'), new RegExp(`--days "${days.replace('.', '[.]')}" is not a whole number of 1 or more`));
    }
    assert.equal((await scan(harness, ['extra'])).code, EXIT.usage);
    assert.equal((await scan(await world(new CliHarness(undefined, '{not json')))).code, EXIT.refused);
  });
});
