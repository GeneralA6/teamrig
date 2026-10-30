import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { NAME_PATTERN, RESERVED_NAMES } from '../core/ids.ts';
import { MODEL_ALIASES, MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from './launch.ts';
import { BUDGET_ACCOUNT_MAX_LENGTH, CONFIG_LIMITS, REVIEW_PATH_LIMITS, RULE_CONFLICT_LIMITS } from './limits.ts';
import { parseConfig } from './parse.ts';
import { KEEP_RULE_PATTERN } from '../permissions/allow-rules.ts';
import { PREFIX_PATTERN } from '../readonly-shell/rules.ts';
import { CORE_RULE_KEYS } from '../rules/keys.ts';
import { AD_HOC_RUNNERS, COMMIT_GATES, CONFLICT_WINNERS, EFFORT_LEVELS, HOOK_ASKS, PACKAGE_INSTALLS, PUSH_TO_PROTECTED, REVIEW_CLASSES, REVIEW_PATH_MODES, VERIFY_GATES } from './types.ts';

/** The roster has no default; everything else in the schema must state the code's default. */
const ROSTER = { sessions: ['alpha', 'bravo'], roles: { lead: 'alpha' } };
const ROSTER_KEYS = new Set(['sessions', 'roles']);

/** Sets every optional key, so walking it visits every key the parser reads. */
const EVERY_KEY = {
  ...ROSTER,
  sessions: ['alpha', 'bravo', 'charlie'],
  leads: { bravo: ['charlie'] },
  team: { id: 'web', parent: 'app' },
  names: { alpha: 'captain' },
  ruleConflicts: [{ file: '~/CLAUDE.md', text: 'Commit straight to main.', rule: 'worktrees', wins: 'local', reason: 'solo repo' }],
  launch: { alpha: { model: 'best', effort: 'xhigh' } },
  roles: { lead: 'alpha', coordinatorOwner: 'bravo', securityReviewer: 'bravo' },
  register: { goalPattern: '^G\\d+$' },
  coordinator: {
    dir: 'data/deploys',
    schedule: { heavyCutoffUtc: '22:30', resetBlackoutHours: 4 },
    heavy: { lockPath: 'data/deploys/host.lock', lockTtlMinutes: 150, maxRunMinutes: 45, waitMinutes: 60 },
    wait: { pollSeconds: 30, maxMinutes: 60 },
    checkTimeoutSeconds: 20,
    claims: { maxMinutes: 120 },
    windows: { settleMinutes: 30, targetSettleMinutes: { 'cloud-api': 10 }, assumedDeployMinutes: 20, minMinutes: 15 },
    repos: {
      api: {
        mainCheckout: 'C:/src/api',
        deploysOnPush: ['cloud-api'],
        dependencyGate: true,
        reviewGate: true,
        reviewCheck: ['node', 'review.js'],
        followMainCheckout: true,
        deploy: { targets: ['cloud-api'], checks: [{ name: 'flow', command: ['node', 'checks/flow.js'] }], afterPull: [['node', 'pulled.js']], command: ['node', 'deploy.js'] },
      },
    },
  },
  budget: {
    account: 'shared',
    weeklyLimitW: 680_000_000,
    subagentWeight: 2,
    extraWPerUsd: 120_000,
    reset: { weekday: 'wed', timeUtc: '01:00' },
    sessions: { alpha: { share: 2 } },
    quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' },
    statusSnapshotDir: '/u',
  },
  refresh: { handoverDir: 'notes' },
  readonlyShell: { enabled: true, allowPrefixes: ['npx tsc --noEmit'] },
  permissions: { keepAllow: ['Bash(kubectl get *)'] },
  statusLine: { folder: false, branch: false, resume: false },
  decisions: { batchTimesUtc: ['13:03'], batchAt: 3 },
  github: { repos: ['acme/web'], owners: { octocat: 'bravo' }, closedDays: 30, everyMinutes: 30 },
  paths: { state: '/s', inbox: '/i', skills: '/k' },
  exec: { path: ['C:/tools'], webhookEnv: 'EXEC_WEBHOOK_URL' },
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
  sessionListsChars: 'contextFiles.maxSessionListsChars',
  ownerGates: 'ownerGates',
  ruleConflicts: 'ruleConflicts',
  protectedBranches: 'pushGuard.protectedBranches',
  reviewPaths: 'pushGuard.reviewPaths',
  commitMaxLines: 'commits.maxLines',
  commitMaxFiles: 'commits.maxFiles',
  testPatterns: 'commits.testPatterns',
  sourcePatterns: 'commits.sourcePatterns',
  forbidFrontmatter: 'skills.forbidFrontmatter',
  requireNoteOn: 'register.requireNoteOn',
  requireFollowupsOn: 'register.requireFollowupsOn',
  reviewRequireOn: 'register.review.requireOn',
  criticalOwners: 'register.review.criticalOwners',
  maxVerifying: 'register.maxVerifying',
  maxReparks: 'register.maxReparks',
  maxSelfMadePerDay: 'register.check.maxSelfMadePerDay',
  goalProgressDays: 'register.check.goalProgressDays',
  overSizeMultiple: 'register.check.overSizeMultiple',
  stopgapFiles: 'register.check.stopgapFiles',
  persistentFailureHours: 'alerts.persistentFailureHours',
  decisionBatchTimes: 'decisions.batchTimesUtc',
  decisionBatchAt: 'decisions.batchAt',
  chainNudgeAt: 'loops.chainNudgeAt',
  leadOwnPaths: 'leadBoundary.ownPaths',
  readonlyShellPrefixes: 'readonlyShell.allowPrefixes',
  keepAllow: 'permissions.keepAllow',
  secretPaths: 'secretGuard.paths',
  secretEnvNames: 'secretGuard.envNames',
  secretCommands: 'secretGuard.commands',
  packageCooldownDays: 'packageGuard.cooldownDays',
  searchNudgeAt: 'leadBoundary.searchNudgeAt',
  turnLogKeepHours: 'turnLog.keepHours',
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
  extraWPerUsd: 'budget.extraWPerUsd',
  paceEndHoursBeforeReset: 'budget.paceEndHoursBeforeReset',
  sessionShare: 'budget.sessions.*.share',
  warnAtPct: 'budget.warnAtPct',
  paceTolerancePct: 'budget.paceTolerancePct',
  quietPaceWeight: 'budget.quietHours.paceWeight',
  liftMaxStopPct: 'budget.lift.maxStopPct',
  liftReserveStopPct: 'budget.lift.reserveStopPct',
  maxBytesPerHook: 'budget.maxBytesPerHook',
  hiringReviewDays: 'hiring.reviewDays',
  hiringResumeMaxTokens: 'hiring.resumeMaxTokens',
  hiringResumeMaxIdleDays: 'hiring.resumeMaxIdleDays',
  scaleOutWindowDays: 'hiring.scaleOut.windowDays',
  scaleOutMinDone: 'hiring.scaleOut.minDone',
  scaleOutTopPriorities: 'hiring.scaleOut.topPriorities',
  burstSurplusHours: 'burst.surplusHours',
  burstMinSparePct: 'burst.minSparePct',
  burstMaxHelpers: 'burst.maxHelpers',
  burstMaxHires: 'burst.maxHires',
  heavyLockTtlMinutes: 'coordinator.heavy.lockTtlMinutes',
  heavyMaxRunMinutes: 'coordinator.heavy.maxRunMinutes',
  heavySmallMaxRunMinutes: 'coordinator.heavy.smallMaxRunMinutes',
  heavyWaitMinutes: 'coordinator.heavy.waitMinutes',
  heavyMemorySampleSeconds: 'coordinator.heavy.memorySampleSeconds',
  heavyMemoryFloorMb: 'coordinator.heavy.memoryFloorMb',
  heavySmallReserveMb: 'coordinator.heavy.smallReserveMb',
  headroomSessionMb: 'open.headroom.sessionMb',
  headroomCommitMaxPct: 'open.headroom.commitMaxPct',
  headroomCloseIdleMinutes: 'open.headroom.closeIdleMinutes',
  coordinatorPollSeconds: 'coordinator.wait.pollSeconds',
  coordinatorWaitMaxMinutes: 'coordinator.wait.maxMinutes',
  checkTimeoutSeconds: 'coordinator.checkTimeoutSeconds',
  claimMaxMinutes: 'coordinator.claims.maxMinutes',
  settleMinutes: 'coordinator.windows.settleMinutes',
  assumedDeployMinutes: 'coordinator.windows.assumedDeployMinutes',
  windowMinMinutes: 'coordinator.windows.minMinutes',
  resetBlackoutHours: 'coordinator.schedule.resetBlackoutHours',
  execPath: 'exec.path',
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

/**
 * Every key the schema lists, with its dotted path, also inside array items (`[]`) and map values (`*`, as nodeAt takes them).
 * The item or value object itself is not a key: the array or map that holds it describes it.
 */
function* walkKeys(schema: JsonRecord, path: string): Generator<[string, JsonRecord]> {
  for (const [key, node] of Object.entries(properties(schema))) {
    if (!isRecord(node)) {
      continue;
    }
    const keyPath = path === '' ? key : `${path}.${key}`;
    yield [keyPath, node];
    yield* walkKeys(node, keyPath);
  }
  const items = schema['items'];
  if (isRecord(items)) {
    yield* walkKeys(items, `${path}[]`);
  }
  const value = anyProperty(schema);
  if (value !== undefined) {
    yield* walkKeys(value, `${path}.*`);
  }
}

function hasDescription(node: JsonRecord): boolean {
  const description = node['description'];
  return typeof description === 'string' && description.trim() !== '';
}

describe('config.schema.json', () => {
  it('describes every key the parser produces', async () => {
    const schema = await loadSchema();
    const missing = [...walkConfig(asJson(EVERY_KEY), schema, '')].filter(([, , node]) => node === undefined).map(([path]) => path);
    assert.deepEqual(missing, []);
  });

  it('says in words what every key does', async () => {
    const undescribed = [...walkKeys(await loadSchema(), '')].filter(([, node]) => !hasDescription(node)).map(([path]) => path);
    assert.deepEqual(undescribed, []);
  });

  it('walks keys inside array items and map values', () => {
    const schema = {
      properties: {
        list: { description: 'a list', items: { properties: { id: { type: 'integer' } } } },
        map: { description: 'a map', additionalProperties: { properties: { share: { description: 'its share' } } } },
      },
    };
    assert.deepEqual([...walkKeys(schema, '')].filter(([, node]) => !hasDescription(node)).map(([path]) => path), ['list[].id']);
    assert.deepEqual(
      [...walkKeys(schema, '')].map(([path]) => path),
      ['list', 'list[].id', 'map', 'map.*.share'],
    );
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
    assert.deepEqual(nodeAt(schema, 'packageGuard.installs')['enum'], [...PACKAGE_INSTALLS]);
    assert.deepEqual(nodeAt(schema, 'commits.gate')['enum'], [...COMMIT_GATES]);
    assert.deepEqual(nodeAt(schema, 'prompts.hookAsks')['enum'], [...HOOK_ASKS]);
  });

  it('takes the read-only shell prefixes the parser takes', async () => {
    const items = nodeAt(await loadSchema(), 'readonlyShell.allowPrefixes')['items'];
    assert.ok(isRecord(items));
    assert.equal(items['pattern'], PREFIX_PATTERN.source);
  });

  it('takes the kept allow rules the parser takes', async () => {
    const items = nodeAt(await loadSchema(), 'permissions.keepAllow')['items'];
    assert.ok(isRecord(items));
    assert.equal(items['pattern'], KEEP_RULE_PATTERN.source);
  });

  it('takes the session names the parser takes, and names the ones Claude Code reserves', async () => {
    const names = nodeAt(await loadSchema(), 'names');
    assert.equal(nodeAt(names, '*')['pattern'], NAME_PATTERN.source);
    assert.ok(String(names['description']).includes(`(${RESERVED_NAMES.join(', ')})`));
  });

  it('takes the role holders the parser takes: a session id, or <team>/<id> of a team above (T1143)', async () => {
    const schema = await loadSchema();
    const defs = schema['$defs'];
    const holder = isRecord(defs) ? defs['roleHolder'] : undefined;
    assert.ok(isRecord(holder));
    for (const role of ['coordinatorOwner', 'securityReviewer']) {
      assert.equal(nodeAt(schema, `roles.${role}`)['$ref'], '#/$defs/roleHolder');
    }
    const pattern = new RegExp(String(holder['pattern']));
    for (const name of ['security', 'root/security', 'root/', '/security', 'Root/security', 'a/b/c', `root/s${'x'.repeat(32)}`]) {
      const { issues } = parseConfig({ sessions: ['alpha', 'security'], roles: { lead: 'alpha', securityReviewer: name } });
      assert.equal(pattern.test(name), issues.length === 0, name);
    }
  });

  it('takes the budget account names the parser takes', async () => {
    const account = nodeAt(await loadSchema(), 'budget.account');
    assert.deepEqual([account['maxLength'], account['pattern']], [BUDGET_ACCOUNT_MAX_LENGTH, '^[^\\r\\n]+$']);
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

  it('takes the review paths the parser takes', async () => {
    const items = nodeAt(await loadSchema(), 'pushGuard.reviewPaths')['items'];
    assert.ok(isRecord(items));
    const { glob, mode, class: reviewer } = properties(items);
    assert.ok(isRecord(glob) && isRecord(mode) && isRecord(reviewer));
    assert.equal(glob['maxLength'], REVIEW_PATH_LIMITS.globMaxLength);
    assert.deepEqual(mode['enum'], [...REVIEW_PATH_MODES]);
    assert.deepEqual(reviewer['enum'], [...REVIEW_CLASSES]);
    assert.deepEqual(items['required'], ['glob']);
  });

  it('requires exactly the roster', async () => {
    const schema = await loadSchema();
    assert.deepEqual(schema['required'], ['sessions', 'roles']);
  });
});
