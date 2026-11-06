import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { KIT_VERSION } from '../core/version.ts';
import { LAUNCHER_RECORD_FORMAT, launcherRecordPath } from '../restore/launcher-refresh.ts';
import { launcherCommand } from '../statusline/install.ts';
import { LAUNCHER_SCRIPT } from '../statusline/launcher.ts';
import { CliHarness, KIT, USER_HOME } from '../testing/cli-harness.ts';
import { holderLetsGo, holdFileLock } from '../testing/held-file-lock.ts';
import { EXIT } from './runtime.ts';

const SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const LAUNCHER = join(KIT, 'bin', 'statusline.mjs');
const OWN = launcherCommand(LAUNCHER);
const THEIRS = 'node "/u/.claude/scripts/statusline.cjs"';
const BACKUP = join(KIT, 'backups', 'claude-settings.json');
/** Settings with a status line already there and another key that must stay as it is. */
const ORIGINAL = formatConfig({ theme: 'dark', statusLine: { type: 'command', command: THEIRS, padding: 1 } });
/** Settings that already name the launcher, so only the launcher file can change. */
const INSTALLED = formatConfig({ statusLine: { type: 'command', command: OWN } });
/** The launcher refresh's record (src/restore/launcher-refresh.ts) and its lock. */
const RECORD = launcherRecordPath(KIT);
const RECORD_LOCK = `${RECORD}.lock`;

/** The record as a session start of `version` wrote it at `at`. */
function record(version: string, at: string = '2030-01-01T10:00:00.000Z'): string {
  return `${JSON.stringify({ v: LAUNCHER_RECORD_FORMAT, version, at }, null, 2)}\n`;
}

async function withSettings(text: string | undefined): Promise<CliHarness> {
  const kit = new CliHarness(null, null);
  if (text !== undefined) {
    await kit.files.write(SETTINGS, text);
  }
  return kit;
}

function settingsIn(kit: CliHarness): unknown {
  const text = kit.files.get(SETTINGS);
  return text === undefined ? undefined : JSON.parse(text);
}

