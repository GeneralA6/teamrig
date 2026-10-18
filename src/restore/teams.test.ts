import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RestoreEntry } from './entry.ts';
import { teamSessionOf, type RestoreTeam } from './teams.ts';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

function entry(overrides: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    claudeSession: SESSION,
    projectDir: '/work/app',
    transcriptPath: undefined,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: undefined,
    team: undefined,
    session: undefined,
    state: 'ready',
    createdAt: 0,
    updatedAt: 0,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    ...overrides,
  };
}

const APP: RestoreTeam = {
  team: 'app',
  lead: 'lead',
  names: new Map([
    ['lead', 'app-lead'],
    ['alpha', 'app-alpha'],
  ]),
  terminal: 'windows-terminal',
  areaBySession: new Map([[OTHER, 'alpha']]),
};

const WEB: RestoreTeam = {
  team: 'web',
  lead: 'boss',
  names: new Map([['front', 'web-front']]),
  terminal: 'auto',
  areaBySession: new Map([
    [SESSION, 'front'],
    [OTHER, 'gone'],
  ]),
};

describe('teamSessionOf', () => {
  it('takes the team and session its variables name, as launched', () => {
    assert.deepEqual(teamSessionOf(entry({ team: 'app', session: 'lead' }), [APP, WEB]), {
      team: 'app',
      session: 'lead',
      name: 'app-lead',
      isLead: true,
      terminal: 'windows-terminal',
      launched: true,
    });
  });

  it('falls back to the inbox it last read when its variables name no current session', () => {
    assert.deepEqual(teamSessionOf(entry({ team: 'app', session: 'retired' }), [APP, WEB]), {
      team: 'web',
      session: 'front',
      name: 'web-front',
      isLead: false,
      terminal: 'auto',
      launched: false,
    });
  });

  it('skips an inbox of a session the team no longer has, and is undefined for no team', () => {
    assert.equal(teamSessionOf(entry({ claudeSession: OTHER }), [WEB, APP])?.session, 'alpha');
    assert.equal(teamSessionOf(entry({ claudeSession: OTHER }), [WEB]), undefined);
    assert.equal(teamSessionOf(entry(), []), undefined);
  });
});
