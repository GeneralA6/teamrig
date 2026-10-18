import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillFile, SkillFlag } from './lint.ts';
import { EMPTY_SKILL_DAY, EMPTY_TALLY, type ScorecardDays } from './scorecard.ts';
import { renderScorecard, scorecardRows, type DayRange, type ScorecardFooter, type ScorecardRow } from './scorecard-report.ts';
import { signatureOf } from './signature.ts';

const WINDOW: DayRange = { from: '2030-01-02', to: '2030-01-08' };
const BASELINE: DayRange = { from: '2029-12-26', to: '2030-01-01' };

function skillFile(name: string, body: string): SkillFile {
  return { name, text: `---\nname: ${name}\ndescription: Use when the nightly job fails.\n---\nOwner: alpha\n${body}\n` };
}

function flag(kind: SkillFlag['kind'], skill: string): SkillFlag {
  return { kind, skill, owner: 'alpha', detail: 'x' };
}

const SKILLS = [
  skillFile('alpha-ship', 'Last verified: 2030-01-05\nSignature: `teamrig integrate`'),
  skillFile('alpha-inbox', 'Signature: `teamrig (inbox`'),
  skillFile('alpha-plain', 'No lines the scorecard reads.'),
];
const DAYS: ScorecardDays = {
  '2029-12-20': { 'alpha-ship': { ...EMPTY_SKILL_DAY, manual: { runs: 5, calls: 50, failed: 5, refused: 5 } } },
  '2029-12-30': { 'alpha-ship': { ...EMPTY_SKILL_DAY, manual: { runs: 1, calls: 9, failed: 2, refused: 0 } } },
  '2030-01-03': {
    'alpha-ship': { loads: 1, skill: { runs: 1, calls: 2, failed: 1, refused: 0 }, manual: { runs: 1, calls: 1, failed: 0, refused: 1 }, edits: 1 },
    'alpha-plain': { ...EMPTY_SKILL_DAY, loads: 1 },
    'zulu-gone': { ...EMPTY_SKILL_DAY, loads: 3 },
  },
  '2030-01-08': { 'alpha-ship': { loads: 1, skill: { runs: 1, calls: 4, failed: 0, refused: 1 }, manual: EMPTY_TALLY, edits: 0 } },
};

function rows(lint: readonly SkillFlag[] = []): ScorecardRow[] {
  return scorecardRows({ days: DAYS, skills: SKILLS, signatures: SKILLS.map(signatureOf), lint }, WINDOW, BASELINE);
}

describe('scorecardRows', () => {
  it("sums the window's skill runs against the baseline's runs by hand, per installed skill", () => {
    assert.deepEqual(rows().find((row) => row.skill === 'alpha-ship'), {
      skill: 'alpha-ship',
      loads: 2,
      missed: 1,
      callsPerRun: 3,
      baseCallsPerRun: 9,
      errorsPerRun: 1,
      baseErrorsPerRun: 2,
      refused: 2,
      edits: 1,
      lastVerified: '2030-01-05',
      descriptionWords: 6,
      flags: [],
    });
  });

  it('lists every installed skill and any other the window counted, by name, with what needs attention', () => {
    const all = rows([flag('UNVERIFIED', 'alpha-plain'), flag('UNVERIFIED', 'alpha-plain'), flag('SIGNATURE', 'alpha-inbox'), flag('OWNER', 'zulu-gone')]);
    assert.deepEqual(
      all.map((row) => [row.skill, row.flags]),
      [
        ['alpha-inbox', ['not loaded', 'SIGNATURE']],
        ['alpha-plain', ['no signature', 'UNVERIFIED']],
        ['alpha-ship', []],
        ['zulu-gone', ['no SKILL.md']],
      ],
    );
    const gone = all.find((row) => row.skill === 'zulu-gone');
    assert.deepEqual([gone?.loads, gone?.callsPerRun, gone?.lastVerified, gone?.descriptionWords], [3, undefined, undefined, undefined]);
  });
});

describe('renderScorecard', () => {
  const footer: ScorecardFooter = { window: WINDOW, baseline: BASELINE, since: '2029-12-20', files: 3, bytesRead: 3 * 1024 * 1024 + 100_000, catchingUp: false };

  it('renders a markdown table, with a dash for a ratio that has no runs', () => {
    const lines = renderScorecard(rows().slice(1, 3), footer);
    assert.deepEqual(lines, [
      'Skills scorecard 2030-01-02 to 2030-01-08, baseline 2029-12-26 to 2030-01-01',
      '',
      '| skill | loads | missed | calls/run | base calls/run | err/run | base err/run | refused | edits | last verified | desc words | flags |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| alpha-plain | 1 | 0 | - | - | - | - | 0 | 0 | - | 6 | no signature |',
      '| alpha-ship | 2 | 1 | 3.0 | 9.0 | 1.0 | 2.0 | 2 | 1 | 2030-01-05 | 6 |  |',
      '',
      "missed: a call matching the skill's Signature line with no load in the 30 calls before. A run ends at the next prompt that starts new work; base = the procedure by hand in the baseline.",
      'Read 3 files, 3.1 MB this run.',
    ]);
  });

  it('says when transcripts are still unread, and which requested days came before the first read', () => {
    const lines = renderScorecard([], { ...footer, since: '2029-12-28', catchingUp: true });
    assert.deepEqual(lines.slice(-2), [
      'Catching up: transcripts are still partly unread; run again for complete counts.',
      "Days before 2029-12-28 are not counted: the scorecard's first read started there.",
    ]);
    const later = renderScorecard([], { ...footer, baseline: { from: '2030-01-10', to: '2030-01-11' }, since: '2030-01-03' });
    assert.equal(later.at(-1), "Days before 2030-01-03 are not counted: the scorecard's first read started there.");
  });
});
