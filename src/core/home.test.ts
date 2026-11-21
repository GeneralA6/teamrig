import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROLLUP_IN_STATE } from '../budget/rollup-file.ts';
import { SESSIONS_WEEK_IN_STATE } from '../budget/session-week-summary.ts';
import { TASKS_WEEK_IN_STATE } from '../budget/task-week-summary.ts';
import { TEAM_WEEK_IN_STATE } from '../budget/team-week-summary.ts';
import { SESSION_LOG_IN_STATE } from '../sessions/log.ts';
import { claudeConfigDir, resolveKitHome, taskFolder, teamConfigFile, teamHome, teamPaths } from './home.ts';

const USER_HOME = join('/', 'u');
const KIT = join('/', 'kit');
const TEAM_HOME = join(KIT, 'teams', 'app');
/** The folder the run's host loads a person's skills from, outside the kit home. */
const HOST_SKILLS = join('/', 'cfg', 'skills');

describe('claudeConfigDir', () => {
  it('uses $CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }, USER_HOME), join('/', 'cfg'));
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: ' ' }, USER_HOME), join(USER_HOME, '.claude'));
    assert.equal(claudeConfigDir({}, USER_HOME), join(USER_HOME, '.claude'));
  });
});

describe('resolveKitHome', () => {
  it('prefers the env override, then a dot folder in the user home', () => {
    assert.equal(resolveKitHome({ TEAMRIG_HOME: '/a' }, USER_HOME), '/a');
    assert.equal(resolveKitHome({}, USER_HOME), join(USER_HOME, '.teamrig'));
  });

  it('ignores a plugin option, which Claude Code passes to hooks but not to Bash tool commands', () => {
    assert.equal(resolveKitHome({ CLAUDE_PLUGIN_OPTION_HOME: '/b' }, USER_HOME), join(USER_HOME, '.teamrig'));
  });

  it('ignores a blank value', () => {
    assert.equal(resolveKitHome({ TEAMRIG_HOME: '  ' }, USER_HOME), join(USER_HOME, '.teamrig'));
  });
});

describe('teamHome', () => {
  it('gives each team its own folder under the kit home', () => {
    assert.equal(teamHome(KIT, 'app'), TEAM_HOME);
  });

  it('refuses a value that is not an id, so it can never leave the teams folder', () => {
    for (const team of ['..', '../other', 'App', 'a/b', '']) {
      assert.throws(() => teamHome(KIT, team), /is not a team id/, team);
    }
  });
});

describe('taskFolder', () => {
  it("puts a task's files in the tasks folder of the team that holds it, the same folder teamPaths names", () => {
    assert.equal(taskFolder(KIT, 'app', 'T12'), join(TEAM_HOME, 'tasks', 'T12'));
    assert.equal(taskFolder(KIT, 'site', 'T12'), join(teamPaths(KIT, 'site', HOST_SKILLS).tasks, 'T12'));
  });

  it('refuses a team that is not an id', () => {
    assert.throws(() => taskFolder(KIT, '../other', 'T12'), /is not a team id/);
  });
});

