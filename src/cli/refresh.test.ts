import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import type { RestartRequest } from '../refresh/state.ts';
import { RefreshStore } from '../refresh/store.ts';
import { CONTEXT_MAX_CHARS } from '../rules/pack.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { APP, AUTO_RESTART_TEAM, CLAUDE_SESSION, CliHarness, contextOf, EVENTS_PATH, LONG_RULES_TEAM, rulesToOverflow, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
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
  const added = await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--session', session]);
  assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
  const id = /^ADDED (T\d+) /.exec(added.stdout[0] ?? '')?.[1] ?? '';
  return kit.run(['set', id, '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', session]);
}

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };

/** Alpha's handover written after the Stop hook asked for it, so the next stop announces the fresh start. */
async function handoverWritten(kit: CliHarness): Promise<RefreshStore> {
  await kit.files.write(TRANSCRIPT, transcript(300_000));
  await finishTask(kit, 'alpha');
  stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }));
  await kit.files.write(HANDOVER('alpha'), '# In progress\n');
  assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
  return new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
}

/** The hook (pid 7000) run through a shell by Claude Code (6900). */
const UNDER_CLAUDE = (): FakeSessionProcesses =>
  new FakeSessionProcesses(7000)
    .add({ pid: 7000, parentPid: 6900, name: 'bash.exe', commandLine: 'bash -c "node main.js hook stop"' })
    .add({ pid: 6900, parentPid: 1, name: 'claude.exe', commandLine: 'claude' });

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
        `teamrig: your context is 300k (refresh at 120k) and you just finished T1. Write your handover to ${HANDOVER('alpha')}, replacing the whole file (your fresh start reads all of it): what the register lacks ` +
        '(the next step of each task in progress; what to check later, and when; questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), ' +
        'not task statuses, which your fresh start reads live from the register. Then run `teamrig refresh --ready --session alpha`. Do not start new work.',
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
      terminalSequence: '\u001b]0;[app] alpha: type /clear\u0007',
    });
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT, 'the notice shows once');

    const note =
      `You were refreshed after T1; read your handover first: ${HANDOVER('alpha')}. Then carry on with its next steps. ` +
      'Read a file with the Read tool before you Edit or Write it: a read by cat or sed, or one before the refresh, does not count.';
    const cron = { cron: '3 13 * * *', prompt: 'budget check', recurring: true };
    await kit.files.append(
      TRANSCRIPT,
      `${JSON.stringify({ type: 'assistant', timestamp: '2030-01-08T09:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_cron', name: 'CronCreate', input: cron }] } })}\n` +
        `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_cron', content: 'ok' }] }, toolUseResult: { id: 'c1', humanSchedule: cron.cron, recurring: true } })}\n`,
    );
    for (const source of ['compact', 'resume']) {
      assert.ok(!contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload(source) })).includes(note), source);
    }
    const fresh = contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('clear') }));
    assert.ok(fresh.includes(note));
    assert.ok(fresh.includes("Your old session's 1 scheduled job(s) are still scheduled, since a /clear keeps the process"), 'a /clear keeps the job');
    assert.ok(!fresh.includes('- cron "3 13 * * *"'), 'so it is not listed to make again');
    assert.ok(!contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('startup') })).includes(note), 'once');
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"refreshed"/);
  });

  it('still names the jobs a /clear kept at the next refresh, and lists them to make again once a new process ends them', async () => {
    const kit = new CliHarness();
    const second = join(USER_HOME, '.claude', 'projects', 'app', 'second.jsonl');
    const third = join(USER_HOME, '.claude', 'projects', 'app', 'third.jsonl');
    const cleared = (fresh: string): string => JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'clear', transcript_path: fresh });
    const carried = join(TEAM_HOME, 'state', 'refresh', 'alpha.carried.json');
    const kept = "Your old session's 1 scheduled job(s) are still scheduled, since a /clear keeps the process";
    const remake = '- cron "3 13 * * *"';
    /** The next refresh asked and its handover written, from the session whose transcript is `path`. */
    const refreshFrom = async (path: string, handover: string): Promise<void> => {
      await kit.files.write(path, transcript(300_000));
      await finishTask(kit, 'alpha');
      stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(false, { transcript_path: path }) }));
      await kit.files.write(HANDOVER('alpha'), handover);
      assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
      stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true, { transcript_path: path }) }));
    };

    await refreshFrom(TRANSCRIPT, '# first\n');
    const cron = { cron: '3 13 * * *', prompt: 'budget check', recurring: true };
    await kit.files.append(
      TRANSCRIPT,
      `${JSON.stringify({ type: 'assistant', timestamp: '2030-01-08T09:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_cron', name: 'CronCreate', input: cron }] } })}\n` +
        `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_cron', content: 'ok' }] }, toolUseResult: { id: 'c1', humanSchedule: cron.cron, recurring: true } })}\n`,
    );
    assert.ok(contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: cleared(second) })).includes(kept), 'the first /clear keeps the job');
    assert.match((await kit.files.read(carried)) ?? '', /"transcript":".*second\.jsonl"/);

    await refreshFrom(second, '# second\n');
    const again = contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: cleared(third) }));
    assert.ok(again.includes(kept), 'the second /clear still names the job its transcript never mentions');
    assert.ok(!again.includes(remake));

    await refreshFrom(third, '# third\n');
    const restarted = contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('startup') }));
    assert.ok(restarted.includes(remake), 'a new process lost it, so it is listed to make again');
    assert.equal(await kit.files.read(carried), undefined, 'and nothing is left live to record');
  });

  it('moves the record on at a /clear the refresh did not ask for, and ends it at a new process', async () => {
    const kit = new CliHarness();
    const store = await handoverWritten(kit);
    const second = join(USER_HOME, '.claude', 'projects', 'app', 'second.jsonl');
    const third = join(USER_HOME, '.claude', 'projects', 'app', 'third.jsonl');
    const job = { id: 'c1', cron: '3 13 * * *', prompt: 'budget check', recurring: true, createdAt: Date.parse('2030-01-08T09:00:00.000Z') };
    const start = (source: string, fresh: string): string => JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source, transcript_path: fresh });
    await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: start('clear', second) });
    await store.setCarried('alpha', { transcript: second, crons: [job] });
    await kit.files.write(second, transcript(1_000));

    await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: start('clear', third) });
    assert.deepEqual(await store.carried('alpha'), { transcript: third, crons: [job] }, 'a plain /clear moves it on');
    await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: start('compact', third) });
    assert.deepEqual(await store.carried('alpha'), { transcript: third, crons: [job] }, 'a compaction keeps it');
    await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: start('startup', third) });
    assert.equal(await store.carried('alpha'), undefined, 'a new process ends it');
  });

  it('keeps the identity of a tab whose title names no session across the refresh /clear, by its Claude Code process', async () => {
    const kit = new CliHarness();
    const start = (session: string, title: string): string => JSON.stringify({ session_id: session, cwd: APP, source: 'clear', session_title: title });
    assert.match(contextOf(await kit.run(['hook', 'session-start'], { stdin: start(CLAUDE_SESSION, 'alpha') })), /bound to the `alpha` session from its Claude Code title/);
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    await finishTask(kit, 'alpha');
    stopJson(await kit.run(['hook', 'stop'], { stdin: stopPayload() }));
    await kit.files.write(HANDOVER('alpha'), '# In progress\n');
    assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    stopJson(await kit.run(['hook', 'stop'], { stdin: stopPayload(true), sessionProcesses: UNDER_CLAUDE() }));
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"noticed":true,.*"claudePid":6900/);

    const cleared = '9f8e7d6c-1111-2222-3333-444455556666';
    const elsewhere = new FakeSessionProcesses(7000).add({ pid: 7000, parentPid: 6800, name: 'bash.exe', commandLine: 'bash' }).add({ pid: 6800, parentPid: 1, name: 'claude.exe', commandLine: 'claude' });
    const other = contextOf(await kit.run(['hook', 'session-start'], { stdin: start(cleared, 'release checks'), sessionProcesses: elsewhere }));
    assert.ok(!other.includes('alpha'), 'another Claude Code process binds nothing');
    const fresh = contextOf(await kit.run(['hook', 'session-start'], { stdin: start(cleared, 'release checks'), sessionProcesses: UNDER_CLAUDE() }));
    assert.match(fresh, /This tab was bound to the `alpha` session: \/clear kept the Claude Code process/);
    assert.ok(fresh.includes(`You were refreshed after T1; read your handover first: ${HANDOVER('alpha')}`), fresh);
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

  it('arms the automatic restart once the handover is written, for the Claude Code the hook runs under', async () => {
    const kit = new CliHarness(AUTO_RESTART_TEAM);
    const store = await handoverWritten(kit);
    const processes = new FakeProcesses();
    const env = { TEAMRIG_SESSION: 'alpha', CLAUDE_PROJECT_DIR: APP, TEAMRIG_LAUNCHED: 'alpha' };
    const underClaude = UNDER_CLAUDE();
    assert.deepEqual(stopJson(await kit.run(['hook', 'stop'], { env, stdin: stopPayload(true), sessionProcesses: underClaude, processes })), {
      systemMessage: 'teamrig: app-alpha finished T1 and wrote its handover; teamrig starts it fresh once it has been idle 15 s (type anything to keep this context)',
      terminalSequence: '\u001b]0;[app] alpha: restarting\u0007',
    });
    const request = await store.restart('alpha');
    assert.ok(request);
    assert.deepEqual(request, { phase: 'pending', at: request.at, pid: 6900, claudeSession: CLAUDE_SESSION, transcript: TRANSCRIPT, cwd: APP, supervised: true });
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"claudePid":6900/);
    // Each look starts a PowerShell on Windows: a slow hook is killed at Claude Code's timeout.
    assert.deepEqual([underClaude.described, underClaude.lineages], [[], [7000]], 'the Claude Code process looked up once');
    const waiters = processes.hidden.filter((run) => run.args[1] === 'restart');
    assert.deepEqual(
      waiters.map((run) => [run.command, run.cwd, ...run.args]),
      [['/usr/bin/node', APP, '/opt/teamrig/dist/cli/main.js', 'restart', 'alpha', '--team', 'app', '--at', request.at, '--project', APP]],
    );
    assert.deepEqual(await kit.run(['hook', 'stop'], { env, stdin: stopPayload(), sessionProcesses: UNDER_CLAUDE(), processes }), SILENT, 'announced once');
    assert.equal(processes.hidden.filter((run) => run.args[1] === 'restart').length, 1);
  });

  it('asks for /clear instead, leaving nothing armed, when the restart cannot start or is off (the default)', async () => {
    const missing = new CliHarness(AUTO_RESTART_TEAM);
    const store = await handoverWritten(missing);
    const processes = new FakeProcesses().onStart('/usr/bin/node', { kind: 'missing' });
    const clear = {
      systemMessage: 'teamrig: app-alpha finished T1 and wrote its handover; type /clear for a fresh start',
      terminalSequence: '\u001b]0;[app] alpha: type /clear\u0007',
    };
    assert.deepEqual(stopJson(await missing.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true), sessionProcesses: UNDER_CLAUDE(), processes })), clear);
    assert.equal(await store.restart('alpha'), undefined);

    const off = new CliHarness();
    const offStore = await handoverWritten(off);
    const none = new FakeProcesses();
    assert.deepEqual(stopJson(await off.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true), sessionProcesses: UNDER_CLAUDE(), processes: none })), clear);
    assert.deepEqual([await offStore.restart('alpha'), none.hidden.filter((run) => run.args[1] === 'restart')], [undefined, []]);
  });

  it('cancels the armed restart when the user types, keeping the context until a later task end or more growth', async () => {
    const kit = new CliHarness(AUTO_RESTART_TEAM);
    const store = await handoverWritten(kit);
    const env = { TEAMRIG_SESSION: 'alpha', CLAUDE_PROJECT_DIR: APP };
    stopJson(await kit.run(['hook', 'stop'], { env, stdin: stopPayload(true), sessionProcesses: UNDER_CLAUDE(), processes: new FakeProcesses() }));
    assert.equal((await store.restart('alpha'))?.phase, 'pending');
    const typed = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, prompt: 'one more thing', session_title: 'app-alpha' });
    const cancelled = await kit.run(['hook', 'inbox-reminder'], { env, stdin: typed });
    assert.ok(
      cancelled.stdout.includes('teamrig: the user typed, so the automatic restart is cancelled and you keep this context; a new handover is asked at your next task end, or once your context grew 24k more'),
      cancelled.stdout.join('\n'),
    );
    assert.equal(await store.restart('alpha'), undefined);
    assert.ok(!(await kit.run(['hook', 'inbox-reminder'], { env, stdin: typed })).stdout.some((line) => line.includes('restart')), 'said once');
    assert.deepEqual(await kit.run(['hook', 'stop'], { env, stdin: stopPayload(), sessionProcesses: UNDER_CLAUDE() }), SILENT, 'not announced again');

    await finishTask(kit, 'alpha');
    assert.match(JSON.stringify(stopJson(await kit.run(['hook', 'stop'], { env, stdin: stopPayload() }))), /"decision":"block".*you just finished T2/);
  });

  it('leaves a restart that is already ending the session alone', async () => {
    const kit = new CliHarness();
    const store = await handoverWritten(kit);
    const request: RestartRequest = { phase: 'ending', at: '2030-01-08T10:00:00.000Z', pid: 6900, claudeSession: CLAUDE_SESSION, transcript: TRANSCRIPT, cwd: APP, supervised: true };
    await store.setRestart('alpha', request);
    const result = await kit.run(['hook', 'inbox-reminder'], { ...AS_ALPHA, stdin: JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, prompt: 'hi' }) });
    assert.ok(!result.stdout.some((line) => line.includes('restart')));
    assert.deepEqual(await store.restart('alpha'), request);
  });

  it('says to type /clear by default, the automatic restart being off', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    await finishTask(kit, 'alpha');
    stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }));
    await kit.files.write(HANDOVER('alpha'), '# In progress\n');
    assert.deepEqual((await kit.run(['refresh', '--ready', '--session', 'alpha'])).stdout, [`Ready. Ask the user to type /clear; your next start reads ${HANDOVER('alpha')}.`]);
    assert.match((await kit.run(['refresh', 'bravo', '--session', 'lead'])).stdout.join('\n'), /; then type \/clear in its tab$/);
  });

  it('asks for the handover at any turn end over the threshold, mid-task, and again only once the context grew', async () => {
    const kit = new CliHarness({ ...TEAM, refresh: { tabTitle: false } });
    const stop = async (tokens: number): Promise<CliResult> => {
      await kit.files.write(TRANSCRIPT, transcript(tokens));
      return kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() });
    };
    assert.deepEqual(await stop(100_000), SILENT, 'under the threshold');
    assert.match(
      JSON.stringify(stopJson(await stop(130_000))),
      /"decision":"block","reason":"teamrig: your context is 130k \(refresh at 120k\), so refresh now rather than at a task end\. Write your handover/,
    );
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"asked","task":null,.*"tokens":130000/);
    assert.deepEqual(await stop(153_999), SILENT, 'not at every turn end the session goes on');
    assert.equal(stopJson(await stop(154_000)) !== null, true, 'asked again 24k later');
    assert.equal((await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('compact') })).code, EXIT.ok);
    assert.match(JSON.stringify(stopJson(await stop(125_000))), /"decision":"block"/, 'a compaction brings the ask back to the threshold');

    await kit.files.write(HANDOVER('alpha'), '# In progress\n');
    assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    assert.deepEqual(stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload(true) })), {
      systemMessage: 'teamrig: app-alpha wrote its handover; type /clear for a fresh start',
    });
    const fresh = contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('clear') }));
    assert.ok(fresh.includes(`You were refreshed mid-task; read your handover first: ${HANDOVER('alpha')}. Then carry on with its next steps.`), fresh);
  });

  it("holds the lead's refresh while the owner's meeting is open, up to the room ceiling, and asks at the turn end after meeting end", async () => {
    const meetingKit = async (): Promise<{ readonly kit: CliHarness; readonly stop: (tokens: number) => Promise<CliResult> }> => {
      const kit = new CliHarness({ ...TEAM, roles: { lead: 'alpha' }, refresh: { tabTitle: false } });
      assert.equal((await kit.run(['meeting', 'start', '--session', 'alpha'])).code, EXIT.ok);
      const stop = async (tokens: number): Promise<CliResult> => {
        await kit.files.write(TRANSCRIPT, transcript(tokens));
        return kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() });
      };
      return { kit, stop };
    };
    const { kit, stop } = await meetingKit();
    const mid = await kit.run(['hook', 'refresh-mid'], { ...AS_ALPHA, stdin: JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, tokens: 150_000 }) });
    assert.deepEqual(stopJson(mid), { kind: 'wait', nextAt: 120_000 }, 'no ask at a tool result; the mod looks again later');
    assert.deepEqual(await stop(150_000), SILENT, 'no ask at the turn end');
    assert.equal(await kit.files.read(STATE('alpha')), undefined);
    assert.equal((await kit.run(['meeting', 'end', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(JSON.stringify(stopJson(await stop(150_000))), /"decision":"block","reason":"teamrig: your context is 150k \(refresh at 120k\)/, 'asked at once after it');

    const ceiling = await meetingKit();
    assert.match(JSON.stringify(stopJson(await ceiling.stop(185_000))), /"decision":"block","reason":"teamrig: your context is 185k/, 'at the ceiling it goes on');
  });

  it('holds the notice of a handover written in the meeting, and so its restart, until the meeting ends', async () => {
    const kit = new CliHarness({ ...AUTO_RESTART_TEAM, roles: { lead: 'alpha' } });
    const store = await handoverWritten(kit);
    const processes = new FakeProcesses();
    const env = { TEAMRIG_SESSION: 'alpha', CLAUDE_PROJECT_DIR: APP, TEAMRIG_LAUNCHED: 'alpha' };
    const stop = (): Promise<CliResult> => kit.run(['hook', 'stop'], { env, stdin: stopPayload(true), sessionProcesses: UNDER_CLAUDE(), processes });
    assert.equal((await kit.run(['meeting', 'start', '--session', 'alpha'])).code, EXIT.ok);
    await kit.files.write(TRANSCRIPT, transcript(150_000));
    assert.deepEqual(await stop(), SILENT);
    assert.deepEqual([await store.restart('alpha'), processes.hidden.length], [undefined, 0], 'nothing armed');

    assert.equal((await kit.run(['meeting', 'end', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(JSON.stringify(stopJson(await stop())), /starts it fresh once it has been idle 15 s/);
    assert.equal((await store.restart('alpha'))?.phase, 'pending');
  });

  it('records a boundary under the threshold and says nothing, and refuses --ready when nothing was asked', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(100_000));
    await finishTask(kit, 'alpha');
    assert.deepEqual(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }), SILENT);
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"idle","task":"T1",.*"tokens":100000,"finished":1/);
    const ready = await kit.run(['refresh', '--ready', '--session', 'alpha']);
    assert.equal(ready.code, EXIT.refused);
    assert.match(ready.stdout[0] ?? '', /^REFUSED no refresh was asked of you/);
  });

  it('asks after the third task at a context worth refreshing, and counts again after a compaction', async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript(90_000));
    const finishAndStop = async (): Promise<CliResult> => {
      await finishTask(kit, 'alpha');
      return kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() });
    };
    assert.deepEqual(await finishAndStop(), SILENT);
    assert.deepEqual(await finishAndStop(), SILENT);
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"idle","task":"T2",.*"finished":2/);
    assert.equal((await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload('compact') })).code, EXIT.ok);
    assert.match((await kit.files.read(STATE('alpha'))) ?? '', /"phase":"idle","task":"T2",.*"finished":0/);
    assert.deepEqual(await finishAndStop(), SILENT);
    assert.deepEqual(await finishAndStop(), SILENT);
    const asked = stopJson(await finishAndStop());
    assert.match(JSON.stringify(asked), /"decision":"block","reason":"teamrig: your context is 90k after 3 tasks \(refresh every 3 tasks\) and you just finished T5\./);
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

  it('refuses a handover over refresh.handoverMaxBytes until it is rewritten short', async () => {
    const kit = new CliHarness({ ...TEAM, refresh: { tabTitle: false, handoverMaxBytes: 100 } });
    await kit.files.write(TRANSCRIPT, transcript(300_000));
    await finishTask(kit, 'alpha');
    stopJson(await kit.run(['hook', 'stop'], { ...AS_ALPHA, stdin: stopPayload() }));
    await kit.files.write(HANDOVER('alpha'), `# every section so far\n${'- a step\n'.repeat(20)}`);
    const long = await kit.run(['refresh', '--ready', '--session', 'alpha']);
    assert.deepEqual([long.code, long.stdout], [
      EXIT.refused,
      [
        `REFUSED ${HANDOVER('alpha')} is 203 bytes, over refresh.handoverMaxBytes (100): your fresh start reads all of it. ` +
          'Rewrite it whole, short, with only what your next session needs',
      ],
    ]);
    await kit.files.write(HANDOVER('alpha'), '# this refresh\n');
    assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
  });

  it("lets only the lead ask for a refresh, which applies at the session's next turn end whatever its size", async () => {
    const kit = new CliHarness({ ...TEAM, refresh: { handoverDir: 'notes' } });
    const refused = await kit.run(['refresh', 'bravo', '--session', 'alpha']);
    assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, ['REFUSED only the lead (app-lead) asks for a refresh']]);
    assert.equal((await kit.run(['refresh', 'zulu', '--session', 'lead'])).code, EXIT.refused);

    const requested = await kit.run(['refresh', 'app-bravo', '--session', 'lead']);
    const handover = join(TEAM_HOME, 'notes', 'bravo.md');
    assert.deepEqual(requested.stdout, [
      `REQUESTED a refresh of app-bravo: at its next turn end it writes its handover to ${handover}; then type /clear in its tab`,
    ]);
    await finishTask(kit, 'bravo');
    const asked = stopJson(await kit.run(['hook', 'stop'], { env: { TEAMRIG_SESSION: 'bravo' }, stdin: stopPayload(false, { transcript_path: join(USER_HOME, 'gone.jsonl') }) }));
    assert.ok(typeof asked === 'object' && asked !== null && 'reason' in asked);
    assert.match(String(asked.reason), new RegExp(`^teamrig: app-lead asked for a refresh and you just finished T1\\. Write your handover to ${handover.replaceAll('\\', '\\\\')}, replacing the whole file \\(your fresh start reads all of it\\): what the register lacks `));

    assert.equal((await kit.run(['refresh', 'app-alpha', '--session', 'lead'])).code, EXIT.ok);
    const midTask = stopJson(await kit.run(['hook', 'stop'], { env: { TEAMRIG_SESSION: 'alpha' }, stdin: stopPayload(false, { transcript_path: join(USER_HOME, 'gone.jsonl') }) }));
    assert.match(JSON.stringify(midTask), /"reason":"teamrig: app-lead asked for a refresh, so refresh now rather than at a task end\. /, 'with no task finished');
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
    await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    const files = new FaultyFiles(kit.files).fail('write', STATE('alpha'), systemError('EACCES'));
    const done = await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'alpha'], { files });
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

