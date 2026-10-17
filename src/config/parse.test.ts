import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET, DEFAULT_BURST, DEFAULT_COMMITS, DEFAULT_HIRING, DEFAULT_OPEN, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_WAKE } from './defaults.ts';
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
    assert.deepEqual(config.tests, { maxFailureChars: 4000 });
    assert.deepEqual(config.github, { repos: [], owners: {}, sessions: {}, closedDays: 14, everyMinutes: 15 });
    assert.deepEqual(config.register, DEFAULT_REGISTER);
    assert.deepEqual(config.budget, DEFAULT_BUDGET);
    assert.deepEqual(config.coordinator.schedule, {});
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
      register: { priorities: [{ id: 1, name: 'now' }], goalPattern: '^G\\d+$', requireNoteOn: ['waiting'], check: { prioritySkipAfterHours: 12 } },
      coordinator: { schedule: { heavyCutoffUtc: '22:30' } },
      budget: { enabled: true, targetPct: 95 },
      paths: { inbox: '/srv/team/inbox' },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.roles, { lead: 'alpha', coordinatorOwner: 'bravo' });
    assert.deepEqual(config.register.priorities, [{ id: 1, name: 'now' }]);
    assert.equal(config.register.goalPattern, '^G\\d+$');
    assert.deepEqual(config.register.requireNoteOn, ['waiting']);
    assert.deepEqual(config.register.check, { staleAfterHours: 72, notPickedUpAfterHours: 24, prioritySkipAfterHours: 12, weekLengthDays: 7, stopgapFiles: ['CLAUDE.md', '.claude/rules'] });
    assert.deepEqual(config.coordinator.schedule, { heavyCutoffUtc: '22:30' });
    assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, enabled: true, targetPct: 95 });
    assert.deepEqual(config.paths, { inbox: '/srv/team/inbox' });
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
        endCommand: 'node end.cjs',
        handoverDir: ' ',
      },
    });
    assert.deepEqual(paths(bad.issues).sort(), [
      'refresh.autoRestart',
      'refresh.contextTokens',
      'refresh.enabled',
      'refresh.endCommand',
      'refresh.everyTasks',
      'refresh.everyTasksMinTokens',
      'refresh.handoverDir',
      'refresh.restartDelaySeconds',
      'refresh.tabTitle',
    ]);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { restartDelaySeconds: 601 } }).issues), ['refresh.restartDelaySeconds']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { endCommand: ['node', ''] } }).issues), ['refresh.endCommand[1]']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { everyTasks: -1 } }).issues), ['refresh.everyTasks']);
    assert.deepEqual(bad.config.refresh, DEFAULT_REFRESH);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { contextTokens: 10_000_001 } }).issues), ['refresh.contextTokens']);
  });

  it('reads the hiring settings, defaulting each and refusing a bad policy, cap or daily budget', () => {
    assert.deepEqual(parseConfig(ROSTER).config.hiring, DEFAULT_HIRING);
    const chosen = { policy: 'lead', maxSessions: 4, dailyPct: 1.5, maxDailyPct: 5, idleHours: 2, reviewDays: 14, resumeMaxTokens: 120_000, resumeMaxIdleDays: 3 };
    const set = parseConfig({ ...ROSTER, hiring: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.hiring, chosen);
    const bad = parseConfig({ ...ROSTER, hiring: { policy: 'auto', maxSessions: 0, dailyPct: 0, maxDailyPct: 101, idleHours: 169, reviewDays: 91, resumeMaxTokens: 9_999, resumeMaxIdleDays: 91 } });
    assert.deepEqual(paths(bad.issues).sort(), [
      'hiring.dailyPct',
      'hiring.idleHours',
      'hiring.maxDailyPct',
      'hiring.maxSessions',
      'hiring.policy',
      'hiring.resumeMaxIdleDays',
      'hiring.resumeMaxTokens',
      'hiring.reviewDays',
    ]);
    assert.deepEqual(bad.config.hiring, DEFAULT_HIRING);
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

  it("refuses a hire's daily budget over what all hires may add up to", () => {
    const { config, issues } = parseConfig({ ...ROSTER, hiring: { dailyPct: 4, maxDailyPct: 2 } });
    assert.deepEqual(paths(issues), ['hiring.dailyPct']);
    assert.match(issues[0]?.message ?? '', /at most hiring\.maxDailyPct \(2\), got 4/);
    assert.deepEqual([config.hiring.dailyPct, config.hiring.maxDailyPct], [1, 2]);
  });

  it('reads the terminal teamrig open uses, refusing one it does not know', () => {
    assert.deepEqual(parseConfig(ROSTER).config.open, DEFAULT_OPEN);
    const set = parseConfig({ ...ROSTER, open: { terminal: 'tmux' } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.open, { terminal: 'tmux' });
    const bad = parseConfig({ ...ROSTER, open: { terminal: 'iterm' } });
    assert.deepEqual(paths(bad.issues), ['open.terminal']);
    assert.match(bad.issues[0]?.message ?? '', /expected one of auto, tmux, windows-terminal/);
    assert.deepEqual(bad.config.open, DEFAULT_OPEN);
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
        dailyPct: 14,
        maxDailyPct: 12,
        sessions: { alpha: { share: 2 }, bravo: { share: 0.5, dailyPct: 1.5 } },
        warnAtPct: [50, 100, 150],
        paceTolerancePct: 1,
        overAction: 'ask-lead',
        escalate: 'session',
        quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' },
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
      dailyPct: 14,
      maxDailyPct: 12,
      sessions: { alpha: { share: 2 }, bravo: { share: 0.5, dailyPct: 1.5 } },
      warnAtPct: [50, 100, 150],
      paceTolerancePct: 1,
      overAction: 'ask-lead',
      escalate: 'session',
      quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' },
      lift: { maxStopPct: 98, reserveStopPct: 99.5 },
      statusSnapshotDir: '/srv/usage/live',
      maxBytesPerHook: 2_000_000,
    });
  });

  it('keeps the reserve stop % at or above the lift stop %', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { lift: { maxStopPct: 99, reserveStopPct: 95 } } });
    assert.deepEqual(paths(issues), ['budget.lift.reserveStopPct']);
    assert.deepEqual(config.budget.lift, { maxStopPct: 99, reserveStopPct: 99 });
  });

  it('gives a listed session without a share the default share', () => {
    const { config, issues } = parseConfig({ ...ROSTER, budget: { sessions: { alpha: { dailyPct: 2 } } } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.budget.sessions, { alpha: { share: 1, dailyPct: 2 } });
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
        dailyPct: 0,
        maxDailyPct: 'twelve',
        sessions: { alpha: { share: -1, dailyPct: 101 }, carol: { share: 1 }, bravo: 'half' },
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
      'budget.dailyPct',
      'budget.escalate',
      'budget.lift.maxStopPct',
      'budget.lift.reserveStopPct',
      'budget.maxBytesPerHook',
      'budget.maxDailyPct',
      'budget.overAction',
      'budget.paceEndHoursBeforeReset',
      'budget.paceTolerancePct',
      'budget.quietHours.action',
      'budget.quietHours.endUtc',
      'budget.reservePct',
      'budget.reset.timeUtc',
      'budget.reset.weekday',
      'budget.sessions.alpha.dailyPct',
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