describe('teamPaths', () => {
  it("keeps its skills in the team's own folder when no host's skills folder is known, and its config where teamConfigFile says", () => {
    const paths = teamPaths(KIT, 'app', undefined);
    assert.equal(paths.skills, join(TEAM_HOME, 'skills'));
    assert.equal(teamPaths(KIT, 'app', undefined, { skills: '/skills' }).skills, '/skills');
    assert.equal(paths.config, teamConfigFile(KIT, 'app'));
    assert.equal(teamConfigFile(KIT, 'app'), join(TEAM_HOME, 'config.json'));
    assert.throws(() => teamConfigFile(KIT, '../other'), /is not a team id/);
  });

  it("keeps everything under the team's folder by default, except the skills folder, which is the host's", () => {
    const paths = teamPaths(KIT, 'app', HOST_SKILLS);
    assert.equal(paths.kitHome, KIT);
    assert.equal(paths.team, 'app');
    assert.equal(paths.home, TEAM_HOME);
    assert.equal(paths.config, join(TEAM_HOME, 'config.json'));
    assert.equal(paths.events, join(TEAM_HOME, 'state', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'state', 'inbox'));
    assert.equal(paths.renames, join(TEAM_HOME, 'state', 'renames.jsonl'));
    assert.equal(paths.renamesLock, join(TEAM_HOME, 'state', 'renames.lock'));
    assert.equal(paths.skills, HOST_SKILLS);
    assert.equal(paths.refresh, join(TEAM_HOME, 'state', 'refresh'));
    assert.equal(paths.handover, join(TEAM_HOME, 'handover'));
    assert.equal(paths.tasks, join(TEAM_HOME, 'tasks'));
    assert.equal(paths.notes, join(TEAM_HOME, 'notes'));
    assert.equal(paths.verifyNotices, join(TEAM_HOME, 'state', 'verify-notices.jsonl'));
    assert.equal(paths.modelNotices, join(TEAM_HOME, 'state', 'model-notices'));
    assert.equal(paths.leaderDigest, join(TEAM_HOME, 'state', 'leader-digest'));
    assert.equal(paths.effortWriteback, join(TEAM_HOME, 'state', 'effort-writeback'));
    assert.equal(paths.effortChanges, join(TEAM_HOME, 'state', 'effort-changes.jsonl'));
    assert.equal(paths.unownedNotices, join(TEAM_HOME, 'state', 'unowned-notices.json'));
    assert.equal(paths.unownedNoticesLock, join(TEAM_HOME, 'state', 'unowned-notices.lock'));
    assert.equal(paths.usage, join(TEAM_HOME, 'state', 'usage'));
    assert.equal(paths.lifts, join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl'));
    assert.equal(paths.teamWeek, join(TEAM_HOME, 'state', ...TEAM_WEEK_IN_STATE), 'where the read side says the team week summary is');
    assert.equal(paths.rollup, join(TEAM_HOME, 'state', ...ROLLUP_IN_STATE), 'where the read side says the usage rollup is');
    assert.equal(paths.cuts, join(TEAM_HOME, 'state', 'usage', 'cuts.jsonl'));
    assert.equal(paths.sessionsWeek, join(TEAM_HOME, 'state', ...SESSIONS_WEEK_IN_STATE), "where the read side says the sessions' week summary is");
    assert.equal(paths.tasksWeek, join(TEAM_HOME, 'state', ...TASKS_WEEK_IN_STATE), "where the read side says the tasks' week summary is");
    assert.equal(paths.hires, join(TEAM_HOME, 'state', 'hires.jsonl'));
    assert.equal(paths.configLock, join(TEAM_HOME, 'state', 'hires.lock'));
    assert.equal(paths.lastTaskAsks, join(TEAM_HOME, 'state', 'last-task-asks'));
    assert.equal(paths.keepWorkingAsks, join(TEAM_HOME, 'state', 'keep-working-asks'));
    assert.equal(paths.logs, join(TEAM_HOME, 'state', 'logs'));
    assert.equal(paths.wake, join(TEAM_HOME, 'state', 'wake'));
    assert.equal(paths.wakeLog, join(TEAM_HOME, 'state', 'wakes.jsonl'));
    assert.equal(paths.launchSettings, join(TEAM_HOME, 'state', 'launch'));
    assert.equal(paths.sessions, join(TEAM_HOME, 'state', 'sessions'));
    assert.equal(paths.sessionLog, join(TEAM_HOME, 'state', ...SESSION_LOG_IN_STATE), 'where the read side says the session log is');
    assert.equal(paths.secretIncidents, join(TEAM_HOME, 'state', 'secret-incidents.jsonl'));
    assert.equal(paths.secretIncidentsLock, join(TEAM_HOME, 'state', 'secret-incidents.lock'));
  });

  it('never shares a file between two teams', () => {
    const app = Object.values(teamPaths(KIT, 'app', HOST_SKILLS));
    const site = new Set(Object.values(teamPaths(KIT, 'site', HOST_SKILLS)));
    assert.deepEqual(
      app.filter((path) => site.has(path)),
      [KIT, HOST_SKILLS],
    );
  });

  it('applies overrides', () => {
    const paths = teamPaths(KIT, 'app', HOST_SKILLS, { state: '/data', inbox: '/notes', skills: '/skills', handover: '/hand' });
    assert.equal(paths.events, join('/data', 'events.jsonl'));
    assert.equal(paths.inbox, '/notes');
    assert.equal(paths.skills, '/skills');
    assert.equal(paths.refresh, join('/data', 'refresh'));
    assert.equal(paths.handover, '/hand');
  });

  it('keeps the week summaries where the read side says, in the state folder an override moves (T1777)', () => {
    const paths = teamPaths(KIT, 'app', HOST_SKILLS, { state: 'data' });
    assert.equal(paths.teamWeek, join(TEAM_HOME, 'data', ...TEAM_WEEK_IN_STATE));
    assert.equal(paths.sessionsWeek, join(TEAM_HOME, 'data', ...SESSIONS_WEEK_IN_STATE));
    assert.equal(paths.tasksWeek, join(TEAM_HOME, 'data', ...TASKS_WEEK_IN_STATE));
    assert.equal(paths.rollup, join(TEAM_HOME, 'data', ...ROLLUP_IN_STATE));
  });

  it("keeps the exec audit log and run outputs in the team's folder, whatever the state override", () => {
    const paths = teamPaths(KIT, 'app', HOST_SKILLS, { state: '/data' });
    assert.equal(paths.execAudit, join(TEAM_HOME, 'exec', 'audit.jsonl'));
    assert.equal(paths.execAuditLock, join(TEAM_HOME, 'exec', 'audit.lock'));
    assert.equal(paths.execOut, join(TEAM_HOME, 'exec', 'out'));
  });

  it("resolves relative overrides against the team's folder, not the working folder", () => {
    const paths = teamPaths(KIT, 'app', HOST_SKILLS, { state: 'data', inbox: join('notes', 'in'), skills: '../skills', handover: 'hand' });
    assert.equal(paths.events, join(TEAM_HOME, 'data', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'notes', 'in'));
    assert.equal(paths.skills, join(KIT, 'teams', 'skills'));
    assert.equal(paths.handover, join(TEAM_HOME, 'hand'));
  });
});
