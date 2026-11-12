import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UPDATED_SHOW_MS,
  UPDATE_EVERY_MS,
  UPDATE_FIRST_MS,
  UPDATE_WATCH_MS,
  UpdateHand,
  parseUpdateAnswer,
  updateBandOf,
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

/** A promise the spec opens by hand, to hold a CLI run while it looks at the hand. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Lets every awaiting step of the hand run on. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Claude Code as the mod sees it: the CLI's answer per command, held while a gate is shut, and a clock. */
class FakeHost implements UpdateHandHost {
  readonly answers: Record<UpdateCommand, UpdateRun> = {
    check: run({ kind: 'notices', notices: [TEAMRIG, PANE] }),
    dismiss: run({ kind: 'dismissed' }),
    apply: run({ kind: 'applied', plugin: 'teamrig', version: '0.333.0' }),
  };
  readonly gates: Partial<Record<UpdateCommand, Promise<void>>> = {};
  readonly calls: { readonly command: UpdateCommand; readonly stdin: unknown }[] = [];
  readonly toasts: string[] = [];
  changes = 0;
  clock = 1_000_000;
  installedAt: () => Promise<number | undefined> = async () => undefined;

  async cli(command: UpdateCommand, stdin: string): Promise<UpdateRun> {
    this.calls.push({ command, stdin: JSON.parse(stdin) });
    const held = this.gates[command];
    if (held !== undefined) {
      await held;
    }
    return this.answers[command];
  }

  toast(text: string): void {
    this.toasts.push(text);
  }

  changed(): void {
    this.changes += 1;
  }

  installedChangedAt(): Promise<number | undefined> {
    return this.installedAt();
  }

  now(): number {
    return this.clock;
  }
}

/** A hand past its first check, which told of both updates. */
async function checked(host: FakeHost): Promise<UpdateHand> {
  const hand = new UpdateHand(host);
  assert.deepEqual(await hand.tick(), { kind: 'checked', notices: [TEAMRIG, PANE] });
  return hand;
}

