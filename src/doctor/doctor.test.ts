import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_FILES, DEFAULT_LEAD_LAUNCH } from '../config/defaults.ts';
import { launchOf } from '../config/launch.ts';
import { Roster } from '../config/roster.ts';
import { describeNameClash, type NameClash, type TreeProblem } from '../config/tree.ts';
import { TimeZone } from '../core/zone.ts';
import { lineHash } from '../inbox/line-hash.ts';
import type { InboxMark } from '../inbox/marks.ts';
import { unreadOf } from '../inbox/unread.ts';
import type { Rename } from '../names/rename.ts';
import { TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';
import { testConfig } from '../testing/config.ts';
import { renameOf } from '../testing/rename.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { doctorFindings, formatFinding, UNREAD_INBOX_DAYS, type DoctorInput } from './doctor.ts';
import type { SessionListSource } from './session-lists.ts';
import type { SettingsEnv } from './settings-env.ts';

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
    retired: new Set(),
    teamRules: [],
    contextFiles: { read: { claudeMd: [], memoryIndex: undefined, skills: { folders: [], count: 0, chars: 0 } }, budgets: DEFAULT_CONTEXT_FILES },
    sessionLists: undefined,
    tree: { problems: [], clashes: [] },
    env: {},
    settingsEnv: [],
    wideAllow: { files: 0, counts: [] },
    launches: [],
    projects: [],
    shellHistory: { history: undefined, profiles: [], gated: false },
    now: NOW,
    zone: TimeZone.UTC,
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
  it('flags the CLAUDE.md files, memory index and skill listing over their budgets, and is quiet at them', () => {
    const budgets = { ...DEFAULT_CONTEXT_FILES, maxClaudeMdChars: 1_000, maxMemoryIndexChars: 500, maxSkillListingChars: 800 };
    const at = (claudeMd: number, memory: number | undefined, skills: number): DoctorInput =>
      input({
        contextFiles: {
          read: {
            claudeMd: [
              { path: '/u/.claude/CLAUDE.md', chars: 200 },
              { path: '/w/CLAUDE.md', chars: claudeMd - 200 },
            ],
            memoryIndex: memory === undefined ? undefined : { path: '/u/.claude/projects/-w/memory/MEMORY.md', chars: memory },
            skills: { folders: ['/u/.claude/skills'], count: 3, chars: skills },
          },
          budgets,
        },
      });
    assert.deepEqual(lines(at(1_000, 500, 800)), []);
    assert.deepEqual(lines(at(1_000, undefined, 800)), []);
    assert.deepEqual(lines(at(1_001, 2_000, 801)), [
      'WARN context-size CLAUDE.md files (/u/.claude/CLAUDE.md 200, /w/CLAUDE.md 801): 1,001 characters (~300 tokens), over its budget of 1,000 [contextFiles.maxClaudeMdChars]; every call re-reads this text, so move how-tos into skills and facts into memory files',
      'WARN context-size memory index /u/.claude/projects/-w/memory/MEMORY.md: 2,000 characters (~500 tokens), over its budget of 500 [contextFiles.maxMemoryIndexChars]; every call re-reads this text, so keep one short line per memory and its detail in the memory file',
      'WARN context-size skill listing (3 skills in /u/.claude/skills): 801 characters (~200 tokens), over its budget of 800 [contextFiles.maxSkillListingChars]; every call re-reads this text, so shorten descriptions or merge skills',
    ]);
  });

  it("flags the newest session's lists over their budget, naming each list's largest sources, and is quiet at it", () => {
    const budgets = { ...DEFAULT_CONTEXT_FILES, maxSessionListsChars: 1_000 };
    const source = (name: string, chars: number): SessionListSource => ({ name, count: 1, chars });
    const at = (skills: number): DoctorInput =>
      input({
        contextFiles: { read: { claudeMd: [], memoryIndex: undefined, skills: { folders: [], count: 0, chars: 0 } }, budgets },
        sessionLists: {
          transcript: '/u/.claude/projects/-w/s1.jsonl',
          lists: [
            {
              kind: 'skills',
              count: 5,
              chars: skills,
              sources: [source('skills folders and built-in', skills - 400), source('docs', 200), source('dev', 100), source('ops', 60), source('ui', 40)],
            },
            { kind: 'tools', count: 2, chars: 300, sources: [source('built-in', 300)] },
            { kind: 'agents', count: 0, chars: 0, sources: [] },
            { kind: 'instructions', count: 1, chars: 100, sources: [] },
          ],
        },
      });
    assert.deepEqual(lines(at(600)), []);
    assert.deepEqual(lines(at(601)), [
      'WARN context-lists lists in the context of the newest session (/u/.claude/projects/-w/s1.jsonl): 1,001 characters (~300 tokens), over its budget of 1,000 [contextFiles.maxSessionListsChars]: skills 5, 601 (skills folders and built-in 201, docs 200, dev 100, +2 more); deferred tools 2, 300 (built-in 300); MCP instructions 1, 100; every call re-reads this text, so turn off unused claude.ai connectors and skills in claude.ai settings, and unused plugins with /plugin',
    ]);
  });

  it('finds nothing on a healthy team with renames, a fresh inbox and short rules', () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout'), renameOf('bravo', 'app-bravo', 'app-alpha'), renameOf('alpha', 'scout', 'ranger')];
    const read = ['- 2030-01-02 09:00 lead: old'];
    const inboxes = [unreadOf('alpha', [...read, '- 2030-01-19 09:00 lead: new'], markAt('alpha', read, '2030-01-18T09:00:00Z'), lineHash)];
    assert.deepEqual(lines(input({ renames, inboxes, teamRules: [{ path: 'rules.md', chars: TEAM_RULES_MAX_CHARS }] })), []);
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

  it("keeps quiet on a retired session's inbox and former names, which stay on purpose", () => {
    const inboxes = [unreadOf('zulu', ['- 2030-01-02 09:00 lead: old'], null, lineHash)];
    const renames = [renameOf('zulu', 'app-zulu', 'ghost')];
    assert.deepEqual(lines(input({ inboxes, renames, retired: new Set(['zulu']) })), []);
    assert.equal(lines(input({ inboxes, renames })).length, 2);
  });

  it('says one name of a removed session in the singular', () => {
    const renames = [renameOf('zulu', 'app-zulu', 'ghost'), renameOf('alpha', 'app-alpha', 'app-zulu')];
    assert.deepEqual(lines(input({ renames })), [
      'WARN name-gone ghost was a name of zulu, which is no longer on the team: commands refuse them, filters read them as zulu',
    ]);
  });

  it('flags a current name Claude Code reserves, from an old rename or the default name, and not a former one', () => {
    const fix = '(session lead) is a name Claude Code keeps for itself, so a message sent to it never reaches a session: give the tab another name with /rename, then record it with `teamrig rename lead <name>`';
    assert.deepEqual(lines(input({ renames: [renameOf('lead', 'app-lead', 'team-lead')] })), [`WARN name-reserved team-lead ${fix}`]);
    const team = { ...input(), roster: new Roster({ sessions: ['lead', 'alpha'], names: {}, roles: { lead: 'lead' } }, 'team', []) };
    assert.deepEqual(lines(team), [`WARN name-reserved team-lead ${fix}`]);
    assert.deepEqual(lines(input({ renames: [renameOf('lead', 'app-lead', 'main'), renameOf('lead', 'main', 'captain')] })), []);
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
      'WARN inbox-unread alpha has 1 unread line(s) and last read it 01-12 09:00 UTC: over 7 days with no read',
      'WARN inbox-unread bravo has 1 unread line(s) and has never read it: over 7 days with no read',
      'WARN inbox-unread lead has 1 unread line(s) and has never read it: over 7 days with no read',
    ]);
    const fresh = [unreadOf('bravo', ['- 2030-01-19 09:00 lead: new'], null, lineHash), unreadOf('alpha', read, markAt('alpha', read, '2030-01-02T09:00:00Z'), lineHash)];
    assert.deepEqual(lines(input({ inboxes: fresh })), []);
    assert.match(lines(input({ inboxes, zone: JERUSALEM }))[0] ?? '', /and last read it 01-12 11:00 IST: /);
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
    assert.deepEqual(lines(input({ teamRules: [{ path: 'rules.md', chars: TEAM_RULES_MAX_CHARS + 1 }] })), [
      `WARN rules-long rules.md is ${TEAM_RULES_MAX_CHARS + 1} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`,
    ]);
  });

  it('flags a rules file that fits alone but not beside the files of the teams above, and skips an empty one', () => {
    const teamRules = [
      { path: 'app/rules.md', chars: 1_500 },
      { path: 'web/rules.md', chars: 0 },
      { path: 'ui/rules.md', chars: 1_000 },
      { path: 'own/rules.md', chars: 1_000 },
    ];
    assert.deepEqual(lines(input({ teamRules })), [
      `WARN rules-long own/rules.md is 1000 characters, but the team rules shown before it (app/rules.md, ui/rules.md) take 2500 of the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten one of them`,
    ]);
  });

  it('still counts a short file below a long one as shown, as the start does', () => {
    const teamRules = [
      { path: 'app/rules.md', chars: TEAM_RULES_MAX_CHARS + 1 },
      { path: 'own/rules.md', chars: TEAM_RULES_MAX_CHARS },
    ];
    assert.deepEqual(lines(input({ teamRules })), [
      `WARN rules-long app/rules.md is ${TEAM_RULES_MAX_CHARS + 1} characters, more than the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten it to keep it in every session's context`,
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

describe('doctorFindings of model and effort overrides', () => {
  const USER = '/u/.claude/settings.json';
  const PROJECT = '/w/app/.claude/settings.local.json';
  const settings = (path: string, env: Record<string, string>): SettingsEnv => ({ kind: 'env', path, env });
  const EFFORT_FROM = (where: string) =>
    `WARN effort-env CLAUDE_CODE_EFFORT_LEVEL=high is set in ${where}: it beats every --effort (the team config's launch efforts among them), /effort and per-call Agent effort, so a session or helper that gets it runs at high whatever it was given; unset it there to let each choose its own`;
  const FORCE_FROM = (where: string) =>
    `WARN model-env CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 is set in ${where}: set to 1 it beats every per-call Agent model, so a helper that gets it never runs on the model its caller gives it; unset it there to let each choose its own`;

  it('is quiet when neither variable is set, or set empty, anywhere', () => {
    const other = { PATH: '/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' };
    assert.deepEqual(lines(input({ env: other, settingsEnv: [settings(USER, other), settings(PROJECT, {})] })), []);
    assert.deepEqual(lines(input({ env: { CLAUDE_CODE_EFFORT_LEVEL: ' ', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '' } })), []);
  });

  it('flags CLAUDE_CODE_EFFORT_LEVEL set in the environment doctor runs in, with its value and what it beats', () => {
    assert.deepEqual(lines(input({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'high', ANTHROPIC_API_KEY: 'not a real key' } })), [EFFORT_FROM('the environment doctor runs in')]);
  });

  it('flags CLAUDE_CODE_EFFORT_LEVEL set in a settings env block only, naming the file', () => {
    assert.deepEqual(lines(input({ settingsEnv: [settings(USER, {}), settings(PROJECT, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })] })), [EFFORT_FROM(`the env block of ${PROJECT}`)]);
  });

  it('flags CLAUDE_CODE_SUBAGENT_MODEL_FORCE in the environment and in a settings env block, one line each', () => {
    const force = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
    assert.deepEqual(lines(input({ env: force })), [FORCE_FROM('the environment doctor runs in')]);
    assert.deepEqual(lines(input({ settingsEnv: [settings(USER, force)] })), [FORCE_FROM(`the env block of ${USER}`)]);
    assert.deepEqual(lines(input({ env: { ...force, CLAUDE_CODE_EFFORT_LEVEL: 'high' }, settingsEnv: [settings(USER, force)] })), [
      EFFORT_FROM('the environment doctor runs in'),
      FORCE_FROM('the environment doctor runs in'),
      FORCE_FROM(`the env block of ${USER}`),
    ]);
  });

  it('flags a settings file whose env block it could not read, and still checks the others', () => {
    const unreadable: SettingsEnv = { kind: 'unreadable', path: USER };
    assert.deepEqual(lines(input({ settingsEnv: [unreadable, settings(PROJECT, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })] })), [
      EFFORT_FROM(`the env block of ${PROJECT}`),
      `WARN settings-json ${USER} is not a JSON object, so doctor could not check its env block for CLAUDE_CODE_EFFORT_LEVEL or CLAUDE_CODE_SUBAGENT_MODEL_FORCE`,
    ]);
  });
});

describe('doctorFindings of launch entries', () => {
  const launchesOf = (launch: Record<string, Record<string, string>>): DoctorInput['launches'] => {
    const config = testConfig({ launch });
    return config.sessions.map((id) => ({ id, launch: launchOf(config, id) }));
  };

  it('flags a session whose launch names a model but no effort, with the key to set', () => {
    assert.deepEqual(lines(input({ launches: launchesOf({ alpha: { model: 'opus' }, bravo: { model: 'claude-sonnet-5-5[1m]' } }) })), [
      "WARN launch-effort app-alpha (session alpha) launches on model opus with no effort, so it runs at that model's default effort (medium on Opus, Sonnet and Haiku 5.5): set launch.alpha.effort in the team config",
      "WARN launch-effort app-bravo (session bravo) launches on model claude-sonnet-5-5[1m] with no effort, so it runs at that model's default effort (medium on Opus, Sonnet and Haiku 5.5): set launch.bravo.effort in the team config",
    ]);
  });

  it('names a renamed session by its current name', () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout')];
    const [line] = lines(input({ renames, launches: launchesOf({ alpha: { model: 'haiku' } }) }));
    assert.ok(line?.startsWith('WARN launch-effort scout (session alpha) launches on model haiku with no effort'), line);
  });

  it('is quiet for a launch with a model and an effort, with neither, with only an effort, or on the default model', () => {
    const launches = launchesOf({ alpha: { model: 'opus', effort: 'high' }, bravo: { effort: 'low' } });
    assert.deepEqual(lines(input({ launches })), []);
    assert.deepEqual(lines(input({ launches: launchesOf({}) })), []);
    assert.deepEqual(lines(input({ launches: launchesOf({ alpha: { model: 'default' } }) })), []);
  });

  it('flags the wide and credential allow rules by class in one finding, and is quiet without any', () => {
    assert.deepEqual(lines(input({ wideAllow: { files: 2, counts: [['Bash wide', 2], ['Bash credential', 1]] } })), [
      "WARN allow-wide 3 local allow rule(s) in 2 settings file(s) approve a whole tool or program, so auto mode's classifier never sees those calls, or hold a credential saved with an approved command (Bash wide 2, Bash credential 1); `teamrig permissions trim` previews their removal, and the owner runs it with --yes",
    ]);
    assert.deepEqual(lines(input()), []);
  });

  it("is quiet for the lead's model with no effort, since the lead's default effort fills it in", () => {
    const launches = launchesOf({ lead: { model: 'sonnet' } });
    assert.deepEqual(launches.find(({ id }) => id === 'lead')?.launch, { model: 'sonnet', effort: DEFAULT_LEAD_LAUNCH.effort });
    assert.deepEqual(lines(input({ launches })), []);
  });
});

