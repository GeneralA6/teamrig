import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET, DEFAULT_BURST, DEFAULT_CHECK_TIMEOUT_SECONDS, DEFAULT_FREEZES, DEFAULT_COMMITS, DEFAULT_FOCUS, DEFAULT_QUEUE, DEFAULT_HIRING, DEFAULT_IDLE, DEFAULT_OPEN, DEFAULT_PERMISSIONS, DEFAULT_REFRESH, DEFAULT_REGISTER, DEFAULT_STATUS_LINE, DEFAULT_WAKE, DEFAULT_STABLE_PERIODS, DEFAULT_MEETING } from './defaults.ts';
import { HIRE_CAP_DROPPED, IDLE_RETIRE_DROPPED } from './migrate.ts';
import { parseConfig } from './parse.ts';
import { CONFIG_VERSION, type AccountBudget, type BudgetConfig } from './types.ts';
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
    assert.deepEqual(config.loops, { chainNudgeAt: 3 });
    assert.deepEqual(config.leadBoundary, { enabled: true, ownPaths: [], searchNudgeAt: 3 });
    assert.deepEqual(config.turnLog, { enabled: true, keepHours: 24 });
    assert.deepEqual(config.needsYou, { enabled: true, kinds: ['permission', 'question', 'elicitation', 'decision'], osToast: false });
    assert.deepEqual(config.meetingNotices, { enabled: true, beforeMinutes: 10, atStart: true, missedAfterMinutes: 5, osToast: true, tabToast: true, leadInbox: true });
    assert.deepEqual(config.tests, { maxFailureChars: 4000 });
    assert.deepEqual(config.github, { repos: [], owners: {}, sessions: {}, closedDays: 14, everyMinutes: 15, acceptLabel: 'teamrig', similarThreshold: 0.35 });
    assert.deepEqual(config.register, DEFAULT_REGISTER);
    assert.deepEqual(config.budget, DEFAULT_BUDGET);
    assert.deepEqual(config.delivery, {
      schedule: {},
      queue: { lockTtlMinutes: 150, maxRunMinutes: 45, smallMaxRunMinutes: 10, waitMinutes: 60, memorySampleSeconds: 15, memoryFloorMb: 4096, smallReserveMb: 2048, heavyReserveMb: 2048, admission: 'pipeline', agingMinutes: 15, perSessionRunning: 2, maxHeavyParallel: 2 },
      wait: { pollSeconds: 30, maxMinutes: 60 },
      checkTimeoutSeconds: 20,
      freezes: { maxMinutes: 120 },
      stablePeriods: { settleMinutes: 30, targetSettleMinutes: {}, assumedDeployMinutes: 20, minMinutes: 15 },
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

  it('requires every role holder to be a session on the team', () => {
    const { config, issues } = parseConfig({ sessions: ['alpha'], roles: { lead: 'bravo', deliveryOwner: 'charlie', securityReviewer: 'delta' } });
    assert.deepEqual(paths(issues), ['roles.lead', 'roles.deliveryOwner', 'roles.securityReviewer']);
    assert.equal(config.roles.deliveryOwner, 'charlie');
    assert.equal(config.roles.securityReviewer, 'delta');
  });

  it('takes a reviewer or delivery owner of a team above as <team>/<id>, never its own team so, nor a qualified lead (T1143)', () => {
    const above = parseConfig({ sessions: ['alpha'], roles: { lead: 'alpha', deliveryOwner: 'root/po', securityReviewer: 'root/security' }, team: { id: 'web', parent: 'root' } });
    assert.deepEqual(above.issues, []);
    assert.deepEqual(above.config.roles, { lead: 'alpha', deliveryOwner: 'root/po', securityReviewer: 'root/security' });
    const own = parseConfig({ sessions: ['alpha'], roles: { lead: 'alpha', securityReviewer: 'web/alpha' }, team: { id: 'web', parent: 'root' } });
    assert.deepEqual(own.issues, [{ path: 'roles.securityReviewer', message: 'names its own team web: write the bare id' }]);
    const bad = parseConfig({ sessions: ['alpha'], roles: { lead: 'root/alpha', deliveryOwner: 'Root/po', securityReviewer: 'a/b/c' } });
    assert.deepEqual(paths(bad.issues), ['roles.lead', 'roles.deliveryOwner', 'roles.securityReviewer']);
  });

  it('leaves the optional roles out when the config does not assign them', () => {
    const { config, issues } = parseConfig({ sessions: ['alpha'], roles: { lead: 'alpha' } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.roles, { lead: 'alpha' });
  });

  it('rejects malformed and duplicate session names', () => {
    const { config, issues } = parseConfig({ sessions: ['alpha', 'Bravo', 'alpha', 7], roles: { lead: 'alpha' } });
    assert.deepEqual(paths(issues), ['sessions[1]', 'sessions[3]', 'sessions']);
    assert.deepEqual(config.sessions, ['alpha', 'alpha']);
  });

  it('keeps a name for each session and defaults to none', () => {
    assert.deepEqual(parseConfig(ROSTER).config.names, {});
    const { config, issues } = parseConfig({ ...ROSTER, names: { alpha: 'captain', bravo: 'bravo' } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.names, { alpha: 'captain', bravo: 'bravo' });
  });

  it('refuses names of strangers, malformed names, reserved names and names that are taken', () => {
    const { config, issues } = parseConfig({
      sessions: ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
      roles: { lead: 'alpha' },
      names: { alpha: 'boss', bravo: 'boss', charlie: 'alpha', delta: 'Delta', echo: 'team-lead', zulu: 'z', constructor: 'c' },
    });
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        'names.bravo: "boss" is already the name of alpha',
        'names.charlie: "alpha" is already a session id',
        'names.delta: expected a name: a lowercase letter, then lowercase letters, digits or -, at most 65 characters (got "Delta")',
        'names.echo: expected a name Claude Code does not keep for itself (main, team-lead, user, system): a message to one never reaches a session (got "team-lead")',
        'names.zulu: is not one of the sessions',
        'names.constructor: is not one of the sessions',
      ],
    );
    assert.deepEqual(config.names, { alpha: 'boss' });
  });

  it('keeps each sub-lead with its members, nested, and defaults to none', () => {
    assert.deepEqual(parseConfig(ROSTER).config.leads, {});
    const { config, issues } = parseConfig({
      sessions: ['alpha', 'bravo', 'charlie', 'delta'],
      roles: { lead: 'alpha' },
      leads: { bravo: ['charlie'], charlie: ['delta'] },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.leads, { bravo: ['charlie'], charlie: ['delta'] });
  });

  it('refuses a sub-lead or member that breaks the tree, and leaves it out', () => {
    const { config, issues } = parseConfig({
      sessions: ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
      roles: { lead: 'alpha' },
      leads: { alpha: ['bravo'], zulu: ['charlie'], bravo: ['alpha', 'bravo', 'zulu', 'charlie'], delta: ['charlie'], echo: [] },
    });
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        'leads.alpha: is the lead, which leads every session no sub-lead lists; list sub-leads only',
        'leads.zulu: is not one of the sessions',
        'leads.bravo: "alpha" is the lead, which no one leads',
        'leads.bravo: "bravo" is the sub-lead itself',
        'leads.bravo: "zulu" is not one of the sessions',
        'leads.delta: "charlie" is already led by bravo; a session has one leader',
        'leads.delta: lists no member; a sub-lead leads at least one session',
        'leads.echo: lists no member; a sub-lead leads at least one session',
      ],
    );
    assert.deepEqual(config.leads, { bravo: ['charlie'] });
  });

  it('refuses a sub-lead that leads itself through its members, which breaks the cycle', () => {
    const { config, issues } = parseConfig({
      sessions: ['alpha', 'bravo', 'charlie', 'delta'],
      roles: { lead: 'alpha' },
      leads: { bravo: ['charlie'], charlie: ['delta'], delta: ['bravo'] },
    });
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      ['leads.bravo: leads itself through its members; a sub-lead cannot be under its own group'],
    );
    assert.deepEqual(config.leads, { charlie: ['delta'], delta: ['bravo'] });
  });

  it('keeps the launch settings of each session and defaults to none', () => {
    assert.deepEqual(parseConfig(ROSTER).config.launch, {});
    const { config, issues } = parseConfig({ ...ROSTER, launch: { alpha: { model: 'opus', effort: 'max' }, bravo: { model: 'claude-haiku-5-5' } } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.launch, { alpha: { model: 'opus', effort: 'max' }, bravo: { model: 'claude-haiku-5-5' } });
  });

  it("keeps a session's project folder, and refuses one that is relative or on more than one line", () => {
    const kept = parseConfig({ ...ROSTER, launch: { alpha: { project: '/srv/app' } } });
    assert.deepEqual(kept.issues, []);
    assert.deepEqual(kept.config.launch, { alpha: { project: '/srv/app' } });
    const { config, issues } = parseConfig({ ...ROSTER, launch: { alpha: { model: 'opus', project: 'projects/app' }, bravo: { project: '/srv/app\n/srv/web' } } });
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        'launch.alpha.project: expected an absolute folder path on one line (got "projects/app")',
        'launch.bravo.project: expected an absolute folder path on one line (got "/srv/app\\n/srv/web")',
      ],
    );
    assert.deepEqual(config.launch, { alpha: { model: 'opus' }, bravo: {} });
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

  it('reads exec.path as absolute folders, empty by default, and refuses one against the cwd or holding a PATH separator', () => {
    assert.deepEqual(parseConfig(ROSTER).config.exec, { path: [] });
    const folders = ['C:/tools', 'D:\\bin', '/usr/bin', '\\tools'];
    assert.deepEqual(parseConfig({ ...ROSTER, exec: { path: folders } }).config.exec.path, folders);
    const { config, issues } = parseConfig({ ...ROSTER, exec: { path: ['C:/tools', 'bin', 'C:tools', 'C:/a;D:/b', '/usr/bin:/tmp'] } });
    assert.deepEqual(paths(issues), ['exec.path[1]', 'exec.path[2]', 'exec.path[3]', 'exec.path[4]']);
    assert.deepEqual(config.exec.path, ['C:/tools']);
  });

  it('reads exec.webhookEnv as a variable name, absent by default, and refuses a URL or a name with a space', () => {
    assert.equal(parseConfig(ROSTER).config.exec.webhookEnv, undefined);
    assert.equal(parseConfig({ ...ROSTER, exec: { webhookEnv: 'EXEC_WEBHOOK_URL' } }).config.exec.webhookEnv, 'EXEC_WEBHOOK_URL');
    for (const value of ['https://chat.example/api/webhooks/1/x', 'EXEC WEBHOOK', '1ST_URL', 'A'.repeat(65)]) {
      const { config, issues } = parseConfig({ ...ROSTER, exec: { webhookEnv: value } });
      assert.deepEqual(paths(issues), ['exec.webhookEnv'], value);
      assert.equal(config.exec.webhookEnv, undefined);
    }
  });

  it('reads alerts.pageWebhookEnv as a variable name and alerts.pageWebhookFile as an absolute file, both absent by default (T1757)', () => {
    const unset = parseConfig(ROSTER).config.alerts;
    assert.deepEqual(unset, { persistentFailureHours: 24 });
    const both = { pageWebhookEnv: 'PAGE_WEBHOOK_URL', pageWebhookFile: 'C:/chat/.page-webhook' };
    assert.deepEqual(parseConfig({ ...ROSTER, alerts: both }).config.alerts, { persistentFailureHours: 24, ...both });
    for (const file of ['D:\\chat\\hook.txt', '/srv/chat/hook', '\\chat\\hook']) {
      assert.equal(parseConfig({ ...ROSTER, alerts: { pageWebhookFile: file } }).config.alerts.pageWebhookFile, file);
    }
    for (const [key, value] of [
      ['pageWebhookEnv', 'https://chat.example/api/webhooks/1/x'],
      ['pageWebhookEnv', 'PAGE WEBHOOK'],
      ['pageWebhookFile', 'chat/.page-webhook'],
      ['pageWebhookFile', 'C:chat'],
      ['pageWebhookFile', 'C:/chat/a\nC:/chat/b'],
      ['pageWebhookFile', 'https://chat.example/api/webhooks/1/x'],
    ] as const) {
      const { config, issues } = parseConfig({ ...ROSTER, alerts: { [key]: value } });
      assert.deepEqual(paths(issues), [`alerts.${key}`], value);
      assert.deepEqual(config.alerts, { persistentFailureHours: 24 }, value);
    }
  });

  it("reads alerts.pageWebhookKey as the key of alerts.pageWebhookFile's file, refused without the file or as no key name (T2426)", () => {
    for (const key of ['PAGE_WEBHOOK_URL', 'page-webhook.url', '_url']) {
      const alerts = { pageWebhookFile: 'C:/secrets/secrets.yaml', pageWebhookKey: key };
      assert.deepEqual(parseConfig({ ...ROSTER, alerts }).config.alerts, { persistentFailureHours: 24, ...alerts });
    }
    const alone = parseConfig({ ...ROSTER, alerts: { pageWebhookKey: 'PAGE_WEBHOOK_URL' } });
    assert.deepEqual(alone.issues.map((issue) => [issue.path, issue.message]), [['alerts.pageWebhookKey', 'needs alerts.pageWebhookFile, the file it reads the key from']]);
    assert.deepEqual(alone.config.alerts, { persistentFailureHours: 24 });
    const badFile = parseConfig({ ...ROSTER, alerts: { pageWebhookFile: 'secrets.yaml', pageWebhookKey: 'PAGE_WEBHOOK_URL' } });
    assert.deepEqual(paths(badFile.issues), ['alerts.pageWebhookFile'], 'only the bad file is reported');
    assert.deepEqual(badFile.config.alerts, { persistentFailureHours: 24 });
    for (const key of ['PAGE WEBHOOK', '1PAGE', 'PAGE:URL', 'x'.repeat(65)]) {
      const { config, issues } = parseConfig({ ...ROSTER, alerts: { pageWebhookFile: 'C:/secrets/secrets.yaml', pageWebhookKey: key } });
      assert.deepEqual(paths(issues), ['alerts.pageWebhookKey'], key);
      assert.deepEqual(config.alerts, { persistentFailureHours: 24, pageWebhookFile: 'C:/secrets/secrets.yaml' }, key);
    }
  });

  it('reads turnLog, and refuses keeping entries under an hour or past a week', () => {
    const off = { enabled: false, keepHours: 168 };
    assert.deepEqual(parseConfig({ ...ROSTER, turnLog: off }).config.turnLog, off);
    const { config, issues } = parseConfig({ ...ROSTER, turnLog: { keepHours: 0 } });
    assert.deepEqual(paths(issues), ['turnLog.keepHours']);
    assert.equal(config.turnLog.keepHours, 24);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, turnLog: { keepHours: 169 } }).issues), ['turnLog.keepHours']);
  });

  it('reads needsYou, leaves out an unknown kind, and refuses a list that is no list or names more kinds than there are', () => {
    const own = { enabled: false, kinds: ['error'], osToast: true };
    assert.deepEqual(parseConfig({ ...ROSTER, needsYou: own }).config.needsYou, own);
    const unknown = parseConfig({ ...ROSTER, needsYou: { kinds: ['question', 'nag', 7] } });
    assert.deepEqual(paths(unknown.issues), ['needsYou.kinds[1]', 'needsYou.kinds[2]']);
    assert.match(unknown.issues[0]?.message ?? '', /expected one of permission, question, elicitation, decision, error/);
    assert.deepEqual(unknown.config.needsYou.kinds, ['question']);
    const notList = parseConfig({ ...ROSTER, needsYou: { kinds: 'question', osToast: 'yes' } });
    assert.deepEqual(paths(notList.issues), ['needsYou.kinds', 'needsYou.osToast']);
    assert.deepEqual(notList.config.needsYou, { enabled: true, kinds: ['permission', 'question', 'elicitation', 'decision'], osToast: false });
    assert.deepEqual(paths(parseConfig({ ...ROSTER, needsYou: { kinds: ['error', 'error', 'error', 'error', 'error', 'error'] } }).issues), ['needsYou.kinds']);
  });

  it('reads meetingNotices, and refuses a lead time under 0 or past two hours', () => {
    const set = { enabled: false, beforeMinutes: 0, atStart: false, missedAfterMinutes: 120, osToast: false, tabToast: false, leadInbox: false };
    assert.deepEqual(parseConfig({ ...ROSTER, meetingNotices: set }).config.meetingNotices, set);
    const { config, issues } = parseConfig({ ...ROSTER, meetingNotices: { beforeMinutes: -1, missedAfterMinutes: 121 } });
    assert.deepEqual(paths(issues), ['meetingNotices.beforeMinutes', 'meetingNotices.missedAfterMinutes']);
    assert.equal(config.meetingNotices.beforeMinutes, 10);
    assert.equal(config.meetingNotices.missedAfterMinutes, 5);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, meetingNotices: { osToast: 'yes' } }).issues), ['meetingNotices.osToast']);
  });

  it('reads loops.chainNudgeAt, where 0 turns the nudge off, and refuses a value past 50', () => {
    assert.equal(parseConfig({ ...ROSTER, loops: { chainNudgeAt: 0 } }).config.loops.chainNudgeAt, 0);
    const { config, issues } = parseConfig({ ...ROSTER, loops: { chainNudgeAt: 51 } });
    assert.deepEqual(paths(issues), ['loops.chainNudgeAt']);
    assert.equal(config.loops.chainNudgeAt, 3);
  });

  it('reads wake, on for p1 by default, and refuses a priority under 1 or waits past their bounds', () => {
    assert.deepEqual(parseConfig(ROSTER).config.wake, { enabled: true, priority: 1, batchSeconds: 120, minGapMinutes: 15 });
    const own = { enabled: false, priority: 2, batchSeconds: 0, minGapMinutes: 0 };
    assert.deepEqual(parseConfig({ ...ROSTER, wake: own }).config.wake, own);
    const { config, issues } = parseConfig({ ...ROSTER, wake: { priority: 0, batchSeconds: 3601, minGapMinutes: 1441 } });
    assert.deepEqual(paths(issues), ['wake.priority', 'wake.batchSeconds', 'wake.minGapMinutes']);
    assert.deepEqual(config.wake, DEFAULT_WAKE);
  });

  it('reads meeting.panel.enabled, on by default, and refuses a value that is not a boolean (T2512)', () => {
    assert.deepEqual(parseConfig(ROSTER).config.meeting, DEFAULT_MEETING);
    assert.equal(parseConfig({ ...ROSTER, meeting: { panel: { enabled: false } } }).config.meeting.panel.enabled, false);
    const bad = parseConfig({ ...ROSTER, meeting: { panel: { enabled: 'no' } } });
    assert.deepEqual([paths(bad.issues), bad.config.meeting], [['meeting.panel.enabled'], DEFAULT_MEETING]);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, meeting: { panel: true } }).issues), ['meeting.panel']);
  });

  it('reads meeting.spotlight, on at 0.6 by default, and refuses a dim outside 0.1 to 0.9 or a non-boolean enabled (T2517, T2523)', () => {
    assert.deepEqual(parseConfig(ROSTER).config.meeting.spotlight, { enabled: true, dim: 0.6, breakthroughSeconds: 120 });
    assert.deepEqual(parseConfig({ ...ROSTER, meeting: { spotlight: { enabled: false, dim: 0.3 } } }).config.meeting.spotlight, {
      enabled: false,
      dim: 0.3,
      breakthroughSeconds: 120,
    });
    for (const dim of [0.05, 0.95, 'dark']) {
      const bad = parseConfig({ ...ROSTER, meeting: { spotlight: { dim } } });
      assert.deepEqual([paths(bad.issues), bad.config.meeting.spotlight.dim], [['meeting.spotlight.dim'], 0.6], String(dim));
    }
    const notBoolean = parseConfig({ ...ROSTER, meeting: { spotlight: { enabled: 'yes' } } });
    assert.deepEqual([paths(notBoolean.issues), notBoolean.config.meeting.spotlight.enabled], [['meeting.spotlight.enabled'], true]);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, meeting: { spotlight: 1 } }).issues), ['meeting.spotlight']);
  });

  it('reads meeting.spotlight.breakthroughSeconds, 120 by default, and refuses one outside 10 to 3600 or not whole (T2524)', () => {
    const set = parseConfig({ ...ROSTER, meeting: { spotlight: { breakthroughSeconds: 30 } } });
    assert.deepEqual([set.issues, set.config.meeting.spotlight.breakthroughSeconds], [[], 30]);
    for (const breakthroughSeconds of [9, 3601, 12.5, 'soon']) {
      const bad = parseConfig({ ...ROSTER, meeting: { spotlight: { breakthroughSeconds } } });
      assert.deepEqual(
        [paths(bad.issues), bad.config.meeting.spotlight.breakthroughSeconds],
        [['meeting.spotlight.breakthroughSeconds'], 120],
        String(breakthroughSeconds),
      );
    }
  });

  it('reads meeting.statusLine, on in magenta with "meeting on: held" by default, and refuses a bad colour or held text (T2513)', () => {
    const defaults = { enabled: true, colour: '#d75fd7', heldText: 'meeting on: held' };
    assert.deepEqual(parseConfig(ROSTER).config.meeting.statusLine, defaults);
    const set = { enabled: false, colour: '#FF8800', heldText: 'held for the meeting' };
    assert.deepEqual(parseConfig({ ...ROSTER, meeting: { statusLine: set } }).config.meeting.statusLine, set);
    for (const colour of ['red', '#fff', '#12345g', 'd75fd7', 7]) {
      const bad = parseConfig({ ...ROSTER, meeting: { statusLine: { colour } } });
      assert.deepEqual([paths(bad.issues), bad.config.meeting.statusLine.colour], [['meeting.statusLine.colour'], defaults.colour], String(colour));
    }
    for (const heldText of ['x'.repeat(41), 'two\nlines', '', 3]) {
      const bad = parseConfig({ ...ROSTER, meeting: { statusLine: { heldText } } });
      assert.deepEqual([paths(bad.issues), bad.config.meeting.statusLine.heldText], [['meeting.statusLine.heldText'], defaults.heldText], String(heldText));
    }
    const notBoolean = parseConfig({ ...ROSTER, meeting: { statusLine: { enabled: 'no' } } });
    assert.deepEqual([paths(notBoolean.issues), notBoolean.config.meeting.statusLine.enabled], [['meeting.statusLine.enabled'], true]);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, meeting: { statusLine: 'on' } }).issues), ['meeting.statusLine']);
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
    assert.deepEqual(config.github, {
      repos: ['acme/web', 'acme/docs.site'],
      owners: { octocat: 'bravo' },
      sessions: {},
      closedDays: 365,
      everyMinutes: 0,
      acceptLabel: 'teamrig',
      similarThreshold: 0.35,
    });
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

  it('reads the github similar threshold within 0 to 1, else keeps 0.35', () => {
    for (const good of [0, 0.5, 1]) {
      const { config, issues } = parseConfig({ ...ROSTER, github: { similarThreshold: good } });
      assert.deepEqual(issues, []);
      assert.equal(config.github.similarThreshold, good);
    }
    for (const wrong of [-0.1, 1.01, '0.5']) {
      const parsed = parseConfig({ ...ROSTER, github: { similarThreshold: wrong } });
      assert.deepEqual(paths(parsed.issues), ['github.similarThreshold'], JSON.stringify(wrong));
      assert.equal(parsed.config.github.similarThreshold, 0.35);
    }
  });

  it('reads the github accept label as one line of at most 50 characters, else keeps teamrig', () => {
    const { config, issues } = parseConfig({ ...ROSTER, github: { acceptLabel: 'Accepted by triage' } });
    assert.deepEqual(issues, []);
    assert.equal(config.github.acceptLabel, 'Accepted by triage');
    assert.equal(parseConfig({ ...ROSTER, github: { acceptLabel: 'x'.repeat(50) } }).config.github.acceptLabel, 'x'.repeat(50));
    for (const wrong of ['', '  ', 'x'.repeat(51), 'a\nb', 7]) {
      const parsed = parseConfig({ ...ROSTER, github: { acceptLabel: wrong } });
      assert.deepEqual(paths(parsed.issues), ['github.acceptLabel'], JSON.stringify(wrong));
      assert.equal(parsed.config.github.acceptLabel, 'teamrig');
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
      delivery: { schedule: { queueCutoffUtc: '24:00' } },
    });
    assert.deepEqual(paths(issues).sort(), [
      'budget.enabled',
      'delivery.schedule.queueCutoffUtc',
      'lock.ttlMs',
      'messages.maxLines',
      'skills',
    ]);
    const maxLines = issues.find((issue) => issue.path === 'messages.maxLines');
    assert.equal(maxLines?.message, 'expected an integer from 3 to 50, got "ten"');
    assert.equal(config.messages.maxLines, 10);
    assert.equal(config.lock.ttlMs, 300_000);
    assert.equal(config.skills.maxPerArea, 8);
    assert.equal(config.budget.enabled, false);
  });

  it('reads the context file budgets, from their defaults and within their bounds', () => {
    assert.deepEqual(parseConfig(ROSTER).config.contextFiles, {
      maxClaudeMdChars: 12_000,
      maxMemoryIndexChars: 6_000,
      maxSkillListingChars: 4_000,
      maxSessionListsChars: 16_000,
    });
    const { config, issues } = parseConfig({
      ...ROSTER,
      contextFiles: { maxClaudeMdChars: 20_000, maxMemoryIndexChars: 499, maxSessionListsChars: 30_000 },
    });
    assert.deepEqual(config.contextFiles, {
      maxClaudeMdChars: 20_000,
      maxMemoryIndexChars: 6_000,
      maxSkillListingChars: 4_000,
      maxSessionListsChars: 30_000,
    });
    assert.deepEqual(paths(issues), ['contextFiles.maxMemoryIndexChars']);
  });

  it('keeps valid overrides', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      roles: { lead: 'alpha', deliveryOwner: 'bravo', securityReviewer: 'bravo' },
      register: { priorities: [{ id: 1, name: 'now' }], goalPattern: '^G\\d+$', requireNoteOn: ['waiting'], check: { prioritySkipAfterHours: 12, maxSelfMadePerDay: 0, goalProgressDays: 2, overSizeMultiple: 1.5 } },
      delivery: { schedule: { queueCutoffUtc: '22:30' } },
      budget: { enabled: true, targetPct: 95 },
      paths: { inbox: '/srv/team/inbox' },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.roles, { lead: 'alpha', deliveryOwner: 'bravo', securityReviewer: 'bravo' });
    assert.deepEqual(config.register.priorities, [{ id: 1, name: 'now' }]);
    assert.equal(config.register.goalPattern, '^G\\d+$');
    assert.deepEqual(config.register.requireNoteOn, ['waiting']);
    assert.deepEqual(config.register.check, {
      staleAfterHours: 72,
      notPickedUpAfterHours: 24,
      prioritySkipAfterHours: 12,
      maxSelfMadePerDay: 0,
      goalProgressDays: 2,
      overSizeMultiple: 1.5,
      weekLengthDays: 7,
      stopgapFiles: ['CLAUDE.md', '.claude/rules'],
    });
    assert.deepEqual(config.delivery.schedule, { queueCutoffUtc: '22:30' });
    assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, enabled: true, targetPct: 95 });
    assert.deepEqual(config.paths, { inbox: '/srv/team/inbox' });
  });

  it('keeps the delivery folder, host lock and queued step limits', () => {
    const delivery = {
      dir: 'data/deploys',
      queue: { lockPath: 'data/deploys/host.lock', lockTtlMinutes: 90, maxRunMinutes: 80, smallMaxRunMinutes: 80, waitMinutes: 0, memorySampleSeconds: 0, memoryFloorMb: 0, smallReserveMb: 512, heavyReserveMb: 1024, admission: 'serial', agingMinutes: 0, perSessionRunning: 0, maxHeavyParallel: 3 },
      wait: { pollSeconds: 5, maxMinutes: 0 },
      checkTimeoutSeconds: 45,
      freezes: { maxMinutes: 90 },
      stablePeriods: { settleMinutes: 10, targetSettleMinutes: {}, assumedDeployMinutes: 5, minMinutes: 30 },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.delivery, { ...delivery, schedule: {}, repos: {} });
  });

  it('cuts a queued step longer than its lock less 10 minutes to fit, and says so', () => {
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { queue: { lockTtlMinutes: 60, maxRunMinutes: 55 } } });
    assert.deepEqual(paths(issues), ['delivery.queue.maxRunMinutes']);
    assert.equal(config.delivery.queue.maxRunMinutes, 50);
  });

  it('fits the default queued step limit to a short lock without an issue', () => {
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { queue: { lockTtlMinutes: 30 } } });
    assert.deepEqual(issues, []);
    assert.equal(config.delivery.queue.maxRunMinutes, 20);
  });

  it('cuts a small step limit longer than a step to it, and says so', () => {
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { queue: { maxRunMinutes: 30, smallMaxRunMinutes: 40 } } });
    assert.deepEqual(paths(issues), ['delivery.queue.smallMaxRunMinutes']);
    assert.equal(config.delivery.queue.smallMaxRunMinutes, 30);
  });

  it('fits the default small step limit to a short step limit without an issue', () => {
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { queue: { maxRunMinutes: 5 } } });
    assert.deepEqual(issues, []);
    assert.equal(config.delivery.queue.smallMaxRunMinutes, 5);
  });

  it('reads the reset blackout and the repositories teamrig merge merges into, each repository from its defaults', () => {
    const delivery = {
      schedule: { queueCutoffUtc: '22:30', resetBlackoutHours: 4 },
      repos: {
        api: { mainCheckout: 'C:/src/api', deploysOnPush: ['cloud-api'], updateMainCheckout: true },
        web: { mainCheckout: 'repos/web', dependencyGate: true },
      },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.delivery.schedule, delivery.schedule);
    assert.deepEqual(config.delivery.repos, {
      api: { mainCheckout: 'C:/src/api', deploysOnPush: ['cloud-api'], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: true },
      web: { mainCheckout: 'repos/web', deploysOnPush: [], dependencyGate: true, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false },
    });
  });

  it('reads the dependency check a gated repository runs, and reports one that never runs or is no program', () => {
    const check = ['node', 'tools/check-change.ts'];
    const repos = {
      gated: { mainCheckout: 'repos/gated', dependencyGate: true, dependencyCheck: check },
      open: { mainCheckout: 'repos/open', dependencyCheck: check },
      bad: { mainCheckout: 'repos/bad', dependencyGate: true, dependencyCheck: 'node check.ts' },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos } });
    assert.deepEqual(paths(issues).sort(), ['delivery.repos.bad.dependencyCheck', 'delivery.repos.open.dependencyCheck']);
    assert.match(issues.find((issue) => issue.path === 'delivery.repos.open.dependencyCheck')?.message ?? '', /runs only with dependencyGate true/);
    assert.deepEqual(config.delivery.repos['gated'], { mainCheckout: 'repos/gated', deploysOnPush: [], dependencyGate: true, dependencyCheck: check, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false });
    assert.equal(config.delivery.repos['bad']?.dependencyCheck, undefined);
  });

  it('reads the review check a gated repository runs, and reports one that never runs or is no program', () => {
    const check = ['node', 'tools/review-change.ts'];
    const repos = {
      gated: { mainCheckout: 'repos/gated', reviewGate: true, reviewCheck: check },
      open: { mainCheckout: 'repos/open', reviewCheck: check },
      bad: { mainCheckout: 'repos/bad', reviewGate: true, reviewCheck: 'node review.ts' },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos } });
    assert.deepEqual(paths(issues).sort(), ['delivery.repos.bad.reviewCheck', 'delivery.repos.open.reviewCheck']);
    assert.match(issues.find((issue) => issue.path === 'delivery.repos.open.reviewCheck')?.message ?? '', /runs only with reviewGate true/);
    assert.deepEqual(config.delivery.repos['gated'], { mainCheckout: 'repos/gated', deploysOnPush: [], dependencyGate: false, reviewGate: true, reviewCheck: check, decisionRecordGate: false, updateMainCheckout: false });
    assert.equal(config.delivery.repos['bad']?.reviewGate, true);
    assert.equal(config.delivery.repos['bad']?.reviewCheck, undefined);
  });

  it('reads a repository’s docs folder and its decision record gate, off by default, and reports a blank folder or a gate that is no boolean (T1869)', () => {
    const repos = {
      local: { mainCheckout: 'repos/local', docsFolder: 'notes/docs', decisionRecordGate: true },
      outside: { mainCheckout: 'repos/outside', docsFolder: '/srv/docs-repo' },
      unset: { mainCheckout: 'repos/unset' },
      blank: { mainCheckout: 'repos/blank', docsFolder: ' ' },
      word: { mainCheckout: 'repos/word', decisionRecordGate: 'yes' },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos } });
    assert.deepEqual(paths(issues).sort(), ['delivery.repos.blank.docsFolder', 'delivery.repos.word.decisionRecordGate']);
    assert.deepEqual(config.delivery.repos['local'], { mainCheckout: 'repos/local', deploysOnPush: [], dependencyGate: false, reviewGate: false, docsFolder: 'notes/docs', decisionRecordGate: true, updateMainCheckout: false });
    assert.equal(config.delivery.repos['outside']?.docsFolder, '/srv/docs-repo');
    assert.equal(config.delivery.repos['outside']?.decisionRecordGate, false);
    assert.equal(config.delivery.repos['unset']?.docsFolder, undefined);
    assert.equal(config.delivery.repos['blank']?.docsFolder, undefined);
    assert.equal(config.delivery.repos['word']?.decisionRecordGate, false);
  });

  it('reads where a repository’s new worktrees go and their setup, and reports a blank folder or a setup that is no program (T1305)', () => {
    const setup = ['node', 'tools/link-modules.ts'];
    const repos = {
      set: { mainCheckout: 'repos/set', worktreeFolder: '../worktrees', worktreeSetup: setup },
      unset: { mainCheckout: 'repos/unset' },
      bad: { mainCheckout: 'repos/bad', worktreeFolder: ' ', worktreeSetup: 'node link.ts' },
      empty: { mainCheckout: 'repos/empty', worktreeSetup: [] },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos } });
    assert.deepEqual(paths(issues).sort(), ['delivery.repos.bad.worktreeFolder', 'delivery.repos.bad.worktreeSetup', 'delivery.repos.empty.worktreeSetup']);
    assert.deepEqual(config.delivery.repos['set'], { mainCheckout: 'repos/set', deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false, worktreeFolder: '../worktrees', worktreeSetup: setup });
    assert.deepEqual(config.delivery.repos['unset'], { mainCheckout: 'repos/unset', deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false });
    assert.equal(config.delivery.repos['bad']?.worktreeFolder, undefined);
    assert.equal(config.delivery.repos['bad']?.worktreeSetup, undefined);
  });

  it('reads a repository’s merge command, and leaves out one that is not a program with its arguments', () => {
    const command = ['node', 'tools/merge.ts'];
    const repos = {
      forge: { mainCheckout: 'repos/forge', merge: { command } },
      push: { mainCheckout: 'repos/push' },
      text: { mainCheckout: 'repos/text', merge: { command: 'node merge.ts' } },
      empty: { mainCheckout: 'repos/empty', merge: {} },
      bare: { mainCheckout: 'repos/bare', merge: ['node', 'merge.ts'] },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos } });
    assert.deepEqual(paths(issues).sort(), ['delivery.repos.bare.merge', 'delivery.repos.empty.merge.command', 'delivery.repos.text.merge.command']);
    assert.deepEqual(config.delivery.repos['forge'], { mainCheckout: 'repos/forge', deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false, merge: { command, remote: 'origin' } });
    assert.equal(config.delivery.repos['push']?.merge, undefined);
    assert.equal(config.delivery.repos['text']?.merge, undefined);
    assert.equal(config.delivery.repos['empty']?.merge, undefined);
    assert.equal(config.delivery.repos['bare']?.merge, undefined);
  });

  it('reads the remote a merge command merges into, and refuses one git could read as an option or a range', () => {
    const command = ['node', 'tools/merge.ts'];
    const repos = {
      fork: { mainCheckout: 'repos/fork', merge: { command, remote: 'upstream' } },
      dotted: { mainCheckout: 'repos/dotted', merge: { command, remote: 'my.Remote_2' } },
      option: { mainCheckout: 'repos/option', merge: { command, remote: '-x' } },
      spaced: { mainCheckout: 'repos/spaced', merge: { command, remote: 'a b' } },
      range: { mainCheckout: 'repos/range', merge: { command, remote: 'a..b' } },
    };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos } });
    assert.deepEqual(paths(issues).sort(), ['delivery.repos.option.merge.remote', 'delivery.repos.range.merge.remote', 'delivery.repos.spaced.merge.remote']);
    assert.match(issues.find((issue) => issue.path === 'delivery.repos.option.merge.remote')?.message ?? '', /expected a git remote name/);
    assert.deepEqual(config.delivery.repos['fork']?.merge, { command, remote: 'upstream' });
    assert.deepEqual(config.delivery.repos['dotted']?.merge, { command, remote: 'my.Remote_2' });
    assert.deepEqual(config.delivery.repos['option']?.merge, { command, remote: 'origin' });
  });

  it('reads a repository’s deploy, its checks and afterPull hooks from their defaults', () => {
    const deploy = { targets: ['cloud-api'], checks: [{ name: 'flow', command: ['node', 'checks/flow.js', '--quiet'] }], command: ['node', 'deploy.js'] };
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { repos: { api: { mainCheckout: 'C:/src/api', deploy }, web: { mainCheckout: 'C:/src/web', deploy: { command: ['npm', 'run', 'deploy'] } } } } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.delivery.repos['api']?.deploy, { ...deploy, afterPull: [] });
    assert.deepEqual(config.delivery.repos['web']?.deploy, { targets: [], checks: [], afterPull: [], command: ['npm', 'run', 'deploy'] });
  });

  it('reads a deploy’s dependency install, and leaves out one that is not a program with its arguments', () => {
    const install = ['npm', 'ci', '--ignore-scripts'];
    const { config, issues } = parseConfig({
      ...ROSTER,
      delivery: { repos: { api: { mainCheckout: 'C:/src/api', deploy: { dependencyInstall: install, command: ['node', 'deploy.js'] } }, web: { mainCheckout: 'C:/src/web', deploy: { dependencyInstall: 'npm ci', command: ['node', 'deploy.js'] } } } },
    });
    assert.deepEqual(paths(issues), ['delivery.repos.web.deploy.dependencyInstall']);
    assert.deepEqual(config.delivery.repos['api']?.deploy?.dependencyInstall, install);
    assert.deepEqual(config.delivery.repos['web']?.deploy, { targets: [], checks: [], afterPull: [], command: ['node', 'deploy.js'] });
  });

  it('leaves out a deploy with no command, and a check or hook that is not a program with its arguments', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      delivery: {
        checkTimeoutSeconds: 0,
        freezes: { maxMinutes: 1441 },
        repos: {
          api: { mainCheckout: 'C:/src/api', deploy: { targets: ['cloud-api'] } },
          web: {
            mainCheckout: 'C:/src/web',
            deploy: { checks: [{ name: 'Flow', command: ['node', 'flow.js'] }, { name: 'load', command: [] }, 'node load.js'], afterPull: [['npm', ''], 'npm ci'], command: ['node', 'deploy.js'] },
          },
        },
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'delivery.checkTimeoutSeconds',
      'delivery.freezes.maxMinutes',
      'delivery.repos.api.deploy.command',
      'delivery.repos.web.deploy.afterPull[0][1]',
      'delivery.repos.web.deploy.afterPull[1]',
      'delivery.repos.web.deploy.checks[0].name',
      'delivery.repos.web.deploy.checks[1].command',
      'delivery.repos.web.deploy.checks[2]',
    ]);
    assert.equal(config.delivery.repos['api']?.deploy, undefined);
    assert.deepEqual(config.delivery.repos['web']?.deploy, { targets: [], checks: [], afterPull: [], command: ['node', 'deploy.js'] });
    assert.equal(config.delivery.checkTimeoutSeconds, 20);
    assert.equal(config.delivery.freezes.maxMinutes, 120);
  });

  it('reads a settle time for each target a repository deploys, and reports the rest', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      delivery: {
        stablePeriods: { settleMinutes: 1441, minMinutes: 0, targetSettleMinutes: { 'cloud-api': 10, workers: 45, Bad: 5, 'cloud-web': -1 } },
        repos: { api: { mainCheckout: 'C:/src/api', deploysOnPush: ['cloud-api', 'cloud-web'] } },
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'delivery.stablePeriods.minMinutes',
      'delivery.stablePeriods.settleMinutes',
      'delivery.stablePeriods.targetSettleMinutes.Bad',
      'delivery.stablePeriods.targetSettleMinutes.cloud-web',
      'delivery.stablePeriods.targetSettleMinutes.workers',
    ]);
    assert.deepEqual(config.delivery.stablePeriods, { settleMinutes: 30, targetSettleMinutes: { 'cloud-api': 10 }, assumedDeployMinutes: 20, minMinutes: 15 });
  });

  it('leaves out a repository with no main checkout or a bad name, and reports a bad target, blackout or deploy wait', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      delivery: {
        schedule: { resetBlackoutHours: 0 },
        wait: { maxMinutes: 1441 },
        repos: { api: { deploysOnPush: ['cloud-api'] }, 'My Repo': { mainCheckout: '/src/x' }, web: 'C:/src/web', ok: { mainCheckout: '/src/ok', deploysOnPush: ['Cloud API'] } },
      },
    });
    assert.deepEqual(paths(issues).sort(), [
      'delivery.repos.My Repo',
      'delivery.repos.api.mainCheckout',
      'delivery.repos.ok.deploysOnPush[0]',
      'delivery.repos.web',
      'delivery.schedule.resetBlackoutHours',
      'delivery.wait.maxMinutes',
    ]);
    assert.deepEqual(config.delivery.repos, { ok: { mainCheckout: '/src/ok', deploysOnPush: [], dependencyGate: false, reviewGate: false, decisionRecordGate: false, updateMainCheckout: false } });
    assert.deepEqual(config.delivery.schedule, {});
    assert.equal(config.delivery.wait.maxMinutes, 60);
  });

  it('reports an empty delivery folder or lock path, limits out of range and an unknown admission word', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      delivery: { dir: ' ', queue: { lockPath: '', lockTtlMinutes: 5, waitMinutes: -1, memorySampleSeconds: 601, memoryFloorMb: -1, smallReserveMb: 1_048_577, heavyReserveMb: -1, admission: 'fifo', agingMinutes: 1441, perSessionRunning: -1, maxHeavyParallel: 0 }, wait: { pollSeconds: 0 } },
    });
    assert.deepEqual(paths(issues).sort(), [
      'delivery.dir',
      'delivery.queue.admission',
      'delivery.queue.agingMinutes',
      'delivery.queue.heavyReserveMb',
      'delivery.queue.lockPath',
      'delivery.queue.lockTtlMinutes',
      'delivery.queue.maxHeavyParallel',
      'delivery.queue.memoryFloorMb',
      'delivery.queue.memorySampleSeconds',
      'delivery.queue.perSessionRunning',
      'delivery.queue.smallReserveMb',
      'delivery.queue.waitMinutes',
      'delivery.wait.pollSeconds',
    ]);
    assert.equal(issues.find((issue) => issue.path === 'delivery.queue.admission')?.message, 'expected one of pipeline, serial (got "fifo")');
    assert.deepEqual(config.delivery, {
      schedule: {},
      queue: { lockTtlMinutes: 150, maxRunMinutes: 45, smallMaxRunMinutes: 10, waitMinutes: 60, memorySampleSeconds: 15, memoryFloorMb: 4096, smallReserveMb: 2048, heavyReserveMb: 2048, admission: 'pipeline', agingMinutes: 15, perSessionRunning: 2, maxHeavyParallel: 2 },
      wait: { pollSeconds: 30, maxMinutes: 60 },
      checkTimeoutSeconds: 20,
      freezes: { maxMinutes: 120 },
      stablePeriods: { settleMinutes: 30, targetSettleMinutes: {}, assumedDeployMinutes: 20, minMinutes: 15 },
      repos: {},
    });
  });

  it("reads the no-progress span in days, and falls back to the default past a compaction's retention, below 0 or for a fraction", () => {
    for (const goalProgressDays of [8, -1, 1.5]) {
      const { config, issues } = parseConfig({ ...ROSTER, register: { check: { goalProgressDays } } });
      assert.deepEqual(paths(issues), ['register.check.goalProgressDays'], String(goalProgressDays));
      assert.equal(config.register.check.goalProgressDays, 1);
    }
    assert.equal(parseConfig({ ...ROSTER, register: { check: { goalProgressDays: 0 } } }).config.register.check.goalProgressDays, 0);
  });

  it('reads the over-size multiple as a number from 0 to 10, and falls back to 2 outside it', () => {
    for (const overSizeMultiple of [11, -0.5]) {
      const { config, issues } = parseConfig({ ...ROSTER, register: { check: { overSizeMultiple } } });
      assert.deepEqual(paths(issues), ['register.check.overSizeMultiple'], String(overSizeMultiple));
      assert.equal(config.register.check.overSizeMultiple, 2);
    }
    assert.equal(parseConfig({ ...ROSTER, register: { check: { overSizeMultiple: 0 } } }).config.register.check.overSizeMultiple, 0);
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

  it('names each version-4 deploy key in a current file with its new name, and reads none of them', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      configVersion: CONFIG_VERSION,
      delivery: {
        gateTimeoutSeconds: 45,
        stablePeriods: { assumedRollMinutes: 5 },
        repos: {
          api: { mainCheckout: 'C:/src/api', roll: { command: ['node', 'deploy.js'] } },
          web: { mainCheckout: 'C:/src/web', deploy: { gates: [{ name: 'flow', command: ['node', 'flow.js'] }], command: ['node', 'deploy.js'] } },
        },
      },
    });
    assert.deepEqual(issues, [
      { path: 'delivery.gateTimeoutSeconds', message: 'was renamed: use delivery.checkTimeoutSeconds' },
      { path: 'delivery.repos.api.roll', message: 'was renamed: use delivery.repos.api.deploy' },
      { path: 'delivery.repos.web.deploy.gates', message: 'was renamed: use delivery.repos.web.deploy.checks' },
      { path: 'delivery.stablePeriods.assumedRollMinutes', message: 'was renamed: use delivery.stablePeriods.assumedDeployMinutes' },
    ]);
    assert.equal(config.delivery.repos['api']?.deploy, undefined);
    assert.deepEqual(config.delivery.repos['web']?.deploy?.checks, []);
    assert.equal(config.delivery.checkTimeoutSeconds, DEFAULT_CHECK_TIMEOUT_SECONDS);
    assert.equal(config.delivery.stablePeriods.assumedDeployMinutes, DEFAULT_STABLE_PERIODS.assumedDeployMinutes);
  });

  it('names each version-5 delivery key in a current file with its new name, and reads none of them', () => {
    const { config, issues } = parseConfig({
      sessions: ['alpha', 'bravo'],
      roles: { lead: 'alpha', coordinatorOwner: 'bravo' },
      configVersion: CONFIG_VERSION,
      coordinator: { dir: 'data/old-deploys' },
      delivery: {
        schedule: { heavyCutoffUtc: '22:30' },
        heavy: { maxRunMinutes: 30 },
        claims: { maxMinutes: 60 },
        windows: { settleMinutes: 10 },
        repos: { api: { mainCheckout: 'C:/src/api', followMainCheckout: true } },
      },
    });
    assert.deepEqual(issues, [
      { path: 'roles.coordinatorOwner', message: 'was renamed: use roles.deliveryOwner' },
      { path: 'coordinator', message: 'was renamed: use delivery' },
      { path: 'delivery.heavy', message: 'was renamed: use delivery.queue' },
      { path: 'delivery.claims', message: 'was renamed: use delivery.freezes' },
      { path: 'delivery.windows', message: 'was renamed: use delivery.stablePeriods' },
      { path: 'delivery.schedule.heavyCutoffUtc', message: 'was renamed: use delivery.schedule.queueCutoffUtc' },
      { path: 'delivery.repos.api.followMainCheckout', message: 'was renamed: use delivery.repos.api.updateMainCheckout' },
    ]);
    assert.equal(config.roles.deliveryOwner, undefined);
    assert.equal(config.delivery.dir, undefined);
    assert.deepEqual(config.delivery.schedule, {});
    assert.deepEqual(config.delivery.queue, DEFAULT_QUEUE);
    assert.deepEqual(config.delivery.freezes, DEFAULT_FREEZES);
    assert.deepEqual(config.delivery.stablePeriods, DEFAULT_STABLE_PERIODS);
    assert.equal(config.delivery.repos['api']?.updateMainCheckout, false);
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

  it('keeps a problem hint pattern, and reports a bad one and keeps the default', () => {
    const kept = parseConfig({ ...ROSTER, register: { review: { hintPattern: '\\boutage\\b' } } });
    assert.deepEqual(kept.issues, []);
    assert.equal(kept.config.register.review.hintPattern, '\\boutage\\b');
    const bad = parseConfig({ ...ROSTER, register: { review: { hintPattern: '(fix' } } });
    assert.deepEqual(paths(bad.issues), ['register.review.hintPattern']);
    assert.equal(bad.config.register.review.hintPattern, DEFAULT_REGISTER.review.hintPattern);
  });

  it('asks a problem review on verifying and done by default, refusing, with no critical owners', () => {
    const { config, issues } = parseConfig(ROSTER);
    assert.deepEqual(issues, []);
    assert.deepEqual(config.register.review, { ...DEFAULT_REGISTER.review, mode: 'refuse', requireOn: ['verifying', 'done'], criticalOwners: [] });
  });

  it("keeps a team's review mode, statuses and critical owners", () => {
    const { config, issues } = parseConfig({ ...ROSTER, register: { review: { mode: 'warn', requireOn: ['done'], criticalOwners: ['security', 'data'] } } });
    assert.deepEqual(issues, []);
    assert.equal(config.register.review.mode, 'warn');
    assert.deepEqual(config.register.review.requireOn, ['done']);
    assert.deepEqual(config.register.review.criticalOwners, ['security', 'data']);
  });

  it('reports a bad review mode, a status a review is never asked at and a bad session name, keeping the rest', () => {
    const { config, issues } = parseConfig({ ...ROSTER, register: { review: { mode: 'strict', requireOn: ['verifying', 'dropped'], criticalOwners: ['security', 'Data Team'] } } });
    assert.deepEqual(paths(issues).sort(), ['register.review.criticalOwners[1]', 'register.review.mode', 'register.review.requireOn[1]']);
    assert.equal(issues.find((issue) => issue.path === 'register.review.requireOn[1]')?.message, 'expected one of verifying, done, got "dropped"');
    assert.equal(config.register.review.mode, 'refuse');
    assert.deepEqual(config.register.review.requireOn, ['verifying']);
    assert.deepEqual(config.register.review.criticalOwners, ['security']);
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
    const set = parseConfig({ ...ROSTER, register: { requireProofOnVerifying: false, verifyGate: 'warn', maxVerifying: 0, maxReparks: 0 } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(
      [set.config.register.requireProofOnVerifying, set.config.register.verifyGate, set.config.register.maxVerifying, set.config.register.maxReparks],
      [false, 'warn', 0, 0],
    );
    const { config, issues } = parseConfig({ ...ROSTER, register: { requireProofOnVerifying: 'yes', verifyGate: 'block', maxVerifying: 101, maxReparks: 21 } });
    assert.deepEqual(paths(issues).sort(), ['register.maxReparks', 'register.maxVerifying', 'register.requireProofOnVerifying', 'register.verifyGate']);
    assert.match(issues.find((issue) => issue.path === 'register.verifyGate')?.message ?? '', /refuse, warn/);
    assert.deepEqual(
      [config.register.requireProofOnVerifying, config.register.verifyGate, config.register.maxVerifying, config.register.maxReparks],
      [true, 'refuse', 5, 2],
    );
  });

  it('reads the goals mode, free when absent, and falls back to free on a wrong one', () => {
    assert.equal(parseConfig({ ...ROSTER }).config.register.goals, 'free');
    const set = parseConfig({ ...ROSTER, register: { goals: 'required' } });
    assert.deepEqual([set.issues, set.config.register.goals], [[], 'required']);
    const { config, issues } = parseConfig({ ...ROSTER, register: { goals: 'strict' } });
    assert.deepEqual(paths(issues), ['register.goals']);
    assert.match(issues[0]?.message ?? '', /free, checked, required/);
    assert.equal(config.register.goals, 'free');
  });

  it('falls back to the default count of self-made tasks past its limit', () => {
    const { config, issues } = parseConfig({ ...ROSTER, register: { check: { maxSelfMadePerDay: 201 } } });
    assert.deepEqual(paths(issues), ['register.check.maxSelfMadePerDay']);
    assert.equal(config.register.check.maxSelfMadePerDay, 10);
  });

  it('reads the commits rule, refusing a bad gate, trailer key, bound or pattern', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      commits: { maxLines: 10, maxFiles: 20, largeCommitTrailer: 'Large commit', testPatterns: ['^fixtures/', '(('], sourcePatterns: ['^lib/', '['], gate: 'block' },
    });
    assert.deepEqual(paths(issues).sort(), ['commits.gate', 'commits.largeCommitTrailer', 'commits.maxLines', 'commits.sourcePatterns[1]', 'commits.testPatterns[1]']);
    assert.deepEqual(config.commits, { ...DEFAULT_COMMITS, maxFiles: 20, testPatterns: ['^fixtures/'], sourcePatterns: ['^lib/'] });
    const refuse = parseConfig({ ...ROSTER, commits: { gate: 'refuse', largeCommitTrailer: 'Big-change' } }).config.commits;
    assert.deepEqual([refuse.gate, refuse.largeCommitTrailer], ['refuse', 'Big-change']);
  });

  it('reads what a normal push to a protected branch does, defaulting to ask and refusing another word', () => {
    assert.equal(parseConfig(ROSTER).config.pushGuard.pushToProtected, 'ask');
    for (const choice of ['ask', 'allow', 'lead', 'gated']) {
      const set = parseConfig({ ...ROSTER, pushGuard: { pushToProtected: choice } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.pushGuard.pushToProtected, choice);
    }
    const bad = parseConfig({ ...ROSTER, pushGuard: { protectedBranches: ['release'], pushToProtected: 'always' } });
    assert.deepEqual(paths(bad.issues), ['pushGuard.pushToProtected']);
    assert.match(bad.issues[0]?.message ?? '', /ask, allow, lead, gated/);
    assert.deepEqual(bad.config.pushGuard, { protectedBranches: ['release'], pushToProtected: 'ask', reviewPaths: [] });
  });

  it('reads the review paths, defaulting mode and class and leaving out an entry with no glob', () => {
    assert.deepEqual(parseConfig(ROSTER).config.pushGuard.reviewPaths, []);
    const { config, issues } = parseConfig({
      ...ROSTER,
      pushGuard: {
        reviewPaths: [
          { glob: 'k8s/**', mode: 'check', class: 'leader' },
          { glob: 'src/auth/**' },
          { glob: 'Makefile', mode: 'sometimes', class: 'owner' },
          { mode: 'check' },
          { glob: '' },
          { glob: 'g'.repeat(201) },
          { glob: 'two\nlines' },
          'Makefile',
        ],
      },
    });
    assert.deepEqual(paths(issues), [
      'pushGuard.reviewPaths[2].mode',
      'pushGuard.reviewPaths[2].class',
      'pushGuard.reviewPaths[3].glob',
      'pushGuard.reviewPaths[4].glob',
      'pushGuard.reviewPaths[5].glob',
      'pushGuard.reviewPaths[6].glob',
      'pushGuard.reviewPaths[7]',
    ]);
    assert.match(issues[0]?.message ?? '', /always, check/);
    assert.match(issues[1]?.message ?? '', /security, leader/);
    assert.equal(issues[2]?.message, 'is required');
    assert.deepEqual(config.pushGuard.reviewPaths, [
      { glob: 'k8s/**', mode: 'check', class: 'leader' },
      { glob: 'src/auth/**', mode: 'always', class: 'security' },
      { glob: 'Makefile', mode: 'always', class: 'security' },
    ]);
    const many = parseConfig({ ...ROSTER, pushGuard: { reviewPaths: Array.from({ length: 129 }, (_, index) => ({ glob: `dir-${index}/**` })) } });
    assert.deepEqual(paths(many.issues), ['pushGuard.reviewPaths']);
    assert.deepEqual(many.config.pushGuard.reviewPaths, []);
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

  it('reads whether a sanctioned route runs before any permission check, defaulting to on and refusing another word', () => {
    assert.equal(parseConfig(ROSTER).config.prompts.routeAllow, 'on');
    for (const choice of ['on', 'off']) {
      const set = parseConfig({ ...ROSTER, prompts: { routeAllow: choice } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.prompts.routeAllow, choice);
    }
    const bad = parseConfig({ ...ROSTER, prompts: { hookAsks: 'refuse', routeAllow: true } });
    assert.deepEqual(paths(bad.issues), ['prompts.routeAllow']);
    assert.deepEqual(bad.config.prompts, { hookAsks: 'refuse', routeAllow: 'on' });
  });

  it('reads the db-write guard, asking by default with no program, client or script of the team', () => {
    assert.deepEqual(parseConfig(ROSTER).config.dbWriteGuard, { writes: 'ask', entrypoints: [], programs: [], nodeClients: [], clientReceivers: [] });
    const own = {
      entrypoints: [{ path: 'scripts/backfill.ts', applyFlags: ['--apply', '-y'] }],
      programs: [
        { name: 'docsh', reads: 'document-shell' },
        { name: 'kvcli', reads: 'key-value-cli' },
        { name: 'pgx', reads: 'sql-command' },
        { name: 'my-sql.exe', reads: 'sql-execute' },
        { name: 'lite3', reads: 'sql-database-file' },
      ],
      nodeClients: [
        { module: 'docstore', vocabulary: 'document' },
        { module: '@scope/kvstore', vocabulary: 'key-value' },
      ],
      clientReceivers: ['cache', '$kv'],
    };
    for (const writes of ['deny', 'ask', 'allow']) {
      const set = parseConfig({ ...ROSTER, dbWriteGuard: { ...own, writes } });
      assert.deepEqual(set.issues, []);
      assert.deepEqual(set.config.dbWriteGuard, { ...own, writes });
    }
  });

  it('drops each broken db-write guard entry with its issue and keeps the rest', () => {
    const kept = { path: 'scripts/backfill.ts', applyFlags: ['--apply'] };
    const program = { name: 'docsh', reads: 'document-shell' };
    const client = { module: 'docstore', vocabulary: 'document' };
    const bad = parseConfig({
      ...ROSTER,
      dbWriteGuard: {
        writes: 'never',
        entrypoints: [kept, { path: 'scripts/fix.ts' }, { path: 'scripts/trim.ts', applyFlags: [] }, { path: 'scripts/move.ts', applyFlags: ['apply'] }, 'scripts/raw.ts'],
        programs: [program, { name: 'bin/docsh', reads: 'document-shell' }, { name: 'kvcli', reads: 'key-value' }, { reads: 'sql-command' }],
        nodeClients: [client, { module: 'Docstore', vocabulary: 'document' }, { module: 'kvstore', vocabulary: 'kv' }],
        clientReceivers: ['cache', 'a.b', 'x'.repeat(41)],
      },
    });
    assert.deepEqual(paths(bad.issues), [
      'dbWriteGuard.writes',
      'dbWriteGuard.entrypoints[1].applyFlags',
      'dbWriteGuard.entrypoints[2].applyFlags',
      'dbWriteGuard.entrypoints[3].applyFlags[0]',
      'dbWriteGuard.entrypoints[4]',
      'dbWriteGuard.programs[1].name',
      'dbWriteGuard.programs[2].reads',
      'dbWriteGuard.programs[3].name',
      'dbWriteGuard.nodeClients[1].module',
      'dbWriteGuard.nodeClients[2].vocabulary',
      'dbWriteGuard.clientReceivers[1]',
      'dbWriteGuard.clientReceivers[2]',
    ]);
    assert.match(bad.issues[0]?.message ?? '', /deny, ask, allow/);
    assert.deepEqual(bad.config.dbWriteGuard, { writes: 'ask', entrypoints: [kept], programs: [program], nodeClients: [client], clientReceivers: ['cache'] });
  });

  it('reads the secret guard, refusing with the default secrets alone and redacting unless the team says otherwise', () => {
    const none = { secretReads: 'deny', writes: 'deny', paths: [], envNames: [], commands: [], redact: true };
    assert.deepEqual(parseConfig(ROSTER).config.secretGuard, none);
    const own = {
      secretReads: 'ask',
      writes: 'allow',
      paths: ['k8s/secrets/*.yaml', '!**/fixtures/*.pem'],
      envNames: ['^STRIPE_', '!^GIT_AUTHOR'],
      commands: ['^vault\\s+read\\s', '!--minify'],
      redact: false,
    };
    const set = parseConfig({ ...ROSTER, secretGuard: own });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.secretGuard, own);
    const bad = parseConfig({ ...ROSTER, secretGuard: { secretReads: 'never', writes: 'off', paths: ['!'], envNames: ['(', '!'], commands: ['!', '[', 'x'.repeat(201)], redact: 'off' } });
    assert.deepEqual(paths(bad.issues), [
      'secretGuard.secretReads',
      'secretGuard.writes',
      'secretGuard.paths[0]',
      'secretGuard.envNames[0]',
      'secretGuard.envNames[1]',
      'secretGuard.commands[0]',
      'secretGuard.commands[1]',
      'secretGuard.commands[2]',
      'secretGuard.redact',
    ]);
    assert.match(bad.issues.find(({ path }) => path === 'secretGuard.commands[0]')?.message ?? '', /leading ! to let a command print/);
    assert.deepEqual(bad.config.secretGuard, none);
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

  it("keeps security's read-only allow rules by default, and a team's own list instead when set", () => {
    const seeded = parseConfig(ROSTER).config.permissions.keepAllow;
    assert.deepEqual(seeded, DEFAULT_PERMISSIONS.keepAllow);
    assert.ok(seeded.includes('Bash(kubectl get *)') && seeded.includes('PowerShell(Get-Date *)') && seeded.includes('WebSearch'));
    const keepAllow = ['Bash(kubectl get *)', 'Bash(git log:*)', 'Bash(MSYS_NO_PATHCONV=1 kubectl logs *)', 'WebSearch', 'mcp__docs__read'];
    const set = parseConfig({ ...ROSTER, permissions: { keepAllow } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.permissions, { keepAllow });
  });

  it('drops a kept allow rule with a * before its end, a path, a URL or a parenthesis, and refuses too many', () => {
    const written = ['Bash(*)', 'Bash(rg * --files)', 'Read(//c/Users/me/**)', 'Bash(curl https://x)', 'Bash(dir C:\\x)', 'Bash((x))', 'Bash(a\nb)', 'Bash', 'Bash(git log *)'];
    const bad = parseConfig({ ...ROSTER, permissions: { keepAllow: written } });
    assert.deepEqual(paths(bad.issues), written.slice(0, 7).map((_, index) => `permissions.keepAllow[${index}]`));
    assert.match(bad.issues[0]?.message ?? '', /no other \*, path, URL or parenthesis/);
    assert.deepEqual(bad.config.permissions.keepAllow, ['Bash', 'Bash(git log *)']);
    const many = parseConfig({ ...ROSTER, permissions: { keepAllow: Array.from({ length: 65 }, (_, index) => `Bash(tool${index})`) } });
    assert.deepEqual(paths(many.issues), ['permissions.keepAllow']);
    assert.deepEqual(many.config.permissions.keepAllow, DEFAULT_PERMISSIONS.keepAllow);
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
      handoverMaxBytes: 0,
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
        handoverMaxBytes: -1,
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
      'refresh.handoverMaxBytes',
      'refresh.holdAfterActivityMinutes',
      'refresh.restartDelaySeconds',
      'refresh.tabTitle',
    ]);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { restartDelaySeconds: 601 } }).issues), ['refresh.restartDelaySeconds']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { countdownSeconds: 121 } }).issues), ['refresh.countdownSeconds']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { endCommand: ['node', ''] } }).issues), ['refresh.endCommand[1]']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { everyTasks: -1 } }).issues), ['refresh.everyTasks']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { handoverMaxBytes: 1_000_001 } }).issues), ['refresh.handoverMaxBytes']);
    assert.deepEqual(bad.config.refresh, DEFAULT_REFRESH);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, refresh: { contextTokens: 10_000_001 } }).issues), ['refresh.contextTokens']);
  });

  it('reads the hiring settings, defaulting each and refusing a bad policy or scale-out measure', () => {
    assert.deepEqual(parseConfig(ROSTER).config.hiring, DEFAULT_HIRING);
    const scaleOut = { windowDays: 5, minDone: 2, topPriorities: 1 };
    const chosen = { policy: 'lead', reviewDays: 14, resumeMaxTokens: 120_000, resumeMaxIdleDays: 3, scaleOut };
    const set = parseConfig({ ...ROSTER, hiring: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.hiring, chosen);
    const badScaleOut = { windowDays: 9, minDone: 0, topPriorities: 11 };
    const bad = parseConfig({
      ...ROSTER,
      hiring: { policy: 'auto', reviewDays: 91, resumeMaxTokens: 9_999, resumeMaxIdleDays: 91, scaleOut: badScaleOut },
    });
    assert.deepEqual(paths(bad.issues).sort(), [
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
    issues.forEach((issue) => assert.match(issue.message, /^is no longer read: a hire's daily budget is its part of the team's, by its share and queued work; delete it$/));
    assert.deepEqual(config.hiring, DEFAULT_HIRING);
  });

  it('flags a hire cap a current-format file still holds, as no cap counts hires', () => {
    const { config, issues } = parseConfig({ ...ROSTER, hiring: { maxSessions: 4, capRaisedBy: 'lead' } });
    assert.deepEqual(paths(issues), ['hiring.maxSessions', 'hiring.capRaisedBy']);
    issues.forEach((issue) => assert.equal(issue.message, `is no longer read: ${HIRE_CAP_DROPPED}; delete it`));
    assert.deepEqual(config.hiring, DEFAULT_HIRING);
  });

  it('flags hiring.idleHours a current-format file still holds, as no hire retires for being idle', () => {
    const { config, issues } = parseConfig({ ...ROSTER, hiring: { idleHours: 4 } });
    assert.deepEqual(paths(issues), ['hiring.idleHours']);
    assert.equal(issues[0]?.message, `is no longer read: ${IDLE_RETIRE_DROPPED}; delete it`);
    assert.deepEqual(config.hiring, DEFAULT_HIRING);
  });

  it('reads the terminal teamrig open uses and the room it needs, refusing a terminal it does not know or a bad size', () => {
    assert.deepEqual(parseConfig(ROSTER).config.open, DEFAULT_OPEN);
    assert.deepEqual([DEFAULT_OPEN.headroom.floorMb, DEFAULT_OPEN.headroom.loadMinutes], [undefined, 5], 'a tab floor unset is the queue floor plus a heavy reserve; a tab holds its MB 5 minutes');
    const chosen = { terminal: 'tmux', teamWindow: true, headroom: { sessionMb: 900, commitMaxPct: 95, closeIdleMinutes: 120, floorMb: 3000, loadMinutes: 8 } };
    const set = parseConfig({ ...ROSTER, open: chosen });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.open, { ...chosen, idle: DEFAULT_IDLE });
    const bad = parseConfig({ ...ROSTER, open: { terminal: 'iterm', teamWindow: 'yes', headroom: { sessionMb: 99, commitMaxPct: 101, closeIdleMinutes: 5, floorMb: -1, loadMinutes: 0 } } });
    assert.deepEqual(paths(bad.issues).sort(), ['open.headroom.closeIdleMinutes', 'open.headroom.commitMaxPct', 'open.headroom.floorMb', 'open.headroom.loadMinutes', 'open.headroom.sessionMb', 'open.teamWindow', 'open.terminal']);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, open: { headroom: { floorMb: '4096', loadMinutes: 61 } } }).issues).sort(), ['open.headroom.floorMb', 'open.headroom.loadMinutes']);
    assert.match(bad.issues.find((issue) => issue.path === 'open.terminal')?.message ?? '', /expected one of auto, tmux, windows-terminal/);
    assert.deepEqual(bad.config.open, DEFAULT_OPEN);
    assert.deepEqual(paths(parseConfig({ ...ROSTER, open: { headroom: 5 } }).issues), ['open.headroom']);
  });

  it('reads whether the idle pass runs and the sessions it keeps open, refusing a mode it does not know or a session not on the team', () => {
    // A team that sets nothing closes and reopens its idle sessions (T1409).
    assert.deepEqual(parseConfig(ROSTER).config.open.idle, { mode: 'on', keepOpen: [] });
    const set = parseConfig({ ...ROSTER, open: { idle: { mode: 'dry-run', keepOpen: ['bravo'] } } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.open.idle, { mode: 'dry-run', keepOpen: ['bravo'] });
    assert.deepEqual(parseConfig({ ...ROSTER, open: { idle: { mode: 'on' } } }).config.open.idle, { mode: 'on', keepOpen: [] });
    const bad = parseConfig({ ...ROSTER, open: { idle: { mode: 'always', keepOpen: ['bravo', 'charlie', 7] } } });
    assert.deepEqual(paths(bad.issues).sort(), ['open.idle.keepOpen[1]', 'open.idle.keepOpen[2]', 'open.idle.mode']);
    assert.match(bad.issues.find((issue) => issue.path === 'open.idle.mode')?.message ?? '', /expected one of off, dry-run, on/);
    assert.match(bad.issues.find((issue) => issue.path === 'open.idle.keepOpen[1]')?.message ?? '', /"charlie" is not one of the sessions/);
    assert.deepEqual(bad.config.open.idle, { mode: 'on', keepOpen: ['bravo'] });
    assert.deepEqual(paths(parseConfig({ ...ROSTER, open: { idle: { keepOpen: 'bravo' } } }).issues), ['open.idle.keepOpen']);
  });

  it('reads how a session lists the skills of other areas, name-only unless set, refusing a listing it does not know', () => {
    assert.equal(parseConfig(ROSTER).config.skills.otherAreas, 'name-only');
    for (const listing of ['on', 'user-invocable-only', 'off'] as const) {
      const set = parseConfig({ ...ROSTER, skills: { otherAreas: listing } });
      assert.deepEqual(set.issues, []);
      assert.equal(set.config.skills.otherAreas, listing);
    }
    const bad = parseConfig({ ...ROSTER, skills: { otherAreas: 'hidden' } });
    assert.deepEqual(paths(bad.issues), ['skills.otherAreas']);
    assert.match(bad.issues[0]?.message ?? '', /expected one of on, name-only, user-invocable-only, off/);
    assert.equal(bad.config.skills.otherAreas, 'name-only');
  });

  it('reads what the status line shows, each part on unless turned off, refusing a value that is not true or false', () => {
    assert.deepEqual(parseConfig(ROSTER).config.statusLine, DEFAULT_STATUS_LINE);
    const set = parseConfig({ ...ROSTER, statusLine: { pace: false } });
    assert.deepEqual(set.issues, []);
    assert.deepEqual(set.config.statusLine, { folder: true, branch: true, pace: false });
    const bad = parseConfig({ ...ROSTER, statusLine: { branch: 'no' } });
    assert.deepEqual(paths(bad.issues), ['statusLine.branch']);
    assert.deepEqual(bad.config.statusLine, DEFAULT_STATUS_LINE);
  });

  it('reads the focus block, each key at its default when absent', () => {
    assert.deepEqual(parseConfig(ROSTER).config.focus, DEFAULT_FOCUS);
    const set = parseConfig({
      ...ROSTER,
      focus: {
        classes: ['Product', 'Upkeep', 'Tooling'],
        roadmapClass: 'Product',
        maintenanceClass: 'Upkeep',
        defaultClass: 'Tooling',
        allocation: { Product: 70, Upkeep: 20, Tooling: 10 },
        score: { rankValues: [30, 10], minSizePct: 0.1 },
        wip: { mode: 'warn', maxInProgress: 2 },
        expedite: { ownerP1: false },
        parkAfterDays: 7,
        improvementsDay: 'mon',
        slicesPerSession: 2,
        maxOwnerDecisions: 8,
      },
    });
    assert.deepEqual(set.issues, []);
    const { focus } = set.config;
    assert.equal(focus.improvementsDay, 'mon');
    assert.equal(focus.slicesPerSession, 2);
    assert.equal(focus.maxOwnerDecisions, 8);
    assert.deepEqual([focus.classes, focus.roadmapClass, focus.maintenanceClass, focus.defaultClass], [['Product', 'Upkeep', 'Tooling'], 'Product', 'Upkeep', 'Tooling']);
    assert.deepEqual(focus.allocation, { Product: 70, Upkeep: 20, Tooling: 10 });
    assert.deepEqual([focus.score.rankValues, focus.score.minSizePct, focus.score.maintenanceValue], [[30, 10], 0.1, DEFAULT_FOCUS.score.maintenanceValue]);
    assert.deepEqual([focus.wip, focus.expedite, focus.parkAfterDays], [{ mode: 'warn', maxInProgress: 2 }, { critical: true, ownerP1: false }, 7]);
  });

  it('refuses each bad focus value, which takes its default', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ classes: [] }, 'focus.classes'],
      [{ classes: ['Roadmap', 'Roadmap'] }, 'focus.classes'],
      [{ classes: ['9lives'] }, 'focus.classes[0]'],
      [{ maxActiveKeyResults: 0 }, 'focus.maxActiveKeyResults'],
      [{ slicesPerSession: 0 }, 'focus.slicesPerSession'],
      [{ slicesPerSession: 6 }, 'focus.slicesPerSession'],
      [{ slicesPerSession: 1.5 }, 'focus.slicesPerSession'],
      [{ maxOwnerDecisions: 0 }, 'focus.maxOwnerDecisions'],
      [{ maxOwnerDecisions: 21 }, 'focus.maxOwnerDecisions'],
      [{ maxOwnerDecisions: 2.5 }, 'focus.maxOwnerDecisions'],
      [{ score: { rankValues: [20, -1] } }, 'focus.score.rankValues[1]'],
      [{ score: { ownerOrderValues: [] } }, 'focus.score.ownerOrderValues'],
      [{ score: { dueSoonDays: 61 } }, 'focus.score.dueSoonDays'],
      [{ score: { unblocksShare: 11 } }, 'focus.score.unblocksShare'],
      [{ score: { minSizePct: 0 } }, 'focus.score.minSizePct'],
      [{ wip: { mode: 'ask' } }, 'focus.wip.mode'],
      [{ wip: { maxInProgress: 51 } }, 'focus.wip.maxInProgress'],
      [{ expedite: { critical: 'yes' } }, 'focus.expedite.critical'],
      [{ allocation: { Roadmap: 101 } }, 'focus.allocation.Roadmap'],
      [{ leaderWaitMinutes: -1 }, 'focus.leaderWaitMinutes'],
      [{ parkAfterDays: 0 }, 'focus.parkAfterDays'],
      [{ plannedTargetPct: 101 }, 'focus.plannedTargetPct'],
      [{ improvementsDay: 'someday' }, 'focus.improvementsDay'],
    ];
    for (const [focus, path] of cases) {
      const bad = parseConfig({ ...ROSTER, focus });
      assert.ok(paths(bad.issues).includes(path), `${JSON.stringify(focus)}: ${JSON.stringify(paths(bad.issues))}`);
    }
    assert.deepEqual(parseConfig({ ...ROSTER, focus: { score: { rankValues: [20, -1] } } }).config.focus.score.rankValues, DEFAULT_FOCUS.score.rankValues);
  });

  it('flags the cap across the tree it no longer reads, and keeps one slice per session (T2215)', () => {
    const { config, issues } = parseConfig({ ...ROSTER, focus: { maxOpenSlices: 3 } });
    assert.deepEqual(paths(issues), ['focus.maxOpenSlices']);
    assert.match(issues[0]?.message ?? '', /^is no longer read: .*focus\.slicesPerSession open; delete it$/);
    assert.equal(config.focus.slicesPerSession, DEFAULT_FOCUS.slicesPerSession);
  });

  it('falls back to the default classes together when the classes, the roles and the allocation disagree', () => {
    const bad = parseConfig({ ...ROSTER, focus: { classes: ['Product', 'Tooling'], defaultClass: 'Tooling', allocation: { Product: 50, Tooling: 40 } } });
    assert.deepEqual(paths(bad.issues), ['focus.roadmapClass', 'focus.maintenanceClass', 'focus.allocation']);
    assert.match(bad.issues[0]?.message ?? '', /Roadmap is not one of focus\.classes \(Product, Tooling\)/);
    assert.match(bad.issues[2]?.message ?? '', /the shares sum to 90, not 100/);
    const { classes, roadmapClass, maintenanceClass, defaultClass, allocation } = bad.config.focus;
    assert.deepEqual({ classes, roadmapClass, maintenanceClass, defaultClass, allocation }, {
      classes: DEFAULT_FOCUS.classes,
      roadmapClass: DEFAULT_FOCUS.roadmapClass,
      maintenanceClass: DEFAULT_FOCUS.maintenanceClass,
      defaultClass: DEFAULT_FOCUS.defaultClass,
      allocation: DEFAULT_FOCUS.allocation,
    });
    const unknown = parseConfig({ ...ROSTER, focus: { allocation: { Roadmap: 60, Maintenance: 25, Tooling: 15 } } });
    assert.deepEqual(paths(unknown.issues), ['focus.allocation.Tooling']);
  });

  it('reads where the team sits in a tree, and leaves it unset in an older config', () => {
    assert.equal(parseConfig(ROSTER).config.team, undefined);
    assert.deepEqual(parseConfig({ ...ROSTER, team: { id: 'web' } }).config.team, { id: 'web' });
    const child = parseConfig({ ...ROSTER, team: { id: 'web', parent: 'app' } });
    assert.deepEqual(child.issues, []);
    assert.deepEqual(child.config.team, { id: 'web', parent: 'app' });
  });

  it("keeps the team's project folder, and refuses a relative one", () => {
    const kept = parseConfig({ ...ROSTER, team: { id: 'web', parent: 'app', project: '/srv/web' } });
    assert.deepEqual(kept.issues, []);
    for (const rooted of ['\\srv\\web', '\\\\host\\web', 'D:\\web']) {
      assert.deepEqual(parseConfig({ ...ROSTER, team: { id: 'web', project: rooted } }).issues, [], rooted);
    }
    assert.deepEqual(kept.config.team, { id: 'web', parent: 'app', project: '/srv/web' });
    const relative = parseConfig({ ...ROSTER, team: { id: 'web', project: 'web' } });
    assert.deepEqual(relative.issues, [{ path: 'team.project', message: 'expected an absolute folder path on one line (got "web")' }]);
    assert.deepEqual(relative.config.team, { id: 'web' });
    const itself = parseConfig({ ...ROSTER, team: { id: 'web', parent: 'web', project: '/srv/web' } });
    assert.deepEqual(itself.config.team, { id: 'web', project: '/srv/web' });
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
        account: 'work',
        accountLead: 'app',
        weeklyLimitW: 680_000_000,
        subagentWeight: 2.15,
        extraWPerUsd: 120_000,
        reset: { weekday: 'wed', timeUtc: '01:00' },
        resets: [{ kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00', note: 'one week cleared' }],
        targetPct: 99,
        reservePct: 1,
        shareFloorPct: 20,
        paceEndHoursBeforeReset: 2,
        sessions: { alpha: { share: 2 }, bravo: { share: 0.5 } },
        pauseByPriority: true,
        warnAtPct: [50, 100, 150],
        fiveHourWarnPct: 70,
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
      account: 'work',
      accountLead: 'app',
      weeklyLimitW: 680_000_000,
      subagentWeight: 2.15,
      extraWPerUsd: 120_000,
      reset: { weekday: 'wed', timeUtc: '01:00' },
      resets: [{ kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00', usedUtc: [], note: 'one week cleared' }],
      targetPct: 99,
      reservePct: 1,
      shareFloorPct: 20,
      paceEndHoursBeforeReset: 2,
      sessions: { alpha: { share: 2 }, bravo: { share: 0.5 } },
      pauseByPriority: true,
      warnAtPct: [50, 100, 150],
      fiveHourWarnPct: 70,
      paceTolerancePct: 1,
      overAction: 'ask-lead',
      escalate: 'session',
      quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask', paceWeight: 0.25 },
      lift: { maxStopPct: 98, reserveStopPct: 99.5 },
      statusSnapshotDir: '/srv/usage/live',
      maxBytesPerHook: 2_000_000,
    });
  });

  describe('under a team above', () => {
    /** The keys of the account's week the team above reads, all set and none the default. */
    const ABOVE: AccountBudget = {
      enabled: true,
      account: 'work',
      accountLead: 'app',
      weeklyLimitW: 680_000_000,
      subagentWeight: 2.15,
      extraWPerUsd: 120_000,
      reset: { weekday: 'wed', timeUtc: '01:00' },
      resets: [{ kind: 'fable', count: 3, expiresUtc: '2027-03-09 07:59', usedUtc: ['2026-11-12 10:00'] }],
    };

    it("takes the team above's keys of the account's week for those it leaves unset", () => {
      const { config, issues } = parseConfig({ ...ROSTER, budget: { targetPct: 90 } }, ABOVE);
      assert.deepEqual(issues, []);
      assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, ...ABOVE, targetPct: 90 });
    });

    it('keeps the keys it states, a budget turned off among them, and takes the rest from above', () => {
      const { config, issues } = parseConfig({ ...ROSTER, budget: { enabled: false, account: 'work', weeklyLimitW: 500_000_000 } }, ABOVE);
      assert.deepEqual(issues, []);
      assert.deepEqual(config.budget, { ...DEFAULT_BUDGET, ...ABOVE, enabled: false, weeklyLimitW: 500_000_000 });
    });

    it("reports a key it sets wrong and takes the team above's instead", () => {
      const { config, issues } = parseConfig({ ...ROSTER, budget: { weeklyLimitW: -1 } }, ABOVE);
      assert.deepEqual(paths(issues), ['budget.weeklyLimitW']);
      assert.equal(config.budget.weeklyLimitW, ABOVE.weeklyLimitW);
    });

    it('takes none of them when it names another account', () => {
      const own = { ...ROSTER, budget: { account: 'home' } };
      assert.deepEqual(parseConfig(own, ABOVE).config.budget, parseConfig(own).config.budget);
    });

    it("keeps its own share floor, never the team above's, and may name another main lead (T2215)", () => {
      const above: BudgetConfig = { ...DEFAULT_BUDGET, ...ABOVE, shareFloorPct: 30 };
      assert.equal(parseConfig({ ...ROSTER, budget: {} }, above).config.budget.shareFloorPct, DEFAULT_BUDGET.shareFloorPct);
      assert.equal(parseConfig({ ...ROSTER, budget: { shareFloorPct: 0 } }, above).config.budget.shareFloorPct, 0);
      assert.equal(parseConfig({ ...ROSTER, budget: { accountLead: 'web' } }, above).config.budget.accountLead, 'web');
    });
  });

  it('holds no resets beside the weekly one when the team lists none (T2450)', () => {
    assert.deepEqual(parseConfig(ROSTER).config.budget.resets, []);
  });

  it('reads reset grants with their uses, and an empty list as none (T2450)', () => {
    const grants = [
      { kind: 'fable', count: 3, expiresUtc: '2027-03-09 07:59', usedUtc: ['2026-11-12 10:00'] },
      { kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00' },
    ];
    const { config, issues } = parseConfig({ ...ROSTER, budget: { resets: grants } });
    assert.deepEqual(issues, []);
    assert.deepEqual(config.budget.resets, [grants[0], { ...grants[1], usedUtc: [] }]);
    assert.deepEqual(parseConfig({ ...ROSTER, budget: { resets: [] } }).config.budget.resets, []);
  });

  it('drops a reset grant it cannot read whole and keeps the others (T2450)', () => {
    const good = { kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00', usedUtc: [] };
    for (const [grant, path, message] of [
      [{ kind: 'opus', count: 1, expiresUtc: '2026-12-10 22:00' }, 'budget.resets[0].kind', 'expected one of fable, full (got "opus")'],
      [{ kind: 'full', expiresUtc: '2026-12-10 22:00' }, 'budget.resets[0].count', 'is required'],
      [{ kind: 'full', count: 0, expiresUtc: '2026-12-10 22:00' }, 'budget.resets[0].count', 'expected an integer from 1 to 20, got 0'],
      [{ kind: 'full', count: 1, expiresUtc: '2026-02-30 10:00' }, 'budget.resets[0].expiresUtc', 'expected a UTC time as YYYY-MM-DD HH:MM'],
      [{ kind: 'full', count: 1, expiresUtc: '2026-12-10' }, 'budget.resets[0].expiresUtc', 'expected a UTC time as YYYY-MM-DD HH:MM'],
      [{ kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00', usedUtc: ['11-12 10:00'] }, 'budget.resets[0].usedUtc[0]', 'expected a UTC time as YYYY-MM-DD HH:MM'],
      [{ kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00', usedUtc: ['2026-11-12 10:00', '2026-11-13 10:00'] }, 'budget.resets[0].usedUtc', 'lists 2 uses of a grant of 1'],
      [{ kind: 'full', count: 1, expiresUtc: '2026-12-10 22:00', note: 'two\nlines' }, 'budget.resets[0].note', undefined],
      ['full', 'budget.resets[0]', 'expected an object, got "full"'],
    ] as const) {
      const { config, issues } = parseConfig({ ...ROSTER, budget: { resets: [grant, good] } });
      assert.deepEqual(paths(issues), [path], JSON.stringify(grant));
      if (message !== undefined) {
        assert.equal(issues[0]?.message.startsWith(message), true, `${JSON.stringify(grant)}: ${issues[0]?.message ?? ''}`);
      }
      assert.deepEqual(config.budget.resets, [good], JSON.stringify(grant));
    }
  });

  it('refuses more than 20 reset grants and holds none (T2450)', () => {
    const grant = { kind: 'fable', count: 1, expiresUtc: '2027-03-09 07:59' };
    const { config, issues } = parseConfig({ ...ROSTER, budget: { resets: Array.from({ length: 21 }, () => grant) } });
    assert.deepEqual(paths(issues), ['budget.resets']);
    assert.deepEqual(config.budget.resets, []);
  });

  it('reads no main lead and the default floor when the team sets neither (T2215)', () => {
    const { budget } = parseConfig(ROSTER).config;
    assert.equal(budget.accountLead, undefined);
    assert.equal(budget.shareFloorPct, 10);
  });

  it('refuses a floor off its whole-number 0 to 50 range and a main lead that is no team id (T2215)', () => {
    for (const [budget, path] of [
      [{ shareFloorPct: -1 }, 'budget.shareFloorPct'],
      [{ shareFloorPct: 2.5 }, 'budget.shareFloorPct'],
      [{ accountLead: '' }, 'budget.accountLead'],
      [{ accountLead: 7 }, 'budget.accountLead'],
    ] as const) {
      const { config, issues } = parseConfig({ ...ROSTER, budget });
      assert.deepEqual(paths(issues), [path], JSON.stringify(budget));
      assert.equal(config.budget.shareFloorPct, DEFAULT_BUDGET.shareFloorPct);
      assert.equal(config.budget.accountLead, undefined);
    }
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

  it('warns at 80% of the five-hour window unless told, and refuses a mark outside 1 to 100', () => {
    assert.equal(parseConfig(ROSTER).config.budget.fiveHourWarnPct, 80);
    for (const [bad, got] of [[0, '0'], [101, '101'], ['high', '"high"']] as const) {
      const { config, issues } = parseConfig({ ...ROSTER, budget: { fiveHourWarnPct: bad } });
      assert.deepEqual(paths(issues), ['budget.fiveHourWarnPct']);
      assert.equal(issues[0]?.message, `expected a number from 1 to 100, got ${got}`);
      assert.equal(config.budget.fiveHourWarnPct, 80);
    }
  });

  it('refuses out-of-range numbers, unknown words and malformed parts, keeping the defaults', () => {
    const { config, issues } = parseConfig({
      ...ROSTER,
      budget: {
        account: 'work\nhome',
        accountLead: 'App/Lead',
        weeklyLimitW: 12.5,
        subagentWeight: 11,
        extraWPerUsd: 999,
        reset: { weekday: 'someday', timeUtc: '1am' },
        targetPct: 0,
        reservePct: 60,
        shareFloorPct: 51,
        paceEndHoursBeforeReset: 49,
        sessions: { alpha: { share: -1 }, carol: { share: 1 }, bravo: 'half' },
        pauseByPriority: 'yes',
        warnAtPct: [80, 0, 'x'],
        fiveHourWarnPct: 101,
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
      'budget.account',
      'budget.accountLead',
      'budget.escalate',
      'budget.extraWPerUsd',
      'budget.fiveHourWarnPct',
      'budget.lift.maxStopPct',
      'budget.lift.reserveStopPct',
      'budget.maxBytesPerHook',
      'budget.overAction',
      'budget.paceEndHoursBeforeReset',
      'budget.paceTolerancePct',
      'budget.pauseByPriority',
      'budget.quietHours.action',
      'budget.quietHours.endUtc',
      'budget.reservePct',
      'budget.reset.timeUtc',
      'budget.reset.weekday',
      'budget.sessions.alpha.share',
      'budget.sessions.bravo',
      'budget.sessions.carol',
      'budget.shareFloorPct',
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

  it('refuses a budget block in the delivery block, its old place, and points at its new place', () => {
    const { config, issues } = parseConfig({ ...ROSTER, delivery: { budget: { enabled: true } } });
    assert.deepEqual(issues, [{ path: 'delivery.budget', message: 'was moved: use the top-level budget block' }]);
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

describe('parseConfig: the owner decision batches', () => {
  it('reads no batch times, a batch at 5 and no dedicated owners by default', () => {
    assert.deepEqual(parseConfig(ROSTER).config.decisions, { batchTimesUtc: [], batchAt: 5, dedicatedOwners: [] });
  });

  it('keeps valid batch times, count and dedicated owners', () => {
    const decisions = { batchTimesUtc: ['13:03', '19:03'], batchAt: 0, dedicatedOwners: ['ledger', 'pricing'] };
    const { config, issues } = parseConfig({ ...ROSTER, decisions });
    assert.deepEqual([issues, config.decisions], [[], decisions]);
  });

  it('drops a time that is no HH:MM and falls back on a count out of bounds', () => {
    const { config, issues } = parseConfig({ ...ROSTER, decisions: { batchTimesUtc: ['13:03', '25:00'], batchAt: 51 } });
    assert.deepEqual(paths(issues).sort(), ['decisions.batchAt', 'decisions.batchTimesUtc[1]']);
    assert.deepEqual(config.decisions, { batchTimesUtc: ['13:03'], batchAt: 5, dedicatedOwners: [] });
  });

  it('drops a dedicated owner that is no session name, and refuses a list past its cap', () => {
    const named = parseConfig({ ...ROSTER, decisions: { dedicatedOwners: ['ledger', 'Ledger Team'] } });
    assert.deepEqual([paths(named.issues), named.config.decisions.dedicatedOwners], [['decisions.dedicatedOwners[1]'], ['ledger']]);
    const many = parseConfig({ ...ROSTER, decisions: { dedicatedOwners: Array.from({ length: 33 }, (_, index) => `area${index}`) } });
    assert.deepEqual([paths(many.issues), many.config.decisions.dedicatedOwners], [['decisions.dedicatedOwners'], []]);
  });

  // T2256: the meeting asks only in plain text, so a config still naming askWith is told to delete it.
  it('flags askWith as no longer read, whatever its value, and reads the rest', () => {
    for (const askWith of ['picker', 'text', 'cards', true]) {
      const { config, issues } = parseConfig({ ...ROSTER, decisions: { askWith, batchAt: 3 } });
      assert.deepEqual([paths(issues), config.decisions], [['decisions.askWith'], { batchTimesUtc: [], batchAt: 3, dedicatedOwners: [] }]);
      assert.match(issues[0]?.message ?? '', /is no longer read: the daily meeting asks the owner each decision in plain text.*; delete it$/);
    }
  });
});