describe('update schedule', () => {
  it('asks first a minute after the mod loads, then every 10 minutes, and dates the installs every 5 seconds', () => {
    assert.equal(UPDATE_FIRST_MS, 60_000);
    assert.equal(UPDATE_EVERY_MS, 600_000);
    assert.equal(UPDATE_WATCH_MS, 5_000);
    assert.equal(UPDATED_SHOW_MS, 30_000);
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

describe('updateBandOf', () => {
  it('draws an update out in green with Update and Dismiss', () => {
    assert.deepEqual(updateBandOf({ kind: 'available', notice: TEAMRIG }), {
      text: 'teamrig: teamrig 0.333.0 is out (you run 0.332.0)',
      color: 'success',
      buttons: ['update', 'dismiss'],
    });
  });

  it('draws an update installing, then installed, in green with no buttons', () => {
    assert.deepEqual(updateBandOf({ kind: 'updating', notice: TEAMRIG }), {
      text: 'teamrig: updating teamrig to 0.333.0...',
      color: 'success',
      buttons: [],
    });
    assert.deepEqual(updateBandOf({ kind: 'updated', plugin: 'teamrig', version: '0.333.0' }), {
      text: 'teamrig: updated to teamrig 0.333.0, reloading',
      color: 'success',
      buttons: [],
    });
  });

  it('draws a failed update in red with Update again, its reason cut to 80 characters', () => {
    assert.deepEqual(updateBandOf({ kind: 'failed', notice: TEAMRIG, why: 'offline' }), {
      text: 'teamrig: teamrig 0.333.0 update failed: offline',
      color: 'error',
      buttons: ['update', 'dismiss'],
    });
    const band = updateBandOf({ kind: 'failed', notice: TEAMRIG, why: 'x'.repeat(200) });
    assert.equal(band.text, `teamrig: teamrig 0.333.0 update failed: ${'x'.repeat(77)}...`);
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
    assert.equal(hand.view(), undefined);
    assert.deepEqual(await hand.tick(), { kind: 'checked', notices: [TEAMRIG, PANE] });
    assert.deepEqual(host.calls, [{ command: 'check', stdin: {} }]);
    assert.deepEqual(hand.view(), { kind: 'available', notice: TEAMRIG });
    assert.equal(host.changes, 1);
    host.answers.check = run({ kind: 'notices', notices: [] });
    assert.deepEqual(await hand.tick(), { kind: 'checked', notices: [] });
    assert.equal(hand.view(), undefined);
  });

  it('shows updating at once on a press, then updated for 30 seconds, then the next update', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    const held = gate();
    host.gates.apply = held.wait;
    const changesBefore = host.changes;
    const update = hand.apply();
    await settle();
    assert.deepEqual(hand.view(), { kind: 'updating', notice: TEAMRIG });
    assert.equal(host.changes, changesBefore + 1);
    held.open();
    assert.deepEqual(await update, { kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
    assert.deepEqual(host.calls.at(-1), { command: 'apply', stdin: { plugin: 'teamrig' } });
    assert.deepEqual(host.toasts, ['teamrig 0.333.0 installed: the tab reloads it']);
    assert.equal(host.changes, changesBefore + 2);
    assert.deepEqual(hand.view(), { kind: 'updated', plugin: 'teamrig', version: '0.333.0' });
    host.clock += UPDATED_SHOW_MS - 1;
    assert.deepEqual(hand.view(), { kind: 'updated', plugin: 'teamrig', version: '0.333.0' });
    host.clock += 1;
    assert.deepEqual(hand.view(), { kind: 'available', notice: PANE });
  });

  it('takes no press while it shows an update installing or installed', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    assert.equal((await hand.apply()).kind, 'applied');
    const calls = host.calls.length;
    assert.deepEqual(await hand.apply(), { kind: 'idle' });
    assert.deepEqual(await hand.dismiss(), { kind: 'idle' });
    assert.equal(host.calls.length, calls);
  });

  it('dismisses the shown version and shows the next update', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    assert.deepEqual(await hand.dismiss(), { kind: 'dismissed', plugin: 'teamrig', version: '0.333.0' });
    assert.deepEqual(host.calls.at(-1), { command: 'dismiss', stdin: { plugin: 'teamrig', version: '0.333.0' } });
    assert.deepEqual(host.toasts, []);
    assert.deepEqual(hand.view(), { kind: 'available', notice: PANE });
  });

  it('shows a failed update with its reason, and a second Update tries again', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.apply = run({ kind: 'failed', why: 'plugin update failed: offline' });
    assert.deepEqual(await hand.apply(), { kind: 'failed', error: 'plugin update failed: offline' });
    assert.deepEqual(hand.view(), { kind: 'failed', notice: TEAMRIG, why: 'plugin update failed: offline' });
    assert.deepEqual(host.toasts, ['teamrig update failed: plugin update failed: offline']);
    host.answers.apply = run({ kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
    assert.equal((await hand.apply()).kind, 'applied');
    assert.deepEqual(hand.view(), { kind: 'updated', plugin: 'teamrig', version: '0.333.0' });
  });

  it('keeps the update shown and toasts why when a dismissal fails or the CLI cannot start', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.dismiss = { exitCode: 1, stdout: 'boom' };
    assert.deepEqual(await hand.dismiss(), { kind: 'failed', error: 'hook update-dismiss exited 1: boom' });
    assert.deepEqual(hand.view(), { kind: 'available', notice: TEAMRIG });
    host.answers.dismiss = run({ kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
    assert.deepEqual(await hand.dismiss(), { kind: 'failed', error: 'hook update-dismiss answered applied' });
    host.answers.apply = run({ kind: 'dismissed' });
    assert.deepEqual(await hand.apply(), { kind: 'failed', error: 'hook update-apply answered dismissed' });
    host.cli = async () => {
      throw new Error('node is missing');
    };
    assert.deepEqual(await hand.apply(), { kind: 'failed', error: 'node is missing' });
    assert.deepEqual(host.toasts, [
      'teamrig dismiss failed: hook update-dismiss exited 1: boom',
      'teamrig dismiss failed: hook update-dismiss answered applied',
      'teamrig update failed: hook update-apply answered dismissed',
      'teamrig update failed: node is missing',
    ]);
    assert.deepEqual(hand.view(), { kind: 'failed', notice: TEAMRIG, why: 'node is missing' });
  });

  it('forgets a failed update once a check no longer tells of its plugin', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.apply = run({ kind: 'failed', why: 'offline' });
    await hand.apply();
    host.answers.check = run({ kind: 'notices', notices: [PANE] });
    await hand.tick();
    assert.deepEqual(hand.view(), { kind: 'available', notice: PANE });
    host.answers.check = run({ kind: 'notices', notices: [TEAMRIG, PANE] });
    await hand.tick();
    assert.deepEqual(hand.view(), { kind: 'available', notice: TEAMRIG });
  });

  it('keeps a failed update shown while a check still tells of its plugin', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.apply = run({ kind: 'failed', why: 'offline' });
    await hand.apply();
    await hand.tick();
    assert.deepEqual(hand.view(), { kind: 'failed', notice: TEAMRIG, why: 'offline' });
  });

  it('does nothing on a press while no update is shown', async () => {
    const host = new FakeHost();
    const hand = new UpdateHand(host);
    assert.deepEqual(await hand.apply(), { kind: 'idle' });
    assert.deepEqual(await hand.dismiss(), { kind: 'idle' });
    assert.deepEqual(host.calls, []);
  });

  it('reports a check that fails, answers wrong or cannot start, never rejects, and keeps the updates it showed', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    host.answers.check = { exitCode: 1, stdout: 'boom' };
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook update-check exited 1: boom' });
    host.answers.check = run({ kind: 'failed', why: 'offline' });
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'offline' });
    host.answers.check = run({ kind: 'dismissed' });
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook update-check answered dismissed' });
    host.cli = async () => {
      throw new Error('node is missing');
    };
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'node is missing' });
    assert.deepEqual(hand.view(), { kind: 'available', notice: TEAMRIG });
  });

  it('runs one press at a time: a tick or a press during an update waits it out', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    const held = gate();
    host.gates.apply = held.wait;
    const update = hand.apply();
    assert.deepEqual(await hand.tick(), { kind: 'overlap' });
    assert.deepEqual(await hand.dismiss(), { kind: 'idle' });
    held.open();
    assert.deepEqual(await update, { kind: 'applied', plugin: 'teamrig', version: '0.333.0' });
  });

  it('answers a press while a check runs, and drops that check answer read before the press', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    const held = gate();
    host.gates.check = held.wait;
    const check = hand.tick();
    await settle();
    assert.deepEqual(await hand.dismiss(), { kind: 'dismissed', plugin: 'teamrig', version: '0.333.0' });
    held.open();
    assert.deepEqual(await check, { kind: 'overlap' });
    assert.deepEqual(hand.view(), { kind: 'available', notice: PANE });
  });
});

