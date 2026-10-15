import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { describeNameClash, type NameClash, type TreeProblem } from '../config/tree.ts';
import { lineHash } from '../inbox/line-hash.ts';
import type { InboxMark } from '../inbox/marks.ts';
import { unreadOf } from '../inbox/unread.ts';
import type { Rename } from '../names/rename.ts';
import { TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';
import { renameOf } from '../testing/rename.ts';
import { doctorFindings, formatFinding, UNREAD_INBOX_DAYS, type DoctorInput } from './doctor.ts';

const NOW = new Date('2030-01-20T10:00:00Z');
const LOG = '/kit/teams/app/state/renames.jsonl';

function input(overrides: Partial<DoctorInput> & { readonly names?: Record<string, string>; readonly renames?: readonly Rename[] } = {}): DoctorInput {
  const { names = {}, renames = [], ...rest } = overrides;
  const config = { sessions: ['lead', 'alpha', 'bravo'], names, roles: { lead: 'lead' } };
  return {
    roster: new Roster(config, 'app', renames),
    configNames: names,
    renameLog: { path: LOG, renames, unreadable: 0, newer: 0 },
    requirements: [],
    inboxes: [],
    teamRules: undefined,
    tree: { problems: [], clashes: [] },
    now: NOW,
    command: 'teamrig',
    ...rest,
  };
}

function markAt(area: string, lines: readonly string[], at: string): InboxMark {
  const last = lines.at(-1);
  return { v: 1, area, line: lines.length, at, claudeSession: null, lastLineHash: last === undefined ? null : lineHash(last) };
}

function lines(input: DoctorInput): string[] {
  return doctorFindings(input).map(formatFinding);
}

describe('doctorFindings', () => {
  it('finds nothing on a healthy team with renames, a fresh inbox and short rules', () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout'), renameOf('bravo', 'app-bravo', 'app-alpha'), renameOf('alpha', 'scout', 'ranger')];
    const read = ['- 2030-01-02 09:00 lead: old'];
    const inboxes = [unreadOf('alpha', [...read, '- 2030-01-19 09:00 lead: new'], markAt('alpha', read, '2030-01-18T09:00:00Z'), lineHash)];
    assert.deepEqual(lines(input({ renames, inboxes, teamRules: { path: 'rules.md', chars: TEAM_RULES_MAX_CHARS } })), []);
  });

  it('flags a removed session\'s names, a shared name and a former name another session holds now', () => {
    const renames = [renameOf('zulu', 'app-zulu', 'ghost'), renameOf('alpha', 'app-alpha', 'scout')];
    const findings = lines(input({ names: { lead: 'chief', bravo: 'chief' }, renames: [...renames, renameOf('alpha', 'scout', 'ranger')] }));
    assert.deepEqual(findings, [
      'WARN name-shared chief is the name of lead, bravo, so commands refuse it: give each its own with `teamrig rename`',
      'WARN name-gone app-zulu, ghost were names of zulu, which is no longer on the team: commands refuse them, filters read them as zulu',
    ]);
    const taken = lines(input({ names: { bravo: 'scout' }, renames: [renameOf('alpha', 'app-alpha', 'scout'), renameOf('alpha', 'scout', 'ranger')] }));
    assert.deepEqual(taken, ['WARN name-shared scout was a name of alpha but is now the name of bravo, so it no longer finds alpha']);
    assert.deepEqual(lines(input({ renames: [renameOf('zulu', 'app-zulu', 'ghost')] })).slice(-1), [
      'WARN name-gone app-zulu, ghost were names of zulu, which is no longer on the team: commands refuse them, filters read them as zulu',
    ]);
    assert.match(lines(input({ names: { zulu: 'ghost' }, renames: [renameOf('zulu', 'ghost', 'phantom')] }))[0] ?? '', /phantom, ghost were names|ghost, phantom were names/);
  });

  it('says one name of a removed session in the singular', () => {
    const renames = [renameOf('zulu', 'app-zulu', 'ghost'), renameOf('alpha', 'app-alpha', 'app-zulu')];
    assert.deepEqual(lines(input({ renames })), [
      'WARN name-gone ghost was a name of zulu, which is no longer on the team: commands refuse them, filters read them as zulu',
    ]);
  });

  it('flags a config edited to rename a session the log has renamed, and not a name the log knows', () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout')];
    assert.deepEqual(lines(input({ names: { alpha: 'ranger' }, renames })).filter((line) => line.includes('name-config')), [
      'WARN name-config the config names alpha "ranger", but the rename log calls it scout and the log wins: to rename it, run `teamrig rename alpha ranger`',
    ]);
    assert.deepEqual(lines(input({ names: { alpha: 'app-alpha', zulu: 'ghost' }, renames })), []);
  });

  it('flags damaged and newer lines in the rename log', () => {
    assert.deepEqual(lines(input({ renameLog: { path: LOG, renames: [], unreadable: 2, newer: 1 } })), [
      `WARN rename-log ${LOG} has 2 damaged line(s), skipped: the names they record do not resolve until fixed`,
      `WARN rename-log ${LOG} has 1 line(s) from a newer teamrig, skipped: no rename can be recorded until teamrig is updated`,
    ]);
  });

  it('flags an inbox keyed by no session id, naming the session a name belongs to', () => {
    const inboxes = [unreadOf('app-alpha', ['- 2030-01-19 09:00 lead: hi'], null, lineHash), unreadOf('zulu', [], null, lineHash)];
    assert.deepEqual(lines(input({ inboxes })), [
      "WARN inbox-orphan inbox app-alpha (1 unread) is no session's: inboxes are keyed by session id, so nobody reads it; app-alpha is a name of alpha, whose inbox is keyed by its id; nothing moves its lines",
      "WARN inbox-orphan inbox zulu (0 unread) is no session's: inboxes are keyed by session id, so nobody reads it; nothing moves its lines",
    ]);
  });

  it(`flags unread lines with no read for over ${UNREAD_INBOX_DAYS} days, and never-read lines that old or undated`, () => {
    const read = ['- 2030-01-02 09:00 lead: old'];
    const inboxes = [
      unreadOf('alpha', [...read, '- 2030-01-19 09:00 lead: new'], markAt('alpha', read, '2030-01-12T09:00:00Z'), lineHash),
      unreadOf('bravo', ['- 2030-01-12 09:00 lead: waiting'], null, lineHash),
      unreadOf('lead', ['written by hand'], null, lineHash),
    ];
    assert.deepEqual(lines(input({ inboxes })), [
      'WARN inbox-unread alpha has 1 unread line(s) and last read it 01-12 09:00: over 7 days with no read',
      'WARN inbox-unread bravo has 1 unread line(s) and has never read it: over 7 days with no read',
      'WARN inbox-unread lead has 1 unread line(s) and has never read it: over 7 days with no read',
    ]);
    const fresh = [unreadOf('bravo', ['- 2030-01-19 09:00 lead: new'], null, lineHash), unreadOf('alpha', read, markAt('alpha', read, '2030-01-02T09:00:00Z'), lineHash)];
    assert.deepEqual(lines(input({ inboxes: fresh })), []);
  });

  it('flags each tree problem and each session name another team uses, with its fix', () => {
    const problem: TreeProblem = { kind: 'tree-parent', team: 'app', parent: 'gone' };
    const clash: NameClash = { name: 'app-alpha', holders: [{ team: 'app', id: 'alpha' }, { team: 'web', id: 'front' }] };
    assert.deepEqual(lines(input({ tree: { problems: [problem], clashes: [clash] } })), [
      'WARN tree-parent team app names parent gone, which has no team config: create it with `teamrig team create gone`, or fix team.parent',
      `WARN name-two-teams ${describeNameClash(clash, 'teamrig')}`,
    ]);
  });

  it('flags rules too long to show at session start', () => {
    assert.deepEqual(lines(input({ teamRules: { path: 'rules.md', chars: TEAM_RULES_MAX_CHARS + 1 } })), [
      `WARN rules-long rules.md is ${TEAM_RULES_MAX_CHARS + 1} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`,
    ]);
  });
});

describe('doctorFindings of requirements', () => {
  it('lists what teamrig lacks on this machine first, each with its fix', () => {
    const found = lines(input({ requirements: [{ kind: 'git-missing' }, { kind: 'node-old', running: '20.11.1' }], inboxes: [] }));
    assert.deepEqual(found, [
      'WARN requirement git is not installed or not on PATH, and teamrig needs it: install it from git-scm.com, then restart Claude Code.',
      'WARN requirement Node.js 20.11.1 is older than teamrig supports (22.18.0 or later): install the current LTS from nodejs.org, then restart Claude Code.',
    ]);
  });
});
