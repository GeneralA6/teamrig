import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOAST_MAX_MS } from './meeting-hand.ts';
import {
  NeedsYouHand,
  needsYouCliArgv,
  needsYouLine,
  parseNeedsYouAnswer,
  parseNeedsYouFocusAnswer,
  sameNeedsYou,
  type NeedsYouAsk,
  type NeedsYouCommand,
  type NeedsYouHandHost,
  type NeedsYouRun,
} from './needs-you-hand.ts';

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const BRAVO: NeedsYouAsk = { session: 'bravo', tab: '[app] bravo', kind: 'permission', text: 'Bash: npm run deploy', task: 'T7', since: '2030-01-08T10:00:05.000Z', focus: true };
const ALPHA: NeedsYouAsk = { session: 'alpha', tab: '[app] alpha', kind: 'question', text: 'Which branch?', task: null, since: '2030-01-08T10:00:01.000Z', focus: false };

function run(answer: unknown, exitCode = 0): NeedsYouRun {
  return { exitCode, stdout: `${JSON.stringify(answer)}\n` };
}

function asks(...list: readonly NeedsYouAsk[]): NeedsYouRun {
  return run({ kind: 'asks', asks: list });
}

/** Claude Code as the mod sees it: the tab, the CLI's answers per command in turn (the last repeats), toasts and redraws. */
class FakeHost implements NeedsYouHandHost {
  readonly answers: Record<NeedsYouCommand, NeedsYouRun[]> = { 'needs-you': [asks()], 'needs-you-focus': [run({ kind: 'focused', text: 'focused [app] bravo' })] };
  readonly calls: { readonly command: NeedsYouCommand; readonly stdin: unknown; readonly env: Readonly<Record<string, string>>; readonly cwd: string }[] = [];
  readonly toasts: { readonly text: string; readonly stayMs: number }[] = [];
  redraws = 0;
  failStart = false;

  async sessionId(): Promise<string> {
    return TAB;
  }

  async cwd(): Promise<string> {
    return '/work/app/src';
  }

  async root(): Promise<string> {
    return '/work/app';
  }

  async cli(command: NeedsYouCommand, stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<NeedsYouRun> {
    if (this.failStart) {
      throw new Error('spawn node ENOENT');
    }
    this.calls.push({ command, stdin: JSON.parse(stdin), env, cwd });
    const queue = this.answers[command];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    assert.ok(next !== undefined, 'the test set an answer');
    return next;
  }

  toast(text: string, stayMs: number): void {
    this.toasts.push({ text, stayMs });
  }

  changed(): void {
    this.redraws += 1;
  }
}

describe('needsYouCliArgv', () => {
  it("runs the plugin's own CLI as hook needs-you or hook needs-you-focus", () => {
    assert.deepEqual(needsYouCliArgv('/plugins/teamrig', 'needs-you'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'needs-you']);
    assert.deepEqual(needsYouCliArgv('/plugins/teamrig', 'needs-you-focus'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'needs-you-focus']);
  });
});

describe('parseNeedsYouAnswer', () => {
  it('reads the asks and the off answer', () => {
    assert.deepEqual(parseNeedsYouAnswer(JSON.stringify({ kind: 'asks', asks: [BRAVO] })), { kind: 'asks', asks: [BRAVO] });
    assert.deepEqual(parseNeedsYouAnswer('{"kind":"off","why":"needsYou.enabled is false"}'), { kind: 'off', why: 'needsYou.enabled is false' });
  });

  it('refuses a malformed ask, a non-JSON line and an unknown kind', () => {
    assert.equal(parseNeedsYouAnswer(JSON.stringify({ kind: 'asks', asks: [{ ...BRAVO, focus: 'yes' }] })), undefined);
    assert.equal(parseNeedsYouAnswer('not json'), undefined);
    assert.equal(parseNeedsYouAnswer('{"kind":"later"}'), undefined);
  });
});

describe('parseNeedsYouFocusAnswer', () => {
  it('reads each outcome and each refusal', () => {
    assert.deepEqual(parseNeedsYouFocusAnswer('{"kind":"behind","text":"selected"}'), { kind: 'behind', text: 'selected' });
    assert.deepEqual(parseNeedsYouFocusAnswer('{"kind":"refused","why":"bravo asks nothing now"}'), { kind: 'refused', why: 'bravo asks nothing now' });
    assert.equal(parseNeedsYouFocusAnswer('{"kind":"focused"}'), undefined);
  });
});

describe('needsYouLine', () => {
  it('names the tab and its ask, cuts a long ask and counts the others', () => {
    const view = { session: 'bravo', since: BRAVO.since, tab: '[app] bravo', text: 'Bash: npm run deploy', focus: true, more: 0 };
    assert.equal(needsYouLine(view), '[app] bravo asks: Bash: npm run deploy');
    assert.equal(needsYouLine({ ...view, more: 2 }), '[app] bravo asks: Bash: npm run deploy (+2 more)');
    const long = needsYouLine({ ...view, text: 'x'.repeat(150) });
    assert.equal(long, `[app] bravo asks: ${'x'.repeat(97)}...`);
  });

  it('sameNeedsYou tells two equal bands from a changed one', () => {
    const view = { session: 'bravo', since: BRAVO.since, tab: '[app] bravo', text: 'a', focus: true, more: 0 };
    assert.equal(sameNeedsYou(view, { ...view }), true);
    assert.equal(sameNeedsYou(view, { ...view, focus: false }), false);
    assert.equal(sameNeedsYou(null, undefined), false);
    assert.equal(sameNeedsYou(null, null), true);
  });
});

describe('NeedsYouHand.tick', () => {
  it("asks the CLI as this tab, toasts each new ask once for the engine's longest toast and shows the newest", async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO, ALPHA)];
    const hand = new NeedsYouHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'asks', count: 2, fresh: ['bravo', 'alpha'] });
    assert.deepEqual(host.calls[0], {
      command: 'needs-you',
      stdin: { session_id: TAB, cwd: '/work/app/src' },
      env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' },
      cwd: '/work/app/src',
    });
    assert.deepEqual(host.toasts, [
      { text: '[app] bravo needs you: Bash: npm run deploy', stayMs: TOAST_MAX_MS },
      { text: '[app] alpha needs you: Which branch?', stayMs: TOAST_MAX_MS },
    ]);
    assert.deepEqual(hand.view(), { session: 'bravo', since: BRAVO.since, tab: '[app] bravo', text: 'Bash: npm run deploy', focus: true, more: 1 });
    assert.deepEqual(await hand.tick(), { kind: 'asks', count: 2, fresh: [] });
    assert.equal(host.toasts.length, 2);
  });

  it('hides the band once no tab asks, and toasts a tab again when it asks anew', async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO), asks(), asks({ ...BRAVO, since: '2030-01-08T10:05:00.000Z' })];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    await hand.tick();
    assert.equal(hand.view(), undefined);
    await hand.tick();
    assert.equal(host.toasts.length, 2);
  });

  it('shows nothing while the team has needsYou off', async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO), run({ kind: 'off', why: 'needsYou.enabled is false' })];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'needsYou.enabled is false' });
    assert.equal(hand.view(), undefined);
  });

  it('keeps the band on a failed run, and reports it without rejecting', async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO), run('boom', 1)];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    const failed = await hand.tick();
    assert.equal(failed.kind, 'failed');
    assert.equal(hand.view()?.session, 'bravo');
    host.failStart = true;
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'spawn node ENOENT' });
  });

  it('runs one ask at a time', async () => {
    const host = new FakeHost();
    const hand = new NeedsYouHand(host);
    const [first, second] = await Promise.all([hand.tick(), hand.tick()]);
    assert.equal(first.kind, 'asks');
    assert.deepEqual(second, { kind: 'overlap' });
  });
});

