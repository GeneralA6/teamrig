import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { MEETING_LAPSE_MS } from '../meeting/state.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, decisionOf, TEAM, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ON_TEAM: JsonRecord = { ...TEAM, pickerGuard: { enabled: true } };
const HOOK = ['hook', 'picker-guard'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
const LEAD = { TEAMRIG_SESSION: 'lead' };

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
    assert.match(reasonOf(result) ?? '', /--session alpha`; the lead brings it to the owner\./);
  });

  it("refuses the lead's picker while no meeting is open, lets it open in the meeting, and refuses it again once it ends or lapses", async () => {
    const kit = new CliHarness(ON_TEAM);
    const ask = { stdin: call('AskUserQuestion'), env: LEAD };
    const away = await kit.run(HOOK, ask);
    assert.equal(decisionOf(away), 'deny', 'no meeting was ever held');
    assert.match(reasonOf(away) ?? '', /--session lead`; the agenda of the owner's next daily meeting lists it/);
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(await kit.run(HOOK, ask), NOTHING, 'the owner is in the meeting');
    kit.clock.advance(MEETING_LAPSE_MS);
    assert.equal(decisionOf(await kit.run(HOOK, ask)), 'deny', 'a meeting never ended lapses');
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.equal(decisionOf(await kit.run(HOOK, ask)), 'deny', 'the meeting ended');
  });

  it("refuses a helper's picker in any team session, the lead's in a meeting too, with the helper's reason", async () => {
    const kit = new CliHarness(ON_TEAM);
    const helper = call('AskUserQuestion', { agent_id: 'a1b2', agent_type: 'general-purpose' });
    const inAlpha = await kit.run(HOOK, { stdin: helper, env: ALPHA });
    assert.equal(decisionOf(inAlpha), 'deny');
    assert.match(reasonOf(inAlpha) ?? '', /^teamrig picker guard: a helper's question picker stops the session that started it/);
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    const inLead = await kit.run(HOOK, { stdin: helper, env: LEAD });
    assert.equal(decisionOf(inLead), 'deny', "the meeting asks through the lead's own thread only");
    assert.equal(reasonOf(inLead), reasonOf(inAlpha));
    assert.deepEqual(await kit.run(HOOK, { stdin: helper }), NOTHING, 'a helper in a tab that is no team session');
  });

  it('lets a tab that is no team session ask', async () => {
    const kit = new CliHarness(ON_TEAM);
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
