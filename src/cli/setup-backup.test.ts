import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FileBytes } from '../core/file-bytes.ts';
import { MANIFEST } from '../permissions/trim.ts';
import { CliHarness, APP, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { textFileBytes } from '../testing/text-file-bytes.ts';
import { EXIT } from './runtime.ts';

const STATE = join('/', 'state');
const ROOT = join(STATE, 'teamrig', 'setup-backups');
const STAMP = '20300108T100000Z';
const NEXT_STAMP = '20300108T100001Z';
const CLAUDE = join(USER_HOME, '.claude');
const USER_RULES = join(CLAUDE, 'CLAUDE.md');
const SETTINGS = join(CLAUDE, 'settings.json');
const SKILL = join(CLAUDE, 'skills', 'deploy', 'SKILL.md');
const NEW_SKILL = join(CLAUDE, 'skills', 'fresh', 'SKILL.md');
const PROJECT_RULES = join(APP, 'CLAUDE.md');
/** Text a setup file holds; backup and restore name files and never print what they hold. */
const HELD = 'token-held-in-a-rule';

/** A setup with no team: three user files and the project's CLAUDE.md, 67 bytes in all. */
async function seeded(): Promise<CliHarness> {
  const kit = new CliHarness(null, null);
  await kit.files.write(USER_RULES, `user rules ${HELD}`);
  await kit.files.write(SETTINGS, '{"model": "opus"}');
  await kit.files.write(SKILL, 'deploy');
  await kit.files.write(PROJECT_RULES, 'project rules');
  return kit;
}

function optionsOf(kit: CliHarness, extra: RunOptions = {}): RunOptions {
  return { platform: 'linux', env: { XDG_STATE_HOME: STATE }, probe: new MemoryPathProbe(kit.files), ...extra };
}

/** A backup at STAMP, then the settings edited, the skill deleted and a new skill made. */
async function changedSince(): Promise<CliHarness> {
  const kit = await seeded();
  assert.equal((await kit.run(['setup', 'backup'], optionsOf(kit))).code, EXIT.ok);
  await kit.files.write(SETTINGS, '{"model": "haiku"}');
  await kit.files.remove(SKILL);
  await kit.files.write(NEW_SKILL, 'fresh');
  kit.clock.advance(1000);
  return kit;
}

function assertNothingHeld(result: CliResult): void {
  assert.ok([...result.stdout, ...result.stderr].every((line) => !line.includes(HELD)));
}

const PREVIEW_HEAD = `PREVIEW nothing written (add --yes to write): setup backup ${STAMP} (4 file(s), made 2030-01-08T10:00:00.000Z) of ${APP}`;

describe('teamrig setup backup', () => {
  it('copies the setup with no team, counts each kind, writes the manifest last and never prints a file', async () => {
    const kit = await seeded();
    const result = await kit.run(['setup', 'backup'], optionsOf(kit));
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      `BACKED UP 4 file(s), 67 bytes to ${join(ROOT, STAMP)}`,
      '  user: 3 file(s)',
      '  project: 1 file(s)',
      '  parents: 0 file(s)',
      '  memory: 0 file(s)',
    ]);
    assertNothingHeld(result);
    assert.equal(kit.files.get(join(ROOT, STAMP, 'files', 'user', 'CLAUDE.md')), `user rules ${HELD}`);
    const manifest: unknown = JSON.parse(kit.files.get(join(ROOT, STAMP, MANIFEST)) ?? 'null');
    assert.ok(typeof manifest === 'object' && manifest !== null && 'files' in manifest && Array.isArray(manifest.files));
    assert.equal(manifest.files.length, 4);
  });

  it('refuses a project folder that does not exist', async () => {
    const kit = await seeded();
    const result = await kit.run(['setup', 'backup', '--project', join('/', 'nowhere')], optionsOf(kit));
    assert.equal(result.code, EXIT.refused);
    assert.equal(kit.files.paths().filter((path) => path.startsWith(ROOT)).length, 0);
  });
});

