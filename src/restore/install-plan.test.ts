import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_START_MENU_SHORTCUT, FakeLogonEntry, FakeShortcutPlace } from '../testing/fake-restore.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { launcherStep, restoreLaunchers, restorePlan, type MachinePlan, type RestoreMachine } from './install-plan.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT } from './launcher.ts';
import { RESTORE_SHORTCUT_DESCRIPTION, shortcutLine, type Shortcut } from './shortcut.ts';

const KIT = 'D:\\homes\\pat\\.teamrig';
const HOME = 'D:\\homes\\pat';
const NODE = 'C:\\nodejs\\node.exe';
const { check: CHECK, run: RUN } = restoreLaunchers(KIT);
const PIN = 'C:\\Roaming\\Quick Launch\\User Pinned\\TaskBar\\Restore Claude Sessions.lnk';
const WANTED: Shortcut = { target: NODE, arguments: `"${RUN.path}"`, folder: HOME, description: RESTORE_SHORTCUT_DESCRIPTION };
/** What an install by an older Node left: the same launcher run by another program. */
const OLD_SHORTCUT: Shortcut = { ...WANTED, target: 'C:\\old\\node.exe' };
const OLDER_TEXT = '// an older launcher\n';

interface Parts {
  readonly files?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly shortcuts?: FakeShortcutPlace;
}

function machineOf(parts: Parts): { readonly machine: RestoreMachine; readonly files: MemoryFiles; readonly logon: FakeLogonEntry } {
  const files = new MemoryFiles(parts.files);
  const logon = new FakeLogonEntry(parts.command);
  return { machine: { files, kitHome: KIT, node: NODE, userHome: HOME, logon, shortcuts: parts.shortcuts }, files, logon };
}

const lines = (plan: MachinePlan): string[] => plan.steps.map((step) => step.line);

async function take(plan: MachinePlan): Promise<void> {
  for (const step of plan.steps) {
    await step.act();
  }
}

