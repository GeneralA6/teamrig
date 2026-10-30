import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { readEvents } from '../register/snapshot.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const TOKEN = ['gh', 'p_', 'a1'.repeat(18)].join('');
const PASSWORD = ['s3', 'cret', 'Value9'].join('');
const INCIDENTS = join(TEAM_HOME, 'state', 'secret-incidents.jsonl');
const REVIEWED = { ...TEAM, roles: { lead: 'lead', securityReviewer: 'bravo' } };
const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const DAY_MS = 24 * 60 * 60 * 1000;

const TRANSCRIPT = join('/', 'projects', 'app', 'session.jsonl');

/** The payload's fields that name the call: its id and the session's transcript. */
const CALL: Readonly<Record<string, string>> = { tool_use_id: 'toolu_01', transcript_path: TRANSCRIPT };

/** A Bash call's PostToolUse payload from the harness's Claude Code session in the project folder, `call` naming it. */
function ran(stdout: string, call: Readonly<Record<string, string>> = CALL): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, ...call, tool_name: 'Bash', tool_input: { command: 'run it' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });
}

/** The incident line's fields that name the call `ran` made by default. */
const CALL_FIELDS = { toolUseId: 'toolu_01', transcript: TRANSCRIPT };

/** The line for the model, after checking the run redacted its result. */
function lineOf(result: CliResult): string {
  assert.equal(result.code, EXIT.ok);
  assert.ok(!(result.stdout[0] ?? '').includes(TOKEN), 'the result still holds the token');
  return contextOf(result);
}

const leakLine = (rotation: string, kinds: string = 'GitHub token'): string =>
  `teamrig: this result held a secret (${kinds}); it was redacted before you saw it. Treat it as leaked: ${rotation} Do not print it again.`;

/** The tasks a register's events created: id, owner, creator, priority and title. */
function createdIn(events: string | undefined): readonly (readonly [string, string, string, number, string])[] {
  return readEvents(events ?? '').events.flatMap((event) => (event.type === 'create' ? [[event.id, event.task.owner, event.by, event.task.priority, event.task.title] as const] : []));
}

/** The incident log's lines, parsed. */
function incidentsIn(text: string | undefined): readonly unknown[] {
  return (text ?? '').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
}

