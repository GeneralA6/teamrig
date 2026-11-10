import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { TAB_CIRCLES } from '../tabs/status.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, transcript } from '../testing/transcript-lines.ts';
import { titleLeftToHooks } from './commands/hook-tab-status.ts';
import { EXIT } from './runtime.ts';

const AT = '2030-01-08T09:50:00.000Z';
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const HANDOVER = join(TEAM_HOME, 'handover', 'alpha.md');
const ON_TEAM: JsonRecord = { ...TEAM, tabStatus: { enabled: true } };
const TITLE_OFF = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' };

/** A helper (an async Agent call) the session started a minute before the harness's clock, still running. */
const HELPER = [
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }] } }),
  JSON.stringify({
    type: 'user',
    timestamp: '2030-01-08T09:59:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'started' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' },
  }),
];

/** A team whose session's transcript opens with the prompt `fix the build`, then `more` lines. */
async function teamWith(config: JsonRecord = ON_TEAM, more: readonly string[] = []): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(TRANSCRIPT, transcript([promptLine(AT, 'fix the build'), ...more]));
  return kit;
}

function payload(event: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, ...fields });
}

/** The title a hook's one JSON line sets, or undefined when it printed no title. */
function titleOf(result: CliResult): string | undefined {
  assert.equal(result.code, EXIT.ok);
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  const sequence = typeof parsed === 'object' && parsed !== null && 'terminalSequence' in parsed ? parsed.terminalSequence : undefined;
  return typeof sequence === 'string' ? /^\u001b\]0;(.*)\u0007$/su.exec(sequence)?.[1] : undefined;
}

describe('titleLeftToHooks', () => {
  it("reads Claude Code's switch as on for 1, true, yes and on, in any case and spacing", () => {
    for (const value of ['1', 'true', ' YES ', 'On']) {
      assert.equal(titleLeftToHooks({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: value }), true, value);
    }
    for (const value of [undefined, '', '0', 'false', 'off']) {
      assert.equal(titleLeftToHooks({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: value }), false, String(value));
    }
  });
});

describe('hook tab-status', () => {
  it("puts the state's circle before the session's topic", async () => {
    const kit = await teamWith();
    const prompt = await kit.run(['hook', 'tab-status'], { stdin: payload('UserPromptSubmit', { prompt: 'and the tests' }), env: TITLE_OFF });
    assert.equal(titleOf(prompt), `${TAB_CIRCLES.working} fix the build`);
    const asking = await kit.run(['hook', 'tab-status'], { stdin: payload('PreToolUse', { tool_name: 'AskUserQuestion', session_title: 'web' }), env: TITLE_OFF });
    assert.equal(titleOf(asking), `${TAB_CIRCLES.waiting} web`);
    const failed = await kit.run(['hook', 'tab-status'], { stdin: payload('StopFailure'), env: TITLE_OFF });
    assert.equal(titleOf(failed), `${TAB_CIRCLES.error} fix the build`);
  });

  // T2256: the picker guard refuses the lead's picker in the meeting too, so its title stays there as well.
  it('leaves the title for a question picker the picker guard refuses, the lead in a meeting too', async () => {
    const kit = await teamWith({ ...ON_TEAM, pickerGuard: { enabled: true } });
    const asking = payload('PreToolUse', { tool_name: 'AskUserQuestion', session_title: 'web' });
    const lead = { stdin: asking, env: { ...TITLE_OFF, TEAMRIG_SESSION: 'lead' } };
    assert.deepEqual((await kit.run(['hook', 'tab-status'], { stdin: asking, env: { ...TITLE_OFF, TEAMRIG_SESSION: 'alpha' } })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'tab-status'], lead)).stdout, [], 'no meeting is open');
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual((await kit.run(['hook', 'tab-status'], lead)).stdout, [], 'the meeting asks in plain text');
    const ended = payload('PostToolUseFailure', { tool_name: 'AskUserQuestion', session_title: 'web' });
    assert.equal(titleOf(await kit.run(['hook', 'tab-status'], { stdin: ended, env: { ...TITLE_OFF, TEAMRIG_SESSION: 'alpha' } })), `${TAB_CIRCLES.working} web`);
  });

  it('gives the title back to the terminal at the session end, and leaves it for an event that changes nothing', async () => {
    const kit = await teamWith();
    assert.equal(titleOf(await kit.run(['hook', 'tab-status'], { stdin: payload('SessionEnd'), env: TITLE_OFF })), '');
    assert.deepEqual((await kit.run(['hook', 'tab-status'], { stdin: payload('PreToolUse', { tool_name: 'Bash' }), env: TITLE_OFF })).stdout, []);
  });

  it("shows working at a typed /compact's end while a helper still runs, and ready at a resume, whose helpers died", async () => {
    const kit = await teamWith(ON_TEAM, HELPER);
    const compacted = await kit.run(['hook', 'tab-status'], { stdin: payload('PostCompact', { trigger: 'manual' }), env: TITLE_OFF });
    assert.equal(titleOf(compacted), `${TAB_CIRCLES.working} fix the build`);
    const started = await kit.run(['hook', 'tab-status'], { stdin: payload('SessionStart', { source: 'resume' }), env: TITLE_OFF });
    assert.equal(titleOf(started), `${TAB_CIRCLES.ready} fix the build`, "a resumed session's helpers died with its old process");
  });

  it("prints nothing with Claude Code's own title on, tab status off, outside a team, for input that is no payload, or on an error", async () => {
    const event = payload('UserPromptSubmit', { prompt: 'go' });
    assert.deepEqual((await (await teamWith()).run(['hook', 'tab-status'], { stdin: event })).stdout, []);
    assert.deepEqual((await (await teamWith(TEAM)).run(['hook', 'tab-status'], { stdin: event, env: TITLE_OFF })).stdout, []);
    const outside = new CliHarness(ON_TEAM, null);
    assert.deepEqual((await outside.run(['hook', 'tab-status'], { stdin: event, env: TITLE_OFF })).stdout, []);
    const kit = await teamWith();
    assert.deepEqual(await kit.run(['hook', 'tab-status'], { stdin: 'not json', env: TITLE_OFF }), { code: EXIT.ok, stdout: [], stderr: [] });
    const faulty = new FaultyFiles(kit.files).fail('readTail', TRANSCRIPT, systemError('EACCES'));
    assert.deepEqual(await kit.run(['hook', 'tab-status'], { stdin: event, env: TITLE_OFF, files: faulty }), { code: EXIT.ok, stdout: [], stderr: [] });
  });
});

