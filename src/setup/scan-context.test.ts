import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { claudeMemoryDir } from '../doctor/context-files.ts';
import { MemoryFiles, MemoryPathProbe } from '../testing/memory-files.ts';
import { importsOf, IMPORT_DEPTH, listingLineOf, MEMORY_INDEX_LINES, readSessionContext, type SessionContextLocations } from './scan-context.ts';

const USER_HOME = resolve('/', 'u');
const CLAUDE_DIR = join(USER_HOME, '.claude');
const PROJECT = resolve('/', 'work', 'app');
const TEAM_RULES = resolve('/', 'kit', 'teams', 'app', 'rules.md');
const AT: SessionContextLocations = {
  claudeDir: CLAUDE_DIR,
  userHome: USER_HOME,
  project: PROJECT,
  skills: join(CLAUDE_DIR, 'skills'),
  teamRules: TEAM_RULES,
};

describe('importsOf', () => {
  it('reads an @path at a line start or after a space, from the home folder, the importing folder or as written', () => {
    const text = ['@notes.md', 'See @~/shared/rules.md and @../up.md for more', `Also @${resolve('/', 'abs.md')}`].join('\n');
    assert.deepEqual(importsOf(text, join(PROJECT, 'CLAUDE.md'), USER_HOME), [
      join(PROJECT, 'notes.md'),
      join(USER_HOME, 'shared', 'rules.md'),
      resolve('/', 'work', 'up.md'),
      resolve('/', 'abs.md'),
    ]);
  });

  it('skips an address, an inline code span and a fenced block', () => {
    const text = ['Mail me at someone@example.com', 'Run `npm i @types/node` first', '```', '@inside.md', '```'].join('\n');
    assert.deepEqual(importsOf(text, join(PROJECT, 'CLAUDE.md'), USER_HOME), []);
  });
});

describe('listingLineOf', () => {
  it('lists a skill as Claude Code does, one line per skill', () => {
    assert.equal(listingLineOf('alpha-check', 'Checks alpha.'), '- alpha-check: Checks alpha.\n');
  });
});

describe('readSessionContext', () => {
  function skill(description: string): string {
    return `---\nname: x\ndescription: ${description}\n---\nBody that is never listed.\n`;
  }

  function world(extra: Readonly<Record<string, string>> = {}): { files: MemoryFiles; probe: MemoryPathProbe } {
    const memory = Array.from({ length: MEMORY_INDEX_LINES + 50 }, (_, index) => `- line ${index + 1}`).join('\n');
    const files = new MemoryFiles({
      [join(CLAUDE_DIR, 'CLAUDE.md')]: 'User rules.\n@~/notes.md\n',
      [join(USER_HOME, 'notes.md')]: 'Notes.\n@~/.claude/CLAUDE.md\n',
      [join(PROJECT, 'CLAUDE.md')]: 'Project rules.\n',
      [join(PROJECT, '.claude', 'rules', 'always.md')]: 'Always loaded.\n',
      [join(PROJECT, '.claude', 'rules', 'ts.md')]: '---\npaths: src/**/*.ts\n---\nOnly for TypeScript.\n',
      [join(PROJECT, '.claude', 'rules', 'deep', 'nested.md')]: 'Nested and loaded.\n',
      [join(CLAUDE_DIR, 'rules', 'mine.md')]: 'User rule.\n',
      [join(claudeMemoryDir(CLAUDE_DIR, PROJECT), 'MEMORY.md')]: memory,
      [TEAM_RULES]: 'Team rules.\n',
      [join(CLAUDE_DIR, 'skills', 'alpha-check', 'SKILL.md')]: skill('Checks alpha.'),
      [join(PROJECT, '.claude', 'skills', 'beta-run', 'SKILL.md')]: skill('Runs beta.'),
      ...extra,
    });
    return { files, probe: new MemoryPathProbe(files) };
  }

  it('loads the CLAUDE.md files with their imports once each, the unconditional rules, the memory index head and the team rules', async () => {
    const { files, probe } = world();
    const context = await readSessionContext(files, probe, AT);
    assert.deepEqual(
      context.files.map((file) => [file.kind, file.path]),
      [
        ['claude-md', join(CLAUDE_DIR, 'CLAUDE.md')],
        ['import', join(USER_HOME, 'notes.md')],
        ['claude-md', join(PROJECT, 'CLAUDE.md')],
        ['rules', join(PROJECT, '.claude', 'rules', 'always.md')],
        ['rules', join(PROJECT, '.claude', 'rules', 'deep', 'nested.md')],
        ['rules', join(CLAUDE_DIR, 'rules', 'mine.md')],
        ['memory', join(claudeMemoryDir(CLAUDE_DIR, PROJECT), 'MEMORY.md')],
        ['team-rules', TEAM_RULES],
      ],
    );
    const memory = context.files.find((file) => file.kind === 'memory');
    assert.equal(memory?.text.split('\n').length, MEMORY_INDEX_LINES);
    assert.equal(memory?.text.split('\n').at(-1), `- line ${MEMORY_INDEX_LINES}`);
  });

  it("lists the user's skills and then the project's, each by its listing line", async () => {
    const { files, probe } = world();
    const context = await readSessionContext(files, probe, AT);
    assert.deepEqual(
      context.skills.map((skill) => [skill.name, skill.path, skill.description, skill.line]),
      [
        ['alpha-check', join(CLAUDE_DIR, 'skills', 'alpha-check', 'SKILL.md').replaceAll('\\', '/'), 'Checks alpha.', '- alpha-check: Checks alpha.\n'],
        ['beta-run', join(PROJECT, '.claude', 'skills', 'beta-run', 'SKILL.md').replaceAll('\\', '/'), 'Runs beta.', '- beta-run: Runs beta.\n'],
      ],
    );
  });

  it(`follows imports ${IMPORT_DEPTH} hops deep and no further`, async () => {
    const chain = Object.fromEntries(Array.from({ length: IMPORT_DEPTH + 1 }, (_, index) => [join(USER_HOME, `hop${index + 1}.md`), `@~/hop${index + 2}.md\n`]));
    const { files, probe } = world({ [join(CLAUDE_DIR, 'CLAUDE.md')]: '@~/hop1.md\n', ...chain });
    const imports = (await readSessionContext(files, probe, AT)).files.filter((file) => file.kind === 'import').map((file) => file.path);
    assert.deepEqual(
      imports,
      Array.from({ length: IMPORT_DEPTH }, (_, index) => join(USER_HOME, `hop${index + 1}.md`)),
    );
  });

  it('looks for no team rules before a team exists, and skips a missing file', async () => {
    const { files, probe } = world();
    await files.remove(join(PROJECT, 'CLAUDE.md'));
    const context = await readSessionContext(files, probe, { ...AT, teamRules: undefined });
    assert.equal(context.files.some((file) => file.kind === 'team-rules'), false);
    assert.equal(context.files.some((file) => file.path === join(PROJECT, 'CLAUDE.md')), false);
  });
});
