import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FileBytes } from '../core/file-bytes.ts';
import { MemoryFiles, MemoryPathProbe } from '../testing/memory-files.ts';
import { textFileBytes } from '../testing/text-file-bytes.ts';
import type { SetupLocations } from './backup-places.ts';
import { applyRestore, planRestore, type RestorePlan } from './backup-restore.ts';
import { backupSetup, storedPath, type BackupResult, type SetupPorts } from './backup.ts';

const CLAUDE = join('/', 'u', '.claude');
const PROJECT = join('/', 'work', 'app');
const AT: SetupLocations = { claudeDir: CLAUDE, project: PROJECT, teamSkills: undefined };
const ROOT = join('/', 'state', 'teamrig', 'setup-backups');
const NOW = Date.parse('2030-01-08T10:00:00Z');

const USER_RULES = join(CLAUDE, 'CLAUDE.md');
const SETTINGS = join(CLAUDE, 'settings.json');
const SKILL = join(CLAUDE, 'skills', 'deploy', 'SKILL.md');
const PROJECT_RULES = join(PROJECT, 'CLAUDE.md');

function portsOf(files: MemoryFiles, bytes: FileBytes = textFileBytes(files)): SetupPorts {
  return { files, probe: new MemoryPathProbe(files), bytes };
}

/** A backup of a small setup, then the setup changed: one file edited, one deleted, one skill added. */
async function changedSince(): Promise<{ readonly files: MemoryFiles; readonly backup: BackupResult }> {
  const files = new MemoryFiles({
    [USER_RULES]: 'user rules',
    [SETTINGS]: '{"model": "opus"}',
    [SKILL]: 'deploy',
    [PROJECT_RULES]: 'project rules',
  });
  const backup = await backupSetup(portsOf(files), AT, ROOT, NOW);
  await files.write(SETTINGS, '{"model": "haiku"}');
  await files.remove(SKILL);
  await files.write(join(CLAUDE, 'skills', 'new', 'SKILL.md'), 'new');
  return { files, backup };
}

function actionsOf(plan: RestorePlan): Record<string, string> {
  return Object.fromEntries(plan.files.map((file) => [file.entry.source, file.action]));
}

describe('planRestore', () => {
  it('names each kept file restore, recreate or unchanged and finds the setup files made since', async () => {
    const { files, backup } = await changedSince();
    const plan = await planRestore(portsOf(files), backup.dir, backup.manifest);
    assert.deepEqual(actionsOf(plan), { [USER_RULES]: 'unchanged', [SETTINGS]: 'restore', [SKILL]: 'recreate', [PROJECT_RULES]: 'unchanged' });
    assert.deepEqual(plan.added, [join(CLAUDE, 'skills', 'new', 'SKILL.md')]);
  });

  it('calls a file damaged when its copy is edited or gone, whatever the setup holds', async () => {
    const { files, backup } = await changedSince();
    await files.write(storedPath(backup.dir, 'files/user/settings.json'), '{"model": "tampered"}');
    await files.remove(storedPath(backup.dir, 'files/project/CLAUDE.md'));
    const plan = await planRestore(portsOf(files), backup.dir, backup.manifest);
    assert.equal(actionsOf(plan)[SETTINGS], 'damaged');
    assert.equal(actionsOf(plan)[PROJECT_RULES], 'damaged');
  });

  it('finds nothing to do for the setup the backup was just made of', async () => {
    const files = new MemoryFiles({ [USER_RULES]: 'user rules', [PROJECT_RULES]: 'project rules' });
    const backup = await backupSetup(portsOf(files), AT, ROOT, NOW);
    const plan = await planRestore(portsOf(files), backup.dir, backup.manifest);
    assert.deepEqual(new Set(plan.files.map((file) => file.action)), new Set(['unchanged']));
    assert.deepEqual(plan.added, []);
  });
});