describe('doctorFindings of configured project folders', () => {
  it("flags a team.project or launch.<id>.project that is missing or a file, naming the session by its current name", () => {
    const renames = [renameOf('alpha', 'app-alpha', 'scout')];
    const projects: DoctorInput['projects'] = [
      { session: undefined, path: '/srv/gone', kind: 'none' },
      { session: 'alpha', path: '/srv/notes.txt', kind: 'file' },
      { session: 'bravo', path: '/srv/web', kind: 'folder' },
    ];
    assert.deepEqual(lines(input({ renames, projects })), [
      'WARN project-missing team.project names /srv/gone, which is missing on this machine, so a tab teamrig open starts for a session without its own folder refuses to launch: create the folder or fix team.project in the team config',
      'WARN project-missing launch.alpha.project names /srv/notes.txt, which is a file on this machine, so a tab teamrig open starts for scout (session alpha) refuses to launch: create the folder or fix launch.alpha.project in the team config',
    ]);
  });

  it('is quiet when every configured project is a folder, or none is configured', () => {
    assert.deepEqual(lines(input({ projects: [{ session: 'alpha', path: '/srv/app', kind: 'folder' }] })), []);
    assert.deepEqual(lines(input()), []);
  });
});

describe('doctorFindings of the PowerShell history', () => {
  const history = '/u/history.txt';
  const fix = "add the history handler from the teamrig guide (workflows: Use a secret by reference) to your profile ($PROFILE) yourself; Claude Code refuses an agent's write to it";

  it('flags a history file no profile gates, naming the profiles read, or that none exists', () => {
    const profiles = ['/u/Documents/PowerShell/profile.ps1', '/u/Documents/WindowsPowerShell/profile.ps1'];
    assert.deepEqual(lines(input({ shellHistory: { history, profiles, gated: false } })), [
      `WARN shell-history PowerShell keeps each line typed in its console in ${history}, a credential in a URL too, and no profile sets -AddToHistoryHandler or -HistorySaveStyle SaveNothing (profiles read: ${profiles.join(', ')}): ${fix}`,
    ]);
    assert.deepEqual(lines(input({ shellHistory: { history, profiles: [], gated: false } })), [
      `WARN shell-history PowerShell keeps each line typed in its console in ${history}, a credential in a URL too, and no profile sets -AddToHistoryHandler or -HistorySaveStyle SaveNothing (none of the usual profile paths exists): ${fix}`,
    ]);
  });

  it('is quiet when a profile gates the history, or there is no history file', () => {
    assert.deepEqual(lines(input({ shellHistory: { history, profiles: ['/u/profile.ps1'], gated: true } })), []);
    assert.deepEqual(lines(input({ shellHistory: { history: undefined, profiles: [], gated: false } })), []);
  });
});
