import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const STATE = join(TEAM_HOME, 'state', 'refresh', 'alpha.json');
const HANDOVER = join(TEAM_HOME, 'handover', 'alpha.md');
/** Filed under a folder that is not the project's slug, so the hook finds it by its session id. */
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'app', `${CLAUDE_SESSION}.jsonl`);
const AS_ALPHA: Readonly<Record<string, string>> = { TEAMRIG_SESSION: 'alpha' };
const OFF = { kind: 'wait', nextAt: null };
const GO = { kind: 'go' };
/** The ask at a tool's result with the context at 130k and no ask before. */
const ASK_130K =
  'teamrig: your context is 130k (refresh at 120k), so refresh within this turn: finish the step you are on and start no other. ' +
  `Write your handover to ${HANDOVER}, replacing the whole file (your fresh start reads all of it): what the register lacks (the next step of each task in progress; what to check later, and when; ` +
  'questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), ' +
  'not task statuses, which your fresh start reads live from the register. Then run `teamrig refresh --ready --session alpha` and end your turn: ' +
  'the fresh start follows it.';

/** The lines of a background command the main thread started at 09:30, before the harness's 10:00. */
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

/** A tab of session alpha: its transcript, readable and listed where Claude Code keeps transcripts. */
class Tab {
  readonly kit: CliHarness;
  private readonly transcripts = new MemoryTranscripts();

  constructor(config: JsonRecord | null = { ...TEAM, refresh: { tabTitle: false } }) {
    this.kit = new CliHarness(config);
  }

  async transcript(text: string): Promise<void> {
    await this.kit.files.write(TRANSCRIPT, text);
    this.transcripts.set(TRANSCRIPT, text, this.kit.clock.now());
  }

  run(command: string, input: JsonRecord | string, env: Readonly<Record<string, string>> = AS_ALPHA): Promise<CliResult> {
    const stdin = typeof input === 'string' ? input : JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, ...input });
    return this.kit.run(['hook', command], { env, stdin, transcripts: this.transcripts });
  }

  async mid(tokens: unknown): Promise<unknown> {
    return answerOf(await this.run('refresh-mid', { tokens }));
  }

  async compact(tokens: unknown, window: unknown): Promise<unknown> {
    return answerOf(await this.run('compact-check', { tokens, window }));
  }

  /** The classic PreCompact hook's answer: its JSON line, or undefined when it printed nothing (the compaction goes). */
  async preCompact(input: JsonRecord | string = { transcript_path: TRANSCRIPT, trigger: 'auto' }, env: Readonly<Record<string, string>> = AS_ALPHA): Promise<unknown> {
    const result = await this.run('pre-compact', input, env);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    return result.stdout.length === 0 ? undefined : answerOf(result);
  }

  state(): Promise<string | undefined> {
    return this.kit.files.read(STATE);
  }
}

/** The hook's one JSON line. */
function answerOf(result: CliResult): unknown {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  assert.equal(result.stdout.length, 1, result.stdout.join('\n'));
  return JSON.parse(result.stdout[0] ?? '');
}

