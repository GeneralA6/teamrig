import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, decisionOf, TEAM, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ON_TEAM: JsonRecord = { ...TEAM, pickerGuard: { enabled: true } };
const HOOK = ['hook', 'picker-guard'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
const ALPHA = { TEAMRIG_SESSION: 'alpha' };

function call(tool: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLAUDE_SESSION, cwd: APP, tool_name: tool, tool_input: { questions: [] }, ...fields });
}

/** The reason of a PreToolUse decision the hook printed, or undefined. */
function reasonOf(result: CliResult): string | undefined {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const output = isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
  return output === undefined ? undefined : stringField(output, 'permissionDecisionReason');
}

describe('hook picker-guard', () => {
  it("refuses a team session's question picker, with its own set command for the decision", async () => {
    const result = await new CliHarness(ON_TEAM).run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA });
    assert.equal(decisionOf(result), 'deny');
    assert.match(reasonOf(result) ?? '', /^teamrig picker guard: the question picker stops this session/);
    assert.match(reasonOf(result) ?? '', /--session alpha`/);
  });

  it('lets the lead ask, and a tab that is no team session', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: { TEAMRIG_SESSION: 'lead' } }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion') }), NOTHING, 'no $TEAMRIG_SESSION and no inbox read');
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: { TEAMRIG_SESSION: 'nobody' } }), NOTHING);
  });

  it('lets plan mode end and every other call go', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('ExitPlanMode'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('Bash'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion', { hook_event_name: 'PostToolUse' }), env: ALPHA }), NOTHING);
  });

  it('prints nothing with the guard off, by default, or with the config missing, broken or unreadable', async () => {
    const off = [new CliHarness(), new CliHarness({ ...TEAM, pickerGuard: { enabled: false } }), new CliHarness(null), new CliHarness('{ not json')];
    for (const kit of off) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA }), NOTHING);
    }
    const locked = new CliHarness(ON_TEAM);
    const files = new FaultyFiles(locked.files).fail('read', CONFIG_PATH, systemError('EACCES'));
    assert.deepEqual(await locked.run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA, files }), NOTHING);
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness(ON_TEAM, null).run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA }), NOTHING);
    assert.deepEqual(await new CliHarness(ON_TEAM).run(HOOK, { stdin: 'not json', env: ALPHA }), NOTHING);
  });
});
