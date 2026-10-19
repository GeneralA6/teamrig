import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { ASK_REFUSED_NOTE } from '../hooks/permission.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, TEAM, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ASKS_OFF: JsonRecord = { ...TEAM, prompts: { hookAsks: 'refuse' } };
const HOOK = ['hook', 'prompt-refuse'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };

function request(tool: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: CLAUDE_SESSION, cwd: APP, tool_name: tool, tool_input: { command: 'git fetch' }, ...fields });
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
    assert.deepEqual(permissionOf(result), { behavior: 'deny', message: `Claude Code would ask a person to allow this Bash call. ${ASK_REFUSED_NOTE}` });
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
