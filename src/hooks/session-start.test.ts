import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigLoad } from '../config/load.ts';
import { CONTEXT_MAX_CHARS, renderCorePack } from '../rules/pack.ts';
import { testConfig } from '../testing/config.ts';
import { renameOf } from '../testing/rename.ts';
import { sessionStartContext, sessionStartOutput, type SessionStartInput } from './session-start.ts';

const PATH = '/kit/teams/app/config.json';
const COMMAND = 'teamrig';
const NAMES = '`teamrig who` prints the name to message any session by; message only those names.';

function loaded(overrides: Partial<Extract<ConfigLoad, { status: 'loaded' }>> = {}): ConfigLoad {
  return { status: 'loaded', path: PATH, config: testConfig({ names: { lead: 'team-lead' } }), issues: [], ...overrides };
}

function context(overrides: Partial<SessionStartInput> = {}): string {
  return sessionStartContext({
    team: 'app',
    load: loaded(),
    teamRules: undefined,
    renames: [],
    titleNote: undefined,
    refreshNote: undefined,
    session: 'alpha',
    command: COMMAND,
    ...overrides,
  });
}

describe('sessionStartContext', () => {
  it('gives the core rules, then who the session is and how to reach the lead', () => {
    const text = context();
    assert.ok(text.startsWith(renderCorePack(testConfig(), COMMAND)));
    assert.ok(text.endsWith(`\n\nYou are the \`alpha\` session of team \`app\` (name \`app-alpha\`). Message the lead as \`team-lead\`.\n${NAMES}`));
  });

  it('finds the session by name too, and tells the lead its role', () => {
    const text = context({ session: 'team-lead' });
    assert.ok(text.endsWith(`\n\nYou are the \`lead\` session of team \`app\` (name \`team-lead\`, roles: lead).\n${NAMES}`));
  });

  it('asks which session it is when the variable is unset, invalid or not on the team', () => {
    for (const session of [undefined, 'Not A Name '.repeat(50), 'zulu']) {
      const text = context({ session });
      assert.match(text, /: ask the user which session you are \(`teamrig who` lists them\) and pass --session <id> to every `teamrig` task and inbox command\. Message the lead as `team-lead`\.\n/);
      assert.doesNotMatch(text, /Not A Name|zulu/);
    }
  });

  it('names the session by its newest name, finds it by an old one, and adds the title note', () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout'), renameOf('lead', 'team-lead', 'chief')];
    const text = context({ renames, session: 'app-alpha', titleNote: 'Title note.' });
    assert.ok(text.endsWith(`\n\nYou are the \`alpha\` session of team \`app\` (name \`scout\`). Message the lead as \`chief\`.\n${NAMES}\nTitle note.`));
  });

  it('points a refreshed session at its handover right after who it is, before the title note', () => {
    const text = context({ refreshNote: 'Read your handover.', titleNote: 'Title note.' });
    assert.ok(text.endsWith(`Message the lead as \`team-lead\`.\n${NAMES}\nRead your handover.\nTitle note.`));
  });

  it("appends the team's rules", () => {
    const text = context({ teamRules: { path: '/kit/teams/app/rules.md', text: 'Ship small.' } });
    assert.match(text, /# Your team's rules\nShip small\.$/);
  });

  it('notes a newer config and config problems', () => {
    const text = context({
      load: loaded({ newerVersion: 3, issues: [{ path: 'lock.ttlMs', message: 'expected a number' }] }),
    });
    assert.match(text, /version 3, from a newer teamrig/);
    assert.match(text, /1 problem\(s\), each read as its default; run: teamrig config validate/);
  });

  it('says in one line why no rules load without a usable config', () => {
    assert.equal(
      context({ load: { status: 'missing', path: PATH } }),
      `teamrig is enabled here but team app has no config at ${PATH}, so no team rules are loaded. Write one (see the README), then run: teamrig config validate`,
    );
    const unreadable = context({ load: { status: 'unreadable', path: PATH, issue: { path: '', message: 'not JSON' } } });
    assert.match(unreadable, /^teamrig cannot read the config of team app at \/kit\/teams\/app\/config\.json/);
  });

  it('stays inside the context cap with long team rules', () => {
    const text = context({ teamRules: { path: '/kit/teams/app/rules.md', text: 'x'.repeat(CONTEXT_MAX_CHARS) } });
    assert.ok(text.length <= CONTEXT_MAX_CHARS);
    assert.match(text, /Your team's rules are in \/kit\/teams\/app\/rules\.md/);
  });
});

describe('sessionStartOutput', () => {
  it('wraps the context as SessionStart additionalContext', () => {
    assert.deepEqual(JSON.parse(sessionStartOutput('hello')), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
    });
  });
});