describe('UpdateHand.watch', () => {
  it('only notes the date at its first look, and checks nothing while the date stays', async () => {
    const host = new FakeHost();
    const hand = new UpdateHand(host);
    host.installedAt = async () => 500;
    assert.deepEqual(await hand.watch(), { kind: 'unchanged' });
    assert.deepEqual(await hand.watch(), { kind: 'unchanged' });
    assert.deepEqual(host.calls, []);
  });

  it('checks at once when another tab or claude plugin update changed the installs, and hides the band', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    let date = 500;
    host.installedAt = async () => date;
    await hand.watch();
    date = 900;
    host.answers.check = run({ kind: 'notices', notices: [] });
    assert.deepEqual(await hand.watch(), { kind: 'changed', tick: { kind: 'checked', notices: [] } });
    assert.equal(hand.view(), undefined);
    assert.deepEqual(await hand.watch(), { kind: 'unchanged' });
    assert.equal(host.calls.filter((each) => each.command === 'check').length, 2);
  });

  it('leaves a change unseen while a press runs, and checks it at the next look', async () => {
    const host = new FakeHost();
    const hand = await checked(host);
    let date = 500;
    host.installedAt = async () => date;
    await hand.watch();
    const held = gate();
    host.gates.dismiss = held.wait;
    const dismissal = hand.dismiss();
    date = 900;
    assert.deepEqual(await hand.watch(), { kind: 'changed', tick: { kind: 'overlap' } });
    held.open();
    await dismissal;
    assert.deepEqual(await hand.watch(), { kind: 'changed', tick: { kind: 'checked', notices: [TEAMRIG, PANE] } });
  });

  it('takes an installs file it cannot date as unchanged, never rejecting', async () => {
    const host = new FakeHost();
    const hand = new UpdateHand(host);
    assert.deepEqual(await hand.watch(), { kind: 'unchanged' });
    host.installedAt = async () => {
      throw new Error('EBUSY');
    };
    assert.deepEqual(await hand.watch(), { kind: 'unchanged' });
    assert.deepEqual(host.calls, []);
  });
});
