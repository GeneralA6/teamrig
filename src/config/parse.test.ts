import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMMITS, DEFAULT_OPEN, DEFAULT_REFRESH, DEFAULT_REGISTER } from './defaults.ts';
import { parseConfig } from './parse.ts';
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
    assert.deepEqual(config.register, DEFAULT_REGISTER);
    assert.equal(config.coordinator.budget.enabled, false);
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

  it('reports every wrong field with its path and falls back to the default', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      messages: { maxLines: 'ten' },
      lock: { ttlMs: 10 },
      skills: 'none',
      coordinator: { budget: { enabled: 'yes' }, schedule: { heavyCutoffUtc: '24:00' } },
    });
    assert.deepEqual(paths(issues).sort(), [
      'coordinator.budget.enabled',
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
    assert.equal(config.coordinator.budget.enabled, false);
  });

  it('keeps valid overrides', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      roles: { lead: 'alpha', coordinatorOwner: 'bravo' },
      register: { tiers: [{ id: 1, name: 'now' }], goalPattern: '^G\\d+$', requireNoteOn: ['blocked'] },
      coordinator: { schedule: { heavyCutoffUtc: '22:30' }, budget: { enabled: true, targetPct: 95 } },
      paths: { inbox: '/srv/team/inbox' },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.roles, { lead: 'alpha', coordinatorOwner: 'bravo' });
    assert.deepEqual(config.register.tiers, [{ id: 1, name: 'now' }]);
    assert.equal(config.register.goalPattern, '^G\\d+$');
    assert.deepEqual(config.register.requireNoteOn, ['blocked']);
    assert.deepEqual(config.coordinator.schedule, { heavyCutoffUtc: '22:30' });
    assert.deepEqual(config.coordinator.budget, { enabled: true, targetPct: 95, reservePct: 0.5 });
    assert.deepEqual(config.paths, { inbox: '/srv/team/inbox' });
  });

  it('drops bad tiers and keeps the defaults when none is left', () => {
    const { config, issues } = parseConfig({ ...ROSTER, register: { tiers: [{ id: 0, name: 'zero' }, { name: 'no id' }, 'x'] } });
    assert.deepEqual(paths(issues), [
      'register.tiers[0].id',
      'register.tiers[1].id',
      'register.tiers[2]',
      'register.tiers',
    ]);
    assert.deepEqual(config.register.tiers, DEFAULT_REGISTER.tiers);
  });

  it('refuses duplicate tier ids', () => {
    const { issues } = parseConfig({ ...ROSTER, register: { tiers: [{ id: 1, name: 'a' }, { id: 1, name: 'b' }] } });
    assert.deepEqual(paths(issues), ['register.tiers']);
  });

  it('validates regular expressions and statuses', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      register: { goalPattern: '([', secretPatterns: ['ok-\\d+', '(('], requireNoteOn: ['dropped', 'paused'] },
    });
    assert.deepEqual(paths(issues).sort(), ['register.goalPattern', 'register.requireNoteOn[1]', 'register.secretPatterns[1]']);
    assert.equal(config.register.goalPattern, undefined);
    assert.deepEqual(config.register.secretPatterns, ['ok-\\d+']);
    assert.deepEqual(config.register.requireNoteOn, ['dropped']);
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

  it('bounds the lists and texts the rule pack prints', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      ownerGates: ['money', 'two\nlines', 'g'.repeat(61)],
      register: { requireNoteOn: ['open', 'in-progress', 'blocked', 'done', 'dropped', 'done'] },
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

  it('reads the refresh settings, defaulting each and refusing a bad threshold or folder', () => {
    assert.deepEqual(parseConfig(ROSTER).config.refresh, DEFAULT_REFRESH);
    const set = parseConfig({ ...ROSTER, refresh: { enabled: false, contextTokens: 150_000, tabTitle: false, handoverDir: 'notes' } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.refresh, { enabled: false, contextTokens: 150_000, tabTitle: false, handoverDir: 'notes' });
    const bad = parseConfig({ ...ROSTER, refresh: { enabled: 'yes', contextTokens: 9_999, tabTitle: 1, handoverDir: ' ' } });
    assert.deepEqual(paths(bad.issues).sort(), ['refresh.contextTokens', 'refresh.enabled', 'refresh.handoverDir', 'refresh.tabTitle']);
    assert.deepEqual(bad.config.refresh, DEFAULT_REFRESH);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { contextTokens: 10_000_001 } }).issues), ['refresh.contextTokens']);
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

  it('ignores keys it does not know, including $schema', () => {
    const { issues } = parseConfig({ ...ROSTER, $schema: './config.schema.json', futureKey: { any: 1 } });
    assert.deepEqual(issues, []);
  });
});
