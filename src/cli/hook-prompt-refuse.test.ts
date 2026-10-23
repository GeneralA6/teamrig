import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { ASK_REFUSED_NOTE } from '../hooks/permission.ts';
import { rerunReason } from '../hooks/prompt-refuse.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ASKS_OFF: JsonRecord = { ...TEAM, prompts: { hookAsks: 'refuse' } };
const ANSWERS_LOG = join(TEAM_HOME, 'state', 'prompt-answers.jsonl');
const REFUSED = (tool: string): JsonRecord => ({ behavior: 'deny', message: `Claude Code would ask a person to allow this ${tool} call. ${ASK_REFUSED_NOTE}` });
const HOOK = ['hook', 'prompt-refuse'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };

function request(tool: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: CLAUDE_SESSION, cwd: APP, tool_name: tool, tool_input: { command: 'git fetch' }, ...fields });
}

function bashRequest(command: string): string {
  return request('Bash', { tool_input: { command } });
}

/** The prompt answers the hook logged, oldest first. */
async function answersOf(kit: CliHarness): Promise<unknown[]> {
  const text = (await kit.files.read(ANSWERS_LOG)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

/** The decision of a PermissionRequest answer the hook printed, or undefined. */
function permissionOf(result: CliResult): JsonRecord | undefined {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
  return output === undefined ? undefined : recordField(output, 'decision');
}

describe('hook prompt-refuse', () => {
  it('refuses a permission prompt when the team config turns asks off, saying what to do instead', async () => {
    const result = await new CliHarness(ASKS_OFF).run(HOOK, { stdin: request('Bash') });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(permissionOf(result), REFUSED('Bash'));
  });

  it('answers each prompt for its case: a read-only line runs, a line with a rerun form quotes it, anything else is refused', async () => {
    const kit = new CliHarness(ASKS_OFF);
    assert.deepEqual(permissionOf(await kit.run(HOOK, { stdin: bashRequest('cat f') })), { behavior: 'allow' });
    assert.deepEqual(permissionOf(await kit.run(HOOK, { stdin: bashRequest('cd /w && npm test') })), { behavior: 'deny', message: rerunReason('Bash', 'env -C /w npm test') });
    assert.deepEqual(permissionOf(await kit.run(HOOK, { stdin: bashRequest('rm -rf x') })), REFUSED('Bash'));
    assert.deepEqual(permissionOf(await kit.run(HOOK, { stdin: request('Write', { tool_input: { file_path: '/w/a', content: 'x' } }) })), REFUSED('Write'));
  });

  it('refuses a line that only reads but would print a secret', async () => {
    assert.deepEqual(permissionOf(await new CliHarness(ASKS_OFF).run(HOOK, { stdin: bashRequest('cat .env') })), REFUSED('Bash'));
  });

  it("logs each answer with its sessions and the command's start", async () => {
    const kit = new CliHarness(ASKS_OFF);
    await kit.run(HOOK, { stdin: bashRequest('cat f'), env: { TEAMRIG_SESSION: 'alpha' } });
    await kit.run(HOOK, { stdin: bashRequest('rm -rf x') });
    assert.deepEqual(await answersOf(kit), [
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', answer: 'readonly', command: 'cat f' },
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: null, claudeSession: CLAUDE_SESSION, tool: 'Bash', answer: 'refused', command: 'rm -rf x' },
    ]);
  });

  it('still answers when the log cannot be written, and logs nothing when the prompt opens', async () => {
    const kit = new CliHarness(ASKS_OFF);
    const files = new FaultyFiles(kit.files).fail('append', ANSWERS_LOG, systemError('ENOSPC'));
    assert.deepEqual(permissionOf(await kit.run(HOOK, { stdin: bashRequest('cat f'), files })), { behavior: 'allow' });
    await kit.run(HOOK, { stdin: request('AskUserQuestion') });
    const on = new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask' } });
    await on.run(HOOK, { stdin: bashRequest('rm -rf x') });
    assert.deepEqual([await answersOf(kit), await answersOf(on)], [[], []]);
  });

  it('lets the question picker and plan mode exit open, and another event go', async () => {
    const kit = new CliHarness(ASKS_OFF);
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      assert.deepEqual(await kit.run(HOOK, { stdin: request(tool) }), NOTHING, tool);
    }
    assert.deepEqual(await kit.run(HOOK, { stdin: request('Bash', { hook_event_name: 'PreToolUse' }) }), NOTHING);
  });

  it('prints nothing with asks on, by default, or with the config missing, broken or unreadable', async () => {
    const on = [new CliHarness(), new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask' } }), new CliHarness(null), new CliHarness('{ not json')];
    for (const kit of on) {
      assert.deepEqual(await kit.run(HOOK, { stdin: request('Bash') }), NOTHING);
    }
    const locked = new CliHarness(ASKS_OFF);
    const files = new FaultyFiles(locked.files).fail('read', CONFIG_PATH, systemError('EACCES'));
    assert.deepEqual(await locked.run(HOOK, { stdin: request('Bash'), files }), NOTHING);
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness(ASKS_OFF, null).run(HOOK, { stdin: request('Bash') }), NOTHING);
    assert.deepEqual(await new CliHarness(ASKS_OFF).run(HOOK, { stdin: 'not json' }), NOTHING);
  });
});
