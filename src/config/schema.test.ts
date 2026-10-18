import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { MODEL_ALIASES, MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from './launch.ts';
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from './limits.ts';
import { parseConfig } from './parse.ts';
import { CORE_RULE_KEYS } from '../rules/keys.ts';
import { AD_HOC_RUNNERS, COMMIT_GATES, CONFLICT_WINNERS, EFFORT_LEVELS, PUSH_TO_PROTECTED, VERIFY_GATES } from './types.ts';

/** The roster has no default; everything else in the schema must state the code's default. */
const ROSTER = { sessions: ['alpha', 'bravo'], roles: { lead: 'alpha' } };
const ROSTER_KEYS = new Set(['sessions', 'roles']);

/** Sets every optional key, so walking it visits every key the parser reads. */
const EVERY_KEY = {
  ...ROSTER,
  team: { id: 'web', parent: 'app' },
  names: { alpha: 'team-lead' },
  ruleConflicts: [{ file: '~/CLAUDE.md', text: 'Commit straight to main.', rule: 'worktrees', wins: 'local', reason: 'solo repo' }],
  launch: { alpha: { model: 'best', effort: 'xhigh' } },
  roles: { lead: 'alpha', coordinatorOwner: 'bravo' },
  register: { goalPattern: '^G\\d+$' },
  coordinator: {
    dir: 'data/deploys',
    schedule: { heavyCutoffUtc: '22:30', resetBlackoutHours: 4 },
    heavy: { lockPath: 'data/deploys/host.lock', lockTtlMinutes: 150, maxRunMinutes: 45, waitMinutes: 60 },
    wait: { pollSeconds: 30, maxMinutes: 60 },
    gateTimeoutSeconds: 20,
    claims: { maxMinutes: 120 },
    repos: {
      api: {
        mainCheckout: 'C:/src/api',
        deploysOnPush: ['cloud-api'],
        dependencyGate: true,
        followMainCheckout: true,
        roll: { targets: ['cloud-api'], gates: [{ name: 'flow', command: ['node', 'gates/flow.js'] }], afterPull: [['node', 'pulled.js']], command: ['node', 'roll.js'] },
      },
    },
  },
  budget: {
    weeklyLimitW: 680_000_000,
    subagentWeight: 2,
    reset: { weekday: 'wed', timeUtc: '01:00' },
    dailyPct: 10,
    maxDailyPct: 12,
    sessions: { alpha: { share: 2, dailyPct: 1 } },
    quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' },
    statusSnapshotDir: '/u',
  },
  refresh: { handoverDir: 'notes' },
  statusLine: { folder: false, branch: false, resume: false },
  github: { repos: ['acme/web'], owners: { octocat: 'bravo' }, closedDays: 30, everyMinutes: 30 },
  paths: { state: '/s', inbox: '/i', skills: '/k' },
};

async function loadSchema(): Promise<JsonRecord> {
  const schema: unknown = JSON.parse(
    await readFile(new URL('../../plugins/teamrig/config.schema.json', import.meta.url), 'utf8'),
  );
  assert.ok(isRecord(schema));
  return schema;
}

/** The parsed config as plain JSON, so it can be walked like the schema. */
function asJson(raw: JsonRecord): JsonRecord {
  const { config, issues } = parseConfig(raw);
  assert.deepEqual(issues, []);
  const json: unknown = JSON.parse(JSON.stringify(config));
  assert.ok(isRecord(json));
  return json;
}

function properties(schema: JsonRecord): JsonRecord {
  const value = schema['properties'];
  return isRecord(value) ? value : {};
}

/** The schema of a key the node does not list, for a map such as `names`. */
function anyProperty(schema: JsonRecord): JsonRecord | undefined {
  const value = schema['additionalProperties'];
  return isRecord(value) ? value : undefined;
}

/** Where each bounded value sits in the config; typed so a new limit cannot skip the schema check. */
const LIMIT_PATHS: { readonly [Name in keyof typeof CONFIG_LIMITS]: string } = {
  maxLines: 'messages.maxLines',
  coldAfterMinutes: 'messages.coldAfterMinutes',
  maxDescriptionWords: 'skills.maxDescriptionWords',
  maxPerArea: 'skills.maxPerArea',
  maxVerifiedAgeDays: 'skills.maxVerifiedAgeDays',
  claudeMdChars: 'contextFiles.maxClaudeMdChars',
  memoryIndexChars: 'contextFiles.maxMemoryIndexChars',
  skillListingChars: 'contextFiles.maxSkillListingChars',
  ownerGates: 'ownerGates',
  ruleConflicts: 'ruleConflicts',
  protectedBranches: 'pushGuard.protectedBranches',
  commitMaxLines: 'commits.maxLines',
  commitMaxFiles: 'commits.maxFiles',
  testPatterns: 'commits.testPatterns',
  forbidFrontmatter: 'skills.forbidFrontmatter',
  requireNoteOn: 'register.requireNoteOn',
  requireFollowupsOn: 'register.requireFollowupsOn',
  maxVerifying: 'register.maxVerifying',
  stopgapFiles: 'register.check.stopgapFiles',
  persistentFailureHours: 'alerts.persistentFailureHours',
  chainNudgeAt: 'loops.chainNudgeAt',
  leadOwnPaths: 'leadBoundary.ownPaths',
  searchNudgeAt: 'leadBoundary.searchNudgeAt',
  wakePriority: 'wake.priority',
  wakeBatchSeconds: 'wake.batchSeconds',
  wakeMinGapMinutes: 'wake.minGapMinutes',
  maxFailureChars: 'tests.maxFailureChars',
  githubRepos: 'github.repos',
  closedDays: 'github.closedDays',
  githubEveryMinutes: 'github.everyMinutes',
  budgetTargetPct: 'budget.targetPct',
  budgetReservePct: 'budget.reservePct',
  weeklyLimitW: 'budget.weeklyLimitW',
  subagentWeight: 'budget.subagentWeight',
  paceEndHoursBeforeReset: 'budget.paceEndHoursBeforeReset',
  dailyPct: 'budget.dailyPct',
  maxDailyPct: 'budget.maxDailyPct',
  sessionShare: 'budget.sessions.*.share',
  sessionDailyPct: 'budget.sessions.*.dailyPct',
  warnAtPct: 'budget.warnAtPct',
  paceTolerancePct: 'budget.paceTolerancePct',
  liftMaxStopPct: 'budget.lift.maxStopPct',
  liftReserveStopPct: 'budget.lift.reserveStopPct',
  maxBytesPerHook: 'budget.maxBytesPerHook',
  hiringMaxSessions: 'hiring.maxSessions',
  hiringDailyPct: 'hiring.dailyPct',
  hiringMaxDailyPct: 'hiring.maxDailyPct',
  hiringIdleHours: 'hiring.idleHours',
  hiringReviewDays: 'hiring.reviewDays',
  hiringResumeMaxTokens: 'hiring.resumeMaxTokens',
  hiringResumeMaxIdleDays: 'hiring.resumeMaxIdleDays',
  burstSurplusHours: 'burst.surplusHours',
  burstMinSparePct: 'burst.minSparePct',
  burstMaxHelpers: 'burst.maxHelpers',
  burstMaxHires: 'burst.maxHires',
  heavyLockTtlMinutes: 'coordinator.heavy.lockTtlMinutes',
  heavyMaxRunMinutes: 'coordinator.heavy.maxRunMinutes',
  heavyWaitMinutes: 'coordinator.heavy.waitMinutes',
  coordinatorPollSeconds: 'coordinator.wait.pollSeconds',
  coordinatorWaitMaxMinutes: 'coordinator.wait.maxMinutes',
  gateTimeoutSeconds: 'coordinator.gateTimeoutSeconds',
  claimMaxMinutes: 'coordinator.claims.maxMinutes',
  resetBlackoutHours: 'coordinator.schedule.resetBlackoutHours',
};

function isLimitName(name: string): name is keyof typeof CONFIG_LIMITS {
  return name in CONFIG_LIMITS;
}

/** The schema node at a dotted config path such as `skills.maxPerArea`; `*` stands for any key of a map. */
function nodeAt(schema: JsonRecord, path: string): JsonRecord {
  const node = path.split('.').reduce<JsonRecord | undefined>((parent, key) => {
    const child = parent === undefined ? undefined : key === '*' ? anyProperty(parent) : properties(parent)[key];
    return isRecord(child) ? child : undefined;
  }, schema);
  assert.ok(node !== undefined, `${path} is not in the schema`);
  return node;
}

/** Every key of the parsed config, with its value and its schema node. */
function* walkConfig(config: JsonRecord, schema: JsonRecord, path: string): Generator<[string, unknown, JsonRecord | undefined]> {
  for (const [key, value] of Object.entries(config)) {
    const node = properties(schema)[key] ?? anyProperty(schema);
    const keyPath = path === '' ? key : `${path}.${key}`;
    yield [keyPath, value, isRecord(node) ? node : undefined];
    if (isRecord(value) && isRecord(node)) {
      yield* walkConfig(value, node, keyPath);
    }
  }
}

/** Every schema property that declares a default, with the matching parsed value. */
function* walkDefaults(schema: JsonRecord, config: JsonRecord | undefined, path: string): Generator<[string, unknown, unknown]> {
  for (const [key, node] of Object.entries(properties(schema))) {
    if (!isRecord(node)) {
      continue;
    }
    const keyPath = path === '' ? key : `${path}.${key}`;
    const value = config?.[key];
    if ('default' in node) {
      yield [keyPath, node['default'], value];
    }
    yield* walkDefaults(node, isRecord(value) ? value : undefined, keyPath);
  }
}

describe('config.schema.json', () => {
  it('describes every key the parser produces', async () => {
    const schema = await loadSchema();
    const missing = [...walkConfig(asJson(EVERY_KEY), schema, '')].filter(([, , node]) => node === undefined).map(([path]) => path);
    assert.deepEqual(missing, []);
  });

  it('states the code default for every key outside the roster', async () => {
    const schema = await loadSchema();
    for (const [path, value, node] of walkConfig(asJson(ROSTER), schema, '')) {
      if (ROSTER_KEYS.has(path.split('.')[0] ?? '') || isRecord(value)) {
        continue;
      }
      assert.ok(node !== undefined && 'default' in node, `${path} has no default in the schema`);
      assert.deepEqual(node['default'], value, path);
    }
  });

  it('declares no default the code does not apply', async () => {
    const schema = await loadSchema();
    for (const [path, declared, applied] of walkDefaults(schema, asJson(ROSTER), '')) {
      assert.deepEqual(declared, applied, path);
    }
  });

  it('states the bounds the parser enforces', async () => {
    const schema = await loadSchema();
    for (const name of Object.keys(CONFIG_LIMITS).filter(isLimitName)) {
      const limit = CONFIG_LIMITS[name];
      const path = LIMIT_PATHS[name];
      const node = nodeAt(schema, path);
      if ('min' in limit) {
        assert.deepEqual([node['minimum'], node['maximum']], [limit.min, limit.max], path);
        continue;
      }
      assert.equal(node['maxItems'], limit.maxItems, path);
      const items = node['items'];
      assert.ok(isRecord(items), path);
      if ('maxLength' in limit) {
        assert.equal(items['maxLength'], limit.maxLength, path);
      }
      if ('itemMin' in limit) {
        assert.deepEqual([items['minimum'], items['maximum']], [limit.itemMin, limit.itemMax], path);
      }
    }
  });

  it('takes the models and efforts the parser takes', async () => {
    const launch = anyProperty(nodeAt(await loadSchema(), 'launch'));
    assert.ok(launch !== undefined);
    const { model, effort } = properties(launch);
    assert.ok(isRecord(model) && isRecord(effort));
    assert.deepEqual(model['anyOf'], [
      { enum: [...MODEL_ALIASES] },
      { type: 'string', pattern: MODEL_ID_PATTERN.source, maxLength: MODEL_ID_MAX_LENGTH },
    ]);
    assert.deepEqual(effort['enum'], [...EFFORT_LEVELS]);
  });

  it('takes the push and commit choices the parser takes', async () => {
    const schema = await loadSchema();
    assert.deepEqual(nodeAt(schema, 'pushGuard.pushToProtected')['enum'], [...PUSH_TO_PROTECTED]);
    assert.deepEqual(nodeAt(schema, 'packageGuard.adHocRunners')['enum'], [...AD_HOC_RUNNERS]);
    assert.deepEqual(nodeAt(schema, 'commits.gate')['enum'], [...COMMIT_GATES]);
  });

  it('takes the verify gate choices the parser takes', async () => {
    assert.deepEqual(nodeAt(await loadSchema(), 'register.verifyGate')['enum'], [...VERIFY_GATES]);
  });

  it('takes the rule conflicts the parser takes', async () => {
    const items = nodeAt(await loadSchema(), 'ruleConflicts')['items'];
    assert.ok(isRecord(items));
    const { file, text, rule, wins, reason } = properties(items);
    assert.ok(isRecord(file) && isRecord(text) && isRecord(rule) && isRecord(wins) && isRecord(reason));
    assert.deepEqual(
      [file['maxLength'], text['maxLength'], reason['maxLength']],
      [RULE_CONFLICT_LIMITS.fileMaxLength, RULE_CONFLICT_LIMITS.textMaxLength, RULE_CONFLICT_LIMITS.reasonMaxLength],
    );
    assert.deepEqual(rule['enum'], [...CORE_RULE_KEYS]);
    assert.deepEqual(wins['enum'], [...CONFLICT_WINNERS]);
    assert.deepEqual(items['required'], ['file', 'text', 'rule', 'wins']);
  });

  it('requires exactly the roster', async () => {
    const schema = await loadSchema();
    assert.deepEqual(schema['required'], ['sessions', 'roles']);
  });
});