describe('teamrig hook secret-redact: rotation tasks', () => {
  it("files a task for the team's security reviewer, tells it, and names the task to the model", async () => {
    const kit = new CliHarness(REVIEWED);
    const result = await kit.run(['hook', 'secret-redact'], { stdin: ran(`token ${TOKEN}`), ...AS_ALPHA });
    assert.deepEqual(JSON.parse(result.stdout[0] ?? ''), {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { stdout: 'token [redacted GitHub token]', stderr: '', interrupted: false, isImage: false },
        additionalContext: leakLine('bravo rotates it in T1.'),
      },
    });
    assert.deepEqual(createdIn(kit.files.get(EVENTS_PATH)), [['T1', 'bravo', 'alpha', 1, 'Rotate the GitHub token a Bash result showed alpha on 2030-01-08']]);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), '- 2030-01-08 10:00 alpha: T1 is yours (p1): Rotate the GitHub token a Bash result showed alpha on 2030-01-08\n');
    assert.deepEqual(incidentsIn(kit.files.get(INCIDENTS)), [{ v: 3, at: '2030-01-08T10:00:00.000Z', session: 'alpha', tool: 'Bash', ...CALL_FIELDS, kind: 'GitHub token', task: 'T1' }]);
    for (const path of [EVENTS_PATH, INCIDENTS, teamInboxOf('app', 'bravo')]) {
      assert.ok(!(kit.files.get(path) ?? '').includes(TOKEN), `${path} holds the token`);
    }
  });

  it("names a URL credential's account in the task and the incident line, never the value, port, path or query", async () => {
    const kit = new CliHarness(REVIEWED);
    lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(`remote https://app:${PASSWORD}@git.Example.com:8443/o/r.git?ref=main`), ...AS_ALPHA }));
    const descriptions = readEvents(kit.files.get(EVENTS_PATH) ?? '').events.flatMap((event) => (event.type === 'create' ? [event.task.description ?? ''] : []));
    assert.equal(descriptions.length, 1);
    assert.match(descriptions[0] ?? '', /found a credentials in a URL \(login app at example\.com\) in a Bash result of session alpha/);
    assert.deepEqual(incidentsIn(kit.files.get(INCIDENTS)), [
      { v: 3, at: '2030-01-08T10:00:00.000Z', session: 'alpha', tool: 'Bash', ...CALL_FIELDS, kind: 'credentials in a URL', accounts: ['login app at example.com'], task: 'T1' },
    ]);
    for (const path of [EVENTS_PATH, INCIDENTS]) {
      assert.ok(!(kit.files.get(path) ?? '').includes(PASSWORD), `${path} holds the password`);
    }
  });

  it('files one task per kind, and gives a lead without a reviewer its own task without a line', async () => {
    const kit = new CliHarness();
    const line = lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(`${TOKEN} DB_PASSWORD=${PASSWORD}`), env: { TEAMRIG_SESSION: 'lead' } }));
    assert.equal(line, leakLine('lead rotates it in T1, T2.', 'GitHub token, value of a secret variable'));
    assert.deepEqual(createdIn(kit.files.get(EVENTS_PATH)).map(([id, owner]) => [id, owner]), [['T1', 'lead'], ['T2', 'lead']]);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
    assert.ok(!(kit.files.get(INCIDENTS) ?? '').includes(PASSWORD));
  });

  it("names the day's task again for the same kind and session, and files a new one the next day or for another session", async () => {
    const kit = new CliHarness(REVIEWED);
    const leak = (env: Record<string, string>): Promise<CliResult> => kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), env });
    assert.equal(lineOf(await leak({ TEAMRIG_SESSION: 'alpha' })), leakLine('bravo rotates it in T1.'));
    assert.equal(lineOf(await leak({ TEAMRIG_SESSION: 'alpha' })), leakLine('bravo rotates it in T1.'));
    assert.equal(lineOf(await leak({ TEAMRIG_SESSION: 'lead' })), leakLine('bravo rotates it in T2.'));
    kit.clock.advance(DAY_MS);
    assert.equal(lineOf(await leak({ TEAMRIG_SESSION: 'alpha' })), leakLine('bravo rotates it in T3.'));
    assert.deepEqual(createdIn(kit.files.get(EVENTS_PATH)).map(([id]) => id), ['T1', 'T2', 'T3']);
    assert.equal(incidentsIn(kit.files.get(INCIDENTS)).length, 4);
  });

  it("files a new task the same day once the day's task is closed, so a real leak is not folded into a false positive", async () => {
    const kit = new CliHarness(REVIEWED);
    const leak = (): Promise<CliResult> => kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), ...AS_ALPHA });
    assert.equal(lineOf(await leak()), leakLine('bravo rotates it in T1.'));
    assert.equal((await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'a false positive', '--session', 'bravo'])).code, EXIT.ok);
    assert.equal(lineOf(await leak()), leakLine('bravo rotates it in T2.'));
    assert.equal(lineOf(await leak()), leakLine('bravo rotates it in T2.'));
    assert.deepEqual(createdIn(kit.files.get(EVENTS_PATH)).map(([id]) => id), ['T1', 'T2']);
  });

  it('files a new task when the task the log names is in no register', async () => {
    const kit = new CliHarness(REVIEWED);
    await kit.files.write(INCIDENTS, `${JSON.stringify({ v: 1, at: '2030-01-08T09:00:00.000Z', session: 'alpha', tool: 'Bash', kind: 'GitHub token', task: 'T9' })}\n`);
    assert.equal(lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), ...AS_ALPHA })), leakLine('bravo rotates it in T1.'));
  });

  it("asks a reviewer in the team above for the task in that team's register, by its address", async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], roles: { lead: 'lead', securityReviewer: 'app/bravo' } }));
    const line = lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), env: { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'front' } }));
    assert.equal(line, leakLine('app/bravo rotates it in app/T1.'));
    assert.deepEqual(createdIn(kit.files.get(EVENTS_PATH)), [['T1', 'bravo', 'web/front', 1, 'Rotate the GitHub token a Bash result showed front on 2030-01-08']]);
    assert.match(kit.files.get(teamInboxOf('app', 'bravo')) ?? '', /web\/front: T1 is yours \(p1\)/);
    assert.deepEqual(incidentsIn(kit.files.get(join(teamHomeOf('web'), 'state', 'secret-incidents.jsonl'))).map((incident) => (incident instanceof Object && 'task' in incident ? incident.task : undefined)), ['app/T1']);
  });

  it("names the team above's task again while it is open there, and asks anew once it is closed", async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], roles: { lead: 'lead', securityReviewer: 'app/bravo' } }));
    const leak = async (): Promise<string> => lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), env: { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'front' } }));
    assert.equal(await leak(), leakLine('app/bravo rotates it in app/T1.'));
    assert.equal(await leak(), leakLine('app/bravo rotates it in app/T1.'));
    assert.equal((await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'a false positive'], { env: { TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'bravo' } })).code, EXIT.ok);
    assert.equal(await leak(), leakLine('app/bravo rotates it in app/T2.'));
  });

  it("redacts and asks the model to have the secret rotated when the tab's session is not known", async () => {
    const kit = new CliHarness(REVIEWED);
    const line = lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN) }));
    assert.equal(line, leakLine("ask bravo to rotate it with a register task (filing one failed: this tab's session is not known)."));
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
    assert.deepEqual(incidentsIn(kit.files.get(INCIDENTS)), [{ v: 3, at: '2030-01-08T10:00:00.000Z', tool: 'Bash', ...CALL_FIELDS, kind: 'GitHub token' }]);
  });

  it("names a helper's call by the helper's id, and a call its payload does not name by nothing", async () => {
    const kit = new CliHarness(REVIEWED);
    lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN, { ...CALL, agent_id: 'a1b2' }), ...AS_ALPHA }));
    lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN, {}), ...AS_ALPHA }));
    assert.deepEqual(incidentsIn(kit.files.get(INCIDENTS)), [
      { v: 3, at: '2030-01-08T10:00:00.000Z', session: 'alpha', tool: 'Bash', ...CALL_FIELDS, agent: 'a1b2', kind: 'GitHub token', task: 'T1' },
      { v: 3, at: '2030-01-08T10:00:00.000Z', session: 'alpha', tool: 'Bash', kind: 'GitHub token', task: 'T1' },
    ]);
  });

  it('redacts and says why when the register refuses the task or another tab holds the incident lock', async () => {
    const kit = new CliHarness(REVIEWED);
    const files = new FaultyFiles(kit.files).fail('append', EVENTS_PATH, systemError('EACCES', 'EACCES: permission denied'));
    const refused = lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), files, ...AS_ALPHA }));
    assert.match(refused, /Treat it as leaked: ask bravo to rotate it with a register task \(filing one failed: .*EACCES: permission denied.*\)\. Do not print it again\.$/);
    await kit.files.write(join(TEAM_HOME, 'state', 'secret-incidents.lock'), JSON.stringify({ pid: 9001, at: kit.clock.now() }));
    const busy = lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), ...AS_ALPHA }));
    assert.match(busy, /ask bravo to rotate it with a register task \(filing one failed: .+\)\./);
    assert.equal(createdIn(kit.files.get(EVENTS_PATH)).length, 0);
  });

  it("still names the task filed when its incident line cannot be written, and the day's next leak names the open copy", async () => {
    const kit = new CliHarness(REVIEWED);
    const files = new FaultyFiles(kit.files).fail('append', INCIDENTS, systemError('EACCES', 'EACCES: permission denied'));
    assert.equal(lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), files, ...AS_ALPHA })), leakLine('bravo rotates it in T1.'));
    assert.equal(kit.files.get(INCIDENTS), undefined);
    const again = lineOf(await kit.run(['hook', 'secret-redact'], { stdin: ran(TOKEN), ...AS_ALPHA }));
    assert.equal(again, leakLine('ask bravo to rotate it with a register task (filing one failed: T1 already tracks this (open, owner bravo)).'));
  });
});