describe('teamrig statusline install', () => {
  it('previews the launcher and the setting, and writes nothing without --yes', async () => {
    const kit = await withSettings(undefined);
    const result = await kit.run(['statusline', 'install']);
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', `  WRITE ${LAUNCHER}`, `  CHANGE ${SETTINGS} statusLine.command: (none) -> ${OWN}`]],
    );
    assert.deepEqual(kit.files.paths(), []);
  });

  it('with --yes writes the launcher and a new settings file when there was none', async () => {
    const kit = await withSettings(undefined);
    const result = await kit.run(['statusline', 'install', '--yes']);
    assert.deepEqual([result.code, result.stdout[0]], [EXIT.ok, 'WROTE the changes below']);
    assert.equal(kit.files.get(LAUNCHER), LAUNCHER_SCRIPT);
    assert.deepEqual(settingsIn(kit), { statusLine: { type: 'command', command: OWN } });
  });

  it('puts the launcher in front of the status line already there, keeping the old file first', async () => {
    const kit = await withSettings(ORIGINAL);
    const result = await kit.run(['statusline', 'install', '--yes']);
    const after = `${OWN} --pass | ${THEIRS}`;
    assert.deepEqual(result.stdout, [
      `WROTE the changes below; the old settings file is at ${BACKUP}`,
      `  WRITE ${LAUNCHER}`,
      `  CHANGE ${SETTINGS} statusLine.command: ${THEIRS} -> ${after}`,
    ]);
    assert.deepEqual(settingsIn(kit), { theme: 'dark', statusLine: { type: 'command', command: after, padding: 1 } });
    assert.equal(kit.files.get(BACKUP), ORIGINAL);
    assert.deepEqual((await kit.run(['statusline', 'install', '--yes'])).stdout, [`UNCHANGED ${SETTINGS}: teamrig is already the status line`]);
  });

  it('refreshes only a launcher that differs, leaving the settings alone', async () => {
    const kit = await withSettings(formatConfig({ statusLine: { type: 'command', command: OWN } }));
    await kit.files.write(LAUNCHER, '// an older launcher\n');
    const result = await kit.run(['statusline', 'install', '--yes']);
    assert.deepEqual(result.stdout, ['WROTE the changes below', `  WRITE ${LAUNCHER}`]);
    assert.equal(kit.files.get(LAUNCHER), LAUNCHER_SCRIPT);
    assert.equal(kit.files.get(BACKUP), undefined);
  });

  it('proposes the bare launcher for one left passing its input to nothing, which shows the raw status JSON', async () => {
    const stranded = `${OWN} --pass`;
    const kit = await withSettings(formatConfig({ statusLine: { type: 'command', command: stranded } }));
    await kit.files.write(LAUNCHER, LAUNCHER_SCRIPT);
    const result = await kit.run(['statusline', 'install']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['PREVIEW nothing written (add --yes to write)', `  CHANGE ${SETTINGS} statusLine.command: ${stranded} -> ${OWN}`]]);
  });

  it('refuses settings it cannot read and a status line the pipe would split, writing nothing', async () => {
    const broken = await withSettings('{ "theme": ');
    const unreadable = await broken.run(['statusline', 'install', '--yes']);
    assert.equal(unreadable.code, EXIT.refused);
    assert.match(unreadable.stdout[0] ?? '', /^REFUSED .*settings\.json is not valid JSON \(.+\); nothing written$/);
    const compound = await withSettings(formatConfig({ statusLine: { type: 'command', command: 'cd ~; ./status.sh' } }));
    const split = await compound.run(['statusline', 'install', '--yes']);
    assert.equal(split.code, EXIT.refused);
    assert.match(split.stdout[0] ?? '', /^REFUSED the status line already there is a shell line with ";"/);
    assert.equal(compound.files.get(LAUNCHER), undefined);
  });

  it("reads Claude Code's folder from $CLAUDE_CONFIG_DIR", async () => {
    const kit = await withSettings(undefined);
    const result = await kit.run(['statusline', 'install'], { env: { CLAUDE_CONFIG_DIR: join('/', 'cfg') } });
    assert.equal(result.stdout[2], `  CHANGE ${join('/', 'cfg', 'settings.json')} statusLine.command: (none) -> ${OWN}`);
  });

  it('first lowers a record a newer teamrig left, so the next session start of a newer one writes its launcher back', async () => {
    const kit = await withSettings(INSTALLED);
    await kit.files.write(LAUNCHER, '// a newer launcher\n');
    await kit.files.write(RECORD, record('99.0.0'));
    const lowered = `  SET ${RECORD}: 99.0.0 -> ${KIT_VERSION}, so the next start of a newer teamrig refreshes what this writes`;
    const preview = await kit.run(['statusline', 'install']);
    assert.deepEqual([preview.stdout, kit.files.get(RECORD)], [['PREVIEW nothing written (add --yes to write)', lowered, `  WRITE ${LAUNCHER}`], record('99.0.0')]);
    const result = await kit.run(['statusline', 'install', '--yes']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['WROTE the changes below', lowered, `  WRITE ${LAUNCHER}`]]);
    assert.deepEqual([kit.files.get(RECORD), kit.files.get(RECORD_LOCK)], [record(KIT_VERSION, '2030-01-08T10:00:00.000Z'), undefined]);
  });

  it('keeps the record when the launcher stays, when it names an older version, and never creates one', async () => {
    const none = await withSettings(undefined);
    assert.equal((await none.run(['statusline', 'install', '--yes'])).code, EXIT.ok);
    assert.equal(none.files.get(RECORD), undefined);
    const settingsOnly = await withSettings(undefined);
    await settingsOnly.files.write(LAUNCHER, LAUNCHER_SCRIPT);
    await settingsOnly.files.write(RECORD, record('99.0.0'));
    const changed = await settingsOnly.run(['statusline', 'install', '--yes']);
    assert.deepEqual(
      [changed.stdout, settingsOnly.files.get(RECORD)],
      [['WROTE the changes below', `  CHANGE ${SETTINGS} statusLine.command: (none) -> ${OWN}`], record('99.0.0')],
    );
    const older = await withSettings(INSTALLED);
    await older.files.write(LAUNCHER, '// an older launcher\n');
    await older.files.write(RECORD, record('0.1.0'));
    const refreshed = await older.run(['statusline', 'install', '--yes']);
    assert.deepEqual([refreshed.stdout, older.files.get(RECORD)], [['WROTE the changes below', `  WRITE ${LAUNCHER}`], record('0.1.0')]);
  });

  it('waits for a session start refreshing the launchers to let go of the record lock before it reads or writes', async () => {
    const kit = await withSettings(undefined);
    await holdFileLock(kit, RECORD_LOCK);
    const seen: Array<string | undefined> = [];
    const result = await kit.run(['statusline', 'install', '--yes'], { sleep: holderLetsGo(kit, RECORD_LOCK, LAUNCHER, seen) });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual([seen, kit.files.get(LAUNCHER), kit.files.get(RECORD_LOCK)], [[undefined], LAUNCHER_SCRIPT, undefined]);
  });

  it('takes no lock for a preview, so a refresh in progress never holds it up', async () => {
    const kit = await withSettings(undefined);
    await holdFileLock(kit, RECORD_LOCK);
    const result = await kit.run(['statusline', 'install']);
    assert.deepEqual([result.code, result.stdout[0], kit.clock.sleeps], [EXIT.ok, 'PREVIEW nothing written (add --yes to write)', []]);
  });

  it('lets go of the record lock when it refuses', async () => {
    const kit = await withSettings('{ "theme": ');
    const result = await kit.run(['statusline', 'install', '--yes']);
    assert.deepEqual([result.code, kit.files.get(RECORD_LOCK)], [EXIT.refused, undefined]);
  });
});

