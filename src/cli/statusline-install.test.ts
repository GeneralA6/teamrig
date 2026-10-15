import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { launcherCommand } from '../statusline/install.ts';
import { LAUNCHER_SCRIPT } from '../statusline/launcher.ts';
import { CliHarness, KIT, USER_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const LAUNCHER = join(KIT, 'bin', 'statusline.mjs');
const OWN = launcherCommand(LAUNCHER);
const THEIRS = 'node "/u/.claude/scripts/statusline.cjs"';
const BACKUP = join(KIT, 'backups', 'claude-settings.json');
/** Settings with a status line already there and another key that must stay as it is. */
const ORIGINAL = formatConfig({ theme: 'dark', statusLine: { type: 'command', command: THEIRS, padding: 1 } });

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
});
