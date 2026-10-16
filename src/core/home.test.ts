import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeConfigDir, resolveKitHome, teamHome, teamPaths } from './home.ts';

const USER_HOME = join('/', 'u');
const KIT = join('/', 'kit');
const TEAM_HOME = join(KIT, 'teams', 'app');

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

describe('teamPaths', () => {
  it("keeps everything under the team's folder by default, except the Claude Code skills folder", () => {
    const paths = teamPaths(KIT, 'app', USER_HOME);
    assert.equal(paths.kitHome, KIT);
    assert.equal(paths.team, 'app');
    assert.equal(paths.home, TEAM_HOME);
    assert.equal(paths.config, join(TEAM_HOME, 'config.json'));
    assert.equal(paths.events, join(TEAM_HOME, 'state', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'state', 'inbox'));
    assert.equal(paths.renames, join(TEAM_HOME, 'state', 'renames.jsonl'));
    assert.equal(paths.renamesLock, join(TEAM_HOME, 'state', 'renames.lock'));
    assert.equal(paths.skills, join(USER_HOME, '.claude', 'skills'));
    assert.equal(paths.refresh, join(TEAM_HOME, 'state', 'refresh'));
    assert.equal(paths.handover, join(TEAM_HOME, 'handover'));
    assert.equal(paths.verifyNotices, join(TEAM_HOME, 'state', 'verify-notices.jsonl'));
    assert.equal(paths.modelNotices, join(TEAM_HOME, 'state', 'model-notices'));
    assert.equal(paths.usage, join(TEAM_HOME, 'state', 'usage'));
    assert.equal(paths.lifts, join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl'));
    assert.equal(paths.hires, join(TEAM_HOME, 'state', 'hires.jsonl'));
    assert.equal(paths.hiresLock, join(TEAM_HOME, 'state', 'hires.lock'));
    assert.equal(paths.logs, join(TEAM_HOME, 'state', 'logs'));
  });

  it('never shares a file between two teams', () => {
    const app = Object.values(teamPaths(KIT, 'app', USER_HOME));
    const site = new Set(Object.values(teamPaths(KIT, 'site', USER_HOME)));
    assert.deepEqual(
      app.filter((path) => site.has(path)),
      [KIT, join(USER_HOME, '.claude', 'skills')],
    );
  });

  it('applies overrides', () => {
    const paths = teamPaths(KIT, 'app', USER_HOME, { state: '/data', inbox: '/notes', skills: '/skills', handover: '/hand' });
    assert.equal(paths.events, join('/data', 'events.jsonl'));
    assert.equal(paths.inbox, '/notes');
    assert.equal(paths.skills, '/skills');
    assert.equal(paths.refresh, join('/data', 'refresh'));
    assert.equal(paths.handover, '/hand');
  });

  it("resolves relative overrides against the team's folder, not the working folder", () => {
    const paths = teamPaths(KIT, 'app', USER_HOME, { state: 'data', inbox: join('notes', 'in'), skills: '../skills', handover: 'hand' });
    assert.equal(paths.events, join(TEAM_HOME, 'data', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'notes', 'in'));
    assert.equal(paths.skills, join(KIT, 'teams', 'skills'));
    assert.equal(paths.handover, join(TEAM_HOME, 'hand'));
  });
});
