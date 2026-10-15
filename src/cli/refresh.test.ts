import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const STATE = (id: string): string => join(TEAM_HOME, 'state', 'refresh', `${id}.json`);
const HANDOVER = (id: string): string => join(TEAM_HOME, 'handover', `${id}.md`);
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'app', `${CLAUDE_SESSION}.jsonl`);
const SILENT: CliResult = { code: EXIT.ok, stdout: [], stderr: [] };

/** A transcript whose last main-thread reply read `tokens` tokens of context. */
function transcript(tokens: number): string {
  const reply = { type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 9 } } };
  return `${JSON.stringify({ type: 'user', isSidechain: false, message: { content: 'go' } })}\n${JSON.stringify(reply)}\n`;
}

/** The lines of a background command started by call `toolu_bg` at the harness's clock, and of its end. */
const BACKGROUND_START = [
  { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: {} }] } },
  {
    type: 'user',
    timestamp: '2030-01-08T09:30:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: b1' }] },
    toolUseResult: { stdout: '', backgroundTaskId: 'b1' },
  },
]
  .map((entry) => `${JSON.stringify(entry)}\n`)
  .join('');
const BACKGROUND_END = `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>' })}\n`;

function stopPayload(stopHookActive = false, extra: JsonRecord = {}): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, stop_hook_active: stopHookActive, ...extra });
}

function startPayload(source: string): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source });
}

/** The Stop hook's one JSON line. */
function stopJson(result: CliResult): unknown {
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.stdout.length, 1, result.stderr.join('\n'));
  return JSON.parse(result.stdout[0] ?? '');
}

/** Adds a task owned by `session` and marks it done, the boundary the Stop hook judges. */
async function finishTask(kit: CliHarness, session: string): Promise<CliResult> {
  const added = await kit.run(['add', '--title', 'Ship it', '--priority', 'p2', '--session', session]);
  assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
  const id = /^ADDED (T\d+) /.exec(added.stdout[0] ?? '')?.[1] ?? '';
  return kit.run(['set', id, '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--session', session]);
}

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };

