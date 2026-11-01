import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT } from '../restore/launcher.ts';
import { RESTORE_SHORTCUT_DESCRIPTION, shortcutLine, type FoundShortcut, type Shortcut } from '../restore/shortcut.ts';
import { CliHarness, KIT, USER_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { FAKE_START_MENU_SHORTCUT, FakeLogonEntry, FakeShortcutPlace, quietRestore } from '../testing/fake-restore.ts';
import { EXIT } from './runtime.ts';

const LAUNCHER = join(KIT, 'bin', 'restore-check.mjs');
const RUN_LAUNCHER = join(KIT, 'bin', 'restore-run.mjs');
const WHERE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run TeamrigSessionRestore';
/** The command the fake entry builds for the harness's Node and the launcher. */
const COMMAND = `"C:\\Windows\\System32\\conhost.exe" --headless "/usr/bin/node" "${LAUNCHER}"`;
const OLD_COMMAND = `"C:\\Windows\\System32\\conhost.exe" --headless "C:\\old\\node.exe" "${LAUNCHER}"`;
/** The shortcut install wants: the harness's Node running the run launcher, in the person's home folder. */
const WANTED: Shortcut = { target: '/usr/bin/node', arguments: `"${RUN_LAUNCHER}"`, folder: USER_HOME, description: RESTORE_SHORTCUT_DESCRIPTION };
const PIN = 'C:\\Roaming\\Quick Launch\\User Pinned\\TaskBar\\Restore Claude Sessions.lnk';
const DESKTOP = 'C:\\Desktop\\Restore Claude Sessions.lnk';
/** A shortcut made by hand before the run launcher: Windows Terminal running a script of its own. */
const OLD: Shortcut = {
  target: 'C:\\WindowsApps\\wt.exe',
  arguments: '-w claude-restore new-tab "C:\\node.exe" "C:\\restore-now\\restore-now.mjs"',
  folder: '',
  description: 'Restore Claude sessions',
};

function onWindows(entry: FakeLogonEntry, shortcuts?: FakeShortcutPlace): RunOptions {
  return { platform: 'win32', restore: { ...quietRestore(), logon: entry, shortcuts } };
}

function found(path: string, shortcut: Shortcut): FoundShortcut {
  return { path, ...shortcut };
}

describe('teamrig restore install', () => {
  it('previews both launchers and the logon entry, and writes nothing without --yes', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const result = await kit.run(['restore', 'install'], onWindows(entry));
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', `  WRITE ${LAUNCHER}`, `  WRITE ${RUN_LAUNCHER}`, `  SET ${WHERE}: (none) -> ${COMMAND}`]],
    );
    assert.deepEqual([kit.files.paths(), entry.command], [[], undefined]);
  });

  it('with --yes writes the launchers, then has the entry name one; a second install changes nothing', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(entry));
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.ok, ['WROTE the changes below', `  WRITE ${LAUNCHER}`, `  WRITE ${RUN_LAUNCHER}`, `  SET ${WHERE}: (none) -> ${COMMAND}`]],
    );
    assert.deepEqual([kit.files.get(LAUNCHER), kit.files.get(RUN_LAUNCHER), entry.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, COMMAND]);
    const again = await kit.run(['restore', 'install', '--yes'], onWindows(entry));
    assert.deepEqual([again.code, again.stdout], [EXIT.ok, [`UNCHANGED ${WHERE}: the restore check already runs at logon`]]);
  });

  it('changes only what is out of date: an old launcher text, or an entry naming another Node', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, '// an older launcher\n');
    await kit.files.write(RUN_LAUNCHER, RESTORE_RUN_LAUNCHER_SCRIPT);
    const staleLauncher = await kit.run(['restore', 'install', '--yes'], onWindows(new FakeLogonEntry(COMMAND)));
    assert.deepEqual(staleLauncher.stdout, ['WROTE the changes below', `  WRITE ${LAUNCHER}`]);
    assert.equal(kit.files.get(LAUNCHER), RESTORE_CHECK_LAUNCHER_SCRIPT);
    const entry = new FakeLogonEntry(OLD_COMMAND);
    const staleEntry = await kit.run(['restore', 'install', '--yes'], onWindows(entry));
    assert.deepEqual(staleEntry.stdout, ['WROTE the changes below', `  SET ${WHERE}: ${OLD_COMMAND} -> ${COMMAND}`]);
    assert.equal(entry.command, COMMAND);
  });

  it('says which step failed and what was done before it', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    entry.failWith = 'PowerShell ended with exit 1: Requested registry access is not allowed.';
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(entry));
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.failed, [`FAILED SET ${WHERE}: (none) -> ${COMMAND}: ${entry.failWith}`, '  done before it:', `  WRITE ${LAUNCHER}`, `  WRITE ${RUN_LAUNCHER}`]],
    );
    assert.deepEqual([kit.files.get(LAUNCHER), entry.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, undefined]);
  });

  it('adds the Start-menu shortcut that runs the run launcher; a second install names both parts unchanged', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const shortcuts = new FakeShortcutPlace();
    const preview = await kit.run(['restore', 'install'], onWindows(entry, shortcuts));
    const steps = [`  WRITE ${LAUNCHER}`, `  WRITE ${RUN_LAUNCHER}`, `  SET ${WHERE}: (none) -> ${COMMAND}`, `  SET ${FAKE_START_MENU_SHORTCUT}: (none) -> ${shortcutLine(WANTED)}`];
    assert.deepEqual([preview.code, preview.stdout], [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', ...steps]]);
    assert.equal(shortcuts.shortcuts.size, 0);
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(entry, shortcuts));
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['WROTE the changes below', ...steps]]);
    assert.deepEqual([...shortcuts.shortcuts], [[FAKE_START_MENU_SHORTCUT, WANTED]]);
    const again = await kit.run(['restore', 'install', '--yes'], onWindows(entry, shortcuts));
    assert.deepEqual(again.stdout, [
      `UNCHANGED ${WHERE}: the restore check already runs at logon`,
      `UNCHANGED ${FAKE_START_MENU_SHORTCUT}: the shortcut already runs the restore`,
    ]);
  });

  it('repoints an older Start-menu shortcut and a taskbar pin made from it in place, so the pin stays', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, RESTORE_CHECK_LAUNCHER_SCRIPT);
    await kit.files.write(RUN_LAUNCHER, RESTORE_RUN_LAUNCHER_SCRIPT);
    const shortcuts = new FakeShortcutPlace([found(FAKE_START_MENU_SHORTCUT, OLD), found(PIN, OLD), found(DESKTOP, WANTED)]);
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(new FakeLogonEntry(COMMAND), shortcuts));
    assert.deepEqual(
      [result.code, result.stdout],
      [
        EXIT.ok,
        [
          'WROTE the changes below',
          `  SET ${FAKE_START_MENU_SHORTCUT}: ${shortcutLine(OLD)} -> ${shortcutLine(WANTED)}`,
          `  SET ${PIN}: ${shortcutLine(OLD)} -> ${shortcutLine(WANTED)}`,
        ],
      ],
    );
    assert.deepEqual([...shortcuts.shortcuts], [[FAKE_START_MENU_SHORTCUT, WANTED], [PIN, WANTED], [DESKTOP, WANTED]]);
  });

  it('says which shortcut failed after the launchers and the entry were done', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const shortcuts = new FakeShortcutPlace();
    shortcuts.failWith = 'PowerShell ended with exit 1: Access to the path is denied.';
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(entry, shortcuts));
    assert.deepEqual(
      [result.code, result.stdout],
      [
        EXIT.failed,
        [
          `FAILED SET ${FAKE_START_MENU_SHORTCUT}: (none) -> ${shortcutLine(WANTED)}: ${shortcuts.failWith}`,
          '  done before it:',
          `  WRITE ${LAUNCHER}`,
          `  WRITE ${RUN_LAUNCHER}`,
          `  SET ${WHERE}: (none) -> ${COMMAND}`,
        ],
      ],
    );
    assert.deepEqual([entry.command, shortcuts.shortcuts.size], [COMMAND, 0]);
  });

  it('changes nothing when the shortcuts cannot be read', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const shortcuts = new FakeShortcutPlace();
    shortcuts.scanFailWith = 'PowerShell ended with exit 1: the shell is not there';
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(entry, shortcuts));
    assert.deepEqual([result.code, result.stderr], [EXIT.failed, [`FAILED ${shortcuts.scanFailWith}`]]);
    assert.deepEqual([kit.files.paths(), entry.command], [[], undefined]);
  });

  it('is refused on a system with no logon entry, naming the manual restore', async () => {
    const kit = new CliHarness(null, null);
    for (const [verb, command] of [['set up', 'install'], ['take out', 'uninstall']] as const) {
      const result = await kit.run(['restore', command, '--yes']);
      assert.deepEqual(
        [result.code, result.stdout],
        [EXIT.refused, [`REFUSED teamrig can ${verb} the logon check on Windows only so far, not on linux; after a crash or reboot, run teamrig restore run`]],
      );
    }
    assert.deepEqual(kit.files.paths(), []);
  });
});

