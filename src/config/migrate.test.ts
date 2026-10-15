import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { CONFIG_MIGRATIONS, migrateConfig, RENAME_BLOCKED_TO_WAITING, RENAME_TIERS_TO_PRIORITIES, type ConfigMigration } from './migrate.ts';
import { CONFIG_VERSION } from './types.ts';

/** v1→v2 renames `messages.maxLines` to `messages.lineLimit`; v2→v3 adds `newKey`. */
const CHAIN: readonly ConfigMigration[] = [
  {
    from: 2,
    apply: (config) => ({ config: { ...config, newKey: true }, changes: ['added newKey'] }),
  },
  {
    from: 1,
    apply: (config) => {
      const messages = config['messages'];
      if (typeof messages !== 'object' || messages === null || !('maxLines' in messages)) {
        return { config, changes: [] };
      }
      const { maxLines, ...rest } = messages;
      return { config: { ...config, messages: { ...rest, lineLimit: maxLines } }, changes: ['messages.maxLines → messages.lineLimit'] };
    },
  },
];

describe('migrateConfig', () => {
  it('ships a chain that reaches the current version', () => {
    const result = migrateConfig({ configVersion: 1 });
    assert.deepEqual([result.kind, result.kind === 'migrated' ? result.version : undefined], ['migrated', CONFIG_VERSION]);
    assert.equal(CONFIG_MIGRATIONS.length, CONFIG_VERSION - 1);
  });

  it('treats a file without configVersion as the first format', () => {
    assert.deepEqual(migrateConfig({ sessions: [] }, 1, []), { kind: 'current', config: { sessions: [] }, version: 1 });
  });

  it('refuses an unusable configVersion', () => {
    for (const version of ['1', 0, 1.5, null]) {
      const result = migrateConfig({ configVersion: version }, 1, []);
      assert.equal(result.kind, 'invalid', String(version));
    }
  });

  it('flags a file written by a newer release', () => {
    assert.deepEqual(migrateConfig({ configVersion: 4 }, 3, CHAIN), { kind: 'newer', version: 4 });
  });

  it('applies each step in order, stamps the version and keeps unknown keys', () => {
    const raw: JsonRecord = { configVersion: 1, messages: { maxLines: 8, extra: 'x' }, custom: [1, 2] };
    const result = migrateConfig(raw, 3, CHAIN);
    assert.deepEqual(result, {
      kind: 'migrated',
      fromVersion: 1,
      version: 3,
      config: { configVersion: 3, messages: { extra: 'x', lineLimit: 8 }, custom: [1, 2], newKey: true },
      changes: ['v1→v2: messages.maxLines → messages.lineLimit', 'v2→v3: added newKey'],
    });
    assert.deepEqual(raw['messages'], { maxLines: 8, extra: 'x' }, 'the input is not mutated');
  });

  it('is idempotent', () => {
    const first = migrateConfig({ configVersion: 2 }, 3, CHAIN);
    assert.equal(first.kind, 'migrated');
    if (first.kind === 'migrated') {
      assert.deepEqual(migrateConfig(first.config, 3, CHAIN), { kind: 'current', config: first.config, version: 3 });
    }
  });

  it('fails loudly when the shipped chain has a gap', () => {
    assert.throws(() => migrateConfig({ configVersion: 1 }, 3, CHAIN.slice(0, 1)), /no config migration from version 1/);
  });
});

describe('the shipped migrations', () => {
  it('v1 to v2 moves register.tiers to register.priorities and keeps every other key', () => {
    const tiers = [{ id: 1, name: 'now' }, { id: 2, name: 'later' }];
    const raw: JsonRecord = { configVersion: 1, register: { tiers, maxTitle: 99 }, custom: true };
    assert.deepEqual(migrateConfig(raw, 2), {
      kind: 'migrated',
      fromVersion: 1,
      version: 2,
      config: { configVersion: 2, register: { maxTitle: 99, priorities: tiers }, custom: true },
      changes: ['v1→v2: register.tiers → register.priorities'],
    });
    assert.deepEqual(raw['register'], { tiers, maxTitle: 99 }, 'the input is not mutated');
  });

  it('v1 to v2 changes nothing but the version when there is no register.tiers', () => {
    for (const config of [{}, { register: { maxTitle: 99 } }, { register: 'not an object' }]) {
      assert.deepEqual(RENAME_TIERS_TO_PRIORITIES.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(RENAME_TIERS_TO_PRIORITIES.from, 1);
  });

  it('v2 to v3 names waiting where register.requireNoteOn named blocked, once, in its place', () => {
    const raw: JsonRecord = { configVersion: 2, register: { requireNoteOn: ['done', 'blocked', 'waiting'], maxTitle: 99 }, custom: true };
    assert.deepEqual(migrateConfig(raw, 3), {
      kind: 'migrated',
      fromVersion: 2,
      version: 3,
      config: { configVersion: 3, register: { requireNoteOn: ['done', 'waiting'], maxTitle: 99 }, custom: true },
      changes: ['v2→v3: register.requireNoteOn: blocked → waiting'],
    });
    assert.deepEqual(raw['register'], { requireNoteOn: ['done', 'blocked', 'waiting'], maxTitle: 99 }, 'the input is not mutated');
  });

  it('v2 to v3 changes nothing but the version when register.requireNoteOn does not name blocked', () => {
    const configs: JsonRecord[] = [
      {},
      { register: 'not an object' },
      { register: { maxTitle: 99 } },
      { register: { requireNoteOn: 'blocked' } },
      { register: { requireNoteOn: ['done'] } },
    ];
    for (const config of configs) {
      assert.deepEqual(RENAME_BLOCKED_TO_WAITING.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(RENAME_BLOCKED_TO_WAITING.from, 2);
  });

  it('a version-1 file reaches the current version through every step', () => {
    const result = migrateConfig({ configVersion: 1, register: { tiers: [], requireNoteOn: ['blocked'] } });
    assert.equal(result.kind, 'migrated');
    if (result.kind === 'migrated') {
      assert.equal(result.config['configVersion'], CONFIG_VERSION);
      assert.deepEqual(result.config['register'], { priorities: [], requireNoteOn: ['waiting'] });
    }
  });
});
