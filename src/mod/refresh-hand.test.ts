import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOLD_GAP_MS,
  parseCompactAnswer,
  parseMidTurnAnswer,
  RECHECK_MS,
  RefreshHand,
  refreshCliArgv,
  type CompactAnswer,
  type MidTurnAnswer,
  type RefreshCommand,
  type RefreshHandHost,
  type RefreshRun,
} from './refresh-hand.ts';

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const ASK = 'teamrig: your context is 130k (refresh at 120k), so refresh within this turn.';
const OFF: MidTurnAnswer = { kind: 'wait', nextAt: null };

interface Call {
  readonly command: RefreshCommand;
  readonly stdin: unknown;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Claude Code as the mod sees it: the tab and the CLI's answers in turn, the last one repeating. */
class FakeHost implements RefreshHandHost {
  time = 1_000_000;
  answers: RefreshRun[] = [];
  /** What each CLI run throws, when set: an Error, or any other value. */
  failure: { readonly thrown: unknown } | undefined;
  /** Holds each CLI run until the test lets it go, when set. */
  gate: Promise<void> | undefined;
  readonly calls: Call[] = [];

  async sessionId(): Promise<string> {
    return TAB;
  }

  async cwd(): Promise<string> {
    return '/work/app/src';
  }

  async root(): Promise<string> {
    return '/work/app';
  }

  async cli(command: RefreshCommand, stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<RefreshRun> {
    this.calls.push({ command, stdin: JSON.parse(stdin), env, cwd });
    await this.gate;
    if (this.failure !== undefined) {
      throw this.failure.thrown;
    }
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    assert.ok(next !== undefined, 'the test set an answer');
    return next;
  }

  now(): number {
    return this.time;
  }

  answer(...answers: (MidTurnAnswer | CompactAnswer)[]): void {
    this.answers = answers.map((answer) => ({ exitCode: 0, stdout: `${JSON.stringify(answer)}\n` }));
  }

  asks(): number {
    return this.calls.filter((call) => call.command === 'refresh-mid').length;
  }
}

describe('RefreshHand.afterTool', () => {
  it("asks the CLI as the tab's session at the first tool result, then only once the context reaches the size it named", async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answer({ kind: 'wait', nextAt: 120_000 });
    assert.deepEqual(await hand.afterTool(40_000), { kind: 'waiting', nextAt: 120_000 });
    assert.deepEqual(host.calls[0], {
      command: 'refresh-mid',
      stdin: { session_id: TAB, cwd: '/work/app/src', tokens: 40_000 },
      env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' },
      cwd: '/work/app/src',
    });
    assert.deepEqual(await hand.afterTool(119_999), { kind: 'quiet' });
    host.answer({ kind: 'ask', text: ASK, nextAt: 154_000 });
    assert.deepEqual(await hand.afterTool(130_000), { kind: 'asked', text: ASK });
    assert.deepEqual(await hand.afterTool(140_000), { kind: 'quiet' }, 'not asked again before the next size');
    assert.equal(host.asks(), 2);
  });

  it('sends the window Claude Code reports, which tells the CLI a large one', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answer({ kind: 'wait', nextAt: 250_000 });
    assert.deepEqual(await hand.afterTool(130_000, 1_000_000), { kind: 'waiting', nextAt: 250_000 });
    assert.deepEqual(host.calls[0]?.stdin, { session_id: TAB, cwd: '/work/app/src', tokens: 130_000, window: 1_000_000 });
  });

  it('looks again a hold gap after a held ask, while background work runs, and asks once it ended', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answer({ kind: 'wait', nextAt: 120_000 });
    assert.deepEqual(await hand.afterTool(130_000), { kind: 'waiting', nextAt: 120_000 });
    host.time += HOLD_GAP_MS - 1;
    assert.deepEqual(await hand.afterTool(131_000), { kind: 'quiet' });
    host.time += 1;
    host.answer({ kind: 'ask', text: ASK, nextAt: 155_000 });
    assert.deepEqual(await hand.afterTool(131_000), { kind: 'asked', text: ASK });
    assert.equal(host.asks(), 2);
  });

