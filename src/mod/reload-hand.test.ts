import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_MS,
  installedFingerprint,
  installedPluginsFileOf,
  isReloadRecord,
  RELOAD_GAP_MS,
  ReloadHand,
  samePath,
  SETTLE_MS,
  type CheckResult,
  type ReloadHandHost,
  type ReloadRecord,
} from './reload-hand.ts';

const ROOT = 'D:\\work\\shop';
const CACHE = 'C:\\Users\\me\\.claude\\plugins\\cache';
const TEAMRIG = 'teamrig@teamrig';
const PANE = 'teamrig-pane@teamrig-pane';

/** One install as installed_plugins.json records it. */
interface Entry {
  readonly scope: string;
  readonly installPath: string;
  readonly version?: string;
  readonly gitCommitSha?: string;
  readonly projectPath?: string;
}

function teamrig(version: string, sha: string): Entry {
  return { scope: 'user', installPath: `${CACHE}\\teamrig\\teamrig\\${version}`, version, gitCommitSha: sha };
}

function pane(version: string): Entry {
  return { scope: 'user', installPath: `${CACHE}\\teamrig-pane\\teamrig-pane\\${version}`, version, gitCommitSha: 'c0ffee' };
}

/** installed_plugins.json (version 2) with these installs. */
function installed(plugins: Readonly<Record<string, readonly Entry[]>>, lastUpdated = '2030-01-08T10:00:00.000Z'): string {
  const withTimes = Object.fromEntries(
    Object.entries(plugins).map(([key, entries]) => [key, entries.map((entry) => ({ ...entry, lastUpdated }))]),
  );
  return `${JSON.stringify({ version: 2, plugins: withTimes }, null, 2)}\n`;
}

const AT_41 = installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], [PANE]: [pane('0.7.0')] });
const AT_42 = installed({ [TEAMRIG]: [teamrig('0.42.0', 'bbb')], [PANE]: [pane('0.7.0')] });
const AT_43 = installed({ [TEAMRIG]: [teamrig('0.43.0', 'ccc')], [PANE]: [pane('0.7.0')] });
const AT_42_PANE_8 = installed({ [TEAMRIG]: [teamrig('0.42.0', 'bbb')], [PANE]: [pane('0.8.0')] });

function fingerprintOf(text: string): string {
  const fingerprint = installedFingerprint(text, ROOT);
  assert.ok(fingerprint !== undefined, 'a test file of the right shape');
  return fingerprint;
}

/** Claude Code as the mod sees it: the installs file, the session's project root and state, and /reload-plugins. */
class FakeHost implements ReloadHandHost {
  time = 0;
  root = ROOT;
  /** installed_plugins.json's text, or the error reading it rejects with. */
  file: string | Error = AT_41;
  /** What the session kept of the last reload. */
  recalled: unknown;
  recallFailure: Error | undefined;
  rememberFailure: Error | undefined;
  /** Thrown by `projectRoot`, as a session gone. */
  rootFailure: unknown;
  /** Thrown by `reload`, as Claude Code refusing the command. */
  reloadFailure: unknown;
  /** Runs while /reload-plugins runs, as an install that lands meanwhile. */
  duringReload: () => void = () => undefined;
  /** Holds each /reload-plugins until it resolves, as it waits for the session to be idle. */
  reloading: Promise<void> = Promise.resolve();
  reloads = 0;
  readonly records: ReloadRecord[] = [];

  async readInstalled(): Promise<string> {
    if (this.file instanceof Error) {
      throw this.file;
    }
    return this.file;
  }

  async projectRoot(): Promise<string> {
    if (this.rootFailure !== undefined) {
      throw this.rootFailure;
    }
    return this.root;
  }

  async reload(): Promise<string> {
    this.reloads += 1;
    this.duringReload();
    await this.reloading;
    if (this.reloadFailure !== undefined) {
      throw this.reloadFailure;
    }
    return 'Reloaded: 3 plugins';
  }

  async recall(): Promise<unknown> {
    if (this.recallFailure !== undefined) {
      throw this.recallFailure;
    }
    return this.recalled;
  }

  async remember(record: ReloadRecord): Promise<void> {
    if (this.rememberFailure !== undefined) {
      throw this.rememberFailure;
    }
    this.records.push(record);
  }

  now(): number {
    return this.time;
  }
}

/** A hand started on the host's file, as the mod starts one when the tab loads it. */
async function started(host: FakeHost): Promise<ReloadHand> {
  const hand = new ReloadHand(host);
  await hand.start();
  return hand;
}

