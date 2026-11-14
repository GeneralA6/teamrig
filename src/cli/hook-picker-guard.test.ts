import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { MEETING_LAPSE_MS, MeetingStore } from '../meeting/state.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, decisionOf, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const ON_TEAM: JsonRecord = { ...TEAM, pickerGuard: { enabled: true } };
/** A team whose config still names the dropped `decisions.askWith: picker` (T2256). */
const PICKER_TEAM: JsonRecord = { ...ON_TEAM, decisions: { askWith: 'picker' } };
const HOOK = ['hook', 'picker-guard'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
const LEAD = { TEAMRIG_SESSION: 'lead' };

function call(tool: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLAUDE_SESSION, cwd: APP, tool_name: tool, tool_input: { questions: [] }, ...fields });
}

/** A PreToolUse payload of a Bash `command` run in the app folder. */
function bash(command: string): string {
  return call('Bash', { tool_input: { command } });
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

  // T1278, T2256: the daily meeting asks only in plain text, so the lead's picker stays shut before, in and after it.
  it("refuses the lead's picker while no meeting is open, in an open one saying to read the card, and once it ends or lapses", async () => {
    const kit = new CliHarness(ON_TEAM);
    const ask = { stdin: call('AskUserQuestion'), env: LEAD };
    const later = /--session lead`; the agenda of the owner's next daily meeting lists it, and you ask it there in plain text/;
    const away = await kit.run(HOOK, ask);
    assert.equal(decisionOf(away), 'deny', 'no meeting was ever held');
    assert.match(reasonOf(away) ?? '', later);
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    const inMeeting = await kit.run(HOOK, ask);
    assert.equal(decisionOf(inMeeting), 'deny', 'the owner is in the meeting, which asks in plain text');
    assert.match(reasonOf(inMeeting) ?? '', /^teamrig picker guard: the owner's daily meeting asks in plain text\. Read the card as it stands/);
    kit.clock.advance(MEETING_LAPSE_MS);
    assert.match(reasonOf(await kit.run(HOOK, ask)) ?? '', later, 'a meeting never ended lapses');
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.match(reasonOf(await kit.run(HOOK, ask)) ?? '', later, 'the meeting ended');
  });

  // T2256: a config still naming the dropped askWith gets a parse issue, and its key no longer opens the picker.
  it("refuses the lead's picker in an open meeting of a team whose config still names askWith: picker", async () => {
    const kit = new CliHarness(PICKER_TEAM);
    // A config with a problem refuses the writing meeting start, so seed a meeting opened half an hour ago.
    await new MeetingStore(kit.files, join(TEAM_HOME, 'state', 'meeting.json')).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null });
    const inMeeting = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: LEAD });
    assert.equal(decisionOf(inMeeting), 'deny');
    assert.match(reasonOf(inMeeting) ?? '', /^teamrig picker guard: the owner's daily meeting asks in plain text\. Read the card as it stands/);
  });

  it("refuses a helper's picker in any team session, the lead's in a meeting too, with the helper's reason", async () => {
    const kit = new CliHarness(ON_TEAM);
    const helper = call('AskUserQuestion', { agent_id: 'a1b2', agent_type: 'general-purpose' });
    const inAlpha = await kit.run(HOOK, { stdin: helper, env: ALPHA });
    assert.equal(decisionOf(inAlpha), 'deny');
    assert.match(reasonOf(inAlpha) ?? '', /^teamrig picker guard: a helper's question picker stops the session that started it/);
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    const inLead = await kit.run(HOOK, { stdin: helper, env: LEAD });
    assert.equal(decisionOf(inLead), 'deny', "a helper reports, the lead's meeting or not");
    assert.equal(reasonOf(inLead), reasonOf(inAlpha));
    assert.deepEqual(await kit.run(HOOK, { stdin: helper }), NOTHING, 'a helper in a tab that is no team session');
  });

  it("refuses a sub-team's lead even with a meeting of its team left open, routing the card to its parent lead", async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], pickerGuard: { enabled: true } }));
    const web = { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'lead' };
    // A child team's lead holds no meeting (T1018), so seed one it opened before that, still open half an hour on.
    await new MeetingStore(kit.files, join(teamHomeOf('web'), 'state', 'meeting.json')).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null });
    const result = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: web });
    assert.equal(decisionOf(result), 'deny', 'the user talks only to the root lead');
    assert.match(reasonOf(result) ?? '', /then tell your parent lead app\/lead \(name `[^`]+`\) in one inbox line, `teamrig inbox add --to app\/lead /);
    const member = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: { ...web, TEAMRIG_SESSION: 'front' } });
    assert.match(reasonOf(member) ?? '', /--session front`; the lead brings it to the owner\./);
  });

  it("tells the root lead of a tree in the owner's meeting to ask in plain text, as the lead of a team on its own", async () => {
    const kit = await treeHarness({ pickerGuard: { enabled: true } });
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    const result = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: LEAD });
    assert.equal(decisionOf(result), 'deny');
    assert.match(reasonOf(result) ?? '', /^teamrig picker guard: the owner's daily meeting asks in plain text\./, 'the root lead is told no parent lead');
  });

  it('lets a tab that is no team session ask', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion') }), NOTHING, 'no $TEAMRIG_SESSION and no inbox read');
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: { TEAMRIG_SESSION: 'nobody' } }), NOTHING);
  });

  it('lets plan mode end and every other call go', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('ExitPlanMode'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('Bash'), env: ALPHA }), NOTHING, 'a Bash call with no command');
    assert.deepEqual(await kit.run(HOOK, { stdin: call('AskUserQuestion', { hook_event_name: 'PostToolUse' }), env: ALPHA }), NOTHING);
  });

  // T2730: Claude Code holds such a line on a permission prompt, in auto mode too; overnight one held a p0 for 9 hours.
  it("refuses a team session's cd compound that runs git or leaves its folder, quoting the rerun form", async () => {
    const kit = new CliHarness(ON_TEAM);
    const git = await kit.run(HOOK, { stdin: bash('cd sub && git status'), env: ALPHA });
    assert.equal(decisionOf(git), 'deny');
    assert.match(reasonOf(git) ?? '', /^teamrig picker guard: Claude Code asks a person before a `cd` compound/);
    assert.match(reasonOf(git) ?? '', /rerun it as: git -C sub status$/);
    const away = await kit.run(HOOK, { stdin: bash('cd .. && npm test'), env: ALPHA });
    assert.match(reasonOf(away) ?? '', /rerun it as: env -C \.\. npm test$/);
  });

  it('lets a cd compound go that stays in the folder and runs no git, or has no rerun form', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('cd sub && npm test'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('git status'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('PowerShell', { tool_input: { command: 'cd .. && git status' } }), env: ALPHA }), NOTHING);
  });

  it('lets a cd compound go with the guard off or in a tab that is no team session', async () => {
    const line = bash('cd sub && git status');
    assert.deepEqual(await new CliHarness({ ...TEAM, pickerGuard: { enabled: false } }).run(HOOK, { stdin: line, env: ALPHA }), NOTHING);
    assert.deepEqual(await new CliHarness(ON_TEAM).run(HOOK, { stdin: line }), NOTHING);
    assert.deepEqual(await new CliHarness(ON_TEAM).run(HOOK, { stdin: line, env: { TEAMRIG_SESSION: 'nobody' } }), NOTHING);
  });

  // T2256: a team that never names the key is guarded; only `enabled: false` turns the guard off.
  it('refuses the picker in a team whose config names no pickerGuard key', async () => {
    const result = await new CliHarness().run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA });
    assert.equal(decisionOf(result), 'deny');
    assert.match(reasonOf(result) ?? '', /^teamrig picker guard: the question picker stops this session/);
  });

  it('prints nothing with the guard off, or with the config missing, broken or unreadable', async () => {
    const off = [new CliHarness({ ...TEAM, pickerGuard: { enabled: false } }), new CliHarness(null), new CliHarness('{ not json')];
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
