import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tabStatusLine, type TabStatusFacts } from './tab-status-note.ts';

const ON: TabStatusFacts = { team: 'shop', configOn: true, configPath: '/kit/teams/shop/config.json', titleLeft: true, settingsPath: '/u/.claude/settings.json' };
const CIRCLE = 'each tab of team shop shows a colored circle before its title for what its session is doing';
const SET_CONFIG = 'set "tabStatus": { "enabled": true } in /kit/teams/shop/config.json';
const ADD_SWITCH =
  'add "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1" to "env" in /u/.claude/settings.json and restart Claude Code, so it stops writing its own title over the circle (tabs of projects outside teamrig then keep the terminal\'s title)';

describe('tabStatusLine', () => {
  it('says tab status is on when the config turns it on and Claude Code leaves the title to hooks', () => {
    assert.equal(tabStatusLine(ON), `TAB STATUS on: ${CIRCLE}: green ready, yellow working, orange waiting on you`);
  });

  it('names the Claude Code switch and where it goes when Claude Code still writes the title', () => {
    assert.equal(tabStatusLine({ ...ON, titleLeft: false }), `NOTE ${CIRCLE} once you ${ADD_SWITCH}`);
  });

  it('names the config key of a kept config that has tab status off', () => {
    assert.equal(tabStatusLine({ ...ON, configOn: false }), `NOTE ${CIRCLE} once you ${SET_CONFIG}`);
  });

  it('names both, the config first, when both are off', () => {
    assert.equal(tabStatusLine({ ...ON, configOn: false, titleLeft: false }), `NOTE ${CIRCLE} once you ${SET_CONFIG}, and ${ADD_SWITCH}`);
  });
});