describe('teamrig setup restore', () => {
  it('lists no backup, then each backup with its file count and project', async () => {
    const kit = await seeded();
    assert.deepEqual((await kit.run(['setup', 'restore'], optionsOf(kit))).stdout, [`NONE no setup backup in ${ROOT} yet; teamrig setup backup makes one`]);
    await kit.run(['setup', 'backup'], optionsOf(kit));
    assert.deepEqual((await kit.run(['setup', 'restore'], optionsOf(kit))).stdout, [`BACKUPS 1 in ${ROOT}`, `  ${STAMP}  4 file(s)  ${APP}`]);
  });

  it('says the setup matches a backup just made, and backs nothing up', async () => {
    const kit = await seeded();
    await kit.run(['setup', 'backup'], optionsOf(kit));
    kit.clock.advance(1000);
    const result = await kit.run(['setup', 'restore', STAMP, '--yes'], optionsOf(kit));
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [`UNCHANGED the setup matches setup backup ${STAMP}: 4 file(s)`]);
    assert.equal(kit.files.paths().some((path) => path.startsWith(join(ROOT, NEXT_STAMP))), false);
  });

  it('previews each changed, deleted and new file and writes nothing without --yes', async () => {
    const kit = await changedSince();
    const result = await kit.run(['setup', 'restore', STAMP], optionsOf(kit));
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout, [
      PREVIEW_HEAD,
      `  RESTORE ${SETTINGS}: changed since the backup`,
      `  RECREATE ${SKILL}: deleted since the backup`,
      `  NEW ${NEW_SKILL}: not in the backup; kept (--remove-new removes it)`,
      '  UNCHANGED 2 file(s)',
    ]);
    assert.equal(kit.files.get(SETTINGS), '{"model": "haiku"}');
    assert.equal(kit.files.get(SKILL), undefined);
  });

  it('with --yes backs the setup up first, puts the files back, keeps the new one and prints the undo', async () => {
    const kit = await changedSince();
    const result = await kit.run(['setup', 'restore', STAMP, '--yes'], optionsOf(kit));
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.stdout[0], `BACKED UP 4 file(s), 67 bytes to ${join(ROOT, NEXT_STAMP)}`);
    assert.deepEqual(result.stdout.slice(5), [
      `WROTE 2 of 2 file(s) from setup backup ${STAMP}; 2 unchanged`,
      `  RESTORED ${SETTINGS}`,
      `  RECREATED ${SKILL}`,
      `  NEW ${NEW_SKILL}: not in the backup; kept (--remove-new removes it)`,
      `UNDO teamrig setup restore ${NEXT_STAMP} --yes --remove-new`,
    ]);
    assertNothingHeld(result);
    assert.equal(kit.files.get(SETTINGS), '{"model": "opus"}');
    assert.equal(kit.files.get(SKILL), 'deploy');
    assert.equal(kit.files.get(NEW_SKILL), 'fresh');

    kit.clock.advance(1000);
    const undo = await kit.run(['setup', 'restore', NEXT_STAMP, '--yes', '--remove-new'], optionsOf(kit));
    assert.equal(undo.code, EXIT.ok);
    assert.equal(kit.files.get(SETTINGS), '{"model": "haiku"}');
    assert.equal(kit.files.get(SKILL), undefined);
    assert.equal(kit.files.get(NEW_SKILL), 'fresh');
  });

  it('with --remove-new also removes the files made since the backup', async () => {
    const kit = await changedSince();
    const result = await kit.run(['setup', 'restore', STAMP, '--yes', '--remove-new'], optionsOf(kit));
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stdout.slice(5, 9), [
      `WROTE 3 of 3 file(s) from setup backup ${STAMP}; 2 unchanged`,
      `  RESTORED ${SETTINGS}`,
      `  RECREATED ${SKILL}`,
      `  REMOVED ${NEW_SKILL}`,
    ]);
    assert.equal(kit.files.get(NEW_SKILL), undefined);
  });

  it('names a damaged copy, writes it nowhere and fails', async () => {
    const kit = await changedSince();
    await kit.files.write(join(ROOT, STAMP, 'files', 'user', 'settings.json'), '{"model": "tampered"}');
    const damaged = `  DAMAGED ${SETTINGS}: its copy in the backup does not match the manifest; not written`;
    assert.ok((await kit.run(['setup', 'restore', STAMP], optionsOf(kit))).stdout.includes(damaged));
    const result = await kit.run(['setup', 'restore', STAMP, '--yes'], optionsOf(kit));
    assert.equal(result.code, EXIT.failed);
    assert.ok(result.stdout.includes(damaged));
    assert.ok(result.stdout.includes(`  RECREATED ${SKILL}`));
    assert.equal(kit.files.get(SETTINGS), '{"model": "haiku"}');
  });

  it('reports a file it could not write and still writes the others', async () => {
    const kit = await changedSince();
    const text = textFileBytes(kit.files);
    const locked: FileBytes = {
      read: (path) => text.read(path),
      createExclusive: (path, bytes) => text.createExclusive(path, bytes),
      async write(path, bytes) {
        if (path === SETTINGS) {
          throw new Error('EBUSY: resource busy or locked');
        }
        await text.write(path, bytes);
      },
    };
    const result = await kit.run(['setup', 'restore', STAMP, '--yes'], optionsOf(kit, { fileBytes: locked }));
    assert.equal(result.code, EXIT.failed);
    assert.ok(result.stdout.includes(`WROTE 1 of 2 file(s) from setup backup ${STAMP}; 2 unchanged`));
    assert.ok(result.stdout.includes(`  FAILED ${SETTINGS}: EBUSY: resource busy or locked`));
    assert.equal(kit.files.get(SKILL), 'deploy');
  });

  it('refuses a missing or unreadable backup and a wrong stamp, and asks for a stamp before --yes', async () => {
    const kit = await seeded();
    assert.equal((await kit.run(['setup', 'restore', '--yes'], optionsOf(kit))).code, EXIT.usage);
    assert.equal((await kit.run(['setup', 'restore', 'yesterday'], optionsOf(kit))).code, EXIT.usage);
    assert.equal((await kit.run(['setup', 'restore', STAMP, 'again'], optionsOf(kit))).code, EXIT.usage);
    const missing = await kit.run(['setup', 'restore', STAMP], optionsOf(kit));
    assert.equal(missing.code, EXIT.failed);
    assert.deepEqual(missing.stderr, [`FAILED no setup backup ${STAMP} in ${ROOT}; setup restore lists them`]);
    await kit.files.write(join(ROOT, STAMP, MANIFEST), '{"format": 1}');
    const unreadable = await kit.run(['setup', 'restore', STAMP], optionsOf(kit));
    assert.equal(unreadable.code, EXIT.failed);
    assert.deepEqual(unreadable.stderr, [`FAILED the manifest of setup backup ${STAMP} is not one this teamrig wrote; nothing written`]);
    assert.deepEqual((await kit.run(['setup', 'restore'], optionsOf(kit))).stdout, [`BACKUPS 1 in ${ROOT}`, `  ${STAMP}  unreadable manifest`]);
  });
});
