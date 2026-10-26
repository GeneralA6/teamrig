import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homeRelative } from '../core/paths.ts';
import { SecretScanner } from '../core/secrets.ts';
import type { PlaceKind } from '../rules/places.ts';
import type { Candidate } from '../rules/scan.ts';
import { listingLineOf, type ListedSkill } from './scan-context.ts';
import { scanReport, tokensOf, type ScanReportContext } from './scan-report.ts';
import type { SettingsFinding } from './scan-settings.ts';
import type { SetupScan } from './scan.ts';

const CLAUDE_MD = '/u/.claude/CLAUDE.md';
const TEAM_RULES = '/kit/teams/app/rules.md';
const PROJECT_RULE = '/work/app/.claude/rules/x.md';
const USER_SETTINGS = '/u/.claude/settings.json';
const RULE = 'Never commit straight to the main branch of any repository.';
const SECRETS = new SecretScanner(['hunter2-']);
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2030-01-08T10:00:00Z');
const AT: ScanReportContext = { project: '/work/app', team: 'app', days: 30, now: NOW, maxMb: 1024, userHome: '/u', secrets: SECRETS };

/** A path outside the home folder, as this machine's paths print it. */
function shown(path: string): string {
  return homeRelative(path, AT.userHome);
}

function skill(name: string, description: string): ListedSkill {
  return { name, path: `/u/.claude/skills/${name}/SKILL.md`, description, line: listingLineOf(name, description) };
}

function candidate(kind: PlaceKind, path: string, line: number): Candidate {
  return { place: { kind, path }, line, text: '- Push straight to main.', topics: { rules: ['push'], tags: [] } };
}

const ALPHA = skill('alpha', 'a'.repeat(300));
const BETA = skill('beta', 'b'.repeat(300));
const WIDE: SettingsFinding = { kind: 'wide-allow', path: USER_SETTINGS, what: '2 allow rule(s) approve a whole tool' };

const SCAN: SetupScan = {
  context: {
    files: [
      { kind: 'claude-md', path: CLAUDE_MD, text: 'x'.repeat(7000) },
      { kind: 'memory', path: '/u/.claude/projects/app/memory/MEMORY.md', text: 'm'.repeat(400) },
      { kind: 'team-rules', path: TEAM_RULES, text: 'r'.repeat(100) },
    ],
    skills: [ALPHA, BETA],
  },
  listing: { count: 2, chars: ALPHA.line.length + BETA.line.length, sources: undefined },
  duplicates: [{ path: CLAUDE_MD, line: 3, text: RULE, firstPath: TEAM_RULES, firstLine: 1 }],
  overrides: [candidate('claude-md', CLAUDE_MD, 4), candidate('rules', PROJECT_RULE, 2), candidate('claude-md', CLAUDE_MD, 9)],
  recorded: 1,
  settings: [WIDE],
  usage: { used: new Set(['alpha']), transcripts: 3, bytes: 1.5 * 1024 * 1024, unread: 0, since: NOW - 30 * DAY_MS },
  recent: new Set(),
};

describe('tokensOf', () => {
  it('counts a token per four characters, rounding up', () => {
    assert.deepEqual([tokensOf(0), tokensOf(1), tokensOf(8), tokensOf(9)], [0, 1, 2, 3]);
  });
});

