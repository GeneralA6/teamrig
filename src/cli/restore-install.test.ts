import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RESTORE_CHECK_LAUNCHER_SCRIPT } from '../restore/launcher.ts';
import { CliHarness, KIT, type RunOptions } from '../testing/cli-harness.ts';
import { FakeLogonEntry, quietRestore } from '../testing/fake-restore.ts';
import { EXIT } from './runtime.ts';

const LAUNCHER = join(KIT, 'bin', 'restore-check.mjs');
const WHERE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run TeamrigSessionRestore';
/** The command the fake entry builds for the harness's Node and the launcher. */
const COMMAND = `"C:\\Windows\\System32\\conhost.exe" --headless "/usr/bin/node" "${LAUNCHER}"`;
const OLD_COMMAND = `"C:\\Windows\\System32\\conhost.exe" --headless "C:\\old\\node.exe" "${LAUNCHER}"`;

function onWindows(entry: FakeLogonEntry): RunOptions {
  return { platform: 'win32', restore: { ...quietRestore(), logon: entry } };
}

describe('teamrig restore install', () => {
  it('previews the launcher and the logon entry, and writes nothing without --yes', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const result = await kit.run(['restore', 'install'], onWindows(entry));
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', `  WRITE ${LAUNCHER}`, `  SET ${WHERE}: (none) -> ${COMMAND}`]],
    );
    assert.deepEqual([kit.files.paths(), entry.command], [[], undefined]);
  });

  it('with --yes writes the launcher, then has the entry name it; a second install changes nothing', async () => {
    const kit = new CliHarness(null, null);
    const entry = new FakeLogonEntry();
    const result = await kit.run(['restore', 'install', '--yes'], onWindows(entry));
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['WROTE the changes below', `  WRITE ${LAUNCHER}`, `  SET ${WHERE}: (none) -> ${COMMAND}`]]);
    assert.deepEqual([kit.files.get(LAUNCHER), entry.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, COMMAND]);
    const again = await kit.run(['restore', 'install', '--yes'], onWindows(entry));
    assert.deepEqual([again.code, again.stdout], [EXIT.ok, [`UNCHANGED ${WHERE}: the restore check already runs at logon`]]);
  });

  it('changes only what is out of date: an old launcher text, or an entry naming another Node', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, '// an older launcher\n');
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
      [EXIT.failed, [`FAILED SET ${WHERE}: (none) -> ${COMMAND}: ${entry.failWith}`, '  done before it:', `  WRITE ${LAUNCHER}`]],
    );
    assert.deepEqual([kit.files.get(LAUNCHER), entry.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, undefined]);
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
  it('previews, then removes the entry before the launcher; a second uninstall changes nothing', async () => {
    const kit = new CliHarness(null, null);
    await kit.files.write(LAUNCHER, RESTORE_CHECK_LAUNCHER_SCRIPT);
    const entry = new FakeLogonEntry(COMMAND);
    const steps = [`  REMOVE ${WHERE}: ${COMMAND}`, `  REMOVE ${LAUNCHER}`];
    const preview = await kit.run(['restore', 'uninstall'], onWindows(entry));
    assert.deepEqual([preview.code, preview.stdout], [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', ...steps]]);
    assert.deepEqual([kit.files.get(LAUNCHER), entry.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, COMMAND]);
    const result = await kit.run(['restore', 'uninstall', '--yes'], onWindows(entry));
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['WROTE the changes below', ...steps]]);
    assert.deepEqual([kit.files.get(LAUNCHER), entry.command], [undefined, undefined]);
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
});