describe('hook stop: tab status', () => {
  const stop = (fields: JsonRecord = {}): string => payload('Stop', { stop_hook_active: false, ...fields });

  it('shows ready at a turn end in a tab that is no session of the team, and working while a helper still runs', async () => {
    assert.equal(titleOf(await (await teamWith()).run(['hook', 'stop'], { stdin: stop(), env: TITLE_OFF })), `${TAB_CIRCLES.ready} fix the build`);
    const busy = await teamWith(ON_TEAM, HELPER);
    assert.equal(titleOf(await busy.run(['hook', 'stop'], { stdin: stop(), env: TITLE_OFF })), `${TAB_CIRCLES.working} fix the build`);
  });

  it('shows the decision circle at a turn end that asks the user to decide, even while a helper runs, and ready at the next plain end', async () => {
    const asking = stop({ last_assistant_message: 'Two ways to ship T4.\n\nDecision needed: Friday or Monday?' });
    assert.equal(titleOf(await (await teamWith()).run(['hook', 'stop'], { stdin: asking, env: TITLE_OFF })), `${TAB_CIRCLES.decision} fix the build`);
    const busy = await teamWith(ON_TEAM, HELPER);
    assert.equal(titleOf(await busy.run(['hook', 'stop'], { stdin: asking, env: TITLE_OFF })), `${TAB_CIRCLES.decision} fix the build`);
    const kit = await teamWith();
    const prompt = await kit.run(['hook', 'tab-status'], { stdin: payload('UserPromptSubmit', { prompt: 'Friday' }), env: TITLE_OFF });
    assert.equal(titleOf(prompt), `${TAB_CIRCLES.working} fix the build`);
    const plain = await kit.run(['hook', 'stop'], { stdin: stop({ last_assistant_message: 'Shipped on Friday.' }), env: TITLE_OFF });
    assert.equal(titleOf(plain), `${TAB_CIRCLES.ready} fix the build`);
  });

  it("titles a session's tab too, and leaves the tab alone with tab status off or on an error", async () => {
    const env = { ...TITLE_OFF, TEAMRIG_SESSION: 'alpha' };
    assert.equal(titleOf(await (await teamWith()).run(['hook', 'stop'], { stdin: stop({ session_title: 'alpha' }), env })), `${TAB_CIRCLES.ready} [app] alpha`);
    assert.deepEqual((await (await teamWith(TEAM)).run(['hook', 'stop'], { stdin: stop(), env })).stdout, []);
    assert.deepEqual((await (await teamWith()).run(['hook', 'stop'], { stdin: stop() })).stdout, []);
    const kit = await teamWith();
    const faulty = new FaultyFiles(kit.files).fail('readTail', TRANSCRIPT, systemError('EACCES'));
    assert.deepEqual((await kit.run(['hook', 'stop'], { stdin: stop(), env: TITLE_OFF, files: faulty })).stdout, []);
  });

  it("puts the circle before the refresh notice's title, and sets none at the block that asks for the handover", async () => {
    const kit = new CliHarness(ON_TEAM);
    const env = { ...TITLE_OFF, TEAMRIG_SESSION: 'alpha' };
    const reply = { type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 2, cache_read_input_tokens: 299_998, output_tokens: 9 } } };
    await kit.files.write(TRANSCRIPT, transcript([promptLine(AT, 'fix the build'), JSON.stringify(reply)]));
    const added = await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'alpha']);
    assert.match(added.stdout[0] ?? '', /^ADDED T1 /);
    const asked = await kit.run(['hook', 'stop'], { stdin: stop(), env });
    assert.match(asked.stdout[0] ?? '', /"decision":"block"/);
    assert.equal(titleOf(asked), undefined);
    await kit.files.write(HANDOVER, '# In progress\n');
    assert.equal((await kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    const notice = await kit.run(['hook', 'stop'], { stdin: stop({ stop_hook_active: true }), env });
    assert.equal(titleOf(notice), `${TAB_CIRCLES.ready} [app] alpha: type /clear`);
  });
});