  it('asks at once when the context crosses the size it waited under, with no hold gap', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answer({ kind: 'wait', nextAt: 120_000 });
    await hand.afterTool(100_000);
    host.time += 1_000;
    host.answer({ kind: 'ask', text: ASK, nextAt: 154_000 });
    assert.deepEqual(await hand.afterTool(121_000), { kind: 'asked', text: ASK });
  });

  it('asks again after the context shrank (a compaction or /clear), and RECHECK_MS after the last ask while the refresh is off', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answer({ kind: 'ask', text: ASK, nextAt: 154_000 });
    await hand.afterTool(130_000);
    host.answer({ kind: 'wait', nextAt: 120_000 });
    assert.deepEqual(await hand.afterTool(20_000), { kind: 'waiting', nextAt: 120_000 }, 'a fresh start: the size starts over');
    host.answer(OFF);
    host.time += RECHECK_MS;
    assert.deepEqual(await hand.afterTool(30_000), { kind: 'waiting', nextAt: null });
    host.time += RECHECK_MS - 1;
    assert.deepEqual(await hand.afterTool(190_000), { kind: 'quiet' }, 'off: no size asks');
    host.time += 1;
    assert.deepEqual(await hand.afterTool(190_000), { kind: 'waiting', nextAt: null });
    assert.equal(host.asks(), 4);
  });

  it('looks once while tools run side by side', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answer({ kind: 'ask', text: ASK, nextAt: 154_000 });
    let release = (): void => undefined;
    host.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = hand.afterTool(130_000);
    assert.deepEqual(await hand.afterTool(130_500), { kind: 'overlap' });
    release();
    assert.deepEqual(await first, { kind: 'asked', text: ASK });
    assert.equal(host.asks(), 1);
  });

  it('reports a failed or unreadable run and waits for the recheck, not the next tool result', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.failure = { thrown: new Error('spawn node ENOENT') };
    assert.deepEqual(await hand.afterTool(130_000), { kind: 'failed', error: 'spawn node ENOENT' });
    assert.deepEqual(await hand.afterTool(131_000), { kind: 'quiet' });
    host.failure = undefined;
    host.answers = [{ exitCode: 1, stdout: 'teamrig: boom\n' }];
    host.time += RECHECK_MS;
    assert.deepEqual(await hand.afterTool(132_000), { kind: 'failed', error: 'hook refresh-mid exited 1: teamrig: boom' });
    host.answers = [{ exitCode: 0, stdout: '{"kind":"ask"}' }];
    host.time += RECHECK_MS;
    assert.deepEqual(await hand.afterTool(133_000), { kind: 'failed', error: 'hook refresh-mid exited 0: {"kind":"ask"}' });
    host.failure = { thrown: 'killed' };
    host.time += RECHECK_MS;
    assert.deepEqual(await hand.afterTool(134_000), { kind: 'failed', error: 'killed' }, 'a thrown value that is not an Error');
    assert.equal(host.asks(), 4);
  });
});

describe('RefreshHand.beforeCompact', () => {
  it("asks the CLI with the context and the window, as the tab's session, and answers its verdict", async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    const skip: CompactAnswer = { kind: 'skip', reason: 'teamrig: the handover is asked for, so compaction waits until 185k (now 170k)' };
    host.answer(skip);
    assert.deepEqual(await hand.beforeCompact(170_000, 200_000), skip);
    assert.deepEqual(host.calls[0], {
      command: 'compact-check',
      stdin: { session_id: TAB, cwd: '/work/app/src', tokens: 170_000, window: 200_000 },
      env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' },
      cwd: '/work/app/src',
    });
    host.answer({ kind: 'go' });
    assert.deepEqual(await hand.beforeCompact(186_000, 200_000), { kind: 'go' });
  });

  it('reports a failed or unreadable run, which lets the compaction go', async () => {
    const host = new FakeHost();
    const hand = new RefreshHand(host);
    host.answers = [{ exitCode: 2, stdout: '' }];
    assert.deepEqual(await hand.beforeCompact(170_000, 200_000), { kind: 'failed', error: 'hook compact-check exited 2: ' });
    host.failure = { thrown: new Error('timed out') };
    assert.deepEqual(await hand.beforeCompact(170_000, 200_000), { kind: 'failed', error: 'timed out' });
  });
});

describe('refresh answers', () => {
  it('reads the CLI line that runs each command', () => {
    assert.deepEqual(refreshCliArgv('/p', 'refresh-mid'), ['node', '/p/dist/cli/main.js', 'hook', 'refresh-mid']);
  });

  it("reads hook refresh-mid's answers and nothing else", () => {
    assert.deepEqual(parseMidTurnAnswer(`${JSON.stringify({ kind: 'ask', text: ASK, nextAt: 154_000 })}\n`), { kind: 'ask', text: ASK, nextAt: 154_000 });
    assert.deepEqual(parseMidTurnAnswer('{"kind":"wait","nextAt":null}'), OFF);
    assert.deepEqual(parseMidTurnAnswer('{"kind":"wait","nextAt":120000}'), { kind: 'wait', nextAt: 120_000 });
    for (const stdout of ['', 'not json', '[]', '{"kind":"wait"}', '{"kind":"ask","text":"x","nextAt":null}', '{"kind":"wait","nextAt":"120k"}', '{"kind":"go"}']) {
      assert.equal(parseMidTurnAnswer(stdout), undefined, stdout);
    }
  });

  it("reads hook compact-check's answers and nothing else", () => {
    assert.deepEqual(parseCompactAnswer('{"kind":"go"}\n'), { kind: 'go' });
    assert.deepEqual(parseCompactAnswer('{"kind":"skip","reason":"why"}'), { kind: 'skip', reason: 'why' });
    for (const stdout of ['', 'null', '{"kind":"skip"}', '{"kind":"wait","nextAt":null}']) {
      assert.equal(parseCompactAnswer(stdout), undefined, stdout);
    }
  });
});