describe('applyRestore', () => {
  it('puts back the changed and deleted files, leaves the rest, and keeps the files made since', async () => {
    const { files, backup } = await changedSince();
    const ports = portsOf(files);
    const outcomes = await applyRestore(ports, backup.dir, await planRestore(ports, backup.dir, backup.manifest), false);
    assert.deepEqual(outcomes, [
      { path: SETTINGS, step: 'restore', failed: undefined },
      { path: SKILL, step: 'recreate', failed: undefined },
    ]);
    assert.equal(files.get(SETTINGS), '{"model": "opus"}');
    assert.equal(files.get(SKILL), 'deploy');
    assert.equal(files.get(join(CLAUDE, 'skills', 'new', 'SKILL.md')), 'new');
    assert.deepEqual(new Set((await planRestore(ports, backup.dir, backup.manifest)).files.map((file) => file.action)), new Set(['unchanged']));
  });

  it('removes the files made since only with removeNew', async () => {
    const { files, backup } = await changedSince();
    const ports = portsOf(files);
    const outcomes = await applyRestore(ports, backup.dir, await planRestore(ports, backup.dir, backup.manifest), true);
    assert.deepEqual(outcomes.at(-1), { path: join(CLAUDE, 'skills', 'new', 'SKILL.md'), step: 'remove', failed: undefined });
    assert.equal(files.get(join(CLAUDE, 'skills', 'new', 'SKILL.md')), undefined);
  });

  it('writes nothing for a damaged file', async () => {
    const { files, backup } = await changedSince();
    await files.write(storedPath(backup.dir, 'files/user/settings.json'), 'tampered');
    const ports = portsOf(files);
    const outcomes = await applyRestore(ports, backup.dir, await planRestore(ports, backup.dir, backup.manifest), false);
    assert.deepEqual(outcomes, [{ path: SKILL, step: 'recreate', failed: undefined }]);
    assert.equal(files.get(SETTINGS), '{"model": "haiku"}');
  });

  it('refuses a copy changed between the preview and the write', async () => {
    const { files, backup } = await changedSince();
    const ports = portsOf(files);
    const plan = await planRestore(ports, backup.dir, backup.manifest);
    await files.write(storedPath(backup.dir, 'files/user/settings.json'), 'tampered');
    const outcomes = await applyRestore(ports, backup.dir, plan, false);
    assert.deepEqual(outcomes[0], { path: SETTINGS, step: 'restore', failed: 'its backup copy changed since the preview; not written' });
    assert.equal(files.get(SETTINGS), '{"model": "haiku"}');
    assert.equal(files.get(SKILL), 'deploy');
  });

  it('reports a failed write and a write that reads back different, and still writes the others', async () => {
    const { files, backup } = await changedSince();
    const text = textFileBytes(files);
    const broken: FileBytes = {
      read: (path) => text.read(path),
      createExclusive: (path, bytes) => text.createExclusive(path, bytes),
      async write(path, bytes) {
        if (path === SETTINGS) {
          throw new Error('EBUSY: resource busy or locked');
        }
        await text.write(path, path === SKILL ? new TextEncoder().encode('short') : bytes);
      },
    };
    const ports = portsOf(files, broken);
    const outcomes = await applyRestore(ports, backup.dir, await planRestore(ports, backup.dir, backup.manifest), false);
    assert.deepEqual(outcomes, [
      { path: SETTINGS, step: 'restore', failed: 'EBUSY: resource busy or locked' },
      { path: SKILL, step: 'recreate', failed: 'the file read back differs from its backup copy' },
    ]);
  });
});

describe("the team's own skills folder", () => {
  it('plans a skill deleted there since the backup, and finds one made there since', async () => {
    const teamSkills = join('/', 'kit', 'teams', 'app', 'skills');
    const kept = join(teamSkills, 'review', 'SKILL.md');
    const made = join(teamSkills, 'fresh', 'SKILL.md');
    const files = new MemoryFiles({ [USER_RULES]: 'user rules', [kept]: 'review' });
    const backup = await backupSetup(portsOf(files), { ...AT, teamSkills }, ROOT, NOW);
    await files.remove(kept);
    await files.write(made, 'fresh');
    const plan = await planRestore(portsOf(files), backup.dir, backup.manifest);
    assert.deepEqual(plan.files.map(({ entry, action }) => [entry.source, action]), [[USER_RULES, 'unchanged'], [kept, 'recreate']]);
    assert.deepEqual(plan.added, [made]);
  });
});
