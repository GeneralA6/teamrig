import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { claudeProjectSlug } from '../budget/discover.ts';
import { formatConfig } from '../config/load.ts';
import type { Env } from '../core/home.ts';
import { APP, CliHarness, KIT, SKILLS_DIR, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { backupStamp } from '../permissions/trim.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { promptLine, replyLine, type FixtureTool } from '../testing/transcript-lines.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { SKILL_DOCTOR_ARGS } from '../setup/skill-doctor.ts';
import { DEFAULT_SCAN_DAYS } from './commands/setup-scan.ts';
import { EXIT } from './runtime.ts';

const CLAUDE_DIR = join(USER_HOME, '.claude');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long before the scan the world's skills were written: older than any window the tests scan. */
const SKILLS_AGE_MS = 40 * DAY_MS;
const NOW = Date.parse('2030-01-08T10:00:00Z') + SKILLS_AGE_MS;
/** A project of another team, with its own pointer. */
const OTHER = resolve('/', 'work', 'other');

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;
}

function agentFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nPrompt.\n`;
}

/** The user's and the project's files, with skills written {@link SKILLS_AGE_MS} before the clock then stands. */
async function world(harness: CliHarness = new CliHarness()): Promise<CliHarness> {
  await harness.files.write(join(CLAUDE_DIR, 'CLAUDE.md'), '# Mine\n- Ping the lead after each step so it always knows.\n');
  await harness.files.write(join(APP, 'CLAUDE.md'), '# Project\nPrices are shown in the local currency of each user.\n');
  await harness.files.write(join(SKILLS_DIR, 'alpha-check', 'SKILL.md'), skill('alpha-check', 'Checks alpha.'));
  await harness.files.write(join(SKILLS_DIR, 'beta-run', 'SKILL.md'), skill('beta-run', 'Runs beta.'));
  harness.clock.advance(SKILLS_AGE_MS);
  return harness;
}

const LINE_AT = '2030-01-08T09:00:00Z';

/** A transcript line whose one call loads `skill`. */
function skillLine(skill: string): string {
  return replyLine({ id: 'm', at: LINE_AT, usage: { input: 1, output: 1 }, tools: [{ id: 't', name: 'Skill', skill }] });
}

/** The path of the project's transcript of the Claude Code session ending in `last` (one hex digit). */
function transcriptPath(last: string): string {
  return join(CLAUDE_DIR, 'projects', claudeProjectSlug(APP), `0123abcd-0000-4000-8000-00000000000${last}.jsonl`);
}

/** A transcript of the project whose one call loads `alpha-check`, last written `ago` before the harness's clock. */
function transcripts(ago: number): MemoryTranscripts {
  return new MemoryTranscripts({ [transcriptPath('a')]: `${skillLine('alpha-check')}\n` }, NOW - ago);
}

function scan(harness: CliHarness, argv: readonly string[] = [], source: MemoryTranscripts = new MemoryTranscripts(), env: Env = {}, hooks: FakeHooks = new FakeHooks()): Promise<CliResult> {
  return harness.run(['setup', 'scan', ...argv], { env, probe: new MemoryPathProbe(harness.files), transcripts: source, hooks });
}

/** Claude Code on the PATH {@link CLAUDE_PATH} names, as the harness's Linux finds it. */
const CLAUDE = '/opt/claude/bin/claude';
const CLAUDE_PATH: Env = { PATH: '/opt/claude/bin' };
/** The UNUSED header's end when the harness's empty PATH holds no Claude Code. */
const NO_DOCTOR = '; /skill-doctor skipped: Claude Code is not on PATH';

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
      ['CONTEXT claude-md', 'CONTEXT claude-md', 'CONTEXT team-rules', 'CONTEXT skills', 'CONTEXT agents'],
    );
    assert.ok(lines.includes('OVERRIDE 1 line(s) in 1 file(s) may override a core rule: claude-md 1; 0 recorded; 1 load unasked; the 1 to judge first below'), lines.join('\n'));
    assert.match(lines.find((line) => line.startsWith('O1 ')) ?? '', /^O1 claude-md .*CLAUDE\.md:2: "- Ping the lead after each step so it always knows\." \(1 roles, 3 messages\)$/);
    assert.ok(lines.includes('NEXT teamrig rules scan, to judge each line with the user'));
    assert.ok(lines.includes(`UNUSED 1 of 2 skill(s) not used in ${DEFAULT_SCAN_DAYS} day(s) (read 1 transcript(s), 0.0 MB)${NO_DOCTOR}`), lines.join('\n'));
    assert.match(lines.find((line) => line.startsWith('U1 ')) ?? '', /^U1 unused-skill .*beta-run.*: no Skill call or \/beta-run in 30 day\(s\)/);
    assert.match(lines.at(-1) ?? '', /^SAVINGS ~\d+ tokens\/turn/);
  });

  it("names an installed plugin's context hook the transcripts show printing, with its plugin and hooks file", async () => {
    const harness = await world();
    const install = join(CLAUDE_DIR, 'plugins', 'cache', 'mk', 'kit', '1.0.0');
    const plugins = { version: 2, plugins: { 'kit@mk': [{ scope: 'user', installPath: install, version: '1.0.0' }] } };
    await harness.files.write(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify(plugins));
    const handler = { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/main.js', 'hook', 'start'] };
    await harness.files.write(join(install, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [handler] }] } }));
    const run = { type: 'hook_success', hookEvent: 'SessionStart', command: 'node ${CLAUDE_PLUGIN_ROOT}/main.js hook start', stdout: 'r'.repeat(400) };
    const source = new MemoryTranscripts({ [transcriptPath('c')]: `${JSON.stringify({ type: 'attachment', attachment: run })}\n` }, NOW - HOUR_MS);
    const lines = okLines(await scan(harness, [], source));
    const line = lines.find((text) => text.includes('of plugin kit@mk'));
    assert.match(line ?? '', /^S\d+ context-hook .*hooks\.json: SessionStart hook "node \$\{CLAUDE_PLUGIN_ROOT\}\/main\.js hook start" of plugin kit@mk: printed ~400 chars/, lines.join('\n'));
  });

  it('judges the user-level skills and agent types by the projects whose sessions used them', async () => {
    const harness = new CliHarness();
    await harness.files.write(join(CLAUDE_DIR, 'agents', 'scout.md'), agentFile('scout', 'Scouts the code.'));
    await harness.files.write(join(CLAUDE_DIR, 'agents', 'idle.md'), agentFile('idle', 'Never runs.'));
    await world(harness);
    const call = (cwd: string, tool: FixtureTool): string => replyLine({ id: tool.id, at: LINE_AT, cwd, usage: { input: 1, output: 1 }, tools: [tool] });
    const other = join(CLAUDE_DIR, 'projects', claudeProjectSlug(OTHER), '0123abcd-0000-4000-8000-00000000000b.jsonl');
    const source = new MemoryTranscripts(
      {
        [transcriptPath('a')]: `${call(APP, { id: 't', name: 'Skill', skill: 'alpha-check' })}\n`,
        [other]: `${call(OTHER, { id: 'u', name: 'Skill', skill: 'beta-run' })}\n${call(OTHER, { id: 'v', name: 'Agent', agent: 'scout' })}\n`,
      },
      NOW - HOUR_MS,
    );
    const lines = okLines(await scan(harness, [], source));
    assert.ok(
      lines.includes(
        "CONTEXT agents 2 agent type(s) listed: 68 chars (~17 tokens/turn); summed from the user's and the project's agent folders (built-in and plugins' agent types not counted: no transcript of this project yet)",
      ),
      lines.join('\n'),
    );
    assert.deepEqual(lines.filter((line) => /^U(NUSED|\d)/.test(line)), [
      `UNUSED 0 of 2 skill(s) and 1 of 2 agent type(s) not used in ${DEFAULT_SCAN_DAYS} day(s) (read 2 transcript(s), 0.0 MB); 2 user-level one(s) used only in other projects${NO_DOCTOR}`,
      'U1 unused-agent ~/.claude/agents/idle.md: no Agent call ran idle in 30 day(s) (~8 tokens/turn)',
      `U2 other-project-skill ~/.claude/skills/beta-run/SKILL.md: used only in other projects in 30 day(s): ${OTHER}; move it to their .claude/skills (~6 tokens/turn)`,
      `U3 other-project-agent ~/.claude/agents/scout.md: used only in other projects in 30 day(s): ${OTHER}; move it to their .claude/agents (~10 tokens/turn)`,
    ]);
  });

  it('before a team exists: the user skills folder, no team rules, and the NEXT steps after team create', async () => {
    const harness = await world(new CliHarness(null, null));
    const lines = okLines(await scan(harness));
    assert.match(lines[0] ?? '', / \(no team yet\)$/);
    assert.equal(lines.some((line) => line.startsWith('CONTEXT team-rules')), false);
    assert.ok(lines.includes('NEXT teamrig rules scan, after teamrig team create, to judge each line with the user'), lines.join('\n'));
    assert.ok(lines.includes(`UNUSED not checked: no transcript on this machine in ${DEFAULT_SCAN_DAYS} day(s)`));
  });

  it("names the newest backup of the setup it scans, the team's own skills folder too, and NO BACKUP until there is one", async () => {
    const harness = await world(new CliHarness({ ...TEAM, paths: { skills: 'skills' } }));
    const probe = new MemoryPathProbe(harness.files);
    assert.equal(okLines(await scan(harness, ['--project', APP]))[1], 'NO BACKUP of this setup: change nothing in it before teamrig setup backup makes one');
    const stamp = backupStamp(harness.clock.now());
    okLines(await harness.run(['setup', 'backup', '--project', APP], { env: {}, probe }));
    harness.clock.advance(3 * HOUR_MS);
    assert.equal(okLines(await scan(harness, ['--project', APP]))[1], `BACKUP ${stamp}, made 3 h ago: teamrig setup restore ${stamp} previews putting the setup back`);
  });

  it('reads only the transcripts written in the last --days days', async () => {
    const harness = await world();
    const source = transcripts(2 * DAY_MS);
    assert.ok(okLines(await scan(harness, ['--days', '1'], source)).includes('UNUSED not checked: no transcript on this machine in 1 day(s)'));
    assert.ok(okLines(await scan(harness, ['--days', '3'], source)).some((line) => line.startsWith('UNUSED 1 of 2 skill(s) not used in 3 day(s)')));
  });

  it("runs Claude Code's /skill-doctor in the scanned project, and nothing when Claude Code is not on PATH", async () => {
    const harness = await world();
    await harness.files.write(CLAUDE, '');
    const hooks = new FakeHooks();
    okLines(await scan(harness, ['--project', OTHER], new MemoryTranscripts(), CLAUDE_PATH, hooks));
    assert.deepEqual(hooks.ran.map((request) => ({ argv: request.argv, cwd: request.cwd })), [{ argv: [CLAUDE, ...SKILL_DOCTOR_ARGS], cwd: OTHER }]);
    const none = new FakeHooks();
    okLines(await scan(harness, [], new MemoryTranscripts(), {}, none));
    assert.deepEqual(none.ran, []);
  });

  it('scans the --project folder, from the working folder, outside any team', async () => {
    const harness = await world();
    const lines = okLines(await scan(harness, ['--project', '../other']));
    assert.match(lines[0] ?? '', /other \(no team yet\)$/);
  });

  it("reads the --project folder's own team, never the caller's $TEAMRIG_TEAM", async () => {
    const harness = await world();
    const caller: Env = { TEAMRIG_TEAM: 'app' };
    await harness.files.write(join(TEAM_HOME, 'rules.md'), 'Team rules.\n');
    assert.match(okLines(await scan(harness, ['--project', OTHER], new MemoryTranscripts(), caller))[0] ?? '', /other \(no team yet\)$/);
    const otherRules = join(KIT, 'teams', 'other', 'rules.md');
    await harness.files.write(join(OTHER, '.teamrig.json'), '{"team": "other"}');
    await harness.files.write(join(KIT, 'teams', 'other', 'config.json'), formatConfig(TEAM));
    await harness.files.write(otherRules, 'Other rules.\n');
    const lines = okLines(await scan(harness, ['--project', OTHER], new MemoryTranscripts(), caller));
    assert.match(lines[0] ?? '', / \(team other\)$/);
    const rulesLines = lines.filter((line) => line.startsWith('CONTEXT team-rules'));
    assert.equal(rulesLines.length, 1, lines.join('\n'));
    assert.match(rulesLines[0] ?? '', /[\\/]teams[\\/]other[\\/]rules\.md: 13 chars/);
  });

  it("in a child team: loads the rules of each team above before the team's own, root first", async () => {
    const harness = await world(await treeHarness());
    const rootRules = join(teamHomeOf('app'), 'rules.md');
    const ownRules = join(teamHomeOf('ui'), 'rules.md');
    await harness.files.write(rootRules, 'Root rules.\n');
    await harness.files.write(ownRules, 'Own rules.\n');
    const lines = okLines(await scan(harness, [], new MemoryTranscripts(), { TEAMRIG_TEAM: 'ui' }));
    assert.match(lines[0] ?? '', / \(team ui\)$/);
    const rulesLines = lines.filter((line) => line.startsWith('CONTEXT team-rules'));
    assert.deepEqual(
      rulesLines.map((line) => line.split(': ')[0]),
      [`CONTEXT team-rules ${resolve(rootRules)}`, `CONTEXT team-rules ${resolve(ownRules)}`],
    );
  });

  it('judges no skill written inside the window, and counts it in the UNUSED header', async () => {
    const harness = await world();
    await harness.files.write(join(SKILLS_DIR, 'gamma-new', 'SKILL.md'), skill('gamma-new', 'New gamma.'));
    const lines = okLines(await scan(harness, [], transcripts(HOUR_MS)));
    assert.ok(
      lines.includes(`UNUSED 1 of 3 skill(s) not used in ${DEFAULT_SCAN_DAYS} day(s) (read 1 transcript(s), 0.0 MB); 1 more changed in that time, too new to judge${NO_DOCTOR}`),
      lines.join('\n'),
    );
    assert.deepEqual(
      lines.filter((line) => /^U\d+ /.test(line)).map((line) => /beta-run|gamma-new/.exec(line)?.[0]),
      ['beta-run'],
    );
  });

  it('reads the transcripts newest first up to --max-mb, and judges only the days read', async () => {
    const harness = await world();
    const source = new MemoryTranscripts();
    source.set(transcriptPath('a'), `${skillLine('alpha-check')}\n${promptLine(LINE_AT, 'x'.repeat(Math.round(1.1 * 1024 * 1024)))}\n`, NOW - DAY_MS / 2);
    source.set(transcriptPath('b'), `${skillLine('beta-run')}\n`, NOW - 2 * DAY_MS);
    const bounded = okLines(await scan(harness, ['--max-mb', '1'], source));
    assert.ok(
      bounded.includes(
        `UNUSED 1 of 2 skill(s) not used in the newest 0.5 day(s) (read 1 transcript(s), 1.1 MB, newest first; 1 older one(s) of 30 day(s) left unread past the 1 MB bound, --max-mb raises it)${NO_DOCTOR}`,
      ),
      bounded.join('\n'),
    );
    assert.match(bounded.find((line) => line.startsWith('U1 ')) ?? '', /beta-run.*: no Skill call or \/beta-run in the newest 0\.5 day\(s\)/);
    assert.ok(okLines(await scan(harness, [], source)).includes(`UNUSED 0 of 2 skill(s) not used in ${DEFAULT_SCAN_DAYS} day(s) (read 2 transcript(s), 1.1 MB)${NO_DOCTOR}`));
  });

  it('refuses a --days or --max-mb that is not a whole number of 1 or more, a positional and a broken team pointer', async () => {
    const harness = await world();
    for (const flag of ['--days', '--max-mb']) {
      for (const value of ['0', '1.5', 'x']) {
        const result = await scan(harness, [flag, value]);
        assert.equal(result.code, EXIT.usage);
        assert.match(result.stderr.join('\n'), new RegExp(`${flag} "${value.replace('.', '[.]')}" is not a whole number of 1 or more`));
      }
    }
    assert.equal((await scan(harness, ['extra'])).code, EXIT.usage);
    assert.equal((await scan(await world(new CliHarness(undefined, '{not json')))).code, EXIT.refused);
  });
});