describe('teamrig restore uninstall', () => {
  it('previews, then removes the entry before the launchers; a second uninstall changes nothing', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, RESTORE_CHECK_LAUNCHER_SCRIPT);
    await kit.files.write(RUN_LAUNCHER, RESTORE_RUN_LAUNCHER_SCRIPT);
    const entry = new FakeLogonEntry(COMMAND);
    const steps = [`  REMOVE ${WHERE}: ${COMMAND}`, `  REMOVE ${LAUNCHER}`, `  REMOVE ${RUN_LAUNCHER}`];
    const preview = await kit.run(['restore', 'uninstall'], onWindows(entry));
    assert.deepEqual([preview.code, preview.stdout], [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', ...steps]]);
    assert.deepEqual([kit.files.get(LAUNCHER), entry.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, COMMAND]);
    const result = await kit.run(['restore', 'uninstall', '--yes'], onWindows(entry));
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['WROTE the changes below', ...steps]]);
    assert.deepEqual([kit.files.get(LAUNCHER), kit.files.get(RUN_LAUNCHER), entry.command], [undefined, undefined, undefined]);
    const again = await kit.run(['restore', 'uninstall', '--yes'], onWindows(entry));
    assert.deepEqual(again.stdout, [`UNCHANGED ${WHERE}: the restore check does not run at logon`]);
  });

  it('removes a launcher left with no entry, and keeps it when the entry cannot be removed', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, RESTORE_CHECK_LAUNCHER_SCRIPT);
    const entry = new FakeLogonEntry(COMMAND);
    entry.failWith = 'PowerShell ended with exit 1: access denied';
    const failed = await kit.run(['restore', 'uninstall', '--yes'], onWindows(entry));
    assert.deepEqual([failed.code, failed.stdout], [EXIT.failed, [`FAILED REMOVE ${WHERE}: ${COMMAND}: ${entry.failWith}`, '  nothing was changed']]);
    assert.equal(kit.files.get(LAUNCHER), RESTORE_CHECK_LAUNCHER_SCRIPT);
    const leftOver = await kit.run(['restore', 'uninstall', '--yes'], onWindows(new FakeLogonEntry()));
    assert.deepEqual(leftOver.stdout, ['WROTE the changes below', `  REMOVE ${LAUNCHER}`]);
    assert.equal(kit.files.get(LAUNCHER), undefined);
  });

  it('removes the shortcuts that run the run launcher before the launchers, and keeps a same-named one that runs anything else', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, RESTORE_CHECK_LAUNCHER_SCRIPT);
    await kit.files.write(RUN_LAUNCHER, RESTORE_RUN_LAUNCHER_SCRIPT);
    const entry = new FakeLogonEntry(COMMAND);
    const shortcuts = new FakeShortcutPlace([found(FAKE_START_MENU_SHORTCUT, WANTED), found(PIN, WANTED), found(DESKTOP, OLD)]);
    const result = await kit.run(['restore', 'uninstall', '--yes'], onWindows(entry, shortcuts));
    assert.deepEqual(
      [result.code, result.stdout],
      [
        EXIT.ok,
        [
          'WROTE the changes below',
          `  REMOVE ${WHERE}: ${COMMAND}`,
          `  REMOVE ${FAKE_START_MENU_SHORTCUT}: ${shortcutLine(WANTED)}`,
          `  REMOVE ${PIN}: ${shortcutLine(WANTED)}`,
          `  REMOVE ${LAUNCHER}`,
          `  REMOVE ${RUN_LAUNCHER}`,
        ],
      ],
    );
    assert.deepEqual([...shortcuts.shortcuts], [[DESKTOP, OLD]]);
    const again = await kit.run(['restore', 'uninstall', '--yes'], onWindows(entry, shortcuts));
    assert.deepEqual(again.stdout, [`UNCHANGED ${WHERE}: the restore check does not run at logon`, `UNCHANGED no Restore Claude Sessions.lnk runs ${RUN_LAUNCHER}`]);
  });
});