describe('restorePlan in refresh mode', () => {
  it('creates nothing on a machine that never ran install: no launcher, no logon entry, no shortcut scanned', async () => {
    const shortcuts = new FakeShortcutPlace();
    shortcuts.scanFailWith = 'a refresh with no run launcher must not scan';
    const { machine, files, logon } = machineOf({ shortcuts });
    const plan = await restorePlan(machine, 'refresh');
    assert.deepEqual(lines(plan), []);
    assert.deepEqual([files.paths(), logon.command, shortcuts.shortcuts.size], [[], undefined, 0]);
  });

  it('rewrites older launchers, then repoints the logon entry and each shortcut found in place, so a pin stays', async () => {
    const shortcuts = new FakeShortcutPlace([
      { path: FAKE_START_MENU_SHORTCUT, ...OLD_SHORTCUT },
      { path: PIN, ...OLD_SHORTCUT },
    ]);
    const oldCommand = new FakeLogonEntry().commandFor('C:\\old\\node.exe', CHECK.path);
    const { machine, files, logon } = machineOf({ files: { [CHECK.path]: OLDER_TEXT, [RUN.path]: OLDER_TEXT }, command: oldCommand, shortcuts });
    const command = logon.commandFor(NODE, CHECK.path);
    const plan = await restorePlan(machine, 'refresh');
    assert.deepEqual(lines(plan), [
      `WRITE ${CHECK.path}`,
      `WRITE ${RUN.path}`,
      `SET ${logon.where}: ${oldCommand} -> ${command}`,
      `SET ${FAKE_START_MENU_SHORTCUT}: ${shortcutLine(OLD_SHORTCUT)} -> ${shortcutLine(WANTED)}`,
      `SET ${PIN}: ${shortcutLine(OLD_SHORTCUT)} -> ${shortcutLine(WANTED)}`,
    ]);
    await take(plan);
    assert.deepEqual([files.get(CHECK.path), files.get(RUN.path), logon.command], [RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, command]);
    assert.deepEqual([...shortcuts.shortcuts], [[FAKE_START_MENU_SHORTCUT, WANTED], [PIN, WANTED]]);
  });

  it('sets no logon entry that is not set, and makes no Start-menu shortcut that is not there', async () => {
    const shortcuts = new FakeShortcutPlace([{ path: PIN, ...OLD_SHORTCUT }]);
    const { machine, logon } = machineOf({ files: { [CHECK.path]: RESTORE_CHECK_LAUNCHER_SCRIPT, [RUN.path]: RESTORE_RUN_LAUNCHER_SCRIPT }, shortcuts });
    const plan = await restorePlan(machine, 'refresh');
    assert.deepEqual(lines(plan), [`SET ${PIN}: ${shortcutLine(OLD_SHORTCUT)} -> ${shortcutLine(WANTED)}`]);
    await take(plan);
    assert.deepEqual([logon.command, [...shortcuts.shortcuts]], [undefined, [[PIN, WANTED]]]);
  });

  it('leaves the logon entry alone without the check launcher, and the shortcuts alone without the run launcher', async () => {
    const shortcuts = new FakeShortcutPlace([{ path: FAKE_START_MENU_SHORTCUT, ...OLD_SHORTCUT }]);
    shortcuts.scanFailWith = 'a refresh with no run launcher must not scan';
    const oldCommand = new FakeLogonEntry().commandFor('C:\\old\\node.exe', CHECK.path);
    const { machine } = machineOf({ command: oldCommand, shortcuts });
    assert.deepEqual(lines(await restorePlan(machine, 'refresh')), []);
  });

  it('changes nothing on a machine that is up to date', async () => {
    const shortcuts = new FakeShortcutPlace([{ path: FAKE_START_MENU_SHORTCUT, ...WANTED }]);
    const command = new FakeLogonEntry().commandFor(NODE, CHECK.path);
    const { machine } = machineOf({ files: { [CHECK.path]: RESTORE_CHECK_LAUNCHER_SCRIPT, [RUN.path]: RESTORE_RUN_LAUNCHER_SCRIPT }, command, shortcuts });
    assert.deepEqual(lines(await restorePlan(machine, 'refresh')), []);
  });

  it('refreshes the launchers on a system with no logon entry or shortcuts', async () => {
    const files = new MemoryFiles({ [CHECK.path]: OLDER_TEXT });
    const plan = await restorePlan({ files, kitHome: KIT, node: NODE, userHome: HOME, logon: undefined, shortcuts: undefined }, 'refresh');
    assert.deepEqual([lines(plan), plan.unchanged], [[`WRITE ${CHECK.path}`], []]);
  });
});

describe('launcherStep', () => {
  const launcher = { path: 'D:\\homes\\pat\\.teamrig\\bin\\statusline.mjs', text: '// the launcher\n' };

  it('in install mode writes a launcher that is missing or older, and none that is current', async () => {
    assert.deepEqual((await launcherStep(new MemoryFiles(), launcher, 'install')).map((step) => step.line), [`WRITE ${launcher.path}`]);
    assert.equal((await launcherStep(new MemoryFiles({ [launcher.path]: OLDER_TEXT }), launcher, 'install')).length, 1);
    assert.equal((await launcherStep(new MemoryFiles({ [launcher.path]: launcher.text }), launcher, 'install')).length, 0);
  });

  it('in refresh mode rewrites only an older launcher that is there', async () => {
    assert.equal((await launcherStep(new MemoryFiles(), launcher, 'refresh')).length, 0);
    assert.equal((await launcherStep(new MemoryFiles({ [launcher.path]: launcher.text }), launcher, 'refresh')).length, 0);
    const files = new MemoryFiles({ [launcher.path]: OLDER_TEXT });
    const steps = await launcherStep(files, launcher, 'refresh');
    await Promise.all(steps.map((step) => step.act()));
    assert.equal(files.get(launcher.path), launcher.text);
  });
});