/** Moves the clock on by `ms` and checks, as the mod's interval does. */
async function checkAfter(hand: ReloadHand, host: FakeHost, ms: number): Promise<CheckResult> {
  host.time += ms;
  return hand.check();
}

const RELOADED: CheckResult = { kind: 'reloaded', text: 'Reloaded: 3 plugins', kept: true };

describe('ReloadHand', () => {
  it('runs no reload while the installs stay as the tab loaded them, a new lastUpdated alone included', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    host.file = installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], [PANE]: [pane('0.7.0')] }, '2030-01-09T00:00:00.000Z');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    assert.deepEqual(await checkAfter(hand, host, SETTLE_MS), { kind: 'no change' });
    assert.equal(host.reloads, 0);
  });

  it('reloads once an install changed and the file read the same for SETTLE_MS, then takes the new installs as loaded', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.file = AT_42;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'settling' });
    assert.deepEqual(await checkAfter(hand, host, SETTLE_MS - 1), { kind: 'settling' });
    assert.deepEqual(await checkAfter(hand, host, 1), RELOADED);
    assert.equal(host.reloads, 1);
    assert.deepEqual(host.records, [{ fingerprint: fingerprintOf(AT_42), at: CHECK_MS + SETTLE_MS }]);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    assert.deepEqual(await checkAfter(hand, host, RELOAD_GAP_MS), { kind: 'no change' });
    assert.equal(host.reloads, 1);
  });

  it('waits until every running turn ended, subagents\' too', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.file = AT_42;
    hand.turnStarted('main');
    hand.turnStarted('subagent');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'settling' });
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'busy' });
    hand.turnEnded('main');
    hand.turnEnded('a turn it never heard start');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'busy' });
    hand.turnEnded('subagent');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
    assert.equal(host.reloads, 1);
  });

  it('runs one reload for several installs in a row', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.file = AT_42;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'settling' });
    host.file = AT_42_PANE_8;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'settling' }, 'the second install starts the wait again');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
    assert.deepEqual(host.records.map((record) => record.fingerprint), [fingerprintOf(AT_42_PANE_8)]);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    assert.equal(host.reloads, 1);
  });

  it('holds the next reload until RELOAD_GAP_MS after the last one', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.file = AT_42;
    await checkAfter(hand, host, CHECK_MS);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
    const reloadedAt = host.time;
    host.file = AT_43;
    await checkAfter(hand, host, CHECK_MS);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'held', until: reloadedAt + RELOAD_GAP_MS });
    host.time = reloadedAt + RELOAD_GAP_MS - 1;
    assert.deepEqual(await hand.check(), { kind: 'held', until: reloadedAt + RELOAD_GAP_MS });
    host.time = reloadedAt + RELOAD_GAP_MS;
    assert.deepEqual(await hand.check(), RELOADED);
    assert.equal(host.reloads, 2);
  });

  it('keeps the gap and the installs reloaded for that the session kept from the module before the reload', async () => {
    const host = new FakeHost();
    const at = 1_000_000;
    host.time = at;
    host.recalled = { fingerprint: fingerprintOf(AT_42), at };
    const hand = await started(host);
    host.file = AT_42;
    const notAgain = 'a reload that did not take is not run again';
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'reloaded before' }, notAgain);
    host.file = AT_43;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'settling' });
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'held', until: at + RELOAD_GAP_MS });
    host.time = at + RELOAD_GAP_MS;
    assert.deepEqual(await hand.check(), RELOADED);
    host.file = AT_42;
    assert.deepEqual(await checkAfter(hand, host, RELOAD_GAP_MS), { kind: 'reloaded before' }, notAgain);
    assert.equal(host.reloads, 1);
  });

  it('waits RELOAD_GAP_MS after a refused reload, then runs it again', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.file = AT_42;
    await checkAfter(hand, host, CHECK_MS);
    host.reloadFailure = new Error('Unknown command: /reload-plugins');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'refused', error: 'Unknown command: /reload-plugins' });
    const refusedAt = host.time;
    assert.equal(host.records.length, 1, 'kept before it ran');
    host.reloadFailure = 'stopped';
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'held', until: refusedAt + RELOAD_GAP_MS });
    host.time = refusedAt + RELOAD_GAP_MS;
    assert.deepEqual(await hand.check(), { kind: 'refused', error: 'stopped' });
    host.reloadFailure = undefined;
    host.time += RELOAD_GAP_MS;
    assert.deepEqual(await hand.check(), RELOADED);
    assert.equal(host.reloads, 3);
  });

  it('reloads even when the session cannot keep its record', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.rememberFailure = new Error('state refused');
    host.file = AT_42;
    await checkAfter(hand, host, CHECK_MS);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'reloaded', text: 'Reloaded: 3 plugins', kept: false });
  });

  it('starts fresh when what the session kept is not a record or cannot be read', async () => {
    for (const recalled of [undefined, null, 'text', [1, 2], { fingerprint: 1, at: 2 }, { fingerprint: 'x', at: Number.NaN }]) {
      const host = new FakeHost();
      host.recalled = recalled;
      const hand = await started(host);
      host.file = AT_42;
      await checkAfter(hand, host, CHECK_MS);
      assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED, JSON.stringify(recalled));
    }
    const host = new FakeHost();
    host.recallFailure = new Error('no state');
    const hand = await started(host);
    host.file = AT_42;
    await checkAfter(hand, host, CHECK_MS);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
  });

  it('counts the project and local installs for this project only', async () => {
    const other = { scope: 'project', installPath: `${CACHE}\\lint\\lint\\1.0.0`, version: '1.0.0', projectPath: 'D:\\work\\other' };
    const host = new FakeHost();
    host.file = installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], 'lint@tools': [other] });
    const hand = await started(host);
    host.file = installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], 'lint@tools': [{ ...other, version: '1.1.0' }] });
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' }, "another project's install");
    const mine = { scope: 'local', installPath: `${CACHE}\\lint\\lint\\1.1.0`, version: '1.1.0', projectPath: 'd:/WORK/shop/' };
    host.file = installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], 'lint@tools': [{ ...other, version: '1.1.0' }, mine] });
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'settling' }, 'this project, spelled another way');
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
  });

  it('reads a missing, half-written or unknown file as no change, and never throws', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    const unreadable: readonly (string | Error)[] = [
      new Error('ENOENT'),
      '{"version": 2, "plugins": {',
      '[]',
      '{"version": 3}',
      '{"plugins": []}',
      '{"plugins": {"a@b": {}}}',
      '{"plugins": {"a@b": ["entry"]}}',
      '{"plugins": {"a@b": [{"scope": 1, "installPath": "/x"}]}}',
      '{"plugins": {"a@b": [{"scope": "user"}]}}',
      '{"plugins": {"a@b": [{"scope": "user", "installPath": "/x", "version": 2}]}}',
      '{"plugins": {"a@b": [{"scope": "user", "installPath": "/x", "gitCommitSha": false}]}}',
      '{"plugins": {"a@b": [{"scope": "local", "installPath": "/x", "projectPath": null}]}}',
    ];
    for (const file of unreadable) {
      host.file = file;
      assert.deepEqual(await checkAfter(hand, host, RELOAD_GAP_MS), { kind: 'no file' }, String(file));
    }
    host.file = AT_41;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    assert.equal(host.reloads, 0);
  });

  it('takes the first file it can read as loaded when it could not read one at start', async () => {
    const host = new FakeHost();
    host.file = new Error('ENOENT');
    const hand = await started(host);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no file' });
    host.file = AT_42;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    host.file = AT_43;
    await checkAfter(hand, host, CHECK_MS);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
  });

  it('starts with no installs loaded when the session root cannot be read, and reports a failed check', async () => {
    const host = new FakeHost();
    host.rootFailure = new Error('no session');
    const hand = await started(host);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'failed', error: 'no session' });
    host.rootFailure = 'gone';
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'failed', error: 'gone' });
    host.rootFailure = undefined;
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' });
    assert.equal(host.reloads, 0);
  });

  it('takes the file as it reads after the reload as loaded, or the installs it reloaded for when it cannot read it', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    host.file = AT_42;
    host.duringReload = () => {
      host.file = AT_43;
    };
    await checkAfter(hand, host, CHECK_MS);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), RELOADED);
    assert.deepEqual(await checkAfter(hand, host, CHECK_MS), { kind: 'no change' }, 'an install during the reload is loaded with it');

    const unread = new FakeHost();
    const second = await started(unread);
    unread.file = AT_42;
    unread.duringReload = () => {
      unread.file = new Error('EBUSY');
    };
    await checkAfter(second, unread, CHECK_MS);
    assert.deepEqual(await checkAfter(second, unread, CHECK_MS), RELOADED);
    unread.file = AT_42;
    assert.deepEqual(await checkAfter(second, unread, CHECK_MS), { kind: 'no change' });

    const rootless = new FakeHost();
    const third = await started(rootless);
    rootless.file = AT_42;
    rootless.duringReload = () => {
      rootless.rootFailure = new Error('no session');
    };
    await checkAfter(third, rootless, CHECK_MS);
    assert.deepEqual(await checkAfter(third, rootless, CHECK_MS), RELOADED);
    rootless.rootFailure = undefined;
    assert.deepEqual(await checkAfter(third, rootless, CHECK_MS), { kind: 'no change' });
  });

  it('skips a check while the one before still runs', async () => {
    const host = new FakeHost();
    const hand = await started(host);
    let release = (): void => undefined;
    host.reloading = new Promise((resolve) => {
      release = resolve;
    });
    host.file = AT_42;
    await checkAfter(hand, host, CHECK_MS);
    host.time += CHECK_MS;
    const first = hand.check();
    assert.deepEqual(await hand.check(), { kind: 'overlap' });
    release();
    assert.deepEqual(await first, RELOADED);
    assert.equal(host.reloads, 1);
  });
});

