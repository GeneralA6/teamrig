import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatConfig, loadConfig, migrationBackupName, writeConfigWithBackup } from './load.ts';
import type { ConfigMigration } from './migrate.ts';
import { CONFIG_VERSION } from './types.ts';

const CONFIG = '/kit/config.json';
const BACKUPS = '/kit/backups';
const ROSTER = { sessions: ['alpha'], roles: { lead: 'alpha' } };
const ADD_FLAG: readonly ConfigMigration[] = [
  { from: 1, firstRelease: '9.1.0', apply: (config) => ({ config: { ...config, flag: true }, changes: ['added flag'] }) },
];

describe('loadConfig', () => {
  it('reports a missing file', async () => {
    assert.deepEqual(await loadConfig(new MemoryFiles(), CONFIG), { status: 'missing', path: CONFIG });
  });

  it('reports text that is not a JSON object', async () => {
    for (const text of ['{ not json', '[1, 2]', '{"configVersion": "one"}']) {
      const load = await loadConfig(new MemoryFiles({ [CONFIG]: text }), CONFIG);
      assert.equal(load.status, 'unreadable', text);
    }
  });

  it('loads a current file with its issues', async () => {
    const files = new MemoryFiles({ [CONFIG]: JSON.stringify({ configVersion: CONFIG_VERSION, sessions: ['alpha'], roles: {} }) });
    const load = await loadConfig(files, CONFIG);
    assert.equal(load.status, 'loaded');
    if (load.status === 'loaded') {
      assert.deepEqual(load.issues.map((issue) => issue.path), ['roles.lead']);
      assert.equal(load.pending, undefined);
      assert.equal(load.newerVersion, undefined);
    }
  });

  it('reads a newer file best-effort and marks it', async () => {
    const files = new MemoryFiles({ [CONFIG]: JSON.stringify({ ...ROSTER, configVersion: 9 }) });
    const load = await loadConfig(files, CONFIG);
    assert.equal(load.status === 'loaded' && load.newerVersion, 9);
    assert.equal(load.status === 'loaded' && load.config.roles.lead, 'alpha');
  });

  it('migrates an older file in memory only', async () => {
    const text = JSON.stringify({ ...ROSTER, configVersion: 1 });
    const files = new MemoryFiles({ [CONFIG]: text });
    const load = await loadConfig(files, CONFIG, ADD_FLAG, 2);
    assert.equal(load.status, 'loaded');
    if (load.status === 'loaded') {
      assert.deepEqual(load.pending, {
        fromVersion: 1,
        toVersion: 2,
        changes: ['v1→v2: added flag'],
        firstRelease: '9.1.0',
        migrated: { ...ROSTER, configVersion: 2, flag: true },
      });
      assert.equal(load.config.configVersion, 2);
    }
    assert.equal(files.get(CONFIG), text);
  });
});

describe('writeConfigWithBackup', () => {
  const pending = { fromVersion: 1, toVersion: 2, changes: ['added flag'], firstRelease: '9.1.0', migrated: { ...ROSTER, configVersion: 2, flag: true } };
  const target = { configPath: CONFIG, backupsDir: BACKUPS, backupName: migrationBackupName(pending) };

  it('backs up the original before writing the new config', async () => {
    const original = '{"configVersion": 1}\n';
    const files = new MemoryFiles({ [CONFIG]: original });
    const backup = await writeConfigWithBackup(files, target, pending.migrated, new FakeClock(0));
    assert.equal(backup.replaceAll('\\', '/'), `${BACKUPS}/config.v1.json`);
    assert.equal(files.get(backup), original);
    assert.equal(files.get(CONFIG), formatConfig(pending.migrated));
  });

  it('never overwrites an earlier backup', async () => {
    const files = new MemoryFiles({ [CONFIG]: 'new', [`${BACKUPS}/config.v1.json`]: 'old' });
    const clock = new FakeClock(Date.UTC(2026, 0, 2, 3, 4));
    const first = await writeConfigWithBackup(files, target, pending.migrated, clock);
    await files.write(CONFIG, 'newer');
    const second = await writeConfigWithBackup(files, target, pending.migrated, clock);
    assert.equal(first.replaceAll('\\', '/'), `${BACKUPS}/config.v1.202601020304.json`);
    assert.equal(second.replaceAll('\\', '/'), `${BACKUPS}/config.v1.202601020304-1.json`);
    assert.equal(files.get(`${BACKUPS}/config.v1.json`), 'old');
    assert.equal(files.get(first), 'new');
    assert.equal(files.get(second), 'newer');
  });

  it('refuses when the file vanished', async () => {
    await assert.rejects(writeConfigWithBackup(new MemoryFiles(), target, pending.migrated, new FakeClock(0)), /disappeared/);
  });
});
