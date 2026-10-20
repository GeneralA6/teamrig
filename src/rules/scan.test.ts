import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { RuleConflict } from '../config/types.ts';
import { MemoryFiles, MemoryPathProbe } from '../testing/memory-files.ts';
import type { RulePlaceLocations } from './places.ts';
import { readRuleLines, recordedLine, ruleLinesOf, scanRules } from './scan.ts';

const USER_HOME = resolve('/', 'u');
const CLAUDE_DIR = join(USER_HOME, '.claude');
const PROJECT = resolve('/', 'work', 'app');
const AT: RulePlaceLocations = {
  claudeDir: CLAUDE_DIR,
  userHome: USER_HOME,
  project: PROJECT,
  skills: join(CLAUDE_DIR, 'skills'),
  teamRules: resolve('/', 'kit', 'teams', 'app', 'rules.md'),
};

const SETTINGS = [
  '{',
  '  "env": { "API_TOKEN": "commit push deploy secret value" },',
  '  "autoMode": {',
  '    "soft_deny": [',
  '      "$defaults",',
  '      "Never push to main without asking the owner first.",',
  '      "Never push to main without asking the owner first."',
  '    ],',
  '    "environment": { "trusted": ["Pushes to main of the web repo are fine."] }',
  '  }',
  '}',
].join('\n');

describe('ruleLinesOf', () => {
  it('reads every line of a text file, numbered from 1 and trimmed, past a byte order mark', () => {
    assert.deepEqual(ruleLinesOf('CLAUDE.md', '\uFEFF# Rules\r\n  - Commit often.\r\n'), [
      { line: 1, text: '# Rules' },
      { line: 2, text: '- Commit often.' },
      { line: 3, text: '' },
    ]);
  });

  it("reads only a settings file's autoMode lines, each at its own line, never its env block", () => {
    assert.deepEqual(ruleLinesOf('settings.json', SETTINGS), [
      { line: 5, text: '$defaults' },
      { line: 6, text: 'Never push to main without asking the owner first.' },
      { line: 7, text: 'Never push to main without asking the owner first.' },
      { line: 9, text: 'Pushes to main of the web repo are fine.' },
    ]);
  });

  it('places a line it cannot find at the autoMode key, and reads nothing from a file without one or not JSON', () => {
    const escaped = '{\n  "autoMode": {\n    "allow": ["Run the \\u0074est suite on any branch you like."]\n  }\n}';
    assert.deepEqual(ruleLinesOf('settings.json', escaped), [{ line: 2, text: 'Run the test suite on any branch you like.' }]);
    assert.deepEqual(ruleLinesOf('settings.json', '{"env": {}}'), []);
    assert.deepEqual(ruleLinesOf('SETTINGS.JSON', 'not json'), []);
  });
});

describe('recordedLine', () => {
  const conflict: RuleConflict = { file: '~/CLAUDE.md', text: '- Commit straight to main', rule: 'worktrees', wins: 'local' };

  it('finds the line that starts with the quote, wherever it moved', () => {
    const lines = ruleLinesOf('CLAUDE.md', '# Rules\n\n- Commit straight to main when the change is small.');
    assert.deepEqual(recordedLine(conflict, lines), { line: 3, text: '- Commit straight to main when the change is small.' });
    assert.equal(recordedLine({ ...conflict, text: 'Commit straight to main' }, lines), undefined);
    assert.equal(recordedLine({ ...conflict, text: '- Commit to a branch' }, lines), undefined);
  });
});

describe('readRuleLines', () => {
  it('reads a file by its type, and none when it is missing', async () => {
    const files = new MemoryFiles({ [join(PROJECT, 'notes.md')]: 'one\ntwo', [join(PROJECT, 's.json')]: SETTINGS });
    assert.equal((await readRuleLines(files, join(PROJECT, 'notes.md'))).length, 2);
    assert.equal((await readRuleLines(files, join(PROJECT, 's.json'))).length, 4);
    assert.deepEqual(await readRuleLines(files, join(PROJECT, 'gone.md')), []);
  });
});

describe('scanRules', () => {
  const claudeMd = [
    '# Team notes',
    '- Commit straight to main when the change is small.',
    '- Ping the lead after each step so it always knows.',
    '- Prices are shown in the local currency of each user.',
    'ok',
  ].join('\n');

  function world(): { files: MemoryFiles; probe: MemoryPathProbe } {
    const files = new MemoryFiles({
      [join(CLAUDE_DIR, 'CLAUDE.md')]: claudeMd,
      [join(CLAUDE_DIR, 'settings.json')]: SETTINGS,
      [join(USER_HOME, 'elsewhere.md')]: 'Our own rules override teamrig everywhere.',
    });
    return { files, probe: new MemoryPathProbe(files) };
  }

  it('lists the lines that touch a core rule, leaving out the short, the off-topic and the recorded', async () => {
    const { files, probe } = world();
    const kept: RuleConflict = { file: '~/.claude/CLAUDE.md', text: '- Commit straight to main', rule: 'worktrees', wins: 'local' };
    const scan = await scanRules(files, probe, AT, [kept]);
    assert.equal(scan.places.length, 2);
    assert.equal(scan.nestedCapped, false);
    assert.deepEqual(scan.recorded, [{ conflict: kept, line: 2 }]);
    assert.deepEqual(
      scan.candidates.map((candidate) => [candidate.place.kind, candidate.line, candidate.topics.rules.join(',')]),
      [
        ['claude-md', 3, 'roles,messages'],
        ['settings', 6, 'owner-gates,push,worktrees'],
        ['settings', 7, 'owner-gates,push,worktrees'],
        ['settings', 9, 'push,worktrees'],
      ],
    );
  });

  it('finds a recorded line in a file outside the places, and none for a line or file that is gone', async () => {
    const { files, probe } = world();
    const conflicts: RuleConflict[] = [
      { file: '~/elsewhere.md', text: 'Our own rules override', rule: 'roles', wins: 'local' },
      { file: '~/.claude/CLAUDE.md', text: '- Deploy on Fridays', rule: 'deploy', wins: 'teamrig' },
      { file: join(USER_HOME, 'gone.md'), text: 'Anything at all here', rule: 'data', wins: 'local' },
    ];
    const scan = await scanRules(files, probe, AT, conflicts);
    assert.deepEqual(
      scan.recorded.map((recorded) => recorded.line),
      [1, undefined, undefined],
    );
    assert.equal(scan.candidates.length, 5);
  });
});