describe('installedFingerprint', () => {
  it('is the same for the same installs in any order, with a missing version or commit as empty', () => {
    const bare = { scope: 'user', installPath: '/home/me/.claude/plugins/cache/m/p/1.0.0' };
    const a = installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], 'p@m': [bare] });
    const b = installed({ 'p@m': [bare], [TEAMRIG]: [teamrig('0.41.0', 'aaa')] });
    assert.equal(installedFingerprint(a, ROOT), installedFingerprint(b, ROOT));
    assert.equal(
      installedFingerprint(installed({ 'p@m': [bare] }), ROOT),
      JSON.stringify(['p@m', '/home/me/.claude/plugins/cache/m/p/1.0.0', '', '']),
    );
    assert.equal(installedFingerprint('{"version": 2, "plugins": {}}', ROOT), '');
  });

  it('changes with an install added, removed or moved to another version or commit', () => {
    const base = fingerprintOf(AT_41);
    for (const changed of [
      installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')] }),
      installed({ [TEAMRIG]: [teamrig('0.41.0', 'aaa')], [PANE]: [pane('0.7.0')], 'p@m': [pane('1.0.0')] }),
      installed({ [TEAMRIG]: [teamrig('0.41.0', 'abc')], [PANE]: [pane('0.7.0')] }),
      AT_42,
    ]) {
      assert.notEqual(fingerprintOf(changed), base);
    }
  });
});

