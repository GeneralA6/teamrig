import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ASKS_OFF: JsonRecord = { ...TEAM, prompts: { hookAsks: 'refuse' } };
const ANSWERS_LOG = join(TEAM_HOME, 'state', 'prompt-answers.jsonl');
const HOOK = ['hook', 'route-allow'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
/** A token shape the secret guard knows, built here so no token sits in the source. */
const TOKEN = ['gh', 'p_', 'a1'.repeat(18)].join('');

function call(command: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'Bash', tool_input: { command }, ...fields });
}

/** The permission decision of a PreToolUse answer the hook printed, or undefined. */
function decisionOf(result: CliResult): unknown {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
  return output?.['permissionDecision'];
}

/** The prompt answers the hook logged, oldest first. */
async function answersOf(kit: CliHarness): Promise<unknown[]> {
  const text = (await kit.files.read(ANSWERS_LOG)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('hook route-allow', () => {
  it("allows a sanctioned route's line before any permission check, logging only its route", async () => {
    const kit = new CliHarness(ASKS_OFF);
    const result = await kit.run(HOOK, { stdin: call('teamrig merge --session alpha'), env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stderr, []);
    assert.equal(decisionOf(result), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('git -C /w commit -s -m fix') })), 'allow');
    assert.deepEqual(await answersOf(kit), [
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'route', route: 'merge', command: null },
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: null, claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'route', route: 'git-commit', command: null },
    ]);
  });

  it('leaves a push and the register commands to the permission check, even where they are routes', async () => {
    const kit = new CliHarness(ASKS_OFF);
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const git: RunOptions['git'] = {
      branch: () => 'dev',
      head: () => undefined,
      pushTarget: () => undefined,
      config: (_dir, key) => (key === 'remote.origin.url' ? { kind: 'set', value: 'u' } : { kind: 'unset' }),
    };
    const env = { TEAMRIG_SESSION: 'alpha' };
    assert.deepEqual(await kit.run(HOOK, { stdin: call('git push -u origin t1-x'), env, git }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig list --session alpha'), env }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });

  it("stays out when a guard asks about or refuses the route's line, so that guard answers it", async () => {
    const kit = new CliHarness(ASKS_OFF);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('git -C /w/.git/other commit -s -m fix') })), 'allow');
    assert.deepEqual(await kit.run(HOOK, { stdin: call('git -C /w/.git/local-ci commit -s -m fix') }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call(`git commit -s -m ${TOKEN}`) }), NOTHING);
    assert.equal((await answersOf(kit)).length, 1);
  });

  it('prints nothing for another line, another tool or input that is not a hook payload', async () => {
    const kit = new CliHarness(ASKS_OFF);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('rm -rf x') }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha', { tool_name: 'PowerShell' }) }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('./teamrig merge --session alpha') }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: 'not json' }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });

  it('prints nothing with asks on, by default, with the switch off, or with the config missing or broken', async () => {
    const quiet = [
      new CliHarness(),
      new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask', routeAllow: 'on' } }),
      new CliHarness({ ...TEAM, prompts: { hookAsks: 'refuse', routeAllow: 'off' } }),
      new CliHarness(null),
      new CliHarness('{ not json'),
    ];
    for (const kit of quiet) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha') }), NOTHING);
    }
  });

  it('still allows when the log cannot be written', async () => {
    const kit = new CliHarness(ASKS_OFF);
    const files = new FaultyFiles(kit.files).fail('append', ANSWERS_LOG, systemError('ENOSPC'));
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha'), files })), 'allow');
    assert.deepEqual(await answersOf(kit), []);
  });
});
