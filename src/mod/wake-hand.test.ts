import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWakeAnswer, RECHECK_MS, WAKE_TICK_MS, WakeHand, wakeCliArgv, type WakeAnswer, type WakeCommand, type WakeHandHost, type WakeRun } from './wake-hand.ts';

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const EVENTS = '/kit/teams/app/state/events.jsonl';
const WAIT: WakeAnswer = { kind: 'wait', watch: EVENTS, recheckAt: null };
const WAKE: WakeAnswer = { kind: 'wake', ids: ['T2'], text: 'New work was handed to you.', toast: 'teamrig woke this tab for T2' };

interface Call {
  readonly command: WakeCommand;
  readonly stdin: unknown;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Claude Code as the mod sees it: the tab, the CLI's answers in turn, the register file's change time and the prompt. */
class FakeHost implements WakeHandHost {
  time = 1_000_000;
  /** What each `hook wake-check` answers, in turn; the last one repeats. */
  answers: WakeRun[] = [];
  changed: number | undefined = 5;
  dropReason: string | undefined;
  submitFailure: Error | undefined;
  readonly calls: Call[] = [];
  readonly submitted: string[] = [];
  readonly toasts: string[] = [];

  async sessionId(): Promise<string> {
    return TAB;
  }

  async cwd(): Promise<string> {
    return '/work/app/src';
  }

  async root(): Promise<string> {
    return '/work/app';
  }

  async cli(command: WakeCommand, stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<WakeRun> {
    this.calls.push({ command, stdin: JSON.parse(stdin), env, cwd });
    if (command === 'wake-dropped') {
      return { exitCode: 0, stdout: '' };
    }
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    assert.ok(next !== undefined, 'the test set an answer');
    return next;
  }

  async changedAt(path: string): Promise<number | undefined> {
    assert.equal(path, EVENTS);
    return this.changed;
  }

  async submit(text: string): Promise<string | undefined> {
    if (this.submitFailure !== undefined) {
      throw this.submitFailure;
    }
    this.submitted.push(text);
    return this.dropReason;
  }

  toast(text: string): void {
    this.toasts.push(text);
  }

  now(): number {
    return this.time;
  }

  answer(...answers: WakeAnswer[]): void {
    this.answers = answers.map((answer) => ({ exitCode: 0, stdout: `${JSON.stringify(answer)}\n` }));
  }

  checks(): number {
    return this.calls.filter((call) => call.command === 'wake-check').length;
  }
}

/** A hand that has made its first two asks: the first names the file, the second takes its change time. */
async function settled(host: FakeHost): Promise<WakeHand> {
  const hand = new WakeHand(host);
  host.answer(WAIT);
  assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: null });
  assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: null });
  assert.equal(host.checks(), 2);
  return hand;
}

describe('WakeHand', () => {
  it("asks the CLI as the tab's session, in its folder, and stays quiet until the register changes", async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    assert.deepEqual(host.calls[0], {
      command: 'wake-check',
      stdin: { session_id: TAB, cwd: '/work/app/src' },
      env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' },
      cwd: '/work/app/src',
    });
    host.time += WAKE_TICK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'quiet' });
    host.changed = 6;
    host.answer(WAKE);
    assert.deepEqual(await hand.tick(), { kind: 'woke', ids: ['T2'] });
    assert.deepEqual(host.submitted, ['New work was handed to you.']);
    assert.deepEqual(host.toasts, ['teamrig woke this tab for T2']);
  });

  it('asks again when the time the CLI named falls due, and RECHECK_MS after its last ask', async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    host.changed = 6;
    host.answer({ kind: 'wait', watch: EVENTS, recheckAt: host.time + 120_000 });
    assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: host.time + 120_000 });
    host.time += 60_000;
    assert.deepEqual(await hand.tick(), { kind: 'quiet' });
    host.time += 60_000;
    host.answer(WAIT);
    assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: null });
    host.time += RECHECK_MS - 1;
    assert.deepEqual(await hand.tick(), { kind: 'quiet' });
    host.time += 1;
    assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: null });
    assert.equal(host.checks(), 5);
  });

  it('never asks while a turn runs, nor while the look before still runs', async () => {
    const host = new FakeHost();
    const hand = new WakeHand(host);
    host.answer(WAIT);
    hand.turnStarted('turn-1');
    hand.turnStarted('agent-1');
    assert.deepEqual(await hand.tick(), { kind: 'busy' });
    hand.turnEnded('turn-1');
    assert.deepEqual(await hand.tick(), { kind: 'busy' });
    hand.turnEnded('agent-1');
    const [first, second] = await Promise.all([hand.tick(), hand.tick()]);
    assert.deepEqual([first, second], [{ kind: 'waiting', recheckAt: null }, { kind: 'overlap' }]);
  });

  it('logs a wake Claude Code dropped, with its reason, and shows no toast', async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    host.changed = 6;
    host.dropReason = 'blocked by a hook';
    host.answer(WAKE);
    assert.deepEqual(await hand.tick(), { kind: 'dropped', ids: ['T2'], reason: 'blocked by a hook' });
    assert.deepEqual(host.calls.at(-1), {
      command: 'wake-dropped',
      stdin: { session_id: TAB, cwd: '/work/app/src', reason: 'blocked by a hook' },
      env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' },
      cwd: '/work/app/src',
    });
    assert.deepEqual(host.toasts, []);
  });

  it('asks again at the next look after a wake that came before the CLI named its file', async () => {
    const host = new FakeHost();
    const hand = new WakeHand(host);
    host.answer(WAKE, WAIT);
    assert.deepEqual(await hand.tick(), { kind: 'woke', ids: ['T2'] });
    assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: null });
  });

  it('is off as the CLI says, asking again RECHECK_MS later, and reports a failed or unreadable run', async () => {
    const host = new FakeHost();
    const hand = new WakeHand(host);
    host.answer({ kind: 'off', why: 'wake.enabled is false' });
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'wake.enabled is false' });
    host.time += RECHECK_MS - 1;
    assert.deepEqual(await hand.tick(), { kind: 'quiet' });
    host.time += 1;
    host.answers = [{ exitCode: 1, stdout: 'teamrig: broken\n' }];
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook wake-check exited 1: teamrig: broken' });
    host.time += RECHECK_MS;
    host.answers = [{ exitCode: 0, stdout: 'not json' }];
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook wake-check exited 0: not json' });
    host.time += RECHECK_MS;
    host.answer(WAKE);
    host.submitFailure = new Error('session gone');
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'session gone' });
  });
});

describe('parseWakeAnswer', () => {
  it('reads each answer and refuses any other shape', () => {
    for (const answer of [WAKE, WAIT, { kind: 'wait', watch: EVENTS, recheckAt: 7 }, { kind: 'off', why: 'x' }] as const) {
      assert.deepEqual(parseWakeAnswer(JSON.stringify(answer)), answer);
    }
    const refused = ['[]', '"wake"', '{"kind":"wake","ids":[1],"text":"t","toast":"t"}', '{"kind":"wait","watch":"w","recheckAt":"soon"}', '{"kind":"off"}', '{"kind":"other"}'];
    for (const text of refused) {
      assert.equal(parseWakeAnswer(text), undefined, text);
    }
  });

  it('runs the CLI from the plugin folder', () => {
    assert.deepEqual(wakeCliArgv('/plugins/teamrig', 'wake-check'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'wake-check']);
  });
});