describe('samePath', () => {
  it('treats Windows paths alike whatever their case and slashes, and POSIX paths exactly', () => {
    assert.equal(samePath('D:\\Work\\Shop', 'd:/work/shop/'), true);
    assert.equal(samePath('\\\\server\\share\\shop', '//SERVER/share/shop'), true);
    assert.equal(samePath('D:\\work\\shop', 'D:\\work\\other'), false);
    assert.equal(samePath('C:/shop', '/shop'), false);
    assert.equal(samePath('/home/me/shop/', '/home/me/shop'), true);
    assert.equal(samePath('/home/me/shop', '/home/me/Shop'), false);
    assert.equal(samePath('/', '/'), true);
  });
});

describe('installedPluginsFileOf', () => {
  it('finds installed_plugins.json beside the cache a plugin runs from', () => {
    assert.equal(installedPluginsFileOf(`${CACHE}\\teamrig\\teamrig\\0.41.0`), 'C:/Users/me/.claude/plugins/installed_plugins.json');
    assert.equal(
      installedPluginsFileOf('/home/me/.config/claude/plugins/cache/teamrig/teamrig/0.41.0/'),
      '/home/me/.config/claude/plugins/installed_plugins.json',
    );
  });

  it('finds none for a plugin run from anywhere else', () => {
    for (const root of ['D:\\src\\teamrig\\plugins\\teamrig','/home/me/plugins/teamrig/0.41.0', 'plugins/cache/m/p/1', '']) {
      assert.equal(installedPluginsFileOf(root), undefined, root);
    }
  });
});

describe('isReloadRecord', () => {
  it('takes a fingerprint and a finite time only', () => {
    assert.equal(isReloadRecord({ fingerprint: 'x', at: 1 }), true);
    for (const value of [undefined, null, 'x', [], { fingerprint: 'x' }, { at: 1 }, { fingerprint: 'x', at: Number.POSITIVE_INFINITY }]) {
      assert.equal(isReloadRecord(value), false, JSON.stringify(value));
    }
  });
});
