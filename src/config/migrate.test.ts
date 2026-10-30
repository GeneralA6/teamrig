import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import {
  CONFIG_MIGRATIONS,
  DROP_FIXED_DAILY_BUDGETS,
  DROP_HIRE_CAP,
  DROP_IDLE_RETIRE,
  HIRE_CAP_DROPPED,
  IDLE_RETIRE_DROPPED,
  migrateConfig,
  RENAME_BLOCKED_TO_WAITING,
  RENAME_TIERS_TO_PRIORITIES,
  RENAME_TO_DELIVERY, RENAME_TO_PLAIN_WORDS,
  type ConfigMigration,
} from './migrate.ts';
import { CONFIG_VERSION } from './types.ts';

/** v1→v2 renames `messages.maxLines` to `messages.lineLimit` (release 9.2.0); v2→v3 adds `newKey` (9.3.0). */
const CHAIN: readonly ConfigMigration[] = [
  {
    from: 2,
    firstRelease: '9.3.0',
    apply: (config) => ({ config: { ...config, newKey: true }, changes: ['added newKey'] }),
  },
  {
    from: 1,
    firstRelease: '9.2.0',
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
      firstRelease: '9.3.0',
    });
    const toV2 = migrateConfig({ configVersion: 1 }, 2, CHAIN);
    assert.equal(toV2.kind === 'migrated' ? toV2.firstRelease : undefined, '9.2.0', "the release of the target version's step");
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
      firstRelease: '0.1.1',
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
      firstRelease: '0.10.0',
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

  it('v3 to v4 drops every fixed daily budget and keeps every other key', () => {
    const budget: JsonRecord = {
      targetPct: 99.3,
      dailyPct: 14,
      maxDailyPct: 20,
      sessions: { alpha: { dailyPct: 1 }, bravo: { share: 2, dailyPct: 3 }, charlie: { share: 1 } },
    };
    const raw: JsonRecord = { configVersion: 3, budget, hiring: { policy: 'lead', maxSessions: 6, dailyPct: 1, maxDailyPct: 15 }, custom: true };
    const session = "the session's part of the team's daily budget is recomputed from its share and queued work";
    const hiring = "a hire's daily budget is its part of the team's";
    assert.deepEqual(migrateConfig(raw, 4), {
      kind: 'migrated',
      fromVersion: 3,
      version: 4,
      config: {
        configVersion: 4,
        budget: { targetPct: 99.3, sessions: { bravo: { share: 2 }, charlie: { share: 1 } } },
        hiring: { policy: 'lead', maxSessions: 6 },
        custom: true,
      },
      changes: [
        'v3→v4: budget.dailyPct removed: the daily budget is recomputed from what is left of the week',
        'v3→v4: budget.maxDailyPct removed: the daily budget is recomputed from what is left of the week',
        `v3→v4: budget.sessions.alpha.dailyPct removed: ${session}`,
        `v3→v4: budget.sessions.bravo.dailyPct removed: ${session}`,
        `v3→v4: hiring.dailyPct removed: ${hiring}`,
        `v3→v4: hiring.maxDailyPct removed: ${hiring}`,
      ],
      firstRelease: '0.83.0',
    });
    assert.deepEqual(raw['budget'], budget, 'the input is not mutated');
    assert.deepEqual(budget['sessions'], { alpha: { dailyPct: 1 }, bravo: { share: 2, dailyPct: 3 }, charlie: { share: 1 } });
  });

  it('v3 to v4 drops budget.sessions when every entry held only a fixed daily %', () => {
    const step = DROP_FIXED_DAILY_BUDGETS.apply({ budget: { enabled: true, sessions: { alpha: { dailyPct: 1 }, bravo: { dailyPct: 1 } } } });
    assert.deepEqual(step.config, { budget: { enabled: true } });
    assert.equal(step.changes.length, 2);
  });

  it('v3 to v4 changes nothing but the version when no daily budget is fixed', () => {
    const configs: JsonRecord[] = [
      {},
      { budget: 'not an object', hiring: 3 },
      { budget: { targetPct: 99, sessions: { alpha: {}, bravo: 'odd', charlie: { share: 2 } } } },
      { budget: { sessions: 'not an object' } },
      { hiring: { policy: 'lead', maxSessions: 2 } },
    ];
    for (const config of configs) {
      assert.deepEqual(DROP_FIXED_DAILY_BUDGETS.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(DROP_FIXED_DAILY_BUDGETS.from, 3);
  });

  it('v4 to v5 renames the deploy keys into plain words, each in its place, and keeps every value', () => {
    const roll = { targets: ['api'], gates: [{ name: 'flow', command: ['node', 'flow.js'] }], afterPull: [], command: ['node', 'deploy.js'] };
    const coordinator: JsonRecord = {
      dir: 'coordinator',
      gateTimeoutSeconds: 30,
      windows: { settleMinutes: 30, assumedRollMinutes: 25, minMinutes: 15 },
      repos: { api: { mainCheckout: '/repo/api', roll, followMainCheckout: true }, web: { mainCheckout: '/repo/web' } },
    };
    const raw: JsonRecord = { configVersion: 4, coordinator, custom: true };
    const result = migrateConfig(raw, 5);
    assert.deepEqual(result, {
      kind: 'migrated',
      fromVersion: 4,
      version: 5,
      config: {
        configVersion: 5,
        coordinator: {
          dir: 'coordinator',
          checkTimeoutSeconds: 30,
          windows: { settleMinutes: 30, assumedDeployMinutes: 25, minMinutes: 15 },
          repos: {
            api: { mainCheckout: '/repo/api', deploy: { targets: ['api'], checks: roll.gates, afterPull: [], command: ['node', 'deploy.js'] }, followMainCheckout: true },
            web: { mainCheckout: '/repo/web' },
          },
        },
        custom: true,
      },
      changes: [
        'v4→v5: coordinator.repos.api.roll → coordinator.repos.api.deploy',
        'v4→v5: coordinator.repos.api.deploy.gates → coordinator.repos.api.deploy.checks',
        'v4→v5: coordinator.gateTimeoutSeconds → coordinator.checkTimeoutSeconds',
        'v4→v5: coordinator.windows.assumedRollMinutes → coordinator.windows.assumedDeployMinutes',
      ],
      firstRelease: RENAME_TO_PLAIN_WORDS.firstRelease,
    });
    const written = result.kind === 'migrated' ? result.config['coordinator'] : undefined;
    assert.ok(isRecord(written));
    assert.deepEqual(Object.keys(written), ['dir', 'checkTimeoutSeconds', 'windows', 'repos'], 'a renamed key keeps its place');
    assert.deepEqual(raw['coordinator'], coordinator, 'the input is not mutated');
    assert.deepEqual(coordinator['repos'], { api: { mainCheckout: '/repo/api', roll, followMainCheckout: true }, web: { mainCheckout: '/repo/web' } });
  });

  it('v4 to v5 keeps the old key where both are set, as version 4 read only it, and says the new one was replaced', () => {
    const raw: JsonRecord = {
      coordinator: {
        gateTimeoutSeconds: 30,
        checkTimeoutSeconds: 90,
        repos: { api: { mainCheckout: '/repo/api', deploy: { command: ['node', 'new.js'] }, roll: { command: ['node', 'old.js'], gates: [], checks: [{ name: 'x' }] } } },
      },
    };
    assert.deepEqual(RENAME_TO_PLAIN_WORDS.apply(raw), {
      config: { coordinator: { checkTimeoutSeconds: 30, repos: { api: { mainCheckout: '/repo/api', deploy: { command: ['node', 'old.js'], checks: [] } } } } },
      changes: [
        'coordinator.repos.api.roll → coordinator.repos.api.deploy, replacing the coordinator.repos.api.deploy version 4 did not read',
        'coordinator.repos.api.deploy.gates → coordinator.repos.api.deploy.checks, replacing the coordinator.repos.api.deploy.checks version 4 did not read',
        'coordinator.gateTimeoutSeconds → coordinator.checkTimeoutSeconds, replacing the coordinator.checkTimeoutSeconds version 4 did not read',
      ],
    });
  });

  it('v4 to v5 changes nothing but the version when no old key is set', () => {
    const configs: JsonRecord[] = [
      {},
      { coordinator: 'not an object' },
      { coordinator: { repos: 'not an object', windows: 3 } },
      { coordinator: { repos: { api: 'odd', web: { mainCheckout: '/repo/web', merge: { gates: [] } } } } },
      { coordinator: { checkTimeoutSeconds: 30, windows: { assumedDeployMinutes: 20 }, repos: { api: { deploy: { checks: [] } } } } },
      { roll: { gates: [] }, gateTimeoutSeconds: 30 },
    ];
    for (const config of configs) {
      assert.deepEqual(RENAME_TO_PLAIN_WORDS.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(RENAME_TO_PLAIN_WORDS.from, 4);
  });

  it('v5 to v6 drops the hire cap and who raised it, and keeps every other key', () => {
    const hiring: JsonRecord = { policy: 'lead', maxSessions: 4, idleHours: 2, capRaisedBy: 'lead', scaleOut: { minDone: 2 } };
    const raw: JsonRecord = { configVersion: 5, hiring, custom: true };
    assert.deepEqual(migrateConfig(raw, 6), {
      kind: 'migrated',
      fromVersion: 5,
      version: 6,
      config: { configVersion: 6, hiring: { policy: 'lead', idleHours: 2, scaleOut: { minDone: 2 } }, custom: true },
      changes: [`v5→v6: hiring.maxSessions removed: ${HIRE_CAP_DROPPED}`, `v5→v6: hiring.capRaisedBy removed: ${HIRE_CAP_DROPPED}`],
      firstRelease: '0.232.0',
    });
    assert.deepEqual(raw['hiring'], { policy: 'lead', maxSessions: 4, idleHours: 2, capRaisedBy: 'lead', scaleOut: { minDone: 2 } }, 'the input is not mutated');
  });

  it('v5 to v6 changes nothing but the version when no hire cap is set', () => {
    const configs: JsonRecord[] = [{}, { hiring: 'not an object' }, { hiring: { policy: 'lead', idleHours: 2 } }, { maxSessions: 2, capRaisedBy: 'owner' }];
    for (const config of configs) {
      assert.deepEqual(DROP_HIRE_CAP.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(DROP_HIRE_CAP.from, 5);
  });

  it('v6 to v7 drops hiring.idleHours, and keeps every other key', () => {
    const raw: JsonRecord = { configVersion: 6, hiring: { policy: 'lead', idleHours: 2, scaleOut: { minDone: 2 } }, custom: true };
    assert.deepEqual(migrateConfig(raw, 7), {
      kind: 'migrated',
      fromVersion: 6,
      version: 7,
      config: { configVersion: 7, hiring: { policy: 'lead', scaleOut: { minDone: 2 } }, custom: true },
      changes: [`v6→v7: hiring.idleHours removed: ${IDLE_RETIRE_DROPPED}`],
      firstRelease: '0.233.0',
    });
  });

  it('v6 to v7 changes nothing but the version when no idle hours are set', () => {
    const configs: JsonRecord[] = [{}, { hiring: 'not an object' }, { hiring: { policy: 'lead' } }, { idleHours: 2 }];
    for (const config of configs) {
      assert.deepEqual(DROP_IDLE_RETIRE.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(DROP_IDLE_RETIRE.from, 6);
  });

  it('v7 to v8 renames the delivery keys into plain words, each in its place, and keeps every value', () => {
    const coordinator: JsonRecord = {
      dir: 'coordinator',
      schedule: { heavyCutoffUtc: '22:30', resetBlackoutHours: 6 },
      heavy: { maxRunMinutes: 45 },
      wait: { pollSeconds: 30 },
      claims: { maxMinutes: 120 },
      windows: { settleMinutes: 30 },
      repos: { api: { mainCheckout: '/repo/api', followMainCheckout: true, worktreeFolder: 'trees' }, web: { mainCheckout: '/repo/web' } },
    };
    const raw: JsonRecord = { configVersion: 7, roles: { lead: 'lead', coordinatorOwner: 'ops', securityReviewer: 'sec' }, coordinator, custom: true };
    const result = migrateConfig(raw, 8);
    assert.deepEqual(result, {
      kind: 'migrated',
      fromVersion: 7,
      version: 8,
      config: {
        configVersion: 8,
        roles: { lead: 'lead', deliveryOwner: 'ops', securityReviewer: 'sec' },
        delivery: {
          dir: 'coordinator',
          schedule: { queueCutoffUtc: '22:30', resetBlackoutHours: 6 },
          queue: { maxRunMinutes: 45 },
          wait: { pollSeconds: 30 },
          freezes: { maxMinutes: 120 },
          stablePeriods: { settleMinutes: 30 },
          repos: { api: { mainCheckout: '/repo/api', updateMainCheckout: true, worktreeFolder: 'trees' }, web: { mainCheckout: '/repo/web' } },
        },
        custom: true,
      },
      changes: [
        'v7→v8: coordinator.repos.api.followMainCheckout → coordinator.repos.api.updateMainCheckout',
        'v7→v8: coordinator.schedule.heavyCutoffUtc → coordinator.schedule.queueCutoffUtc',
        'v7→v8: coordinator.heavy → coordinator.queue',
        'v7→v8: coordinator.claims → coordinator.freezes',
        'v7→v8: coordinator.windows → coordinator.stablePeriods',
        'v7→v8: coordinator → delivery',
        'v7→v8: roles.coordinatorOwner → roles.deliveryOwner',
      ],
      firstRelease: RENAME_TO_DELIVERY.firstRelease,
    });
    const written: JsonRecord = result.kind === 'migrated' ? result.config : {};
    assert.deepEqual(Object.keys(written), ['configVersion', 'roles', 'delivery', 'custom'], 'a renamed key keeps its place');
    const delivery = written['delivery'];
    assert.ok(isRecord(delivery));
    assert.deepEqual(Object.keys(delivery), ['dir', 'schedule', 'queue', 'wait', 'freezes', 'stablePeriods', 'repos']);
    assert.deepEqual(raw['coordinator'], coordinator, 'the input is not mutated');
    assert.deepEqual(coordinator['repos'], { api: { mainCheckout: '/repo/api', followMainCheckout: true, worktreeFolder: 'trees' }, web: { mainCheckout: '/repo/web' } });
  });

  it('v7 to v8 keeps the old key where both are set, as version 7 read only it, and says the new one was replaced', () => {
    const raw: JsonRecord = {
      roles: { lead: 'lead', coordinatorOwner: 'ops', deliveryOwner: 'web' },
      coordinator: { heavy: { maxRunMinutes: 45 }, queue: { maxRunMinutes: 5 }, repos: { api: { followMainCheckout: false, updateMainCheckout: true } } },
      delivery: { dir: 'unread' },
    };
    assert.deepEqual(RENAME_TO_DELIVERY.apply(raw), {
      config: {
        roles: { lead: 'lead', deliveryOwner: 'ops' },
        delivery: { queue: { maxRunMinutes: 45 }, repos: { api: { updateMainCheckout: false } } },
      },
      changes: [
        'coordinator.repos.api.followMainCheckout → coordinator.repos.api.updateMainCheckout, replacing the coordinator.repos.api.updateMainCheckout version 7 did not read',
        'coordinator.heavy → coordinator.queue, replacing the coordinator.queue version 7 did not read',
        'coordinator → delivery, replacing the delivery version 7 did not read',
        'roles.coordinatorOwner → roles.deliveryOwner, replacing the roles.deliveryOwner version 7 did not read',
      ],
    });
  });

  it('v7 to v8 changes nothing but the version when no old key is set', () => {
    const configs: JsonRecord[] = [
      {},
      { roles: 'not an object', delivery: 'not an object' },
      { roles: { lead: 'lead', deliveryOwner: 'ops' }, delivery: { queue: {}, freezes: {}, stablePeriods: {}, schedule: { queueCutoffUtc: '22:30' } } },
      { delivery: { repos: { api: { updateMainCheckout: true }, web: 'odd' } } },
      { heavy: {}, claims: {}, windows: {}, coordinatorOwner: 'ops', followMainCheckout: true },
    ];
    for (const config of configs) {
      assert.deepEqual(RENAME_TO_DELIVERY.apply(config), { config, changes: [] }, JSON.stringify(config));
    }
    assert.equal(RENAME_TO_DELIVERY.from, 7);
  });

  it('a version-1 file reaches the current version through every step', () => {
    const result = migrateConfig({
      configVersion: 1,
      register: { tiers: [], requireNoteOn: ['blocked'] },
      coordinator: { gateTimeoutSeconds: 30, heavy: { maxRunMinutes: 45 } },
      hiring: { policy: 'lead', maxSessions: 3 },
    });
    assert.equal(result.kind, 'migrated');
    if (result.kind === 'migrated') {
      assert.equal(result.config['configVersion'], CONFIG_VERSION);
      assert.deepEqual(result.config['register'], { priorities: [], requireNoteOn: ['waiting'] });
      assert.deepEqual(result.config['delivery'], { checkTimeoutSeconds: 30, queue: { maxRunMinutes: 45 } });
      assert.deepEqual(result.config['hiring'], { policy: 'lead' });
    }
  });
});