describe('runCli: live tasks in the start note', () => {
  const LIVE =
    'LIVE TASKS of alpha, read from the register at this start (2 active; where your handover or a compaction summary says otherwise, the register wins):\n' +
    '  T2 in-progress, p2, due 01-10 (from T4) | Write the docs\n' +
    '  T3 waiting, p2 | Ship the docs (waiting: on T2)\n' +
    'WAITING ON YOU 1 task(s) of other sessions:\n' +
    '  T4 open, p2, owner bravo, due 01-10, after T2 | Not mine · needs your T2';

  /** Alpha holds T1 done, T2 in progress and T3 waiting on it; bravo holds T4, due 01-10 and planned after T2. */
  async function addTasks(kit: CliHarness): Promise<void> {
    const steps = [
      ['add', '--title', 'Write the docs', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha'],
      ['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha'],
      ['add', '--title', 'Not mine', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-10', '--after', 'T2', '--session', 'bravo'],
      ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'],
      ['set', 'T3', '--status', 'in-progress', '--session', 'alpha'],
      ['set', 'T3', '--status', 'waiting', '--waits', 'task:T2', '--note', 'needs the docs', '--session', 'alpha'],
    ];
    for (const step of steps) {
      const result = await kit.run(step);
      assert.equal(result.code, EXIT.ok, [...step, ...result.stdout].join(' '));
    }
  }

  const start = async (kit: CliHarness, source: string, files?: FaultyFiles): Promise<string> =>
    contextOf(await kit.run(['hook', 'session-start'], { ...AS_ALPHA, stdin: startPayload(source), ...(files === undefined ? {} : { files }) }));

  it('lists them after a compaction and at the refresh fresh start, right after the handover pointer', async () => {
    const kit = new CliHarness();
    await handoverWritten(kit);
    await addTasks(kit);
    assert.ok((await start(kit, 'compact')).endsWith(`\n${LIVE}`), 'after a compaction, the handover still waiting');
    assert.ok(!(await start(kit, 'resume')).includes('LIVE TASKS'), 'a resume keeps its context');

    const fresh = await start(kit, 'clear');
    const note =
      `You were refreshed after T1; read your handover first: ${HANDOVER('alpha')}. Then carry on with its next steps. ` +
      'Read a file with the Read tool before you Edit or Write it: a read by cat or sed, or one before the refresh, does not count.';
    assert.ok(fresh.includes(`${note}\n${LIVE}`), fresh);
    assert.ok(!(await start(kit, 'startup')).includes('LIVE TASKS'), 'once: a later start is no refresh');
    assert.ok((await start(kit, 'compact')).endsWith(`\n${LIVE}`), 'every compaction');
  });

  it('shows none at a start that is no refresh, and says none are active when the session holds none', async () => {
    const kit = new CliHarness();
    await finishTask(kit, 'alpha');
    await addTasks(kit);
    for (const source of ['startup', 'clear', 'resume']) {
      assert.ok(!(await start(kit, source)).includes('LIVE TASKS'), source);
    }
    const lead = contextOf(await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'lead' }, stdin: startPayload('compact') }));
    assert.ok(lead.endsWith('LIVE TASKS of lead, read from the register at this start: none active; where your handover or a compaction summary says otherwise, the register wins.'), lead);
  });

  it('gives them as a pointer when they and a team rules file would overflow the context cap (T1376)', async () => {
    const kit = new CliHarness(LONG_RULES_TEAM);
    for (const title of ['Write the docs of the long start note', 'Ship the docs of the long start note', 'Plan the week around the release', 'Review the plan of the long start note', 'Merge the fix of the long start note', 'Prove the fix of the long start note']) {
      const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', 'lead']);
      assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    }
    const asLead = { env: { TEAMRIG_SESSION: 'lead' }, stdin: startPayload('compact') };
    const roomy = contextOf(await kit.run(['hook', 'session-start'], asLead));
    assert.ok(roomy.includes('\nLIVE TASKS of lead, read from the register at this start (6 active;'), roomy);
    const rules = rulesToOverflow(roomy);

    await kit.files.write(join(TEAM_HOME, 'rules.md'), rules);
    const cut = contextOf(await kit.run(['hook', 'session-start'], asLead));
    assert.ok(cut.length <= CONTEXT_MAX_CHARS, String(cut.length));
    assert.ok(cut.endsWith(`# Your team's rules\n${rules}`));
    assert.ok(cut.includes('\nLIVE TASKS of lead: this start has no room for them; run `teamrig start --session lead` first,'), cut.slice(0, -rules.length).slice(-600));
  });

  it('names the command that lists the tasks when the register cannot be read', async () => {
    const kit = new CliHarness();
    await finishTask(kit, 'alpha');
    await addTasks(kit);
    const files = new FaultyFiles(kit.files).fail('read', EVENTS_PATH, systemError('EACCES'));
    const text = await start(kit, 'compact', files);
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.ok(text.endsWith('LIVE TASKS: teamrig could not read the register (EACCES: simulated); run `teamrig list --session alpha` for your tasks.'), text);
  });
});
