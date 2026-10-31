import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TEAM_WEEK_PATH } from '../budget/team-week-summary.ts';
import { claudeConfigDir, claudeTempDir, resolveKitHome, taskFolder, teamHome, teamPaths } from './home.ts';

const USER_HOME = join('/', 'u');
const KIT = join('/', 'kit');
const TEAM_HOME = join(KIT, 'teams', 'app');
/** Claude Code's folder, away from the user's home as `CLAUDE_CONFIG_DIR` may move it. */
const CLAUDE_DIR = join('/', 'cfg');

describe('claudeConfigDir', () => {
  it('uses $CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: join('/', 'cfg') }, USER_HOME), join('/', 'cfg'));
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: ' ' }, USER_HOME), join(USER_HOME, '.claude'));
    assert.equal(claudeConfigDir({}, USER_HOME), join(USER_HOME, '.claude'));
  });
});

describe('claudeTempDir', () => {
  it('uses $CLAUDE_CODE_TMPDIR, else the system temporary folder', () => {
    assert.equal(claudeTempDir({ CLAUDE_CODE_TMPDIR: join('/', 'scratch') }, join('/', 'tmp')), join('/', 'scratch'));
    assert.equal(claudeTempDir({ CLAUDE_CODE_TMPDIR: ' ' }, join('/', 'tmp')), join('/', 'tmp'));
    assert.equal(claudeTempDir({}, join('/', 'tmp')), join('/', 'tmp'));
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
    assert.equal(taskFolder(KIT, 'site', 'T12'), join(teamPaths(KIT, 'site', CLAUDE_DIR).tasks, 'T12'));
  });

  it('refuses a team that is not an id', () => {
    assert.throws(() => taskFolder(KIT, '../other', 'T12'), /is not a team id/);
  });
});

describe('teamPaths', () => {
  it("keeps everything under the team's folder by default, except the skills folder of Claude Code's folder", () => {
    const paths = teamPaths(KIT, 'app', CLAUDE_DIR);
    assert.equal(paths.kitHome, KIT);
    assert.equal(paths.team, 'app');
    assert.equal(paths.home, TEAM_HOME);
    assert.equal(paths.config, join(TEAM_HOME, 'config.json'));
    assert.equal(paths.events, join(TEAM_HOME, 'state', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'state', 'inbox'));
    assert.equal(paths.renames, join(TEAM_HOME, 'state', 'renames.jsonl'));
    assert.equal(paths.renamesLock, join(TEAM_HOME, 'state', 'renames.lock'));
    assert.equal(paths.skills, join(CLAUDE_DIR, 'skills'));
    assert.equal(paths.refresh, join(TEAM_HOME, 'state', 'refresh'));
    assert.equal(paths.handover, join(TEAM_HOME, 'handover'));
    assert.equal(paths.tasks, join(TEAM_HOME, 'tasks'));
    assert.equal(paths.notes, join(TEAM_HOME, 'notes'));
    assert.equal(paths.verifyNotices, join(TEAM_HOME, 'state', 'verify-notices.jsonl'));
    assert.equal(paths.modelNotices, join(TEAM_HOME, 'state', 'model-notices'));
    assert.equal(paths.unownedNotices, join(TEAM_HOME, 'state', 'unowned-notices.json'));
    assert.equal(paths.unownedNoticesLock, join(TEAM_HOME, 'state', 'unowned-notices.lock'));
    assert.equal(paths.usage, join(TEAM_HOME, 'state', 'usage'));
    assert.equal(paths.lifts, join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl'));
    assert.equal(paths.teamWeek, join(TEAM_HOME, ...TEAM_WEEK_PATH), 'where the read side says the team week summary is');
    assert.equal(paths.cuts, join(TEAM_HOME, 'state', 'usage', 'cuts.jsonl'));
    assert.equal(paths.hires, join(TEAM_HOME, 'state', 'hires.jsonl'));
    assert.equal(paths.hiresLock, join(TEAM_HOME, 'state', 'hires.lock'));
    assert.equal(paths.lastTaskAsks, join(TEAM_HOME, 'state', 'last-task-asks'));
    assert.equal(paths.keepWorkingAsks, join(TEAM_HOME, 'state', 'keep-working-asks'));
    assert.equal(paths.logs, join(TEAM_HOME, 'state', 'logs'));
    assert.equal(paths.wake, join(TEAM_HOME, 'state', 'wake'));
    assert.equal(paths.wakeLog, join(TEAM_HOME, 'state', 'wakes.jsonl'));
    assert.equal(paths.launchSettings, join(TEAM_HOME, 'state', 'launch'));
    assert.equal(paths.sessions, join(TEAM_HOME, 'state', 'sessions'));
    assert.equal(paths.sessionLog, join(TEAM_HOME, 'state', 'session-log.jsonl'));
    assert.equal(paths.secretIncidents, join(TEAM_HOME, 'state', 'secret-incidents.jsonl'));
    assert.equal(paths.secretIncidentsLock, join(TEAM_HOME, 'state', 'secret-incidents.lock'));
  });

  it('never shares a file between two teams', () => {
    const app = Object.values(teamPaths(KIT, 'app', CLAUDE_DIR));
    const site = new Set(Object.values(teamPaths(KIT, 'site', CLAUDE_DIR)));
    assert.deepEqual(
      app.filter((path) => site.has(path)),
      [KIT, join(CLAUDE_DIR, 'skills')],
    );
  });

  it('applies overrides', () => {
    const paths = teamPaths(KIT, 'app', CLAUDE_DIR, { state: '/data', inbox: '/notes', skills: '/skills', handover: '/hand' });
    assert.equal(paths.events, join('/data', 'events.jsonl'));
    assert.equal(paths.inbox, '/notes');
    assert.equal(paths.skills, '/skills');
    assert.equal(paths.refresh, join('/data', 'refresh'));
    assert.equal(paths.handover, '/hand');
  });

  it("keeps the exec audit log and run outputs in the team's folder, whatever the state override", () => {
    const paths = teamPaths(KIT, 'app', CLAUDE_DIR, { state: '/data' });
    assert.equal(paths.execAudit, join(TEAM_HOME, 'exec', 'audit.jsonl'));
    assert.equal(paths.execAuditLock, join(TEAM_HOME, 'exec', 'audit.lock'));
    assert.equal(paths.execOut, join(TEAM_HOME, 'exec', 'out'));
  });

  it("resolves relative overrides against the team's folder, not the working folder", () => {
    const paths = teamPaths(KIT, 'app', CLAUDE_DIR, { state: 'data', inbox: join('notes', 'in'), skills: '../skills', handover: 'hand' });
    assert.equal(paths.events, join(TEAM_HOME, 'data', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'notes', 'in'));
    assert.equal(paths.skills, join(KIT, 'teams', 'skills'));
    assert.equal(paths.handover, join(TEAM_HOME, 'hand'));
  });
});