describe('runCli: hook refresh-mid', () => {
  it('asks within the turn once the context reaches the threshold, and the turn end asks once more until the handover is written', async () => {
    const tab = new Tab();
    await tab.transcript('{}\n');
    assert.deepEqual(await tab.mid(100_000), { kind: 'wait', nextAt: 120_000 });
    assert.equal(await tab.state(), undefined, 'nothing recorded under the threshold');

    const asked = await tab.mid(130_000);
    assert.deepEqual(asked, {
      kind: 'ask',
      text: ASK_130K,
      nextAt: 154_000,
    });
    assert.match((await tab.state()) ?? '', /"phase":"asked","task":null,.*"tokens":130000,.*"midTurn":true/);
    assert.deepEqual(await tab.mid(140_000), { kind: 'wait', nextAt: 154_000 }, 'not at every tool');

    const stop = await tab.run('stop', { transcript_path: TRANSCRIPT, stop_hook_active: false });
    assert.match(JSON.stringify(answerOf(stop)), /"decision":"block","reason":"teamrig: the refresh asked within this turn at 130k is still due, so refresh now/);
    assert.match((await tab.state()) ?? '', /"midTurn":false/);

    await tab.kit.files.write(HANDOVER, '# In progress\n');
    assert.equal((await tab.kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    assert.deepEqual(answerOf(await tab.run('stop', { transcript_path: TRANSCRIPT, stop_hook_active: true })), {
      systemMessage: 'teamrig: app-alpha wrote its handover; type /clear for a fresh start',
    });
  });

  it('asks while background work the session started still runs, naming it, and plainly once it reported back', async () => {
    const running = new Tab();
    await running.transcript(BACKGROUND_START);
    const line = 'A background task you started still runs: say in the handover what its result still needs; the fresh start waits until it reports back. ';
    assert.deepEqual(await running.mid(130_000), { kind: 'ask', text: ASK_130K.replace('Then run', `${line}Then run`), nextAt: 154_000 });
    const ended = new Tab();
    await ended.transcript(BACKGROUND_START + BACKGROUND_END);
    assert.deepEqual(await ended.mid(130_000), { kind: 'ask', text: ASK_130K, nextAt: 154_000 });
  });

  it('asks for nothing outside a team session, with refresh off, or on input it cannot read', async () => {
    const tab = new Tab();
    assert.deepEqual(answerOf(await tab.run('refresh-mid', { tokens: 130_000 }, {})), OFF, 'no team session');
    assert.deepEqual(await tab.mid('130k'), OFF);
    assert.deepEqual(answerOf(await tab.run('refresh-mid', 'not json')), OFF);
    assert.deepEqual(await new Tab({ ...TEAM, refresh: { enabled: false } }).mid(130_000), OFF);
    assert.deepEqual(await new Tab(null).mid(130_000), OFF, 'no config');
    assert.equal(await tab.state(), undefined);
  });
});

describe('runCli: hook compact-check', () => {
  it('holds the compaction until the ceiling while the handover is asked for or written, and lets it go otherwise', async () => {
    const tab = new Tab();
    await tab.transcript('{}\n');
    assert.deepEqual(await tab.compact(170_000, 200_000), GO, 'no refresh pending');

    await tab.mid(130_000);
    assert.deepEqual(await tab.compact(170_000, 200_000), {
      kind: 'skip',
      reason: 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)',
    });
    assert.deepEqual(await tab.compact(185_000, 200_000), GO, 'at the ceiling');
    assert.deepEqual(await tab.compact(170_000, 180_000), GO, 'a window no larger than the ceiling');

    await tab.kit.files.write(HANDOVER, '# In progress\n');
    assert.equal((await tab.kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(JSON.stringify(await tab.compact(170_000, 200_000)), /"kind":"skip","reason":"teamrig: the handover is written and/);
  });

  it('lets the compaction go outside a team session, with refresh off, or on input it cannot read', async () => {
    const tab = new Tab();
    await tab.mid(130_000);
    assert.deepEqual(answerOf(await tab.run('compact-check', { tokens: 170_000, window: 200_000 }, {})), GO, 'no team session');
    assert.deepEqual(await tab.compact(170_000, undefined), GO);
    assert.deepEqual(answerOf(await tab.run('compact-check', 'not json')), GO);
    assert.deepEqual(await new Tab({ ...TEAM, refresh: { enabled: false } }).compact(170_000, 200_000), GO);
  });
});

/** A main-thread reply whose context was `tokens`, as Claude Code writes it to the transcript. */
function replyLine(tokens: number): string {
  const usage = { input_tokens: 1, cache_read_input_tokens: tokens - 1, output_tokens: 50 };
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage } })}\n`;
}

/** A tool result line of about `bytes` bytes. */
function resultLine(bytes: number): string {
  return `${JSON.stringify({ type: 'user', isSidechain: false, message: { content: 'x'.repeat(bytes) } })}\n`;
}

describe('runCli: hook pre-compact', () => {
  it("holds Claude Code's own compaction under the ceiling while the handover is asked for or written, on the transcript's estimate", async () => {
    const tab = new Tab();
    await tab.transcript(replyLine(170_000));
    assert.equal(await tab.preCompact(), undefined, 'no refresh pending');

    await tab.mid(130_000);
    assert.deepEqual(await tab.preCompact(), {
      decision: 'block',
      reason: 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)',
    });
    assert.equal(await tab.preCompact({ transcript_path: TRANSCRIPT, trigger: 'manual' }), undefined, 'a /compact the user typed');

    await tab.kit.files.write(HANDOVER, '# In progress\n');
    assert.equal((await tab.kit.run(['refresh', '--ready', '--session', 'alpha'])).code, EXIT.ok);
    assert.match(JSON.stringify(await tab.preCompact()), /"decision":"block","reason":"teamrig: the handover is written and/);

    // 45,000 bytes since the reply read at least 15,000 tokens more: 185k, the ceiling.
    await tab.transcript(replyLine(170_000) + resultLine(45_000));
    assert.equal(await tab.preCompact(), undefined, 'at the ceiling');
  });

  it('lets the compaction go outside a team session, with refresh off, without a reply in the transcript, or on input it cannot read', async () => {
    const tab = new Tab();
    await tab.transcript(replyLine(170_000));
    await tab.mid(130_000);
    assert.equal(await tab.preCompact(undefined, {}), undefined, 'no team session');
    assert.equal(await tab.preCompact({ trigger: 'auto' }), undefined, 'no transcript path');
    assert.equal(await tab.preCompact({ transcript_path: join(USER_HOME, 'missing.jsonl'), trigger: 'auto' }), undefined, 'no transcript');
    assert.equal(await tab.preCompact('not json'), undefined);
    await tab.transcript('{}\n');
    assert.equal(await tab.preCompact(), undefined, 'no reply with usage');

    const off = new Tab({ ...TEAM, refresh: { enabled: false } });
    await off.transcript(replyLine(170_000));
    await off.kit.files.write(STATE, (await tab.state()) ?? '');
    assert.equal(await off.preCompact(), undefined, 'refresh off, with the ask still on record');
  });
});
