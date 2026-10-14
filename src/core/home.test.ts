import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveKitHome, teamHome, teamPaths } from './home.ts';

const USER_HOME = join('/', 'u');
const KIT = join('/', 'kit');
const TEAM_HOME = join(KIT, 'teams', 'app');

describe('resolveKitHome', () => {
  it('prefers the env override, then the plugin option, then a dot folder in the user home', () => {
    assert.equal(resolveKitHome({ TEAMRIG_HOME: '/a', CLAUDE_PLUGIN_OPTION_HOME: '/b' }, USER_HOME), '/a');
    assert.equal(resolveKitHome({ CLAUDE_PLUGIN_OPTION_HOME: '/b' }, USER_HOME), '/b');
    assert.equal(resolveKitHome({}, USER_HOME), join(USER_HOME, '.teamrig'));
  });

  it('ignores blank values', () => {
    assert.equal(resolveKitHome({ TEAMRIG_HOME: '  ', CLAUDE_PLUGIN_OPTION_HOME: '' }, USER_HOME), join(USER_HOME, '.teamrig'));
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
    assert.equal(paths.skills, join(USER_HOME, '.claude', 'skills'));
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
    const paths = teamPaths(KIT, 'app', USER_HOME, { state: '/data', inbox: '/notes', skills: '/skills' });
    assert.equal(paths.events, join('/data', 'events.jsonl'));
    assert.equal(paths.inbox, '/notes');
    assert.equal(paths.skills, '/skills');
  });

  it("resolves relative overrides against the team's folder, not the working folder", () => {
    const paths = teamPaths(KIT, 'app', USER_HOME, { state: 'data', inbox: join('notes', 'in'), skills: '../skills' });
    assert.equal(paths.events, join(TEAM_HOME, 'data', 'events.jsonl'));
    assert.equal(paths.inbox, join(TEAM_HOME, 'notes', 'in'));
    assert.equal(paths.skills, join(KIT, 'teams', 'skills'));
  });
});