describe('scanReport', () => {
  it('sizes each loaded file and the listing, then numbers the findings by section and sums what they save', () => {
    assert.deepEqual(scanReport(SCAN, AT), [
      `SCAN ${shown(AT.project)} (team app)`,
      'CONTEXT claude-md ~/.claude/CLAUDE.md: 7,000 chars (~1,750 tokens/turn)',
      'CONTEXT memory ~/.claude/projects/app/memory/MEMORY.md: 400 chars (~100 tokens/turn), the first 200 lines Claude Code loads',
      `CONTEXT team-rules ${shown(TEAM_RULES)}: 100 chars (~25 tokens/turn)`,
      "CONTEXT skills 2 skill(s) listed: 619 chars (~155 tokens/turn); summed from the user's and the project's skill folders (plugins' skills not counted: no transcript of this project yet)",
      'TOTAL 8,119 chars (~2,030 tokens/turn) at every session start',
      'C1 large-file ~/.claude/CLAUDE.md: 7,000 chars, over the 6,000 an always-loaded file should keep to (~250 tokens/turn)',
      "C2 long-description ~/.claude/skills/alpha/SKILL.md: skill alpha's description is 300 chars, over 250 (~13 tokens/turn)",
      'DUPLICATE 1 line(s) or sentence(s) repeat one loaded before',
      `D1 duplicate ~/.claude/CLAUDE.md:3: "${RULE}" repeats ${shown(TEAM_RULES)}:1 (~15 tokens/turn)`,
      'OVERRIDE 3 line(s) in 2 file(s) may override a core rule: claude-md 2, rules 1; 1 recorded',
      'NEXT teamrig rules scan, to judge each line with the user',
      'SETTINGS 1 finding(s)',
      'S1 wide-allow ~/.claude/settings.json: 2 allow rule(s) approve a whole tool',
      'NEXT teamrig permissions trim',
      'UNUSED 1 of 2 skill(s) not used in 30 day(s) (read 3 transcript(s), 1.5 MB)',
      'U1 unused-skill ~/.claude/skills/beta/SKILL.md: no Skill call or /beta in 30 day(s) (~78 tokens/turn)',
      'SAVINGS ~356 tokens/turn if every CONTEXT, DUPLICATE and UNUSED finding is applied',
    ]);
  });

  it('before a team and its transcripts: the recorded listing, NEXT steps after team create, no skill judged unused, secrets redacted', () => {
    const scan: SetupScan = {
      ...SCAN,
      context: { files: [], skills: [BETA] },
      listing: {
        count: 7,
        chars: 1200,
        sources: [
          { name: 'skills folders and built-in', count: 5, chars: 1000 },
          { name: 'tr', count: 2, chars: 200 },
        ],
      },
      duplicates: [{ path: CLAUDE_MD, line: 2, text: 'Use the key hunter2-abcdef for the staging API only.', firstPath: CLAUDE_MD, firstLine: 1 }],
      overrides: [candidate('rules', PROJECT_RULE, 2)],
      recorded: 0,
      usage: { used: new Set(), transcripts: 0, bytes: 0, unread: 0, since: NOW - 7 * DAY_MS },
    };
    const lines = scanReport(scan, { ...AT, team: undefined, days: 7 });
    assert.deepEqual(lines, [
      `SCAN ${shown(AT.project)} (no team yet)`,
      "CONTEXT skills 7 skill(s) listed: 1,200 chars (~300 tokens/turn); as this project's newest transcript lists them: skills folders and built-in 5 (1,000 chars), tr 2 (200 chars)",
      'TOTAL 1,200 chars (~300 tokens/turn) at every session start',
      "C1 long-description ~/.claude/skills/beta/SKILL.md: skill beta's description is 300 chars, over 250 (~13 tokens/turn)",
      'DUPLICATE 1 line(s) or sentence(s) repeat one loaded before',
      'D1 duplicate ~/.claude/CLAUDE.md:2: "Use the key [redacted secret pattern from the team config..." repeats ~/.claude/CLAUDE.md:1 (~13 tokens/turn)',
      'OVERRIDE 1 line(s) in 1 file(s) may override a core rule: rules 1; 0 recorded',
      'NEXT teamrig rules scan, after teamrig team create, to judge each line with the user',
      'SETTINGS 1 finding(s)',
      'S1 wide-allow ~/.claude/settings.json: 2 allow rule(s) approve a whole tool',
      'NEXT teamrig permissions trim, after teamrig team create',
      'UNUSED not checked: no transcript on this machine in 7 day(s)',
      'SAVINGS ~26 tokens/turn if every CONTEXT, DUPLICATE and UNUSED finding is applied',
    ]);
  });

  it('judges no skill whose file changed inside the window, and counts only the unused ones among them', () => {
    const scan: SetupScan = { ...SCAN, recent: new Set([ALPHA.path, BETA.path]) };
    assert.deepEqual(
      scanReport(scan, AT).filter((line) => /^U(NUSED|\d)/.test(line)),
      ['UNUSED 0 of 2 skill(s) not used in 30 day(s) (read 3 transcript(s), 1.5 MB); 1 more changed in that time, too new to judge'],
    );
  });

  it('judges a bounded read by the newest days it covers, and says how many older transcripts it left unread', () => {
    const scan: SetupScan = { ...SCAN, usage: { ...SCAN.usage, unread: 4, since: NOW - 2.5 * DAY_MS } };
    assert.deepEqual(scanReport(scan, AT).filter((line) => /^U(NUSED|\d)/.test(line)), [
      'UNUSED 1 of 2 skill(s) not used in the newest 2.5 day(s) (read 3 transcript(s), 1.5 MB, newest first; 4 older one(s) of 30 day(s) left unread past the 1024 MB bound, --max-mb raises it)',
      'U1 unused-skill ~/.claude/skills/beta/SKILL.md: no Skill call or /beta in the newest 2.5 day(s) (~78 tokens/turn)',
    ]);
  });

  it('says so when there is nothing to judge', () => {
    const scan: SetupScan = { ...SCAN, duplicates: [], overrides: [], recorded: 2, settings: [] };
    const lines = scanReport(scan, AT);
    assert.deepEqual(
      lines.filter((line) => /^(DUPLICATE|OVERRIDE|SETTINGS|NEXT)/.test(line)),
      ['DUPLICATE none', 'OVERRIDE none to judge; 2 recorded', 'SETTINGS none'],
    );
  });
});
