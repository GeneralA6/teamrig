import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LockBusyError, type Mutex } from '../core/lock.ts';
import { FAKE_START_MENU_SHORTCUT, FakeLogonEntry, FakeShortcutPlace } from '../testing/fake-restore.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { restoreLaunchers, type Launcher } from './install-plan.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT } from './launcher.ts';
import { LAUNCHER_RECORD_FORMAT, launcherRecordPath, lowerRecordSteps, refreshLaunchers, type LauncherRefresh } from './launcher-refresh.ts';
import { restoreLogPath } from './registry.ts';
import { RESTORE_SHORTCUT_DESCRIPTION, shortcutLine, type Shortcut } from './shortcut.ts';

const KIT = 'D:\\homes\\pat\\.teamrig';
const HOME = 'D:\\homes\\pat';
const NODE = 'C:\\nodejs\\node.exe';
const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const AT = '2030-01-08T10:00:00.000Z';
const { check: CHECK, run: RUN } = restoreLaunchers(KIT);
const RECORD = launcherRecordPath(KIT);
const LOG = restoreLogPath(KIT);
const PIN = 'C:\\Roaming\\Quick Launch\\User Pinned\\TaskBar\\Restore Claude Sessions.lnk';
const STATUSLINE: Launcher = { path: 'D:\\homes\\pat\\.teamrig\\bin\\statusline.mjs', text: '// the status line launcher\n' };
const WANTED: Shortcut = { target: NODE, arguments: `"${RUN.path}"`, folder: HOME, description: RESTORE_SHORTCUT_DESCRIPTION };
const OLD_SHORTCUT: Shortcut = { ...WANTED, target: 'C:\\old\\node.exe' };
const OLDER_TEXT = '// an older launcher\n';
const OLD_COMMAND = new FakeLogonEntry().commandFor('C:\\old\\node.exe', CHECK.path);
const OLD_INSTALL = { [CHECK.path]: OLDER_TEXT, [RUN.path]: OLDER_TEXT, [STATUSLINE.path]: OLDER_TEXT };

function record(version: string, format: number = LAUNCHER_RECORD_FORMAT): string {
  return `${JSON.stringify({ v: format, version, at: '2030-01-01T10:00:00.000Z' }, null, 2)}\n`;
}

interface World {
  readonly files: MemoryFiles;
  readonly logon: FakeLogonEntry;
  readonly shortcuts: FakeShortcutPlace;
  readonly lock: InlineMutex;
  readonly refresh: LauncherRefresh;
}

interface Parts {
  readonly files?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly shortcuts?: FakeShortcutPlace;
  readonly version?: string;
  readonly lock?: Mutex;
}

function worldOf(parts: Parts): World {
  const files = new MemoryFiles(parts.files);
  const logon = new FakeLogonEntry(parts.command);
  const shortcuts = parts.shortcuts ?? new FakeShortcutPlace();
  const lock = new InlineMutex();
  const machine = { files, kitHome: KIT, node: NODE, userHome: HOME, logon, shortcuts };
  const refresh: LauncherRefresh = { machine, others: [STATUSLINE], lock: parts.lock ?? lock, version: parts.version ?? '0.282.1', now: NOW };
  return { files, logon, shortcuts, lock, refresh };
}

/** A machine an older teamrig installed: older launchers, its logon entry and two shortcuts on another Node. */
function oldInstall(extra: Readonly<Record<string, string>> = {}): World {
  const shortcuts = new FakeShortcutPlace([
    { path: FAKE_START_MENU_SHORTCUT, ...OLD_SHORTCUT },
    { path: PIN, ...OLD_SHORTCUT },
  ]);
  return worldOf({ files: { ...OLD_INSTALL, ...extra }, command: OLD_COMMAND, shortcuts });
}

/** A lock another start holds: taking it fails at once. */
class BusyMutex implements Mutex {
  async run<T>(): Promise<T> {
    throw new LockBusyError(`${RECORD}.lock`, 0);
  }
}

/** A lock taken after another start wrote `text` to the record. */
class RefreshedMeanwhileMutex implements Mutex {
  private readonly files: MemoryFiles;
  private readonly text: string;

  constructor(files: MemoryFiles, text: string) {
    this.files = files;
    this.text = text;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.files.write(RECORD, this.text);
    return task();
  }
}

/** A lock whose file cannot be written. */
class BrokenMutex implements Mutex {
  async run<T>(): Promise<T> {
    throw new Error('EACCES: the lock file cannot be written');
  }
}

