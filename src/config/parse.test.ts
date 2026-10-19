import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET, DEFAULT_BURST, DEFAULT_COMMITS, DEFAULT_HIRING, DEFAULT_OPEN, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_STATUS_LINE, DEFAULT_WAKE } from './defaults.ts';
import { parseConfig } from './parse.ts';
import { CONFIG_VERSION } from './types.ts';
import type { ConfigIssue } from './reader.ts';

const ROSTER = { sessions: ['alpha', 'bravo'], roles: { lead: 'alpha' } };

function paths(issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

describe('parseConfig', () => {
  it('fills every default from a roster-only file', () => {
    const { config, issues } = parseConfig(ROSTER);
    assert.deepEqual(issues, []);
    assert.deepEqual(config.sessions, ['alpha', 'bravo']);
    assert.deepEqual(config.roles, { lead: 'alpha' });
    assert.equal(config.configVersion, 1);
    assert.equal(config.messages.maxLines, 10);
    assert.equal(config.messages.coldAfterMinutes, 60);
    assert.deepEqual(config.loops, { chainNudgeAt: 6 });
    assert.deepEqual(config.leadBoundary, { enabled: true, ownPaths: [], searchNudgeAt: 3 });
    assert.deepEqual(config.turnLog, { enabled: true, keepHours: 24 });
    assert.deepEqual(config.tests, { maxFailureChars: 4000 });
    assert.deepEqual(config.github, { repos: [], owners: {}, sessions: {}, closedDays: 14, everyMinutes: 15 });
    assert.deepEqual(config.register, DEFAULT_REGISTER);
    assert.deepEqual(config.budget, DEFAULT_BUDGET);
    assert.deepEqual(config.coordinator, {
      schedule: {},
      heavy: { lockTtlMinutes: 150, maxRunMinutes: 45, waitMinutes: 60, memorySampleSeconds: 15, memoryFloorMb: 4096, smallReserveMb: 2048 },
      wait: { pollSeconds: 30, maxMinutes: 60 },
      gateTimeoutSeconds: 20,
      claims: { maxMinutes: 120 },
      windows: { settleMinutes: 30, targetSettleMinutes: {}, assumedRollMinutes: 20, minMinutes: 15 },
      repos: {},
    });
    assert.deepEqual(config.pushGuard.protectedBranches, ['main', 'master']);
    assert.deepEqual(config.paths, {});
    assert.deepEqual(config.commits, DEFAULT_COMMITS);
  });

  it('requires the roster', () => {
    const { issues } = parseConfig({});
    assert.deepEqual(paths(issues), ['sessions', 'roles.lead']);
  });

  it('requires the lead and coordinator owner to be sessions on the team', () => {
    const { config, issues } = parseConfig({ sessions: ['alpha'], roles: { lead: 'bravo', coordinatorOwner: 'charlie' } });
    assert.deepEqual(paths(issues), ['roles.lead', 'roles.coordinatorOwner']);
    assert.equal(config.roles.coordinatorOwner, 'charlie');
  });

  it('rejects malformed and duplicate session names', () => {
    const { config, issues } = parseConfig({ sessions: ['alpha', 'Bravo', 'alpha', 7], roles: { lead: 'alpha' } });
    assert.deepEqual(paths(issues), ['sessions[1]', 'sessions[3]', 'sessions']);
    assert.deepEqual(config.sessions, ['alpha', 'alpha']);
  });

  it('keeps a name for each session and defaults to none', () => {
    assert.deepEqual(parseConfig(ROSTER).config.names, {});
    const { config, issues } = parseConfig({ ...ROSTER, names: { alpha: 'team-lead', bravo: 'bravo' } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.names, { alpha: 'team-lead', bravo: 'bravo' });
  });

  it('refuses names of strangers, malformed names and names that are taken', () => {
    const { config, issues } = parseConfig({
      sessions: ['alpha', 'bravo', 'charlie', 'delta'],
      roles: { lead: 'alpha' },
      names: { alpha: 'boss', bravo: 'boss', charlie: 'alpha', delta: 'Delta', zulu: 'z', constructor: 'c' },
    });
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        'names.bravo: "boss" is already the name of alpha',
        'names.charlie: "alpha" is already a session id',
        'names.delta: expected a name: a lowercase letter, then lowercase letters, digits or -, at most 65 characters (got "Delta")',
        'names.zulu: is not one of the sessions',
        'names.constructor: is not one of the sessions',
      ],
    );
    assert.deepEqual(config.names, { alpha: 'boss' });
  });

  it('keeps the launch settings of each session and defaults to none', () => {
    assert.deepEqual(parseConfig(ROSTER).config.launch, {});
    const { config, issues } = parseConfig({ ...ROSTER, launch: { alpha: { model: 'opus', effort: 'max' }, bravo: { model: 'claude-haiku-5-5' } } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.launch, { alpha: { model: 'opus', effort: 'max' }, bravo: { model: 'claude-haiku-5-5' } });
  });

  it('reports launch settings of strangers and wrong models and efforts, and leaves each out', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      launch: { alpha: { model: 'gpt-5', effort: 'high' }, bravo: { model: 'sonnet', effort: 'turbo' }, zulu: { model: 'opus' }, constructor: {}, charlie: 'opus' },
    });
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        'launch.alpha.model: expected a model alias (default, best, fable, opus, sonnet, haiku, opusplan, fable[1m], opus[1m], sonnet[1m], opusplan[1m]) or a model id starting claude- (got "gpt-5")',
        'launch.bravo.effort: expected one of low, medium, high, xhigh, max (got "turbo")',
        'launch.zulu: is not one of the sessions',
        'launch.constructor: is not one of the sessions',
        'launch.charlie: expected an object, got "opus"',
      ],
    );
    assert.deepEqual(config.launch, { alpha: { effort: 'high' }, bravo: { model: 'sonnet' } });
  });

  it('reports a launch that is not an object', () => {
    const { config, issues } = parseConfig({ ...ROSTER, launch: ['alpha'] });
    assert.deepEqual(paths(issues), ['launch']);
    assert.deepEqual(config.launch, {});
  });

  it('reads messages.coldAfterMinutes, where 0 turns the cold-send hold off, and refuses a value past a day', () => {
    assert.equal(parseConfig({ ...ROSTER, messages: { coldAfterMinutes: 0 } }).config.messages.coldAfterMinutes, 0);
    const { config, issues } = parseConfig({ ...ROSTER, messages: { coldAfterMinutes: 1441 } });
    assert.deepEqual(paths(issues), ['messages.coldAfterMinutes']);
    assert.equal(config.messages.coldAfterMinutes, 60);
  });

  it('reads leadBoundary, where searchNudgeAt 0 never nudges for searches, and refuses a threshold past 50', () => {
    const own = { enabled: false, ownPaths: ['~/ops/lead'], searchNudgeAt: 0 };
    assert.deepEqual(parseConfig({ ...ROSTER, leadBoundary: own }).config.leadBoundary, own);
    const { config, issues } = parseConfig({ ...ROSTER, leadBoundary: { searchNudgeAt: 51 } });
    assert.deepEqual(paths(issues), ['leadBoundary.searchNudgeAt']);
    assert.equal(config.leadBoundary.searchNudgeAt, 3);
  });

  it('reads turnLog, and refuses keeping entries under an hour or past a week', () => {
    const off = { enabled: false, keepHours: 168 };
    assert.deepEqual(parseConfig({ ...ROSTER, turnLog: off }).config.turnLog, off);
    const { config, issues } = parseConfig({ ...ROSTER, turnLog: { keepHours: 0 } });
    assert.deepEqual(paths(issues), ['turnLog.keepHours']);
    assert.equal(config.turnLog.keepHours, 24);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, turnLog: { keepHours: 169 } }).issues), ['turnLog.keepHours']);
  });

  it('reads loops.chainNudgeAt, where 0 turns the nudge off, and refuses a value past 50', () => {
    assert.equal(parseConfig({ ...ROSTER, loops: { chainNudgeAt: 0 } }).config.loops.chainNudgeAt, 0);
    const { config, issues } = parseConfig({ ...ROSTER, loops: { chainNudgeAt: 51 } });
    assert.deepEqual(paths(issues), ['loops.chainNudgeAt']);
    assert.equal(config.loops.chainNudgeAt, 6);
  });

  it('reads wake, on for p1 by default, and refuses a priority under 1 or waits past their bounds', () => {
    assert.deepEqual(parseConfig(ROSTER).config.wake, { enabled: true, priority: 1, batchSeconds: 120, minGapMinutes: 15 });
    const own = { enabled: false, priority: 2, batchSeconds: 0, minGapMinutes: 0 };
    assert.deepEqual(parseConfig({ ...ROSTER, wake: own }).config.wake, own);
    const { config, issues } = parseConfig({ ...ROSTER, wake: { priority: 0, batchSeconds: 3601, minGapMinutes: 1441 } });
    assert.deepEqual(paths(issues), ['wake.priority', 'wake.batchSeconds', 'wake.minGapMinutes']);
    assert.deepEqual(config.wake, DEFAULT_WAKE);
  });

  it('reads timeZone, leaves it unset by default, and refuses a name the system does not know', () => {
    assert.equal(parseConfig({ ...ROSTER, timeZone: 'Asia/Jerusalem' }).config.timeZone, 'Asia/Jerusalem');
    assert.equal('timeZone' in parseConfig(ROSTER).config, false);
    const unknown = parseConfig({ ...ROSTER, timeZone: 'IDT' });
    assert.deepEqual([paths(unknown.issues), 'timeZone' in unknown.config], [['timeZone'], false]);
  });

  it('reads wake.dayStartUtc, and refuses a malformed one or one in the quiet hours', () => {
    const quietHours = { startUtc: '22:00', endUtc: '06:00', action: 'ask' };
    const budget = { enabled: true, quietHours };
    assert.equal(parseConfig({ ...ROSTER, budget, wake: { dayStartUtc: '06:00' } }).config.wake.dayStartUtc, '06:00');
    assert.equal(parseConfig({ ...ROSTER, wake: { dayStartUtc: '03:00' } }).config.wake.dayStartUtc, '03:00', 'no quiet hours, no clash');
    const malformed = parseConfig({ ...ROSTER, wake: { dayStartUtc: '6:00' } });
    assert.deepEqual(paths(malformed.issues), ['wake.dayStartUtc']);
    assert.equal(malformed.config.wake.dayStartUtc, undefined);
    const quiet = parseConfig({ ...ROSTER, budget, wake: { dayStartUtc: '05:59' } });
    assert.deepEqual(quiet.issues, [{ path: 'wake.dayStartUtc', message: "is in the budget's quiet hours (22:00 to 06:00 UTC), where no session wakes" }]);
    assert.deepEqual(quiet.config.wake, DEFAULT_WAKE);
  });

  it('reads tests.maxFailureChars, and refuses a value under 500 or past 50,000', () => {
    assert.equal(parseConfig({ ...ROSTER, tests: { maxFailureChars: 500 } }).config.tests.maxFailureChars, 500);
    assert.equal(parseConfig({ ...ROSTER, tests: { maxFailureChars: 50_000 } }).config.tests.maxFailureChars, 50_000);
    for (const wrong of [499, 50_001]) {
      const { config, issues } = parseConfig({ ...ROSTER, tests: { maxFailureChars: wrong } });
      assert.deepEqual(paths(issues), ['tests.maxFailureChars']);
      assert.equal(config.tests.maxFailureChars, 4000);
    }
  });

  it('reads github repos and owners in lowercase, closedDays within 1 to 365 and everyMinutes within 0 to 1440', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      github: { repos: ['Acme/Web', 'acme/docs.site'], owners: { OctoCat: 'bravo' }, closedDays: 365, everyMinutes: 0 },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.github, { repos: ['acme/web', 'acme/docs.site'], owners: { octocat: 'bravo' }, sessions: {}, closedDays: 365, everyMinutes: 0 });
    for (const wrong of [0, 366]) {
      const parsed = parseConfig({ ...ROSTER, github: { closedDays: wrong } });
      assert.deepEqual(paths(parsed.issues), ['github.closedDays']);
      assert.equal(parsed.config.github.closedDays, 14);
    }
    for (const wrong of [-1, 1441, 2.5]) {
      const parsed = parseConfig({ ...ROSTER, github: { everyMinutes: wrong } });
      assert.deepEqual(paths(parsed.issues), ['github.everyMinutes']);
      assert.equal(parsed.config.github.everyMinutes, 15);
    }
  });

  it('reads each listed repository\'s session in lowercase, and reports one not listed, an unknown session or a repeat', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      github: { repos: ['acme/web', 'acme/api'], sessions: { 'Acme/Web': 'bravo', 'acme/other': 'alpha', 'acme/api': 'zulu', 'ACME/web': 'alpha' } },
    });
    assert.deepEqual(paths(issues), ['github.sessions.acme/other', 'github.sessions.acme/api', 'github.sessions.ACME/web']);
    assert.deepEqual(config.github.sessions, { 'acme/web': 'bravo' });
  });

  it('reports a wrong repository, a repository listed twice, a wrong login and an unknown session', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      github: {
        repos: ['acme', 'acme/web/extra', 'acme/web', 'ACME/web'],
        owners: { 'octo_cat': 'bravo', hubot: 'zulu', monalisa: 'alpha', MonaLisa: 'bravo', octocat: 7 },
      },
    });
    assert.deepEqual(paths(issues), [
      'github.repos[0]',
      'github.repos[1]',
      'github.repos',
      'github.owners.octo_cat',
      'github.owners.hubot',
      'github.owners.MonaLisa',
      'github.owners.octocat',
    ]);
    assert.deepEqual(config.github.repos, ['acme/web']);
    assert.deepEqual(config.github.owners, { monalisa: 'alpha' });
  });

  it('reports every wrong field with its path and falls back to the default', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      messages: { maxLines: 'ten' },
      lock: { ttlMs: 10 },
      skills: 'none',
      budget: { enabled: 'yes' },
      coordinator: { schedule: { heavyCutoffUtc: '24:00' } },
    });
    assert.deepEqual(paths(issues).sort(), [
      'budget.enabled',
      'coordinator.schedule.heavyCutoffUtc',
      'lock.ttlMs',
      'messages.maxLines',
      'skills',
    ]);
    const maxLines = issues.find((issue) => issue.path === 'messages.maxLines');
    assert.equal(maxLines?.message, 'expected an integer from 3 to 50, got "ten"');
    assert.equal(config.messages.maxLines, 10);
    assert.equal(config.lock.ttlMs, 30_000);
    assert.equal(config.skills.maxPerArea, 8);
    assert.equal(config.budget.enabled, false);
  });

  it('reads the context file budgets, from their defaults and within their bounds', () => {
    assert.deepEqual(parseConfig(ROSTER).config.contextFiles, { maxClaudeMdChars: 12_000, maxMemoryIndexChars: 6_000, maxSkillListingChars: 4_000 });
    const { config, issues } = parseConfig({ ...ROSTER, contextFiles: { maxClaudeMdChars: 20_000, maxMemoryIndexChars: 499 } });
    assert.deepEqual(config.contextFiles, { maxClaudeMdChars: 20_000, maxMemoryIndexChars: 6_000, maxSkillListingChars: 4_000 });
    assert.deepEqual(paths(issues), ['contextFiles.maxMemoryIndexChars']);
  });

  it('keeps valid overrides', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      roles: { lead: 'alpha', coordinatorOwner: 'bravo' },
      register: { priorities: [{ id: 1, name: 'now' }], goalPattern: '^G\\d+$', requireNoteOn: ['waiting'], check: { prioritySkipAfterHours: 12, maxSelfMadePerDay: 0 } },
      coordinator: { schedule: { heavyCutoffUtc: '22:30' } },
      budget: { enabled: true, targetPct: 95 },
      paths: { inbox: '/srv/team/inbox' },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.roles, { lead: 'alpha', coordinatorOwner: 'bravo' });
    assert.deepEqual(config.register.priorities, [{ id: 1, name: 'now' }]);
    assert.equal(config.register.goalPattern, '^G\\d+$');
    assert.deepEqual(config.register.requireNoteOn, ['waiting']);
    assert.deepEqual(config.register.check, {
      staleAfterHours: 72,
      notPickedUpAfterHours: 24,
      prioritySkipAfterHours: 12,
      maxSelfMadePerDay: 0,
      weekLengthDays: 7,
      stopgapFiles: ['CLAUDE.md', '.claude/rules'],
    });
    assert.deepEqual(config.coordinator.schedule, { heavyCutoffUtc: '22:30' });
    assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, enabled: true, targetPct: 95 });
    assert.deepEqual(config.paths, { inbox: '/srv/team/inbox' });
  });

  it('keeps the coordinator folder, host lock and heavy step limits', () => {
    const coordinator = {
      dir: 'data/deploys',
      heavy: { lockPath: 'data/deploys/host.lock', lockTtlMinutes: 90, maxRunMinutes: 80, waitMinutes: 0, memorySampleSeconds: 0, memoryFloorMb: 0, smallReserveMb: 512 },
      wait: { pollSeconds: 5, maxMinutes: 0 },
      gateTimeoutSeconds: 45,
      claims: { maxMinutes: 90 },
      windows: { settleMinutes: 10, targetSettleMinutes: {}, assumedRollMinutes: 5, minMinutes: 30 },
    };
    const { config, issues } = parseConfig({ ...ROSTER, coordinator });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.coordinator, { ...coordinator, schedule: {}, repos: {} });
  });

  it('cuts a heavy step longer than its lock less 10 minutes to fit, and says so', () => {
    const { config, issues } = parseConfig({ ...ROSTER, coordinator: { heavy: { lockTtlMinutes: 60, maxRunMinutes: 55 } } });
    assert.deepEqual(paths(issues), ['coordinator.heavy.maxRunMinutes']);
    assert.equal(config.coordinator.heavy.maxRunMinutes, 50);
  });

  it('fits the default heavy step limit to a short lock without an issue', () => {
    const { config, issues } = parseConfig({ ...ROSTER, coordinator: { heavy: { lockTtlMinutes: 30 } } });
    assert.deepEqual(issues, []);
    assert.equal(config.coordinator.heavy.maxRunMinutes, 20);
  });

  it('reads the reset blackout and the repositories integrate lands, each repository from its defaults', () => {
    const coordinator = {
      schedule: { heavyCutoffUtc: '22:30', resetBlackoutHours: 4 },
      repos: {
        api: { mainCheckout: 'C:/src/api', deploysOnPush: ['cloud-api'], followMainCheckout: true },
        web: { mainCheckout: 'repos/web', dependencyGate: true },
      },
    };
    const { config, issues } = parseConfig({ ...ROSTER, coordinator });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.coordinator.schedule, coordinator.schedule);
    assert.deepEqual(config.coordinator.repos, {
      api: { mainCheckout: 'C:/src/api', deploysOnPush: ['cloud-api'], dependencyGate: false, followMainCheckout: true },
      web: { mainCheckout: 'repos/web', deploysOnPush: [], dependencyGate: true, followMainCheckout: false },
    });
  });

  it('reads the dependency check a gated repository runs, and reports one that never runs or is no program', () => {
    const check = ['node', 'tools/check-change.ts'];
    const repos = {
      gated: { mainCheckout: 'repos/gated', dependencyGate: true, dependencyCheck: check },
      open: { mainCheckout: 'repos/open', dependencyCheck: check },
      bad: { mainCheckout: 'repos/bad', dependencyGate: true, dependencyCheck: 'node check.ts' },
    };
    const { config, issues } = parseConfig({ ...ROSTER, coordinator: { repos } });
    assert.deepEqual(paths(issues).sort(), ['coordinator.repos.bad.dependencyCheck', 'coordinator.repos.open.dependencyCheck']);
    assert.match(issues.find((issue) => issue.path === 'coordinator.repos.open.dependencyCheck')?.message ?? '', /runs only with dependencyGate true/);
    assert.deepEqual(config.coordinator.repos['gated'], { mainCheckout: 'repos/gated', deploysOnPush: [], dependencyGate: true, dependencyCheck: check, followMainCheckout: false });
    assert.equal(config.coordinator.repos['bad']?.dependencyCheck, undefined);
  });

  it('reads a repository’s roll, its gates and afterPull hooks from their defaults', () => {
    const roll = { targets: ['cloud-api'], gates: [{ name: 'flow', command: ['node', 'gates/flow.js', '--quiet'] }], command: ['node', 'roll.js'] };
    const { config, issues } = parseConfig({ ...ROSTER, coordinator: { repos: { api: { mainCheckout: 'C:/src/api', roll }, web: { mainCheckout: 'C:/src/web', roll: { command: ['npm', 'run', 'deploy'] } } } } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.coordinator.repos['api']?.roll, { ...roll, afterPull: [] });
    assert.deepEqual(config.coordinator.repos['web']?.roll, { targets: [], gates: [], afterPull: [], command: ['npm', 'run', 'deploy'] });
  });

  it('reads a roll’s dependency install, and leaves out one that is not a program with its arguments', () => {
    const install = ['npm', 'ci', '--ignore-scripts'];
    const { config, issues } = parseConfig({
      ...ROSTER,
      coordinator: { repos: { api: { mainCheckout: 'C:/src/api', roll: { dependencyInstall: install, command: ['node', 'roll.js'] } }, web: { mainCheckout: 'C:/src/web', roll: { dependencyInstall: 'npm ci', command: ['node', 'roll.js'] } } } },
    });
    assert.deepEqual(paths(issues), ['coordinator.repos.web.roll.dependencyInstall']);
    assert.deepEqual(config.coordinator.repos['api']?.roll?.dependencyInstall, install);
    assert.deepEqual(config.coordinator.repos['web']?.roll, { targets: [], gates: [], afterPull: [], command: ['node', 'roll.js'] });
  });

  it('leaves out a roll with no command, and a gate or hook that is not a program with its arguments', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      coordinator: {
        gateTimeoutSeconds: 0,
        claims: { maxMinutes: 1441 },
        repos: {
          api: { mainCheckout: 'C:/src/api', roll: { targets: ['cloud-api'] } },
          web: {
            mainCheckout: 'C:/src/web',
            roll: { gates: [{ name: 'Flow', command: ['node', 'flow.js'] }, { name: 'load', command: [] }, 'node load.js'], afterPull: [['npm', ''], 'npm ci'], command: ['node', 'roll.js'] },
          },
        },
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'coordinator.claims.maxMinutes',
      'coordinator.gateTimeoutSeconds',
      'coordinator.repos.api.roll.command',
      'coordinator.repos.web.roll.afterPull[0][1]',
      'coordinator.repos.web.roll.afterPull[1]',
      'coordinator.repos.web.roll.gates[0].name',
      'coordinator.repos.web.roll.gates[1].command',
      'coordinator.repos.web.roll.gates[2]',
    ]);
    assert.equal(config.coordinator.repos['api']?.roll, undefined);
    assert.deepEqual(config.coordinator.repos['web']?.roll, { targets: [], gates: [], afterPull: [], command: ['node', 'roll.js'] });
    assert.equal(config.coordinator.gateTimeoutSeconds, 20);
    assert.equal(config.coordinator.claims.maxMinutes, 120);
  });

  it('reads a settle time for each target a repository deploys, and reports the rest', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      coordinator: {
        windows: { settleMinutes: 1441, minMinutes: 0, targetSettleMinutes: { 'cloud-api': 10, workers: 45, Bad: 5, 'cloud-web': -1 } },
        repos: { api: { mainCheckout: 'C:/src/api', deploysOnPush: ['cloud-api', 'cloud-web'] } },
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'coordinator.windows.minMinutes',
      'coordinator.windows.settleMinutes',
      'coordinator.windows.targetSettleMinutes.Bad',
      'coordinator.windows.targetSettleMinutes.cloud-web',
      'coordinator.windows.targetSettleMinutes.workers',
    ]);
    assert.deepEqual(config.coordinator.windows, { settleMinutes: 30, targetSettleMinutes: { 'cloud-api': 10 }, assumedRollMinutes: 20, minMinutes: 15 });
  });

  it('leaves out a repository with no main checkout or a bad name, and reports a bad target, blackout or deploy wait', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      coordinator: {
        schedule: { resetBlackoutHours: 0 },
        wait: { maxMinutes: 1441 },
        repos: { api: { deploysOnPush: ['cloud-api'] }, 'My Repo': { mainCheckout: '/src/x' }, web: 'C:/src/web', ok: { mainCheckout: '/src/ok', deploysOnPush: ['Cloud API'] } },
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'coordinator.repos.My Repo',
      'coordinator.repos.api.mainCheckout',
      'coordinator.repos.ok.deploysOnPush[0]',
      'coordinator.repos.web',
      'coordinator.schedule.resetBlackoutHours',
      'coordinator.wait.maxMinutes',
    ]);
    assert.deepEqual(config.coordinator.repos, { ok: { mainCheckout: '/src/ok', deploysOnPush: [], dependencyGate: false, followMainCheckout: false } });
    assert.deepEqual(config.coordinator.schedule, {});
    assert.equal(config.coordinator.wait.maxMinutes, 60);
  });

  it('reports an empty coordinator folder or lock path and limits out of range', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      coordinator: { dir: ' ', heavy: { lockPath: '', lockTtlMinutes: 5, waitMinutes: -1, memorySampleSeconds: 601, memoryFloorMb: -1, smallReserveMb: 1_048_577 }, wait: { pollSeconds: 0 } },
    });
    assert.deepEqual(paths(issues).sort(), [
      'coordinator.dir',
      'coordinator.heavy.lockPath',
      'coordinator.heavy.lockTtlMinutes',
      'coordinator.heavy.memoryFloorMb',
      'coordinator.heavy.memorySampleSeconds',
      'coordinator.heavy.smallReserveMb',
      'coordinator.heavy.waitMinutes',
      'coordinator.wait.pollSeconds',
    ]);
    assert.deepEqual(config.coordinator, {
      schedule: {},
      heavy: { lockTtlMinutes: 150, maxRunMinutes: 45, waitMinutes: 60, memorySampleSeconds: 15, memoryFloorMb: 4096, smallReserveMb: 2048 },
      wait: { pollSeconds: 30, maxMinutes: 60 },
      gateTimeoutSeconds: 20,
      claims: { maxMinutes: 120 },
      windows: { settleMinutes: 30, targetSettleMinutes: {}, assumedRollMinutes: 20, minMinutes: 15 },
      repos: {},
    });
  });

  it('drops bad priorities and keeps the defaults when none is left', () => {
    const { config, issues } = parseConfig({ ...ROSTER, register: { priorities: [{ id: 0, name: 'zero' }, { name: 'no id' }, 'x'] } });
    assert.deepEqual(paths(issues), [
      'register.priorities[0].id',
      'register.priorities[1].id',
      'register.priorities[2]',
      'register.priorities',
    ]);
    assert.equal(issues.at(-1)?.message, 'needs at least one priority');
    assert.deepEqual(config.register.priorities, DEFAULT_REGISTER.priorities);
  });

  it('refuses duplicate priority ids', () => {
    const { issues } = parseConfig({ ...ROSTER, register: { priorities: [{ id: 1, name: 'a' }, { id: 1, name: 'b' }] } });
    assert.deepEqual(issues, [{ path: 'register.priorities', message: 'uses a priority id more than once' }]);
  });

  it('names the version-1 key register.tiers in a current file, and reads the default priorities', () => {
    const { config, issues } = parseConfig({ ...ROSTER, configVersion: CONFIG_VERSION, register: { tiers: [{ id: 1, name: 'now' }] } });
    assert.deepEqual(issues, [{ path: 'register.tiers', message: 'was renamed: use register.priorities' }]);
    assert.deepEqual(config.register.priorities, DEFAULT_REGISTER.priorities);
  });

  it('validates regular expressions and statuses', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      register: { goalPattern: '([', secretPatterns: ['ok-\\d+', '(('], requireNoteOn: ['dropped', 'paused'], requireFollowupsOn: ['dropped', 'open'] },
    });
    assert.deepEqual(paths(issues).sort(), ['register.goalPattern', 'register.requireFollowupsOn[1]', 'register.requireNoteOn[1]', 'register.secretPatterns[1]']);
    assert.equal(issues.find((issue) => issue.path === 'register.requireFollowupsOn[1]')?.message, 'expected one of verifying, done, dropped, got "open"');
    assert.deepEqual(config.register.requireFollowupsOn, ['dropped']);
    assert.equal(config.register.goalPattern, undefined);
    assert.deepEqual(config.register.secretPatterns, ['ok-\\d+']);
    assert.deepEqual(config.register.requireNoteOn, ['dropped']);
  });

  it('reads register.autoArchive, on by default, and refuses a value that is not true or false', () => {
    assert.equal(parseConfig(ROSTER).config.register.autoArchive, true);
    const off = parseConfig({ ...ROSTER, register: { autoArchive: false } });
    assert.deepEqual([off.issues, off.config.register.autoArchive], [[], false]);
    const { config, issues } = parseConfig({ ...ROSTER, register: { autoArchive: 'no' } });
    assert.deepEqual(paths(issues), ['register.autoArchive']);
    assert.match(issues[0]?.message ?? '', /true or false/);
    assert.equal(config.register.autoArchive, true);
  });

  it('reads requireDescription, on by default, and falls back to on for a value that is not true or false', () => {
    assert.equal(parseConfig(ROSTER).config.register.requireDescription, true);
    const off = parseConfig({ ...ROSTER, register: { requireDescription: false } });
    assert.deepEqual([off.issues, off.config.register.requireDescription], [[], false]);
    const { config, issues } = parseConfig({ ...ROSTER, register: { requireDescription: 'no' } });
    assert.deepEqual(paths(issues), ['register.requireDescription']);
    assert.match(issues[0]?.message ?? '', /true or false/);
    assert.equal(config.register.requireDescription, true);
  });

  it('reads the verify loop keys, and falls back to the default on a wrong one', () => {
    const set = parseConfig({ ...ROSTER, register: { requireProofOnVerifying: false, verifyGate: 'warn', maxVerifying: 0 } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(
      [set.config.register.requireProofOnVerifying, set.config.register.verifyGate, set.config.register.maxVerifying],
      [false, 'warn', 0],
    );
    const { config, issues } = parseConfig({ ...ROSTER, register: { requireProofOnVerifying: 'yes', verifyGate: 'block', maxVerifying: 101 } });
    assert.deepEqual(paths(issues).sort(), ['register.maxVerifying', 'register.requireProofOnVerifying', 'register.verifyGate']);
    assert.match(issues.find((issue) => issue.path === 'register.verifyGate')?.message ?? '', /refuse, warn/);
    assert.deepEqual([config.register.requireProofOnVerifying, config.register.verifyGate, config.register.maxVerifying], [true, 'refuse', 5]);
  });

  it('falls back to the default count of self-made tasks past its limit', () => {
    const { config, issues } = parseConfig({ ...ROSTER, register: { check: { maxSelfMadePerDay: 201 } } });
    assert.deepEqual(paths(issues), ['register.check.maxSelfMadePerDay']);
    assert.equal(config.register.check.maxSelfMadePerDay, 10);
  });

  it('reads the commits rule, refusing a bad gate, trailer key, bound or pattern', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      commits: { maxLines: 10, maxFiles: 20, largeCommitTrailer: 'Large commit', testPatterns: ['^fixtures/', '(('], gate: 'block' },
    });
    assert.deepEqual(paths(issues).sort(), ['commits.gate', 'commits.largeCommitTrailer', 'commits.maxLines', 'commits.testPatterns[1]']);
    assert.deepEqual(config.commits, { ...DEFAULT_COMMITS, maxFiles: 20, testPatterns: ['^fixtures/'] });
    const refuse = parseConfig({ ...ROSTER, commits: { gate: 'refuse', largeCommitTrailer: 'Big-change' } }).config.commits;
    assert.deepEqual([refuse.gate, refuse.largeCommitTrailer], ['refuse', 'Big-change']);
  });

  it('reads what a normal push to a protected branch does, defaulting to ask and refusing another word', () => {
    assert.equal(parseConfig(ROSTER).config.pushGuard.pushToProtected, 'ask');
    for (const choice of ['ask', 'allow']) {
      const set = parseConfig({ ...ROSTER, pushGuard: { pushToProtected: choice } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.pushGuard.pushToProtected, choice);
    }
    const bad = parseConfig({ ...ROSTER, pushGuard: { protectedBranches: ['release'], pushToProtected: 'always' } });
    assert.deepEqual(paths(bad.issues), ['pushGuard.pushToProtected']);
    assert.match(bad.issues[0]?.message ?? '', /ask, allow/);
    assert.deepEqual(bad.config.pushGuard, { protectedBranches: ['release'], pushToProtected: 'ask' });
  });

  it('reads what an ad-hoc package run does, defaulting to deny and refusing another word', () => {
    assert.equal(parseConfig(ROSTER).config.packageGuard.adHocRunners, 'deny');
    for (const choice of ['deny', 'ask', 'allow']) {
      const set = parseConfig({ ...ROSTER, packageGuard: { adHocRunners: choice } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.packageGuard.adHocRunners, choice);
    }
    const bad = parseConfig({ ...ROSTER, packageGuard: { adHocRunners: 'never' } });
    assert.deepEqual(paths(bad.issues), ['packageGuard.adHocRunners']);
    assert.match(bad.issues[0]?.message ?? '', /deny, ask, allow/);
    assert.equal(bad.config.packageGuard.adHocRunners, 'deny');
  });

  it('reads what an unvetted install does and the cooldown, defaulting to deny and 14 days', () => {
    assert.deepEqual(parseConfig(ROSTER).config.packageGuard, { adHocRunners: 'deny', installs: 'deny', cooldownDays: 14 });
    for (const choice of ['deny', 'ask', 'allow']) {
      const set = parseConfig({ ...ROSTER, packageGuard: { installs: choice, cooldownDays: 0 } });
      assert.deepEqual(set.issues, []);
      assert.deepEqual(set.config.packageGuard, { adHocRunners: 'deny', installs: choice, cooldownDays: 0 });
    }
    const bad = parseConfig({ ...ROSTER, packageGuard: { installs: 'never', cooldownDays: 400 } });
    assert.deepEqual(paths(bad.issues), ['packageGuard.installs', 'packageGuard.cooldownDays']);
    assert.match(bad.issues[0]?.message ?? '', /deny, ask, allow/);
    assert.deepEqual(bad.config.packageGuard, { adHocRunners: 'deny', installs: 'deny', cooldownDays: 14 });
  });

  it('reads what a git command that skips the hooks does, defaulting to deny and refusing another word', () => {
    assert.equal(parseConfig(ROSTER).config.commitGuard.skipHooks, 'deny');
    for (const choice of ['deny', 'ask', 'allow']) {
      const set = parseConfig({ ...ROSTER, commitGuard: { skipHooks: choice } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.commitGuard.skipHooks, choice);
    }
    const bad = parseConfig({ ...ROSTER, commitGuard: { skipHooks: 'never' } });
    assert.deepEqual(paths(bad.issues), ['commitGuard.skipHooks']);
    assert.match(bad.issues[0]?.message ?? '', /deny, ask, allow/);
    assert.equal(bad.config.commitGuard.skipHooks, 'deny');
  });

  it('reads what a hook does with a call it would ask about, defaulting to ask and refusing another word', () => {
    assert.equal(parseConfig(ROSTER).config.prompts.hookAsks, 'ask');
    for (const choice of ['ask', 'refuse']) {
      const set = parseConfig({ ...ROSTER, prompts: { hookAsks: choice } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.prompts.hookAsks, choice);
    }
    const bad = parseConfig({ ...ROSTER, prompts: { hookAsks: 'deny' } });
    assert.deepEqual(paths(bad.issues), ['prompts.hookAsks']);
    assert.match(bad.issues[0]?.message ?? '', /ask, refuse/);
    assert.equal(bad.config.prompts.hookAsks, 'ask');
  });

  it('reads the secret guard, refusing with the default secrets alone unless the team says otherwise', () => {
    assert.deepEqual(parseConfig(ROSTER).config.secretGuard, { secretReads: 'deny', paths: [], envNames: [] });
    const own = { secretReads: 'ask', paths: ['k8s/secrets/*.yaml', '!**/fixtures/*.pem'], envNames: ['^STRIPE_', '!^GIT_AUTHOR'] };
    const set = parseConfig({ ...ROSTER, secretGuard: own });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.secretGuard, own);
    const bad = parseConfig({ ...ROSTER, secretGuard: { secretReads: 'never', paths: ['!'], envNames: ['(', '!'] } });
    assert.deepEqual(paths(bad.issues), ['secretGuard.secretReads', 'secretGuard.paths[0]', 'secretGuard.envNames[0]', 'secretGuard.envNames[1]']);
    assert.deepEqual(bad.config.secretGuard, { secretReads: 'deny', paths: [], envNames: [] });
  });

  it('reads the read-only shell hook, off and trusting no prefix by default', () => {
    assert.deepEqual(parseConfig(ROSTER).config.readonlyShell, { enabled: false, allowPrefixes: [] });
    const allowPrefixes = ['npx tsc --noEmit', 'npx jest', '@scope/tool run', 'node --test=x'];
    const set = parseConfig({ ...ROSTER, readonlyShell: { enabled: true, allowPrefixes } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.readonlyShell, { enabled: true, allowPrefixes });
  });

  it('drops a read-only shell prefix no command as written could match, and refuses too many', () => {
    const written = ['FOO=1 npx jest', '-rf', 'npx  jest', 'npx jest ', 'npx "jest"', 'npx jest; rm x', `npx ${'x'.repeat(120)}`, 'npx jest'];
    const bad = parseConfig({ ...ROSTER, readonlyShell: { enabled: 'yes', allowPrefixes: written } });
    assert.deepEqual(paths(bad.issues), ['readonlyShell.enabled', ...written.slice(0, -1).map((_, index) => `readonlyShell.allowPrefixes[${index}]`)]);
    assert.match(bad.issues[1]?.message ?? '', /one space apart/);
    assert.match(bad.issues[7]?.message ?? '', /at most 120 characters/);
    assert.deepEqual(bad.config.readonlyShell, { enabled: false, allowPrefixes: ['npx jest'] });
    const many = parseConfig({ ...ROSTER, readonlyShell: { allowPrefixes: Array.from({ length: 17 }, (_, index) => `tool${index}`) } });
    assert.deepEqual(paths(many.issues), ['readonlyShell.allowPrefixes']);
    assert.deepEqual(many.config.readonlyShell.allowPrefixes, []);
  });

  it('bounds the lists and texts the rule pack prints', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      ownerGates: ['money', 'two\nlines', 'g'.repeat(61)],
      register: { requireNoteOn: ['open', 'in-progress', 'waiting', 'done', 'dropped', 'done'] },
      skills: { forbidFrontmatter: ['allowed-tools', 'not a key', 'k'.repeat(33)] },
      pushGuard: { protectedBranches: Array.from({ length: 9 }, (_, index) => `release-${index}`) },
    });
    assert.deepEqual(paths(issues).sort(), [
      'ownerGates[1]',
      'ownerGates[2]',
      'pushGuard.protectedBranches',
      'register.requireNoteOn',
      'skills.forbidFrontmatter[1]',
      'skills.forbidFrontmatter[2]',
    ]);
    const message = (path: string) => issues.find((issue) => issue.path === path)?.message;
    assert.equal(message('ownerGates[1]'), 'expected a single line (got "two\\nlines")');
    assert.match(message('ownerGates[2]') ?? '', /^expected at most 60 characters/);
    assert.match(message('pushGuard.protectedBranches') ?? '', /^expected a list of at most 8 items/);
    assert.match(message('skills.forbidFrontmatter[1]') ?? '', /^expected a frontmatter key/);
    assert.deepEqual(config.ownerGates, ['money']);
    assert.deepEqual(config.register.requireNoteOn, DEFAULT_REGISTER.requireNoteOn);
    assert.deepEqual(config.skills.forbidFrontmatter, ['allowed-tools']);
    assert.deepEqual(config.pushGuard.protectedBranches, ['main', 'master']);
  });

  it('reads the recorded rule conflicts, dropping each bad one with its issue', () => {
    assert.deepEqual(parseConfig(ROSTER).config.ruleConflicts, []);
    const kept = { file: '~/CLAUDE.md', text: 'Commit straight to main.', rule: 'worktrees', wins: 'local' };
    const { config, issues } = parseConfig({
      ...ROSTER,
      ruleConflicts: [
        kept,
        { ...kept, wins: 'teamrig', reason: 'kept for the old docs' },
        { ...kept, rule: 'everything' },
        { ...kept, wins: 'both' },
        { file: '~/CLAUDE.md', rule: 'push', wins: 'local' },
        { ...kept, text: 'two\nlines' },
        { ...kept, text: 't'.repeat(301) },
        { ...kept, reason: 'r'.repeat(201) },
        'not an object',
      ],
    });
    assert.deepEqual(paths(issues), [
      'ruleConflicts[2].rule',
      'ruleConflicts[3].wins',
      'ruleConflicts[4].text',
      'ruleConflicts[5].text',
      'ruleConflicts[6].text',
      'ruleConflicts[7].reason',
      'ruleConflicts[8]',
    ]);
    assert.match(issues[0]?.message ?? '', /^expected one of roles, own-change/);
    assert.equal(issues[2]?.message, 'is required');
    assert.deepEqual(config.ruleConflicts, [kept, { ...kept, wins: 'teamrig', reason: 'kept for the old docs' }]);
    const many = parseConfig({ ...ROSTER, ruleConflicts: Array.from({ length: 41 }, () => kept) });
    assert.deepEqual(paths(many.issues), ['ruleConflicts']);
    assert.deepEqual(many.config.ruleConflicts, []);
  });

  it('reads the refresh settings, defaulting each and refusing a bad threshold or folder', () => {
    assert.deepEqual(parseConfig(ROSTER).config.refresh, DEFAULT_REFRESH);
    const chosen = {
      enabled: false,
      contextTokens: 150_000,
      everyTasks: 0,
      everyTasksMinTokens: 60_000,
      tabTitle: false,
      autoRestart: false,
      restartDelaySeconds: 30,
      holdAfterActivityMinutes: 0,
      countdownSeconds: 0,
      compactCeilingTokens: 0,
      endCommand: ['node', 'end.cjs', 'end'],
      handoverDir: 'notes',
    };
    const set = parseConfig({ ...ROSTER, refresh: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.refresh, chosen);
    const bad = parseConfig({
      ...ROSTER,
      refresh: {
        enabled: 'yes',
        contextTokens: 9_999,
        everyTasks: 101,
        everyTasksMinTokens: 9_999,
        tabTitle: 1,
        autoRestart: 'on',
        restartDelaySeconds: 4,
        holdAfterActivityMinutes: 61,
        countdownSeconds: -1,
        compactCeilingTokens: -1,
        endCommand: 'node end.cjs',
        handoverDir: ' ',
      },
    });
    assert.deepEqual(paths(bad.issues).sort(), [
      'refresh.autoRestart',
      'refresh.compactCeilingTokens',
      'refresh.contextTokens',
      'refresh.countdownSeconds',
      'refresh.enabled',
      'refresh.endCommand',
      'refresh.everyTasks',
      'refresh.everyTasksMinTokens',
      'refresh.handoverDir',
      'refresh.holdAfterActivityMinutes',
      'refresh.restartDelaySeconds',
      'refresh.tabTitle',
    ]);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { restartDelaySeconds: 601 } }).issues), ['refresh.restartDelaySeconds']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { countdownSeconds: 121 } }).issues), ['refresh.countdownSeconds']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { endCommand: ['node', ''] } }).issues), ['refresh.endCommand[1]']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { everyTasks: -1 } }).issues), ['refresh.everyTasks']);
    assert.deepEqual(bad.config.refresh, DEFAULT_REFRESH);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { contextTokens: 10_000_001 } }).issues), ['refresh.contextTokens']);
  });

  it('reads the hiring settings, defaulting each and refusing a bad policy, cap or scale-out measure', () => {
    assert.deepEqual(parseConfig(ROSTER).config.hiring, DEFAULT_HIRING);
    const scaleOut = { windowDays: 5, minDone: 2, topPriorities: 1 };
    const chosen = { policy: 'lead', maxSessions: 4, idleHours: 2, reviewDays: 14, resumeMaxTokens: 120_000, resumeMaxIdleDays: 3, scaleOut };
    const set = parseConfig({ ...ROSTER, hiring: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.hiring, chosen);
    const badScaleOut = { windowDays: 9, minDone: 0, topPriorities: 11 };
    const bad = parseConfig({
      ...ROSTER,
      hiring: { policy: 'auto', maxSessions: 0, idleHours: 169, reviewDays: 91, resumeMaxTokens: 9_999, resumeMaxIdleDays: 91, scaleOut: badScaleOut },
    });
    assert.deepEqual(paths(bad.issues).sort(), [
      'hiring.idleHours',
      'hiring.maxSessions',
      'hiring.policy',
      'hiring.resumeMaxIdleDays',
      'hiring.resumeMaxTokens',
      'hiring.reviewDays',
      'hiring.scaleOut.minDone',
      'hiring.scaleOut.topPriorities',
      'hiring.scaleOut.windowDays',
    ]);
    assert.deepEqual(bad.config.hiring, DEFAULT_HIRING);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, hiring: { scaleOut: 7 } }).issues), ['hiring.scaleOut']);
  });

  it('reads the burst settings, defaulting each and refusing a bad policy or cap', () => {
    assert.deepEqual(parseConfig(ROSTER).config.burst, DEFAULT_BURST);
    const chosen = { policy: 'lead', surplusHours: 24, minSparePct: 2.5, maxHelpers: 0, maxHires: 1 };
    const set = parseConfig({ ...ROSTER, burst: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.burst, chosen);
    const bad = parseConfig({ ...ROSTER, burst: { policy: 'automatic', surplusHours: 168, minSparePct: 0, maxHelpers: 21, maxHires: -1 } });
    assert.deepEqual(paths(bad.issues).sort(), ['burst.maxHelpers', 'burst.maxHires', 'burst.minSparePct', 'burst.policy', 'burst.surplusHours']);
    assert.deepEqual(bad.config.burst, DEFAULT_BURST);
  });

  it('flags the fixed hiring daily budgets this format no longer reads, instead of ignoring them', () => {
    const { config, issues } = parseConfig({ ...ROSTER, hiring: { dailyPct: 4, maxDailyPct: 2 } });
    assert.deepEqual(paths(issues), ['hiring.dailyPct', 'hiring.maxDailyPct']);
    issues.forEach((issue) => assert.match(issue.message, /^is no longer read: .*maxSessions bounds hiring; delete it$/));
    assert.deepEqual(config.hiring, DEFAULT_HIRING);
  });

  it('reads the terminal teamrig open uses and the room it needs, refusing a terminal it does not know or a bad size', () => {
    assert.deepEqual(parseConfig(ROSTER).config.open, DEFAULT_OPEN);
    const chosen = { terminal: 'tmux', headroom: { sessionMb: 900, commitMaxPct: 95, closeIdleMinutes: 120 } };
    const set = parseConfig({ ...ROSTER, open: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.open, chosen);
    const bad = parseConfig({ ...ROSTER, open: { terminal: 'iterm', headroom: { sessionMb: 99, commitMaxPct: 101, closeIdleMinutes: 5 } } });
    assert.deepEqual(paths(bad.issues).sort(), ['open.headroom.closeIdleMinutes', 'open.headroom.commitMaxPct', 'open.headroom.sessionMb', 'open.terminal']);
    assert.match(bad.issues.find((issue) => issue.path === 'open.terminal')?.message ?? '', /expected one of auto, tmux, windows-terminal/);
    assert.deepEqual(bad.config.open, DEFAULT_OPEN);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, open: { headroom: 5 } }).issues), ['open.headroom']);
  });

  it('reads what the status line shows, each part on unless turned off, refusing a value that is not true or false', () => {
    assert.deepEqual(parseConfig(ROSTER).config.statusLine, DEFAULT_STATUS_LINE);
    const set = parseConfig({ ...ROSTER, statusLine: { resume: false } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.statusLine, { folder: true, branch: true, resume: false });
    const bad = parseConfig({ ...ROSTER, statusLine: { branch: 'no' } });
    assert.deepEqual(paths(bad.issues), ['statusLine.branch']);
    assert.deepEqual(bad.config.statusLine, DEFAULT_STATUS_LINE);
  });

  it('reads where the team sits in a tree, and leaves it unset in an older config', () => {
    assert.equal(parseConfig(ROSTER).config.team, undefined);
    assert.deepEqual(parseConfig({ ...ROSTER, team: { id: 'web' } }).config.team, { id: 'web' });
    const child = parseConfig({ ...ROSTER, team: { id: 'web', parent: 'app' } });
    assert.deepEqual(child.issues, []);
    assert.deepEqual(child.config.team, { id: 'web', parent: 'app' });
  });

  it('refuses a team section that is not an object, has no id, or names itself or a bad id as parent', () => {
    const notObject = parseConfig({ ...ROSTER, team: 'web' });
    assert.deepEqual(paths(notObject.issues), ['team']);
    assert.equal(notObject.config.team, undefined);
    const noId = parseConfig({ ...ROSTER, team: { parent: 'app' } });
    assert.deepEqual(paths(noId.issues), ['team.id']);
    assert.equal(noId.config.team, undefined);
    const itself = parseConfig({ ...ROSTER, team: { id: 'web', parent: 'web' } });
    assert.deepEqual(itself.issues, [{ path: 'team.parent', message: 'is the team itself; a root team has no parent' }]);
    assert.deepEqual(itself.config.team, { id: 'web' });
    const bad = parseConfig({ ...ROSTER, team: { id: 'web', parent: 'App/Lead' } });
    assert.deepEqual(paths(bad.issues), ['team.parent']);
    assert.deepEqual(bad.config.team, { id: 'web' });
  });

  it('ignores keys it does not know, including $schema', () => {
    const { issues } = parseConfig({ ...ROSTER, $schema: './config.schema.json', futureKey: { any: 1 } });
    assert.deepEqual(issues, []);
  });
});