describe('NeedsYouHand.dismiss', () => {
  it('hides the shown ask and shows the next, until that tab asks anew', async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO, ALPHA), asks(BRAVO, ALPHA), asks({ ...BRAVO, since: '2030-01-08T10:05:00.000Z' }, ALPHA)];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    const redraws = host.redraws;
    assert.deepEqual(hand.dismiss(), { kind: 'dismissed', session: 'bravo' });
    assert.equal(host.redraws, redraws + 1);
    assert.equal(hand.view()?.session, 'alpha');
    assert.equal(hand.view()?.more, 0);
    await hand.tick();
    assert.equal(hand.view()?.session, 'alpha');
    await hand.tick();
    assert.equal(hand.view()?.session, 'bravo');
  });

  it('does nothing with no ask shown', () => {
    assert.deepEqual(new NeedsYouHand(new FakeHost()).dismiss(), { kind: 'idle' });
  });
});

describe('NeedsYouHand.focus', () => {
  it("asks the CLI to bring the shown ask's tab to the front, with no toast when it came", async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO)];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    const toasts = host.toasts.length;
    assert.deepEqual(await hand.focus(), { kind: 'focused', text: 'focused [app] bravo' });
    assert.deepEqual(host.calls.at(-1)?.stdin, { session_id: TAB, cwd: '/work/app/src', session: 'bravo' });
    assert.equal(host.toasts.length, toasts);
  });

  it('toasts why when the tab stayed behind or the CLI refused', async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO)];
    host.answers['needs-you-focus'] = [run({ kind: 'behind', text: 'selected [app] bravo in its window' }), run({ kind: 'refused', why: 'bravo asks nothing now' })];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    await hand.focus();
    await hand.focus();
    assert.deepEqual(host.toasts.slice(-2).map((each) => each.text), ['selected [app] bravo in its window', 'Focus not run: bravo asks nothing now']);
  });

  it('toasts a failed run and never rejects', async () => {
    const host = new FakeHost();
    host.answers['needs-you'] = [asks(BRAVO)];
    host.answers['needs-you-focus'] = [run('boom', 1)];
    const hand = new NeedsYouHand(host);
    await hand.tick();
    const failed = await hand.focus();
    assert.equal(failed.kind, 'failed');
    assert.match(host.toasts.at(-1)?.text ?? '', /^Focus failed: hook needs-you-focus exited 1/);
  });

  it('offers no Focus for an ask the CLI holds back, or with no ask shown', async () => {
    const host = new FakeHost();
    const hand = new NeedsYouHand(host);
    assert.deepEqual(await hand.focus(), { kind: 'idle' });
    host.answers['needs-you'] = [asks(ALPHA)];
    await hand.tick();
    assert.deepEqual(await hand.focus(), { kind: 'idle' });
    assert.equal(host.calls.filter((each) => each.command === 'needs-you-focus').length, 0);
  });
});