describe('teamrig statusline uninstall', () => {
  it('hands the status line back and removes the launcher, keeping the old file first', async () => {
    const kit = await withSettings(ORIGINAL);
    await kit.run(['statusline', 'install', '--yes']);
    const preview = await kit.run(['statusline', 'uninstall']);
    assert.deepEqual(preview.stdout, [
      'PREVIEW nothing written (add --yes to write)',
      `  CHANGE ${SETTINGS} statusLine.command: ${OWN} --pass | ${THEIRS} -> ${THEIRS}`,
      `  REMOVE ${LAUNCHER}`,
    ]);
    const result = await kit.run(['statusline', 'uninstall', '--yes']);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout[0] ?? '', /^WROTE the changes below; the old settings file is at .*claude-settings\.\d+\.json$/);
    assert.equal(kit.files.get(SETTINGS), ORIGINAL);
    assert.equal(kit.files.get(LAUNCHER), undefined);
  });

  it('changes nothing when teamrig is not the status line and no launcher is there', async () => {
    const kit = await withSettings(ORIGINAL);
    const result = await kit.run(['statusline', 'uninstall', '--yes']);
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, [`UNCHANGED ${SETTINGS}: teamrig is not the status line`]]);
    assert.equal(kit.files.get(SETTINGS), ORIGINAL);
  });

  it('waits for a session start refreshing the launchers to let go of the record lock, and leaves the record as it was', async () => {
    const kit = await withSettings(INSTALLED);
    await kit.files.write(LAUNCHER, LAUNCHER_SCRIPT);
    await kit.files.write(RECORD, record('99.0.0'));
    await holdFileLock(kit, RECORD_LOCK);
    const seen: Array<string | undefined> = [];
    const result = await kit.run(['statusline', 'uninstall', '--yes'], { sleep: holderLetsGo(kit, RECORD_LOCK, LAUNCHER, seen) });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual([seen, kit.files.get(LAUNCHER), kit.files.get(RECORD), kit.files.get(RECORD_LOCK)], [[LAUNCHER_SCRIPT], undefined, record('99.0.0'), undefined]);
  });
});