describe('parseConfig budget', () => {
  it('reads every budget key a team sets', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      budget: {
        enabled: true,
        weeklyLimitW: 680_000_000,
        subagentWeight: 2.15,
        reset: { weekday: 'wed', timeUtc: '01:00' },
        targetPct: 99,
        reservePct: 1,
        paceEndHoursBeforeReset: 2,
        sessions: { alpha: { share: 2 }, bravo: { share: 0.5 } },
        warnAtPct: [50, 100, 150],
        paceTolerancePct: 1,
        overAction: 'ask-lead',
        escalate: 'session',
        quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask', paceWeight: 0.25 },
        lift: { maxStopPct: 98, reserveStopPct: 99.5 },
        statusSnapshotDir: '/srv/usage/live',
        maxBytesPerHook: 2_000_000,
      },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.budget, {
      enabled: true,
      weeklyLimitW: 680_000_000,
      subagentWeight: 2.15,
      reset: { weekday: 'wed', timeUtc: '01:00' },
      targetPct: 99,
      reservePct: 1,
      paceEndHoursBeforeReset: 2,
      sessions: { alpha: { share: 2 }, bravo: { share: 0.5 } },
      warnAtPct: [50, 100, 150],
      paceTolerancePct: 1,
      overAction: 'ask-lead',
      escalate: 'session',
      quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask', paceWeight: 0.25 },
      lift: { maxStopPct: 98, reserveStopPct: 99.5 },
      statusSnapshotDir: '/srv/usage/live',
      maxBytesPerHook: 2_000_000,
    });
  });

  it('reports a quiet pace weight out of 0..1 and keeps the quiet hours without it', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask', paceWeight: 1.5 } } });
    assert.deepEqual(paths(issues), ['budget.quietHours.paceWeight']);
    assert.deepEqual(config.budget.quietHours, { startUtc: '22:00', endUtc: '06:00', action: 'ask' });
  });

  it('keeps the reserve stop % at or above the lift stop %', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { lift: { maxStopPct: 99, reserveStopPct: 95 } } });
    assert.deepEqual(paths(issues), ['budget.lift.reserveStopPct']);
    assert.deepEqual(config.budget.lift, { maxStopPct: 99, reserveStopPct: 99 });
  });

  it('gives a listed session without a share the default share', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { sessions: { alpha: {} } } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.budget.sessions, { alpha: { share: 1 } });
  });

  it('flags the fixed daily budgets this format no longer reads, instead of ignoring them', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { dailyPct: 10, maxDailyPct: 12, sessions: { alpha: { share: 2, dailyPct: 1 } } } });
    assert.deepEqual(paths(issues), ['budget.dailyPct', 'budget.maxDailyPct', 'budget.sessions.alpha.dailyPct']);
    issues.forEach((issue) => assert.match(issue.message, /^is no longer read: .*; delete it$/));
    assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, sessions: { alpha: { share: 2 } } });
  });

  it('refuses out-of-range numbers, unknown words and malformed parts, keeping the defaults', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      budget: {
        weeklyLimitW: 12.5,
        subagentWeight: 11,
        reset: { weekday: 'someday', timeUtc: '1am' },
        targetPct: 0,
        reservePct: 60,
        paceEndHoursBeforeReset: 49,
        sessions: { alpha: { share: -1 }, carol: { share: 1 }, bravo: 'half' },
        warnAtPct: [80, 0, 'x'],
        paceTolerancePct: 11,
        overAction: 'stop',
        escalate: 'always',
        quietHours: { startUtc: '22:00', endUtc: '25:00', action: 'nap' },
        lift: { maxStopPct: 0, reserveStopPct: 101 },
        statusSnapshotDir: '',
        maxBytesPerHook: 10,
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'budget.escalate',
      'budget.lift.maxStopPct',
      'budget.lift.reserveStopPct',
      'budget.maxBytesPerHook',
      'budget.overAction',
      'budget.paceEndHoursBeforeReset',
      'budget.paceTolerancePct',
      'budget.quietHours.action',
      'budget.quietHours.endUtc',
      'budget.reservePct',
      'budget.reset.timeUtc',
      'budget.reset.weekday',
      'budget.sessions.alpha.share',
      'budget.sessions.bravo',
      'budget.sessions.carol',
      'budget.statusSnapshotDir',
      'budget.subagentWeight',
      'budget.targetPct',
      'budget.warnAtPct[1]',
      'budget.warnAtPct[2]',
      'budget.weeklyLimitW',
    ]);
    assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, sessions: { alpha: { share: 1 } }, warnAtPct: [80] });
    const overAction = issues.find((issue) => issue.path === 'budget.overAction');
    assert.equal(overAction?.message, 'expected one of warn, ask-lead, ask, block (got "stop")');
  });

  it('refuses a target and reserve that pass 100% of the week', () => {
    const { issues } = parseConfig({ ...ROSTER, budget: { targetPct: 99.5, reservePct: 1 } });
    assert.deepEqual(issues, [{ path: 'budget.reservePct', message: 'with targetPct it passes 100% of the week (99.5 + 1)' }]);
  });

  it('refuses a reset or quiet hours that are not objects, or miss a key', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { reset: 'wed', quietHours: { startUtc: '22:00', action: 'ask' } } });
    assert.deepEqual(paths(issues), ['budget.reset', 'budget.quietHours.endUtc']);
    assert.equal(config.budget.reset, undefined);
    assert.equal(config.budget.quietHours, undefined);
  });

  it('refuses quiet hours that end when they start', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { quietHours: { startUtc: '22:00', endUtc: '22:00', action: 'warn' } } });
    assert.deepEqual(issues, [{ path: 'budget.quietHours.endUtc', message: 'is the start time; quiet hours need a start and a different end' }]);
    assert.equal(config.budget.quietHours, undefined);
  });

  it('refuses the old coordinator.budget block and points at its new place', () => {
    const { config, issues } = parseConfig({ ...ROSTER, coordinator: { budget: { enabled: true } } });
    assert.deepEqual(issues, [{ path: 'coordinator.budget', message: 'was moved: use the top-level budget block' }]);
    assert.equal(config.budget.enabled, false);
  });
});

describe('parseConfig: the decision card', () => {
  it('reads whether a wait on the owner needs a decision card, and falls back to the default on a wrong one', () => {
    assert.equal(parseConfig(ROSTER).config.register.requireDecisionCard, true);
    assert.equal(parseConfig({ ...ROSTER, register: { requireDecisionCard: false } }).config.register.requireDecisionCard, false);
    const { config, issues } = parseConfig({ ...ROSTER, register: { requireDecisionCard: 'yes' } });
    assert.deepEqual([paths(issues), config.register.requireDecisionCard], [['register.requireDecisionCard'], true]);
  });
});
