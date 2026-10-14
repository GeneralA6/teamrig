import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitPaths, resolveKitHome } from './home.ts';

const USER_HOME = join('/', 'u');

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

describe('kitPaths', () => {
  it('keeps everything under the kit home by default, except the Claude Code skills folder', () => {
    const paths = kitPaths('/kit', USER_HOME);
    assert.equal(paths.config, join('/kit', 'config.json'));
    assert.equal(paths.events, join('/kit', 'state', 'events.jsonl'));
    assert.equal(paths.inbox, join('/kit', 'state', 'inbox'));
    assert.equal(paths.skills, join(USER_HOME, '.claude', 'skills'));
  });

  it('applies overrides', () => {
    const paths = kitPaths('/kit', USER_HOME, { state: '/data', inbox: '/notes', skills: '/skills' });
    assert.equal(paths.events, join('/data', 'events.jsonl'));
    assert.equal(paths.inbox, '/notes');
    assert.equal(paths.skills, '/skills');
  });
});

describe('kitPaths with relative overrides', () => {
  it('resolves them against the kit home, not the working folder', () => {
    const home = join('/', 'kit');
    const paths = kitPaths(home, USER_HOME, { state: 'data', inbox: join('notes', 'in'), skills: '../skills' });
    assert.equal(paths.events, join(home, 'data', 'events.jsonl'));
    assert.equal(paths.inbox, join(home, 'notes', 'in'));
    assert.equal(paths.skills, join('/', 'skills'));
  });
});