describe('refreshLaunchers', () => {
  it('rewrites old launchers after a version change, repoints the logon entry and each shortcut, logs each step and records the version', async () => {
    const { files, logon, shortcuts, refresh } = oldInstall({ [RECORD]: record('0.282.0') });
    const command = logon.commandFor(NODE, CHECK.path);
    const steps = [
      `WRITE ${STATUSLINE.path}`,
      `WRITE ${CHECK.path}`,
      `WRITE ${RUN.path}`,
      `SET ${logon.where}: ${OLD_COMMAND} -> ${command}`,
      `SET ${FAKE_START_MENU_SHORTCUT}: ${shortcutLine(OLD_SHORTCUT)} -> ${shortcutLine(WANTED)}`,
      `SET ${PIN}: ${shortcutLine(OLD_SHORTCUT)} -> ${shortcutLine(WANTED)}`,
    ];
    assert.deepEqual(await refreshLaunchers(refresh), { kind: 'refreshed', steps });
    assert.deepEqual(
      [files.get(STATUSLINE.path), files.get(CHECK.path), files.get(RUN.path), logon.command],
      [STATUSLINE.text, RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, command],
    );
    assert.deepEqual([...shortcuts.shortcuts], [[FAKE_START_MENU_SHORTCUT, WANTED], [PIN, WANTED]]);
    assert.equal(files.get(LOG), steps.map((line) => `${AT} launchers: 0.282.0 -> 0.282.1: ${line}\n`).join(''));
    assert.equal(files.get(RECORD), `${JSON.stringify({ v: LAUNCHER_RECORD_FORMAT, version: '0.282.1', at: AT }, null, 2)}\n`);
  });

  it('refreshes a machine with no record as one an older teamrig set up, logging its old version as none', async () => {
    const { files, refresh } = oldInstall();
    const outcome = await refreshLaunchers(refresh);
    assert.equal(outcome.kind, 'refreshed');
    assert.match(files.get(LOG) ?? '', new RegExp(`^${AT} launchers: none -> 0\\.282\\.1: WRITE `));
  });

  it('takes a damaged record, or one of no release version, for no record', async () => {
    for (const damaged of ['{ torn', record('dev'), '{"v":1}\n', '{"v":"one","version":"0.282.0"}\n']) {
      const { files, refresh } = oldInstall({ [RECORD]: damaged });
      assert.equal((await refreshLaunchers(refresh)).kind, 'refreshed', damaged);
      assert.equal(files.get(CHECK.path), RESTORE_CHECK_LAUNCHER_SCRIPT);
    }
  });

  it('creates nothing on a machine that never ran install, logs nothing, and records the version so later starts only read it', async () => {
    const { files, logon, shortcuts, refresh } = worldOf({});
    shortcuts.scanFailWith = 'a refresh with no run launcher must not scan';
    assert.deepEqual(await refreshLaunchers(refresh), { kind: 'refreshed', steps: [] });
    assert.deepEqual([files.paths(), logon.command, shortcuts.shortcuts.size], [[RECORD.replaceAll('\\', '/')], undefined, 0]);
  });

  it('only reads the record when it names this version: no lock, no logon read, no scan, no write', async () => {
    const { files, lock, shortcuts, refresh } = oldInstall({ [RECORD]: record('0.282.1') });
    shortcuts.scanFailWith = 'a current record must not scan';
    assert.deepEqual(await refreshLaunchers(refresh), { kind: 'current' });
    assert.deepEqual([lock.runs, files.get(CHECK.path), files.get(LOG)], [0, OLDER_TEXT, undefined]);
  });

  it('writes nothing while an older teamrig runs beside a newer one that refreshed, so the two never take turns', async () => {
    for (const newer of [record('0.282.2'), record('0.290.0'), record('1.0.0'), record('0.282.0', LAUNCHER_RECORD_FORMAT + 1)]) {
      const { files, lock, refresh } = oldInstall({ [RECORD]: newer });
      assert.deepEqual(await refreshLaunchers(refresh), { kind: 'current' }, newer);
      assert.deepEqual([lock.runs, files.get(CHECK.path), files.get(RECORD)], [0, OLDER_TEXT, newer]);
    }
  });

  it('refreshes nothing when the running version is no release version', async () => {
    const { files, lock, refresh } = oldInstall();
    assert.deepEqual(await refreshLaunchers({ ...refresh, version: '0.282.1-dev' }), { kind: 'current' });
    assert.deepEqual([lock.runs, files.get(CHECK.path)], [0, OLDER_TEXT]);
  });

  it('leaves the refresh to the start that holds the lock: a busy lock skips and writes nothing', async () => {
    const { files, refresh } = oldInstall();
    assert.deepEqual(await refreshLaunchers({ ...refresh, lock: new BusyMutex() }), { kind: 'busy' });
    assert.deepEqual([files.get(CHECK.path), files.get(RECORD), files.get(LOG)], [OLDER_TEXT, undefined, undefined]);
  });

  it('reads the record again under the lock: one another start wrote meanwhile ends the refresh', async () => {
    const { files, refresh } = oldInstall();
    const lock = new RefreshedMeanwhileMutex(files, record('0.282.1'));
    assert.deepEqual(await refreshLaunchers({ ...refresh, lock }), { kind: 'current' });
    assert.deepEqual([files.get(CHECK.path), files.get(LOG)], [OLDER_TEXT, undefined]);
  });

  it('logs a failed step after the ones done and keeps the record, so the next session start tries again', async () => {
    const { files, logon, shortcuts, refresh } = oldInstall({ [RECORD]: record('0.282.0') });
    logon.failWith = 'Access is denied';
    const command = logon.commandFor(NODE, CHECK.path);
    const failed = `FAILED SET ${logon.where}: ${OLD_COMMAND} -> ${command}: Access is denied; the next session start tries again`;
    assert.deepEqual(await refreshLaunchers(refresh), { kind: 'failed', line: failed });
    const logged = [`WRITE ${STATUSLINE.path}`, `WRITE ${CHECK.path}`, `WRITE ${RUN.path}`, failed];
    assert.equal(files.get(LOG), logged.map((line) => `${AT} launchers: 0.282.0 -> 0.282.1: ${line}\n`).join(''));
    assert.deepEqual([files.get(RECORD), [...shortcuts.shortcuts.values()]], [record('0.282.0'), [OLD_SHORTCUT, OLD_SHORTCUT]]);
  });

  it('logs a machine it cannot read, changes nothing and keeps the record', async () => {
    const { files, shortcuts, refresh } = oldInstall();
    shortcuts.scanFailWith = 'powershell timed out after 30 s';
    const failed = 'FAILED reading what is out of date: powershell timed out after 30 s; the next session start tries again';
    assert.deepEqual(await refreshLaunchers(refresh), { kind: 'failed', line: failed });
    assert.deepEqual([files.get(LOG), files.get(CHECK.path), files.get(RECORD)], [`${AT} launchers: none -> 0.282.1: ${failed}\n`, OLDER_TEXT, undefined]);
  });

  it('passes on a lock that fails for any other reason than another holder', async () => {
    const { refresh } = oldInstall();
    await assert.rejects(refreshLaunchers({ ...refresh, lock: new BrokenMutex() }), /EACCES/);
  });
});

