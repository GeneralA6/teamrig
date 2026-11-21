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
    await new MeetingStore(kit.files, join(TEAM_HOME, 'state', 'meeting.json')).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null, carried: [], kind: 'daily' });
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

  it("refuses a sub-team's lead, routing the card to its parent lead, and in its own open meeting saying to ask in plain text (T2985)", async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], pickerGuard: { enabled: true } }));
    const web = { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'lead' };
    const result = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: web });
    assert.equal(decisionOf(result), 'deny', 'no meeting is open, so the card goes up');
    assert.match(reasonOf(result) ?? '', /then tell your parent lead app\/lead \(name `[^`]+`\) in one inbox line, `teamrig inbox add --to app\/lead /);
    // A sub-team's lead meets the owner over its subtree (T2985): its meeting, opened half an hour before, is open.
    await new MeetingStore(kit.files, join(teamHomeOf('web'), 'state', 'meeting.json')).write({ startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: null, since: null, carried: [], kind: 'daily' });
    const meeting = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: web });
    assert.equal(decisionOf(meeting), 'deny');
    assert.match(reasonOf(meeting) ?? '', /^teamrig picker guard: the owner's daily meeting asks in plain text\./);
    const member = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: { ...web, TEAMRIG_SESSION: 'front' } });
    assert.match(reasonOf(member) ?? '', /--session front`; the lead brings it to the owner\./);
  });

  // T2985: a worker in its own meeting with the owner asks there in plain text.
  it('refuses the picker of a session in its own meeting, saying to ask in plain text, and as before once it ends', async () => {
    const kit = new CliHarness(ON_TEAM);
    const ask = { stdin: call('AskUserQuestion'), env: ALPHA };
    assert.equal((await kit.run(['meeting', 'start', '--about', 'the cache design', '--session', 'alpha'])).code, EXIT.ok);
    const inMeeting = await kit.run(HOOK, ask);
    assert.equal(decisionOf(inMeeting), 'deny');
    assert.match(reasonOf(inMeeting) ?? '', /^teamrig picker guard: your meeting M1 with the owner is in this tab: ask in plain text/);
    assert.match(reasonOf(await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: { TEAMRIG_SESSION: 'bravo' } })) ?? '', /the lead brings it to the owner\./, 'another session');
    assert.equal((await kit.run(['meeting', 'end', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(reasonOf(await kit.run(HOOK, ask)) ?? '', /the lead brings it to the owner\./);
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

  // T2802: a line with no rerun form went on to that prompt, which held the lead's tab 14 hours (T1749).
  it("refuses a team session's cd compound with no rerun form, saying to drop the cd", async () => {
    const kit = new CliHarness(ON_TEAM);
    const held = await kit.run(HOOK, { stdin: bash('set -e; S=/tmp/s; mkdir -p "$S"; cd "$S"; git init -q; git push origin main'), env: ALPHA });
    assert.equal(decisionOf(held), 'deny');
    assert.match(reasonOf(held) ?? '', /^teamrig picker guard: Claude Code asks a person before a `cd` compound/);
    assert.match(reasonOf(held) ?? '', /Drop the `cd`: run git as `git -C <dir> \.\.\.`/);
    const midLine = await kit.run(HOOK, { stdin: bash('npm ci; cd sub; git status'), env: ALPHA });
    assert.match(reasonOf(midLine) ?? '', /Drop the `cd`/);
  });

  it('lets a cd compound go that stays in the folder and runs no git', async () => {
    const kit = new CliHarness(ON_TEAM);
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('cd sub && npm test'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('npm ci; cd sub; npm test'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: bash('git status'), env: ALPHA }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('PowerShell', { tool_input: { command: 'cd .. && git status' } }), env: ALPHA }), NOTHING);
  });

  // #1578: under bypassPermissions Claude Code shows no cd-compound prompt, so no Bash line is refused for one;
  // every other mode refuses as before, and the question picker is refused in every mode.
  describe('under permission_mode bypassPermissions (#1578)', () => {
    /** Bash lines the guard refuses in every other mode: a leading cd to a folder only known at run time, and a cd mid-line. */
    const CD_LINES = ['cd ~/x && git status', 'npm ci; cd sub; git status', 'cd sub && git status', 'cd .. && npm test'] as const;
    const inMode = (command: string, mode: string | undefined): string => call('Bash', { tool_input: { command }, ...(mode === undefined ? {} : { permission_mode: mode }) });

    it('lets every cd compound go, the drop-cd and rerun-form lines alike', async () => {
      const kit = new CliHarness(ON_TEAM);
      for (const line of CD_LINES) {
        assert.deepEqual(await kit.run(HOOK, { stdin: inMode(line, 'bypassPermissions'), env: ALPHA }), NOTHING, line);
      }
    });

    it('refuses the same lines with the same text in the default, plan, acceptEdits and auto modes, and with no mode named', async () => {
      const kit = new CliHarness(ON_TEAM);
      for (const mode of [undefined, 'default', 'plan', 'acceptEdits', 'auto']) {
        const tilde = await kit.run(HOOK, { stdin: inMode('cd ~/x && git status', mode), env: ALPHA });
        assert.equal(decisionOf(tilde), 'deny', String(mode));
        assert.match(reasonOf(tilde) ?? '', /^teamrig picker guard: Claude Code asks a person before a `cd` compound/);
        assert.match(reasonOf(await kit.run(HOOK, { stdin: inMode('npm ci; cd sub; git status', mode), env: ALPHA })) ?? '', /Drop the `cd`/, String(mode));
        assert.match(reasonOf(await kit.run(HOOK, { stdin: inMode('cd sub && git status', mode), env: ALPHA })) ?? '', /rerun it as: git -C sub status$/, String(mode));
      }
    });

    it('still refuses the question picker, with the same reason as in any other mode', async () => {
      const kit = new CliHarness(ON_TEAM);
      const plain = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA });
      const bypass = await kit.run(HOOK, { stdin: call('AskUserQuestion', { permission_mode: 'bypassPermissions' }), env: ALPHA });
      assert.equal(decisionOf(bypass), 'deny');
      assert.equal(reasonOf(bypass), reasonOf(plain));
    });
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

  // T3015: the meeting files only pick the refusal's reason, so an unreadable one still refuses the picker.
  it("refuses a worker's and the lead's picker when the meeting schedule or the meeting file cannot be read", async () => {
    const kit = new CliHarness(ON_TEAM);
    const state = join(TEAM_HOME, 'state');
    const files = new FaultyFiles(kit.files).fail('read', join(state, 'meetings.jsonl'), systemError('EACCES')).fail('read', join(state, 'meeting.json'), systemError('EACCES'));
    const worker = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA, files });
    assert.equal(decisionOf(worker), 'deny');
    assert.match(reasonOf(worker) ?? '', /--session alpha`; the lead brings it to the owner\./, 'read as no meeting in its tab');
    const lead = await kit.run(HOOK, { stdin: call('AskUserQuestion'), env: LEAD, files });
    assert.equal(decisionOf(lead), 'deny');
    assert.match(reasonOf(lead) ?? '', /the agenda of the owner's next daily meeting lists it/, 'read as no open meeting');
  });

  it("prints nothing outside a team's projects or for input that is not a hook payload", async () => {
    assert.deepEqual(await new CliHarness(ON_TEAM, null).run(HOOK, { stdin: call('AskUserQuestion'), env: ALPHA }), NOTHING);
    assert.deepEqual(await new CliHarness(ON_TEAM).run(HOOK, { stdin: 'not json', env: ALPHA }), NOTHING);
  });
});
