import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UPDATE_EVERY_MS,
  UPDATE_FIRST_MS,
  UpdateHand,
  parseUpdateAnswer,
  updateCliArgv,
  updateLine,
  type UpdateAnswer,
  type UpdateCommand,
  type UpdateHandHost,
  type UpdateNotice,
  type UpdateRun,
} from './update-hand.ts';

const TEAMRIG: UpdateNotice = { plugin: 'teamrig', marketplace: 'teamrig', installed: '0.332.0', newest: '0.333.0' };
const PANE: UpdateNotice = { plugin: 'teamrig-pane', marketplace: 'teamrig-pane', installed: '0.40.0', newest: '0.41.0' };

function run(answer: UpdateAnswer): UpdateRun {
  return { exitCode: 0, stdout: `${JSON.stringify(answer)}\n` };
}

/** Claude Code as the mod sees it: the CLI's answer per command, and what each run was asked. */
class FakeHost implements UpdateHandHost {
  readonly answers: Record<UpdateCommand, UpdateRun> = {
    check: run({ kind: 'notices', notices: [TEAMRIG, PANE] }),
    dismiss: run({ kind: 'dismissed' }),
    apply: run({ kind: 'applied', plugin: 'teamrig', version: '0.333.0' }),
  };
  readonly calls: { readonly command: UpdateCommand; readonly stdin: unknown }[] = [];
  readonly toasts: string[] = [];

  async cli(command: UpdateCommand, stdin: string): Promise<UpdateRun> {
    this.calls.push({ command, stdin: JSON.parse(stdin) });
    return this.answers[command];
  }

  toast(text: string): void {
    this.toasts.push(text);
  }
}

/** A hand past its first check, which told of both updates. */
async function checked(host: FakeHost): Promise<UpdateHand> {
  const hand = new UpdateHand(host);
  assert.deepEqual(await hand.tick(), { kind: 'checked', notices: [TEAMRIG, PANE] });
  return hand;
}

describe('update schedule', () => {
  it('asks first a minute after the mod loads, then every 10 minutes', () => {
    assert.equal(UPDATE_FIRST_MS, 60_000);
    assert.equal(UPDATE_EVERY_MS, 600_000);
  });
});

describe('updateCliArgv', () => {
  it("runs the plugin's CLI as hook update-<command>", () => {
    assert.deepEqual(updateCliArgv('/plugins/teamrig', 'apply'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'update-apply']);
  });
});

describe('updateLine', () => {
  it('names the plugin, the newest version and the one the tab runs', () => {
    assert.equal(updateLine(TEAMRIG), 'teamrig 0.333.0 is out (you run 0.332.0)');
  });
});

describe('parseUpdateAnswer', () => {
  it('reads each answer the CLI gives', () => {
    const answers: readonly UpdateAnswer[] = [
      { kind: 'notices', notices: [TEAMRIG] },
      { kind: 'dismissed' },
      { kind: 'applied', plugin: 'teamrig', version: '0.333.0' },
      { kind: 'failed', why: 'Claude Code is not on PATH' },
    ];
    for (const answer of answers) {
      assert.deepEqual(parseUpdateAnswer(JSON.stringify(answer)), answer);
    }
  });

  it('takes nothing else', () => {
    assert.equal(parseUpdateAnswer('not json'), undefined);
    assert.equal(parseUpdateAnswer('{"kind":"notices","notices":[{"plugin":"teamrig"}]}'), undefined);
    assert.equal(parseUpdateAnswer('{"kind":"applied","plugin":"teamrig"}'), undefined);
    assert.equal(parseUpdateAnswer('{"kind":"failed"}'), undefined);
    assert.equal(parseUpdateAnswer('[]'), undefined);
  });
});

describe('UpdateHand', () => {
  it('shows the first update a check told of, and none once a check tells of none', async () => {
    const host = new FakeHost();
    const hand = new UpdateHand(host);
    assert.equal(hand.notice(), undefined);
    assert.deepEqual(await hand.tick(), { kind: 'checked', notices: [TEAMRIG, PANE] });
    assert.deepEqual(host.calls, [{ command: 'check', stdin: {} }]);
    assert.deepEqual(hand.notice(), TEAMRIG);
    host.answers.check = run({ kind: 'notices', notices: [] });
    assert.deepEqual(await hand.tick(), { kind: 'checked', notices: [] });
    assert.equal(hand.notice(), undefined);
  });

  it('updates the shown plugin, toasts it and shows the next update', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    assert.deepEqual(await hand.apply(), { kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
    assert.deepEqual(host.calls.at(-1), { command: 'apply', stdin: { plugin: 'teamrig' } });
    assert.deepEqual(host.toasts, ['teamrig 0.333.0 installed: the tab reloads it']);
    assert.deepEqual(hand.notice(), PANE);
  });

  it('dismisses the shown version and shows the next update', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    assert.deepEqual(await hand.dismiss(), { kind: 'dismissed', plugin: 'teamrig', version: '0.333.0' });
    assert.deepEqual(host.calls.at(-1), { command: 'dismiss', stdin: { plugin: 'teamrig', version: '0.333.0' } });
    assert.deepEqual(host.toasts, []);
    assert.deepEqual(hand.notice(), PANE);
  });

  it('keeps the update shown and toasts why when an update or a dismissal fails', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.apply = run({ kind: 'failed', why: 'plugin update failed: offline' });
    assert.deepEqual(await hand.apply(), { kind: 'failed', error: 'plugin update failed: offline' });
    host.answers.dismiss = { exitCode: 1, stdout: 'boom' };
    assert.deepEqual(await hand.dismiss(), { kind: 'failed', error: 'hook update-dismiss exited 1: boom' });
    host.cli = async () => {
      throw new Error('node is missing');
    };
    assert.deepEqual(await hand.apply(), { kind: 'failed', error: 'node is missing' });
    assert.deepEqual(host.toasts, [
      'teamrig update failed: plugin update failed: offline',
      'teamrig dismiss failed: hook update-dismiss exited 1: boom',
      'teamrig update failed: node is missing',
    ]);
    assert.deepEqual(hand.notice(), TEAMRIG);
  });

  it('does nothing on a press while no update is shown', async () => {
    const host = new FakeHost();
    const hand = new UpdateHand(host);
    assert.deepEqual(await hand.apply(), { kind: 'idle' });
    assert.deepEqual(await hand.dismiss(), { kind: 'idle' });
    assert.deepEqual(host.calls, []);
  });

  it('reports a check that fails or cannot start, never rejects, and keeps the updates it showed', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.check = { exitCode: 1, stdout: 'boom' };
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook update-check exited 1: boom' });
    host.cli = async () => {
      throw new Error('node is missing');
    };
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'node is missing' });
    assert.deepEqual(hand.notice(), TEAMRIG);
  });

  it('runs one CLI call at a time: a tick or a press during an update waits it out', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    let release: (() => void) | undefined;
    host.cli = (command) =>
      new Promise((resolve) => {
        release = () => resolve(host.answers[command]);
      });
    const update = hand.apply();
    assert.deepEqual(await hand.tick(), { kind: 'overlap' });
    assert.deepEqual(await hand.dismiss(), { kind: 'idle' });
    while (release === undefined) {
      await Promise.resolve();
    }
    release();
    assert.deepEqual(await update, { kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
  });
});