describe('lowerRecordSteps', () => {
  it('lowers a record of a newer version or format to this one, so the next start of a newer teamrig refreshes again', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [record('0.290.0'), '0.290.0'],
      [record('0.282.0', LAUNCHER_RECORD_FORMAT + 1), 'a newer format'],
    ];
    for (const [newer, from] of cases) {
      const { files, refresh } = oldInstall({ [RECORD]: newer });
      const steps = await lowerRecordSteps(files, KIT, '0.282.1', NOW);
      assert.deepEqual(
        steps.map((step) => step.line),
        [`SET ${RECORD}: ${from} -> 0.282.1, so the next start of a newer teamrig refreshes what this writes`],
      );
      assert.equal(files.get(RECORD), newer, 'nothing is written before the step is taken');
      for (const step of steps) {
        await step.act();
      }
      assert.equal(files.get(RECORD), `${JSON.stringify({ v: LAUNCHER_RECORD_FORMAT, version: '0.282.1', at: AT }, null, 2)}\n`);
      assert.equal((await refreshLaunchers({ ...refresh, version: '0.290.0' })).kind, 'refreshed', from);
      assert.equal(files.get(CHECK.path), RESTORE_CHECK_LAUNCHER_SCRIPT);
    }
  });

  it('lowers nothing for a record of this version or an older one, for none or a damaged one, or for no release version', async () => {
    const cases: ReadonlyArray<readonly [string | undefined, string]> = [
      [record('0.282.1'), '0.282.1'],
      [record('0.282.0'), '0.282.1'],
      [undefined, '0.282.1'],
      ['{ torn', '0.282.1'],
      [record('0.290.0'), '0.282.1-dev'],
    ];
    for (const [text, version] of cases) {
      const files = new MemoryFiles(text === undefined ? {} : { [RECORD]: text });
      assert.deepEqual(await lowerRecordSteps(files, KIT, version, NOW), [], `${text} at ${version}`);
    }
  });
});