describe('runCli: context refresh', () => {
  it('asks for the handover at a task boundary over the threshold, then points the cleared session at it', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    const done = await finishTask(kit, 'alpha');
    assert.equal(done.code, EXIT.ok);
    assert.match(done.stdout[0] ?? '', /^SET T1 done,/);
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"boundary","task":"T1"/);

    const asked = await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() });
    assert.deepEqual(stopJson(asked), {
      decision: 'block',
      reason:
        `teamrig: your context is 300k (refresh at 250k) and you just finished T1. Write your handover to ${HANDOVER('alpha')} ` +
        '(what is in progress, the next step of each, open questions, where things are), then run ' +
        '`teamrig refresh --ready --session alpha`. Do not start new work.',
    });
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true) }), SILENT, 'asked once, never again in the continued turn');

    const early = await kit.run(['refresh', '--ready', '--session', 'alpha']);
    assert.deepEqual([early.code, early.stdout], [EXIT.refused, [`REFUSED write your handover to ${HANDOVER('alpha')} first`]]);
    await kit.files.write(HANDOVER('alpha'), '# In progress\n- T2: tests left\n');
    const ready = await kit.run(['refresh', '--ready', '--session', 'alpha']);
    const readyLine = `Ready. Ask the user to type /clear; your next start reads ${HANDOVER('alpha')}.`;
    assert.deepEqual(ready, { code: EXIT.ok, stdout: [readyLine], stderr: [] });
    assert.deepEqual((await kit.run(['refresh', '--ready'], AS_ALPHA)).stdout, [readyLine], 'the same answer again');

    assert.deepEqual(stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true) })), {
      systemMessage: 'teamrig: app-alpha finished T1 and wrote its handover; type /clear for a fresh start',
      terminalSequence: '\u001b]0;app-alpha: type /clear\u0007',
    });
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT, 'the notice shows once');

    const note = `You were refreshed after T1; read your handover first: ${HANDOVER('alpha')}`;
    for (const source of ['compact', 'resume']) {
      assert.ok(!contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload(source) })).includes(note), source);
    }
    assert.ok(contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('clear') })).includes(note));
    assert.ok(!contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('startup') })).includes(note), 'once');
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"refreshed"/);
  });

  it('waits for background work the session started before asking for the handover and before the notice', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, `${BACKGROUND_START}${transcript(300_000)}`);
    await finishTask(kit, 'alpha');
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT, 'a refresh would cut the command off');
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"boundary","task":"T1"/, 'left for a later stop');

    await kit.files.write(TRANSCRIPT, `${BACKGROUND_START}${BACKGROUND_END}${transcript(300_000)}`);
    const asked = stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }));
    assert.match(JSON.stringify(asked), /"decision":"block".*you just finished T1/);

    await kit.files.write(HANDOVER('alpha'), '# In progress\n');
    await kit.files.write(TRANSCRIPT, `${BACKGROUND_START}${BACKGROUND_END}${BACKGROUND_START.replaceAll('toolu_bg', 'toolu_bg2')}${transcript(300_000)}`);
    assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true) }), SILENT, 'no /clear notice over running work');
    await kit.files.write(TRANSCRIPT, `${BACKGROUND_START}${BACKGROUND_END}${BACKGROUND_START.replaceAll('toolu_bg', 'toolu_bg2')}${BACKGROUND_END.replace('toolu_bg', 'toolu_bg2')}`);
    assert.match(JSON.stringify(stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }))), /wrote its handover; type \/clear/);
  });

  it('records a boundary under the threshold and says nothing, and refuses --ready when nothing was asked', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(120_000));
    await finishTask(kit, 'alpha');
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT);
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"idle","task":"T1",.*"tokens":120000/);
    const ready = await kit.run(['refresh', '--ready', '--session', 'alpha']);
    assert.equal(ready.code, EXIT.refused);
    assert.match(ready.stdout[0] ?? '', /^REFUSED no refresh was asked of you/);
  });

  it('refuses a handover that was already there when the Stop hook asked', async () => {
    const kit = new CliHarness({ ...TEAM, refresh: { tabTitle: false } });
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    await kit.files.write(HANDOVER('alpha'), '# the last refresh\n');
    await finishTask(kit, 'alpha');
    stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }));
    const stale = await kit.run(['refresh', '--ready', '--session', 'alpha']);
    assert.equal(stale.code, EXIT.refused);
    assert.match(stale.stdout[0] ?? '', /is the handover from before/);
    await kit.files.write(HANDOVER('alpha'), '# this refresh\n');
    assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    assert.deepEqual(stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true) })), {
      systemMessage: 'teamrig: app-alpha finished T1 and wrote its handover; type /clear for a fresh start',
    });
  });

  it("lets only the lead ask for a refresh, which applies at the session's next boundary whatever its size", async () => {
    const kit = new CliHarness({ ...TEAM, refresh: { handoverDir: 'notes' } });
    const refused = await kit.run(['refresh', 'bravo', '--session', 'alpha']);
    assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, ['REFUSED only the lead (app-lead) asks for a refresh']]);
    assert.equal((await kit.run(['refresh', 'zulu', '--session', 'lead'])).code, EXIT.refused);

    const requested = await kit.run(['refresh', 'app-bravo', '--session', 'lead']);
    const handover = join(TEAM_HOME, 'notes', 'bravo.md');
    assert.deepEqual(requested.stdout, [
      `REQUESTED a refresh of app-bravo: after its next \`set done\` it writes its handover to ${handover}; then type /clear in its tab`,
    ]);
    await finishTask(kit, 'bravo');
    const asked = stopJson(await kit.run(['hook', 'stop'], { env: { TEAMRIG_SESSION: 'bravo' }, stdin: stopPayload(false, { transcript_path: join(USER_HOME, 'gone.jsonl') }) }));
    assert.ok(typeof asked === 'object' && asked !== null && 'reason' in asked);
    assert.match(String(asked.reason), new RegExp(`^teamrig: app-lead asked for a refresh and you just finished T1\\. Write your handover to ${handover.replaceAll('\\', '\\\\')} `));
  });

  it('refuses a refresh line it cannot read, and everything with refresh off', async () => {
    const kit = new CliHarness();
    assert.equal((await kit.run(['refresh', '--session', 'lead'])).code, EXIT.usage);
    assert.equal((await kit.run(['refresh', '--ready', 'alpha', '--session', 'alpha'])).code, EXIT.usage);

    const off = new CliHarness({ ...TEAM, refresh: { enabled: false } });
    await off.files.write(TRANSCRIPT, transcript(900_000));
    assert.equal((await finishTask(off, 'alpha')).code, EXIT.ok);
    assert.equal(await off.files.read(STATE('alpha')), undefined, 'no boundary');
    assert.deepEqual(await off.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT);
    for (const argv of [['refresh', '--ready'], ['refresh', 'bravo']]) {
      const result = await off.run([...argv, '--session', argv[1] === 'bravo' ? 'lead' : 'alpha']);
      assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED context refresh is off for this team (refresh.enabled in the team config)']]);
    }
  });

  it('keeps the task done with a warning when its boundary cannot be recorded', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship it', '--priority', 'p2', '--session', 'alpha']);
    const files = new FaultyFiles(kit.files).fail('write', STATE('alpha'), systemError('EACCES'));
    const done = await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--session', 'alpha'], { files });
    assert.equal(done.code, EXIT.ok);
    assert.match(done.stdout[0] ?? '', /^SET T1 done,/);
    assert.deepEqual(done.stderr, ['WARN T1 is done, but its refresh check was not recorded: EACCES: simulated']);
  });

  it('keeps the Stop hook silent outside a team, without a config or a session, and on any error', async () => {
    assert.deepEqual(await new CliHarness(TEAM, null).run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT);
    assert.deepEqual(await new CliHarness(TEAM, '{"team": 7}').run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT);
    assert.deepEqual(await new CliHarness(null).run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT);

    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    await finishTask(kit, 'alpha');
    assert.deepEqual(await kit.run(['hook', 'stop'], { stdin: stopPayload() }), SILENT, 'no session named and no inbox read');
    assert.deepEqual(await kit.run(['hook', 'stop'], { env: { TEAMRIG_SESSION: 'zulu' }, stdin: stopPayload() }), SILENT);
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: 'not json' }), SILENT);
    const files = new FaultyFiles(kit.files).fail('write', STATE('alpha'), systemError('EACCES'));
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(), files }), SILENT, 'no block that is not recorded');
    stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }));
  });

  it('finds the session from the inbox it last read when no session is named', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    await finishTask(kit, 'alpha');
    stopJson(await kit.run(['hook', 'stop'], { stdin: stopPayload() }));
  });

  it('tells a starting session when its refresh state cannot be read, and still loads its rules', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('read', STATE('alpha'), systemError('EACCES'));
    const text = contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('clear'), files }));
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.ok(text.includes('teamrig could not check for a refresh handover (EACCES: simulated); if you wrote one before a /clear, read it first.'));
  });
});
