import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import type { MemoryFiles } from '../testing/memory-files.ts';
import { KEPT_PUSH_RULE, keptPushLineOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const RULES = join(TEAM_HOME, 'rules.md');
const MARKS = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
const HELPER = { session_id: CLAUDE_SESSION, cwd: APP, agent_id: 'a1', agent_type: 'general-purpose' };
const SUBAGENT_START = JSON.stringify({ hook_event_name: 'SubagentStart', ...HELPER });

/** The hook event the one output line answers. */
function eventOf(result: CliResult): unknown {
  assert.equal(result.stdout.length, 1);
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(typeof parsed === 'object' && parsed !== null && 'hookSpecificOutput' in parsed);
  const output = parsed.hookSpecificOutput;
  assert.ok(typeof output === 'object' && output !== null && 'hookEventName' in output);
  return output.hookEventName;
}

/** Every stored file and its text, to show a hook changed none. */
function snapshot(files: MemoryFiles): Map<string, string | undefined> {
  return new Map(files.paths().map((path) => [path, files.get(path)]));
}

/** A harness whose Claude Code session read its inbox as `area`, as a hand-started tab does. */
async function markedAs(area: string): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  await kit.run(['inbox', 'read', '--session', area], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  return kit;
}

describe('the subagent-start hook', () => {
  it("gives a helper the team's rules as the helper of the session that started it", async () => {
    const kit = await markedAs('alpha');
    await kit.files.write(RULES, 'Ship small.');
    const result = await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START });
    assert.equal(result.code, EXIT.ok);
    assert.equal(eventOf(result), 'SubagentStart');
    const text = contextOf(result);
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.match(text, /\n\nYou are a helper \(`general-purpose`\) of the `alpha` session of team `app` \(name `app-alpha`\)\. /);
    assert.match(text, /pass --session alpha to any `teamrig` command your brief asks for\./);
    assert.ok(text.endsWith("# Your team's rules\nShip small."));
    assert.ok(!text.includes('You are the `'));
  });

  it("gives a helper of a child team's session the rules of each team above it first", async () => {
    const kit = await treeHarness();
    await kit.files.write(RULES, '- app rule.');
    await kit.files.write(join(teamHomeOf('ui'), 'rules.md'), '- ui rule.');
    const text = contextOf(await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START, env: { TEAMRIG_TEAM: 'ui', TEAMRIG_SESSION: 'pixel' } }));
    assert.ok(text.endsWith("# Team app's rules (a team above yours; they win over a lower team's)\n- app rule.\n\n# Your team's rules\n- ui rule."), text);
  });

  it("gives a helper of a child team's session the kept local rules of a team above it, tagged", async () => {
    const kit = await treeHarness({ ruleConflicts: [KEPT_PUSH_RULE] });
    const text = contextOf(await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START, env: { TEAMRIG_TEAM: 'ui', TEAMRIG_SESSION: 'pixel' } }));
    assert.ok(text.includes(`\nKept local rules [ruleConflicts]:\n${keptPushLineOf('app')}\n`), text);
  });

  it('takes the session from $TEAMRIG_SESSION when it is set', async () => {
    const kit = await markedAs('alpha');
    const text = contextOf(await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START, env: { TEAMRIG_SESSION: 'bravo' } }));
    assert.match(text, /of the `bravo` session of team `app` \(name `app-bravo`\)\./);
    assert.ok(!text.includes('is not set here'));
  });

  it('changes no file: binding, renaming and refreshing belong to the session', async () => {
    const kit = await markedAs('alpha');
    const before = snapshot(kit.files);
    await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START });
    assert.deepEqual(snapshot(kit.files), before);
  });

  it('still gives the rules when the inbox marks cannot be read, as the helper of a session of the team', async () => {
    const kit = await markedAs('alpha');
    const files = new FaultyFiles(kit.files).fail('read', MARKS, new Error('disk gone'));
    const text = contextOf(await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START, files }));
    assert.match(text, /\n\nYou are a helper \(`general-purpose`\) of a session of team `app`\. /);
  });

  it('says why the rules are missing when a read fails, and never refuses', async () => {
    const kit = new CliHarness(TEAM);
    const files = new FaultyFiles(kit.files).fail('read', RULES, systemError('EIO'));
    const result = await kit.run(['hook', 'subagent-start'], { stdin: SUBAGENT_START, files });
    assert.equal(result.code, EXIT.ok);
    assert.equal(contextOf(result), 'teamrig could not load the rules of team app: EIO: simulated');
  });

  it('prints nothing outside a team, and one line for a broken team pointer or a missing config', async () => {
    assert.deepEqual((await new CliHarness(TEAM, null).run(['hook', 'subagent-start'], { stdin: SUBAGENT_START })).stdout, []);
    assert.match(contextOf(await new CliHarness(TEAM, '{"team": 7}').run(['hook', 'subagent-start'], { stdin: SUBAGENT_START })), /^teamrig: no team, so no team rules: /);
    assert.match(contextOf(await new CliHarness(null).run(['hook', 'subagent-start'], { stdin: SUBAGENT_START })), /^teamrig is enabled here but team app has no config at /);
  });

  it('gives a payload with no agent type a helper line without one', async () => {
    const kit = await markedAs('alpha');
    const text = contextOf(await kit.run(['hook', 'subagent-start'], { stdin: 'not json' }));
    assert.match(text, /\n\nYou are a helper of a session of team `app`\. /);
  });
});

describe('the SessionStart hook inside a helper', () => {
  const COMPACT = { session_id: CLAUDE_SESSION, cwd: APP, source: 'compact' };

  it("gives a compaction inside a helper the helper's context, never the session's identity or live tasks, and changes no file", async () => {
    const kit = await markedAs('alpha');
    await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    const own = contextOf(await kit.run(['hook', 'session-start'], { stdin: JSON.stringify(COMPACT) }));
    assert.match(own, /You are the `alpha` session of team `app`/);
    assert.match(own, /LIVE TASKS/);

    const before = snapshot(kit.files);
    const result = await kit.run(['hook', 'session-start'], { stdin: JSON.stringify({ ...COMPACT, agent_id: 'a1', agent_type: 'Explore' }) });
    assert.equal(result.code, EXIT.ok);
    assert.equal(eventOf(result), 'SessionStart');
    const text = contextOf(result);
    assert.match(text, /\n\nYou are a helper \(`Explore`\) of the `alpha` session of team `app` \(name `app-alpha`\)\. /);
    assert.ok(!text.includes('You are the `'));
    assert.ok(!text.includes('LIVE TASKS'));
    assert.deepEqual(snapshot(kit.files), before);
  });
});
